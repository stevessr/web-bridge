#![recursion_limit = "256"]

pub mod accounts;
pub mod commands;
pub mod napcat;
pub mod providers;
pub mod remote;
pub mod state;
pub mod web;

use std::sync::Arc;

pub use accounts::{AccountRegistry, RuntimeRole};
pub use state::{CoreConfig, CoreState};
use uuid::Uuid;
use web_bridge_protocol::{AccountRef, AccountSnapshot, Command, RouteMode};

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

    pub fn register_account(
        &self,
        account: AccountRef,
        display_name: Option<String>,
        route: RouteMode,
    ) -> Result<AccountSnapshot, &'static str> {
        self.state.accounts.upsert(account, display_name, route)
    }

    pub fn set_account_route(
        &self,
        account: &AccountRef,
        route: RouteMode,
    ) -> Result<AccountSnapshot, &'static str> {
        self.state.accounts.set_route(account, route)
    }

    pub fn remove_account(&self, account: &AccountRef) -> Option<AccountSnapshot> {
        self.state.accounts.remove(account)
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
