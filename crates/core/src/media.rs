use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use web_bridge_protocol::AccountRef;

use crate::private_fs::{restrict_dir, restrict_file};

pub const MAX_MEDIA_BYTES: usize = 64 * 1024 * 1024;
const MEDIA_PREFIX: &str = "media:";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMediaInfo {
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub size: u64,
}

pub struct LoadedMedia {
    pub info: StoredMediaInfo,
    pub bytes: Vec<u8>,
}

pub struct MediaStore {
    root: PathBuf,
}

impl MediaStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub async fn store(
        &self,
        account: &AccountRef,
        name: String,
        content_type: String,
        bytes: &[u8],
    ) -> Result<StoredMediaInfo> {
        if bytes.len() > MAX_MEDIA_BYTES {
            bail!("media exceeds the {} byte limit", MAX_MEDIA_BYTES);
        }
        let id = Uuid::new_v4().to_string();
        let account_dir = self.account_dir(account);
        tokio::fs::create_dir_all(&account_dir)
            .await
            .context("create media account directory")?;
        restrict_dir(&account_dir).context("restrict media account directory")?;

        let info = StoredMediaInfo {
            id: id.clone(),
            name: normalize_name(name),
            content_type: normalize_content_type(content_type),
            size: bytes.len() as u64,
        };
        let data_path = account_dir.join(format!("{id}.bin"));
        let metadata_path = account_dir.join(format!("{id}.json"));
        let data_tmp = account_dir.join(format!("{id}.bin.tmp"));
        let metadata_tmp = account_dir.join(format!("{id}.json.tmp"));

        tokio::fs::write(&data_tmp, bytes)
            .await
            .context("write media data")?;
        restrict_file(&data_tmp).context("restrict media data")?;
        let metadata = serde_json::to_vec(&info).context("encode media metadata")?;
        tokio::fs::write(&metadata_tmp, metadata)
            .await
            .context("write media metadata")?;
        restrict_file(&metadata_tmp).context("restrict media metadata")?;
        tokio::fs::rename(&data_tmp, &data_path)
            .await
            .context("commit media data")?;
        tokio::fs::rename(&metadata_tmp, &metadata_path)
            .await
            .context("commit media metadata")?;
        restrict_file(&data_path).context("restrict committed media data")?;
        restrict_file(&metadata_path).context("restrict committed media metadata")?;
        Ok(info)
    }

    pub async fn load(&self, account: &AccountRef, id: &str) -> Result<LoadedMedia> {
        validate_id(id)?;
        let account_dir = self.account_dir(account);
        let metadata = tokio::fs::read(account_dir.join(format!("{id}.json")))
            .await
            .context("read media metadata")?;
        let info: StoredMediaInfo =
            serde_json::from_slice(&metadata).context("decode media metadata")?;
        if info.id != id {
            bail!("media metadata id mismatch");
        }
        let bytes = tokio::fs::read(account_dir.join(format!("{id}.bin")))
            .await
            .context("read media data")?;
        if bytes.len() as u64 != info.size {
            bail!("media size does not match metadata");
        }
        Ok(LoadedMedia { info, bytes })
    }

    pub async fn load_reference(
        &self,
        account: &AccountRef,
        reference: &str,
    ) -> Result<Option<LoadedMedia>> {
        let Some(id) = reference.strip_prefix(MEDIA_PREFIX) else {
            return Ok(None);
        };
        self.load(account, id).await.map(Some)
    }

    pub async fn remove_account(&self, account: &AccountRef) -> Result<()> {
        let path = self.account_dir(account);
        match tokio::fs::remove_dir_all(&path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).with_context(|| format!("remove media directory {}", path.display())),
        }
    }

    pub fn reference(info: &StoredMediaInfo) -> String {
        format!("{MEDIA_PREFIX}{}", info.id)
    }

    fn account_dir(&self, account: &AccountRef) -> PathBuf {
        self.root
            .join(network_name(account))
            .join(safe_component(&account.id))
    }
}

fn validate_id(id: &str) -> Result<()> {
    let parsed = Uuid::parse_str(id).context("invalid media id")?;
    if parsed.to_string() != id.to_ascii_lowercase() {
        bail!("media id is not canonical");
    }
    Ok(())
}

fn network_name(account: &AccountRef) -> &'static str {
    match account.network {
        web_bridge_protocol::Network::Qq => "qq",
        web_bridge_protocol::Network::Matrix => "matrix",
        web_bridge_protocol::Network::Telegram => "telegram",
    }
}

fn safe_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "account".into()
    } else {
        sanitized
    }
}

fn normalize_name(name: String) -> String {
    let name = Path::new(&name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment")
        .trim();
    if name.is_empty() {
        "attachment".into()
    } else {
        name.chars().take(255).collect()
    }
}

fn normalize_content_type(content_type: String) -> String {
    let trimmed = content_type.trim();
    if trimmed.is_empty() {
        "application/octet-stream".into()
    } else {
        trimmed.chars().take(255).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_bridge_protocol::Network;

    #[tokio::test]
    async fn media_is_isolated_by_account_and_removed_with_account_namespace() {
        let root = std::env::temp_dir().join(format!("web-bridge-media-{}", Uuid::new_v4()));
        let store = MediaStore::new(root.clone());
        let account_a = AccountRef {
            network: Network::Matrix,
            id: "a".into(),
        };
        let account_b = AccountRef {
            network: Network::Matrix,
            id: "b".into(),
        };
        let info = store
            .store(
                &account_a,
                "../photo.png".into(),
                "image/png".into(),
                b"image-bytes",
            )
            .await
            .unwrap();
        assert_eq!(info.name, "photo.png");
        assert_eq!(MediaStore::reference(&info), format!("media:{}", info.id));
        assert_eq!(
            store.load(&account_a, &info.id).await.unwrap().bytes,
            b"image-bytes"
        );
        assert!(store.load(&account_b, &info.id).await.is_err());

        store.remove_account(&account_a).await.unwrap();
        assert!(store.load(&account_a, &info.id).await.is_err());
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
