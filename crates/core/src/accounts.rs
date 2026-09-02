use dashmap::DashMap;
use web_bridge_protocol::{AccountRef, AccountSnapshot, AccountStatus, Network, RouteMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeRole {
    Server,
    Client,
}

impl RuntimeRole {
    pub const fn local_route(self) -> RouteMode {
        match self {
            Self::Server => RouteMode::Server,
            Self::Client => RouteMode::Client,
        }
    }

    pub const fn route_is_local(self, route: RouteMode) -> bool {
        matches!(
            (self, route),
            (Self::Server, RouteMode::Server) | (Self::Client, RouteMode::Client)
        )
    }
}

#[derive(Default)]
pub struct AccountRegistry {
    entries: DashMap<AccountRef, AccountSnapshot>,
}

impl AccountRegistry {
    pub fn list(&self) -> Vec<AccountSnapshot> {
        let mut accounts: Vec<_> = self
            .entries
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        accounts.sort_by(|a, b| {
            network_order(a.account.network)
                .cmp(&network_order(b.account.network))
                .then_with(|| a.account.id.cmp(&b.account.id))
        });
        accounts
    }

    pub fn get(&self, account: &AccountRef) -> Option<AccountSnapshot> {
        self.entries.get(account).map(|entry| entry.value().clone())
    }

    pub fn upsert(
        &self,
        account: AccountRef,
        display_name: Option<String>,
        route: RouteMode,
    ) -> Result<AccountSnapshot, &'static str> {
        if !account.network.permits_route(route) {
            return Err("QQ accounts must use server routing");
        }

        let previous = self.get(&account);
        let snapshot = AccountSnapshot {
            account: account.clone(),
            display_name: display_name
                .or_else(|| previous.as_ref().and_then(|item| item.display_name.clone())),
            route,
            status: previous
                .as_ref()
                .map(|item| item.status)
                .unwrap_or(AccountStatus::Offline),
            last_error: previous.and_then(|item| item.last_error),
        };
        self.entries.insert(account, snapshot.clone());
        Ok(snapshot)
    }

    pub fn set_route(
        &self,
        account: &AccountRef,
        route: RouteMode,
    ) -> Result<AccountSnapshot, &'static str> {
        if !account.network.permits_route(route) {
            return Err("QQ accounts must use server routing");
        }
        let Some(mut entry) = self.entries.get_mut(account) else {
            return Err("account not found");
        };
        entry.route = route;
        Ok(entry.value().clone())
    }

    pub fn set_status(
        &self,
        account: &AccountRef,
        status: AccountStatus,
        error: Option<String>,
    ) -> Option<AccountSnapshot> {
        let mut entry = self.entries.get_mut(account)?;
        entry.status = status;
        entry.last_error = error;
        Some(entry.value().clone())
    }

    pub fn remove(&self, account: &AccountRef) -> Option<AccountSnapshot> {
        self.entries.remove(account).map(|(_, snapshot)| snapshot)
    }
}

const fn network_order(network: Network) -> u8 {
    match network {
        Network::Qq => 0,
        Network::Matrix => 1,
        Network::Telegram => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_keeps_multiple_accounts_per_network() {
        let registry = AccountRegistry::default();
        for id in ["10001", "10002"] {
            registry
                .upsert(
                    AccountRef {
                        network: Network::Qq,
                        id: id.into(),
                    },
                    None,
                    RouteMode::Server,
                )
                .unwrap();
        }
        assert_eq!(registry.list().len(), 2);
    }

    #[test]
    fn all_networks_can_have_multiple_accounts() {
        let registry = AccountRegistry::default();
        for network in [Network::Qq, Network::Matrix, Network::Telegram] {
            for suffix in ["a", "b"] {
                let route = if network == Network::Qq {
                    RouteMode::Server
                } else {
                    RouteMode::Client
                };
                registry
                    .upsert(
                        AccountRef {
                            network,
                            id: suffix.into(),
                        },
                        None,
                        route,
                    )
                    .unwrap();
            }
        }
        assert_eq!(registry.list().len(), 6);
    }

    #[test]
    fn qq_cannot_be_changed_to_client_route() {
        let registry = AccountRegistry::default();
        let account = AccountRef {
            network: Network::Qq,
            id: "10001".into(),
        };
        registry
            .upsert(account.clone(), None, RouteMode::Server)
            .unwrap();
        assert!(registry.set_route(&account, RouteMode::Client).is_err());
    }
}
