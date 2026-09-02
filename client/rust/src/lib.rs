use std::sync::OnceLock;

use web_bridge_core::{CoreConfig, CoreRuntime, RuntimeRole};
use web_bridge_protocol::{AccountRef, Network, PROTOCOL_VERSION, RouteMode};

static RUNTIME: OnceLock<CoreRuntime> = OnceLock::new();

fn runtime() -> &'static CoreRuntime {
    RUNTIME.get_or_init(|| CoreRuntime::new(RuntimeRole::Client, CoreConfig::default()))
}

#[flutter_rust_bridge::frb(sync)]
pub fn protocol_version() -> u16 {
    PROTOCOL_VERSION
}

#[flutter_rust_bridge::frb(sync)]
pub fn route_is_allowed(network: String, route: String) -> bool {
    parse_network(&network)
        .zip(parse_route(&route))
        .is_some_and(|(network, route)| web_bridge_core::route_is_allowed(network, route))
}

#[flutter_rust_bridge::frb(sync)]
pub fn register_account(
    network: String,
    account_id: String,
    display_name: Option<String>,
    route: String,
) -> Result<String, String> {
    let network = parse_network(&network).ok_or_else(|| "unknown network".to_owned())?;
    let route = parse_route(&route).ok_or_else(|| "unknown route".to_owned())?;
    let snapshot = runtime()
        .register_account(
            AccountRef {
                network,
                id: account_id,
            },
            display_name,
            route,
        )
        .map_err(str::to_owned)?;
    serde_json::to_string(&snapshot).map_err(|error| error.to_string())
}

#[flutter_rust_bridge::frb(sync)]
pub fn set_account_route(
    network: String,
    account_id: String,
    route: String,
) -> Result<String, String> {
    let network = parse_network(&network).ok_or_else(|| "unknown network".to_owned())?;
    let route = parse_route(&route).ok_or_else(|| "unknown route".to_owned())?;
    let snapshot = runtime()
        .set_account_route(
            &AccountRef {
                network,
                id: account_id,
            },
            route,
        )
        .map_err(str::to_owned)?;
    serde_json::to_string(&snapshot).map_err(|error| error.to_string())
}

#[flutter_rust_bridge::frb(sync)]
pub fn remove_account(network: String, account_id: String) -> bool {
    let Some(network) = parse_network(&network) else {
        return false;
    };
    runtime()
        .remove_account(&AccountRef {
            network,
            id: account_id,
        })
        .is_some()
}

#[flutter_rust_bridge::frb(sync)]
pub fn list_accounts_json() -> Result<String, String> {
    serde_json::to_string(&runtime().list_accounts()).map_err(|error| error.to_string())
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
