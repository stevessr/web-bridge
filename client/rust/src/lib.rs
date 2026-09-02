use web_bridge_protocol::{Network, RouteMode};

/// Native-side policy check. UI code must not be able to accidentally add a
/// direct QQ route even if its Dart state becomes inconsistent.
#[flutter_rust_bridge::frb(sync)]
pub fn route_is_allowed(network: String, route: String) -> bool {
    let network = match network.as_str() {
        "qq" => Network::Qq,
        "matrix" => Network::Matrix,
        "telegram" => Network::Telegram,
        _ => return false,
    };
    let route = match route.as_str() {
        "server" => RouteMode::Server,
        "client" => RouteMode::Client,
        _ => return false,
    };
    network.permits_route(route)
}

#[flutter_rust_bridge::frb(sync)]
pub fn protocol_version() -> u16 {
    web_bridge_protocol::PROTOCOL_VERSION
}
