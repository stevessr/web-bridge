use anyhow::{Context, Result, bail};
use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue},
};
use serde::Deserialize;
use web_bridge_protocol::AccountRef;

use crate::media::{LoadedMedia, MAX_MEDIA_BYTES, MediaStore, StoredMediaInfo};

const DEVICE_HEADER: &str = "x-web-bridge-device-id";
const LEGACY_DEVICE_HEADER: &str = "x-device-id";
const FILE_NAME_HEADER: &str = "x-file-name";

#[derive(Clone)]
pub struct RemoteMediaClient {
    client: Client,
    media_root: Url,
    authorization: HeaderValue,
    device_id: HeaderValue,
}

#[derive(Deserialize)]
struct UploadResponse {
    reference: String,
    id: String,
    name: String,
    content_type: String,
    size: u64,
}

impl RemoteMediaClient {
    pub fn new(endpoint: &str, token: &str, device_id: &str) -> Result<Self> {
        if token.is_empty() {
            bail!("remote media transport requires a non-empty bearer token");
        }
        if device_id.is_empty() {
            bail!("remote media transport requires a non-empty device id");
        }

        let media_root = media_root(endpoint)?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .context("build remote media authorization header")?;
        authorization.set_sensitive(true);
        let device_id = HeaderValue::from_str(device_id).context("build remote media device header")?;

        Ok(Self {
            client: Client::new(),
            media_root,
            authorization,
            device_id,
        })
    }

    pub async fn upload(
        &self,
        account: &AccountRef,
        name: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<StoredMediaInfo> {
        if bytes.len() > MAX_MEDIA_BYTES {
            bail!("media object exceeds {MAX_MEDIA_BYTES} bytes");
        }
        let url = self.account_url(account)?;
        let response = self
            .client
            .post(url)
            .header(AUTHORIZATION, self.authorization.clone())
            .header(DEVICE_HEADER, self.device_id.clone())
            .header(LEGACY_DEVICE_HEADER, self.device_id.clone())
            .header(FILE_NAME_HEADER, name)
            .header(CONTENT_TYPE, content_type)
            .body(bytes)
            .send()
            .await
            .context("upload media to web-bridge server")?
            .error_for_status()
            .context("web-bridge server rejected media upload")?;
        let uploaded: UploadResponse = response
            .json()
            .await
            .context("decode web-bridge media upload response")?;
        let parsed_id = MediaStore::parse_reference(&uploaded.reference)
            .context("server returned an invalid media reference")?;
        if parsed_id != uploaded.id {
            bail!("server media response id does not match its media reference");
        }
        if uploaded.size > MAX_MEDIA_BYTES as u64 {
            bail!("server returned oversized media metadata");
        }
        Ok(StoredMediaInfo {
            id: uploaded.id,
            name: uploaded.name,
            content_type: uploaded.content_type,
            size: uploaded.size,
        })
    }

    pub async fn download(&self, account: &AccountRef, reference: &str) -> Result<LoadedMedia> {
        let id = MediaStore::parse_reference(reference).context("invalid media reference")?;
        let url = self.media_url(account, &id)?;
        let response = self
            .client
            .get(url)
            .header(AUTHORIZATION, self.authorization.clone())
            .header(DEVICE_HEADER, self.device_id.clone())
            .header(LEGACY_DEVICE_HEADER, self.device_id.clone())
            .send()
            .await
            .context("download media from web-bridge server")?
            .error_for_status()
            .context("web-bridge server rejected media download")?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_MEDIA_BYTES as u64)
        {
            bail!("remote media object exceeds {MAX_MEDIA_BYTES} bytes");
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let name = response
            .headers()
            .get(FILE_NAME_HEADER)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("attachment")
            .to_owned();
        let bytes = response
            .bytes()
            .await
            .context("read remote media response body")?;
        if bytes.len() > MAX_MEDIA_BYTES {
            bail!("remote media object exceeds {MAX_MEDIA_BYTES} bytes");
        }
        Ok(LoadedMedia {
            info: StoredMediaInfo {
                id,
                name,
                content_type,
                size: bytes.len() as u64,
            },
            bytes: bytes.to_vec(),
        })
    }

    fn account_url(&self, account: &AccountRef) -> Result<Url> {
        let mut url = self.media_root.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| anyhow::anyhow!("remote media URL cannot be used as a base URL"))?;
            segments
                .push(network_name(account))
                .push(account.id.as_str());
        }
        Ok(url)
    }

    fn media_url(&self, account: &AccountRef, media_id: &str) -> Result<Url> {
        let mut url = self.account_url(account)?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("remote media URL cannot be used as a base URL"))?
            .push(media_id);
        Ok(url)
    }
}

fn media_root(endpoint: &str) -> Result<Url> {
    let mut url = Url::parse(endpoint).context("parse remote websocket endpoint")?;
    match url.scheme() {
        "ws" => url
            .set_scheme("http")
            .map_err(|_| anyhow::anyhow!("failed to derive HTTP media endpoint"))?,
        "wss" => url
            .set_scheme("https")
            .map_err(|_| anyhow::anyhow!("failed to derive HTTPS media endpoint"))?,
        other => bail!("unsupported remote websocket scheme: {other}"),
    }
    url.set_query(None);
    url.set_fragment(None);

    let mut segments: Vec<_> = url
        .path_segments()
        .context("remote websocket endpoint cannot be a base URL")?
        .filter(|segment| !segment.is_empty())
        .map(str::to_owned)
        .collect();
    if segments.len() < 2 || segments[segments.len() - 2..] != ["v1", "ws"] {
        bail!("remote websocket endpoint path must end in /v1/ws");
    }
    segments.truncate(segments.len() - 2);
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("remote websocket endpoint cannot be a base URL"))?;
        path.clear();
        for segment in segments {
            path.push(&segment);
        }
        path.push("v1").push("media");
    }
    Ok(url)
}

fn network_name(account: &AccountRef) -> &'static str {
    match account.network {
        web_bridge_protocol::Network::Qq => "qq",
        web_bridge_protocol::Network::Matrix => "matrix",
        web_bridge_protocol::Network::Telegram => "telegram",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_bridge_protocol::Network;

    #[test]
    fn derives_http_media_endpoint_without_leaking_token() {
        let client = RemoteMediaClient::new(
            "wss://bridge.example/prefix/v1/ws?transport=native",
            "super-secret",
            "device-a",
        )
        .unwrap();
        let account = AccountRef {
            network: Network::Telegram,
            id: "account with space".into(),
        };
        let url = client.account_url(&account).unwrap();
        assert_eq!(
            url.as_str(),
            "https://bridge.example/prefix/v1/media/telegram/account%20with%20space"
        );
        assert!(!url.as_str().contains("super-secret"));
        assert_eq!(client.authorization, "Bearer super-secret");
        assert!(client.authorization.is_sensitive());
    }

    #[test]
    fn ws_maps_to_http_and_rejects_unexpected_path() {
        assert_eq!(
            media_root("ws://127.0.0.1:8787/v1/ws")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8787/v1/media"
        );
        assert!(media_root("https://bridge.example/v1/ws").is_err());
        assert!(media_root("wss://bridge.example/socket").is_err());
    }
}
