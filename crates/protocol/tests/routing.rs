use web_bridge_protocol::{Network, RouteMode};

#[test]
fn qq_is_server_only() {
    assert!(Network::Qq.permits_route(RouteMode::Server));
    assert!(!Network::Qq.permits_route(RouteMode::Client));
}

#[test]
fn matrix_and_telegram_can_be_owned_by_either_side() {
    for network in [Network::Matrix, Network::Telegram] {
        assert!(network.permits_route(RouteMode::Server));
        assert!(network.permits_route(RouteMode::Client));
    }
}
