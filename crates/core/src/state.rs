use std::{collections::HashMap, path::PathBuf, sync::Arc};

use dashmap::DashMap;
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::warn;
use web_bridge_protocol::{AccountRef, ServerFrame};

use crate::{
    accounts::{AccountRegistry, RuntimeRole},
    auth::ClientCredential,
    private_fs::{restrict_dir, restrict_file},
    providers::{matrix::MatrixHandle, telegram::TelegramHandle},
    remote::RemoteBridge,
    storage::MessageStore,
};

#[derive(Clone)]
pub struct CoreConfig {
    pub client_token: String,
    pub client_credentials: Vec<ClientCredential>,
    pub napcat_token: String,
    pub napcat_tokens: HashMap<String, String>,
    pub client_allowed_origins: Vec<String>,
    pub data_dir: PathBuf,
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            client_token: "dev-client-token".into(),
            client_credentials: Vec::new(),
            napcat_token: "dev-napcat-token".into(),
            napcat_tokens: HashMap::new(),
            client_allowed_origins: Vec::new(),
            data_dir: PathBuf::from("data"),
        }
    }
}

pub struct PendingQqAction {
    pub account: AccountRef,
    pub response: oneshot::Sender<Result<(), String>>,
}

pub struct CoreState {
    pub role: RuntimeRole,
    pub config: CoreConfig,
    pub events: broadcast::Sender<ServerFrame>,
    pub accounts: AccountRegistry,
    pub storage: MessageStore,
    /// QQ account -> reverse OneBot websocket writer.
    pub qq: DashMap<AccountRef, mpsc::UnboundedSender<String>>,
    /// OneBot echo -> command waiting for the actual NapCat action response.
    pub qq_pending: DashMap<String, PendingQqAction>,
    /// Matrix account -> independent SDK client and sync task.
    pub matrix: DashMap<AccountRef, Arc<MatrixHandle>>,
    /// Telegram account -> independent MTProto client/session/login state.
    pub telegram: DashMap<AccountRef, Arc<TelegramHandle>>,
    /// Client-mode connection to a remote web-bridge server.
    pub remote: std::sync::Mutex<Option<RemoteBridge>>,
}

impl CoreState {
    pub fn new(role: RuntimeRole, config: CoreConfig) -> Self {
        let (events, _) = broadcast::channel(4096);
        let (accounts, storage) = if cfg!(test) {
            (
                AccountRegistry::default(),
                MessageStore::memory().expect("open in-memory message store"),
            )
        } else {
            if let Err(error) = std::fs::create_dir_all(&config.data_dir) {
                warn!(%error, "failed to create core data directory");
            }
            if let Err(error) = restrict_dir(&config.data_dir) {
                warn!(%error, path = %config.data_dir.display(), "failed to restrict core data directory permissions");
            }

            let accounts_path = config.data_dir.join("accounts.sqlite");
            let accounts = match AccountRegistry::open(&accounts_path) {
                Ok(registry) => {
                    if let Err(error) = restrict_file(&accounts_path) {
                        warn!(%error, path = %accounts_path.display(), "failed to restrict account registry permissions");
                    }
                    registry
                }
                Err(error) => {
                    warn!(%error, "failed to open persistent account registry; using memory only");
                    AccountRegistry::default()
                }
            };

            let messages_path = config.data_dir.join("messages.sqlite");
            let storage = match MessageStore::open(&messages_path) {
                Ok(storage) => {
                    if let Err(error) = restrict_file(&messages_path) {
                        warn!(%error, path = %messages_path.display(), "failed to restrict message store permissions");
                    }
                    storage
                }
                Err(error) => {
                    warn!(%error, "failed to open persistent message store; using memory only");
                    MessageStore::memory().expect("open fallback in-memory message store")
                }
            };
            (accounts, storage)
        };
        Self {
            role,
            config,
            events,
            accounts,
            storage,
            qq: DashMap::new(),
            qq_pending: DashMap::new(),
            matrix: DashMap::new(),
            telegram: DashMap::new(),
            remote: std::sync::Mutex::new(None),
        }
    }

    pub fn account_data_dir(&self, account: &AccountRef) -> PathBuf {
        self.config
            .data_dir
            .join(format!("{:?}", account.network).to_lowercase())
            .join(safe_component(&account.id))
    }

    pub fn fail_qq_pending(&self, account: &AccountRef, reason: &str) {
        let echoes: Vec<_> = self
            .qq_pending
            .iter()
            .filter(|entry| &entry.value().account == account)
            .map(|entry| entry.key().clone())
            .collect();
        for echo in echoes {
            if let Some((_, pending)) = self.qq_pending.remove(&echo) {
                let _ = pending.response.send(Err(reason.to_owned()));
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands;
    use web_bridge_protocol::{AccountStatus, Network, RouteMode};

    fn qq(id: &str) -> AccountRef {
        AccountRef {
            network: Network::Qq,
            id: id.into(),
        }
    }

    #[tokio::test]
    async fn qq_pending_failures_are_scoped_to_one_account() {
        let state = CoreState::new(RuntimeRole::Server, CoreConfig::default());
        let account_a = qq("10001");
        let account_b = qq("10002");
        let (response_a, receive_a) = oneshot::channel();
        let (response_b, _receive_b) = oneshot::channel();
        state.qq_pending.insert(
            "echo-a".into(),
            PendingQqAction {
                account: account_a.clone(),
                response: response_a,
            },
        );
        state.qq_pending.insert(
            "echo-b".into(),
            PendingQqAction {
                account: account_b.clone(),
                response: response_b,
            },
        );

        state.fail_qq_pending(&account_a, "account A disconnected");

        assert!(!state.qq_pending.contains_key("echo-a"));
        assert!(state.qq_pending.contains_key("echo-b"));
        assert_eq!(
            receive_a.await.unwrap(),
            Err("account A disconnected".to_owned())
        );
    }

    #[tokio::test]
    async fn disconnecting_one_qq_account_keeps_the_other_online() {
        let state = CoreState::new(RuntimeRole::Server, CoreConfig::default());
        let account_a = qq("10001");
        let account_b = qq("10002");
        for account in [&account_a, &account_b] {
            state
                .accounts
                .upsert(account.clone(), None, RouteMode::Server)
                .unwrap();
            state
                .accounts
                .set_status(account, AccountStatus::Online, None)
                .unwrap();
        }
        let (sender_a, _receiver_a) = mpsc::unbounded_channel::<String>();
        let (sender_b, _receiver_b) = mpsc::unbounded_channel::<String>();
        state.qq.insert(account_a.clone(), sender_a);
        state.qq.insert(account_b.clone(), sender_b);

        commands::disconnect_provider(&state, &account_a).await;

        assert!(!state.qq.contains_key(&account_a));
        assert!(state.qq.contains_key(&account_b));
        assert_eq!(
            state.accounts.get(&account_a).unwrap().status,
            AccountStatus::Offline
        );
        assert_eq!(
            state.accounts.get(&account_b).unwrap().status,
            AccountStatus::Online
        );
    }
}
