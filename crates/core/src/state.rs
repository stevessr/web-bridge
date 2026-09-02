use dashmap::DashMap;
use tokio::sync::{broadcast, mpsc};
use web_bridge_protocol::{AccountRef, ServerFrame};

use crate::accounts::{AccountRegistry, RuntimeRole};

#[derive(Debug, Clone)]
pub struct CoreConfig {
    pub client_token: String,
    pub napcat_token: String,
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            client_token: "dev-client-token".into(),
            napcat_token: "dev-napcat-token".into(),
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
        }
    }
}
