use std::{path::Path, sync::Mutex};

use dashmap::DashMap;
use rusqlite::{Connection, params};
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
    db: Option<Mutex<Connection>>,
}

impl AccountRegistry {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS accounts (
                network TEXT NOT NULL,
                account_id TEXT NOT NULL,
                display_name TEXT,
                route TEXT NOT NULL,
                status TEXT NOT NULL,
                last_error TEXT,
                PRIMARY KEY (network, account_id)
            );",
        )?;

        let entries = DashMap::new();
        {
            let mut statement = connection.prepare(
                "SELECT network, account_id, display_name, route, status, last_error FROM accounts",
            )?;
            let rows = statement.query_map([], |row| {
                let network: String = row.get(0)?;
                let route: String = row.get(3)?;
                let status: String = row.get(4)?;
                Ok((
                    network,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    route,
                    status,
                    row.get::<_, Option<String>>(5)?,
                ))
            })?;

            for row in rows {
                let (network, account_id, display_name, route, _status, last_error) = row?;
                let Some(network) = parse_network(&network) else {
                    continue;
                };
                let Some(route) = parse_route(&route) else {
                    continue;
                };
                if !network.permits_route(route) {
                    continue;
                }
                let account = AccountRef {
                    network,
                    id: account_id,
                };
                entries.insert(
                    account.clone(),
                    AccountSnapshot {
                        account,
                        display_name,
                        route,
                        status: AccountStatus::Offline,
                        last_error,
                    },
                );
            }
        }

        Ok(Self {
            entries,
            db: Some(Mutex::new(connection)),
        })
    }

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
        self.persist_snapshot(&snapshot);
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
        let snapshot = entry.value().clone();
        drop(entry);
        self.persist_snapshot(&snapshot);
        Ok(snapshot)
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
        let snapshot = entry.value().clone();
        drop(entry);
        self.persist_snapshot(&snapshot);
        Some(snapshot)
    }

    pub fn remove(&self, account: &AccountRef) -> Option<AccountSnapshot> {
        let removed = self.entries.remove(account).map(|(_, snapshot)| snapshot);
        if removed.is_some()
            && let Some(db) = &self.db
            && let Ok(connection) = db.lock()
        {
            let _ = connection.execute(
                "DELETE FROM accounts WHERE network = ?1 AND account_id = ?2",
                params![network_name(account.network), account.id],
            );
        }
        removed
    }

    fn persist_snapshot(&self, snapshot: &AccountSnapshot) {
        let Some(db) = &self.db else {
            return;
        };
        let Ok(connection) = db.lock() else {
            return;
        };
        let _ = connection.execute(
            "INSERT INTO accounts (network, account_id, display_name, route, status, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(network, account_id) DO UPDATE SET
                 display_name = excluded.display_name,
                 route = excluded.route,
                 status = excluded.status,
                 last_error = excluded.last_error",
            params![
                network_name(snapshot.account.network),
                snapshot.account.id,
                snapshot.display_name,
                route_name(snapshot.route),
                status_name(snapshot.status),
                snapshot.last_error,
            ],
        );
    }
}

const fn network_order(network: Network) -> u8 {
    match network {
        Network::Qq => 0,
        Network::Matrix => 1,
        Network::Telegram => 2,
    }
}

const fn network_name(network: Network) -> &'static str {
    match network {
        Network::Qq => "qq",
        Network::Matrix => "matrix",
        Network::Telegram => "telegram",
    }
}

const fn route_name(route: RouteMode) -> &'static str {
    match route {
        RouteMode::Server => "server",
        RouteMode::Client => "client",
    }
}

const fn status_name(status: AccountStatus) -> &'static str {
    match status {
        AccountStatus::Offline => "offline",
        AccountStatus::Connecting => "connecting",
        AccountStatus::Online => "online",
        AccountStatus::Error => "error",
    }
}

fn parse_network(value: &str) -> Option<Network> {
    match value {
        "qq" => Some(Network::Qq),
        "matrix" => Some(Network::Matrix),
        "telegram" => Some(Network::Telegram),
        _ => None,
    }
}

fn parse_route(value: &str) -> Option<RouteMode> {
    match value {
        "server" => Some(RouteMode::Server),
        "client" => Some(RouteMode::Client),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

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

    #[test]
    fn persistent_registry_restores_accounts_as_offline() {
        let path = std::env::temp_dir().join(format!("web-bridge-accounts-{}.sqlite", Uuid::new_v4()));
        let account = AccountRef {
            network: Network::Matrix,
            id: "matrix-a".into(),
        };
        {
            let registry = AccountRegistry::open(&path).unwrap();
            registry
                .upsert(
                    account.clone(),
                    Some("Alice".into()),
                    RouteMode::Client,
                )
                .unwrap();
            registry
                .set_status(&account, AccountStatus::Online, None)
                .unwrap();
        }

        let restored = AccountRegistry::open(&path).unwrap();
        let snapshot = restored.get(&account).unwrap();
        assert_eq!(snapshot.route, RouteMode::Client);
        assert_eq!(snapshot.display_name.as_deref(), Some("Alice"));
        assert_eq!(snapshot.status, AccountStatus::Offline);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn persistent_registry_removal_does_not_return_after_restart() {
        let path = std::env::temp_dir().join(format!("web-bridge-accounts-{}.sqlite", Uuid::new_v4()));
        let account = AccountRef {
            network: Network::Telegram,
            id: "telegram-a".into(),
        };
        {
            let registry = AccountRegistry::open(&path).unwrap();
            registry
                .upsert(account.clone(), None, RouteMode::Server)
                .unwrap();
            assert!(registry.remove(&account).is_some());
        }
        let restored = AccountRegistry::open(&path).unwrap();
        assert!(restored.get(&account).is_none());
        let _ = std::fs::remove_file(path);
    }
}
