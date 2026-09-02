use dashmap::DashMap;
use tokio::sync::{broadcast, mpsc};
use web_bridge_protocol::ServerFrame;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub client_token: String,
    pub napcat_token: String,
}

pub struct AppState {
    pub config: AppConfig,
    pub events: broadcast::Sender<ServerFrame>,
    /// QQ account self_id -> reverse OneBot websocket writer.
    pub qq: DashMap<String, mpsc::UnboundedSender<String>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let (events, _) = broadcast::channel(4096);
        Self { config, events, qq: DashMap::new() }
    }
}
