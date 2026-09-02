use std::{path::PathBuf, sync::Arc};

use dashmap::DashMap;
use tokio::sync::{broadcast, mpsc};
use web_bridge_protocol::{AccountRef, ServerFrame};

use crate::{
    accounts::{AccountRegistry, RuntimeRole},
    providers::{matrix::MatrixHandle, telegram::TelegramHandle},
};

#[derive(Debug, Clone)]
pub struct CoreConfig {
    pub client_token: String,
    pub napcat_token: String,
    pub data_dir: PathBuf,
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            client_token: "dev-client-token".into(),
            napcat_token: "dev-napcat-token".into(),
            data_dir: PathBuf::from("data"),
        }
    }
}

pub struct CoreState {
    pub role: RuntimeRole,
    pub config: CoreConfig,
    pub events: broadcast::Sender<ServerFrame>,
    pub accounts: AccountRegistry,
    /// QQ account -> reverse OneBot websocket writer.
    pub qq: DashMap<AccountRef, mpsc::UnboundedSender<String>>,
    /// Matrix account -> independent SDK client and sync task.
    pub matrix: DashMap<AccountRef, Arc<MatrixHandle>>,
    /// Telegram account -> independent MTProto client/session/login state.
    pub telegram: DashMap<AccountRef, Arc<TelegramHandle>>,
}

impl CoreState {
    pub fn new(role: RuntimeRole, config: CoreConfig) -> Self {
        let (events, _) = broadcast::channel(4096);
        Self {
            role,
            config,
            events,
            accounts: AccountRegistry::default(),
            qq: DashMap::new(),
            matrix: DashMap::new(),
            telegram: DashMap::new(),
        }
    }

    pub fn account_data_dir(&self, account: &AccountRef) -> PathBuf {
        self.config
            .data_dir
            .join(format!("{:?}", account.network).to_lowercase())
            .join(safe_component(&account.id))
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
