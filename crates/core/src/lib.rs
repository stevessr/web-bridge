pub mod accounts;
pub mod napcat;
pub mod state;
pub mod web;

use std::sync::Arc;

pub use accounts::{AccountRegistry, RuntimeRole};
pub use state::{CoreConfig, CoreState};
use web_bridge_protocol::{AccountRef, AccountSnapshot, RouteMode};

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
}

pub fn route_is_allowed(network: web_bridge_protocol::Network, route: RouteMode) -> bool {
    network.permits_route(route)
}
