#![recursion_limit = "256"]

pub mod accounts;
pub mod auth;
pub mod commands;
pub mod media;
pub mod napcat;
mod private_fs;
pub mod providers;
pub mod remote;
pub mod remote_media;
pub mod state;
pub mod storage;
pub mod telegram_session;
pub mod web;

use std::sync::Arc;

pub use accounts::{AccountRegistry, RuntimeRole};
pub use auth::ClientCredential;
pub use state::{CoreConfig, CoreState};
use uuid::Uuid;
use web_bridge_protocol::{AccountSnapshot, Command, RouteMode};

#[derive(Clone)]
pub struct CoreRuntime {
    state: Arc<CoreState>,
}

impl CoreRuntime {
    pub fn new(role: RuntimeRole, config: CoreConfig) -> Self {
        Self {
            state: Arc::new(CoreState::new(role, config)),
        }
    }

    pub fn state(&self) -> Arc<CoreState> {
        Arc::clone(&self.state)
    }

    pub fn list_accounts(&self) -> Vec<AccountSnapshot> {
        self.state.accounts.list()
    }

    pub fn route_is_local(&self, route: RouteMode) -> bool {
        self.state.role.route_is_local(route)
    }

    pub async fn restore_local_sessions(&self) {
        providers::matrix::restore_sessions(Arc::clone(&self.state)).await;
        providers::telegram::restore_sessions(Arc::clone(&self.state)).await;
    }

    pub async fn connect_remote(
        &self,
        endpoint: &str,
        token: &str,
        device_id: String,
    ) -> anyhow::Result<()> {
        remote::ensure_client_role(&self.state)?;
        let bridge =
            remote::RemoteBridge::connect(Arc::clone(&self.state), endpoint, token, device_id)
                .await?;
        let mut remote = self
            .state
            .remote
            .lock()
            .map_err(|_| anyhow::anyhow!("remote bridge lock poisoned"))?;
        if let Some(previous) = remote.replace(bridge) {
            previous.close();
        }
        Ok(())
    }

    pub fn remote_command(&self, command: Command) -> anyhow::Result<Uuid> {
        remote::ensure_client_role(&self.state)?;
        let remote = self
            .state
            .remote
            .lock()
            .map_err(|_| anyhow::anyhow!("remote bridge lock poisoned"))?;
        remote
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("server is not connected"))?
            .command(command)
    }

    pub fn disconnect_remote(&self) -> anyhow::Result<()> {
        let mut remote = self
            .state
            .remote
            .lock()
            .map_err(|_| anyhow::anyhow!("remote bridge lock poisoned"))?;
        if let Some(bridge) = remote.take() {
            bridge.close();
        }
        Ok(())
    }
}

pub fn route_is_allowed(network: web_bridge_protocol::Network, route: RouteMode) -> bool {
    network.permits_route(route)
}
