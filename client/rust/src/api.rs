use std::sync::{Mutex, OnceLock};

use tokio::sync::{OnceCell, broadcast};
use uuid::Uuid;
use web_bridge_core::{CoreConfig, CoreRuntime, RuntimeRole, commands};
use web_bridge_protocol::{AccountRef, Command, Network, PROTOCOL_VERSION, RouteMode, ServerFrame};

static RUNTIME: OnceLock<CoreRuntime> = OnceLock::new();
static EVENT_RECEIVER: OnceLock<Mutex<broadcast::Receiver<ServerFrame>>> = OnceLock::new();
static LOCAL_SESSION_RESTORE: OnceCell<()> = OnceCell::const_new();

fn runtime() -> &'static CoreRuntime {
    RUNTIME.get_or_init(|| CoreRuntime::new(RuntimeRole::Client, CoreConfig::default()))
}

fn event_receiver() -> &'static Mutex<broadcast::Receiver<ServerFrame>> {
    EVENT_RECEIVER.get_or_init(|| Mutex::new(runtime().state().events.subscribe()))
}

async fn ensure_local_sessions_restored() {
    LOCAL_SESSION_RESTORE
        .get_or_init(|| async {
            runtime().restore_local_sessions().await;
        })
        .await;
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

pub async fn connect_server(
    endpoint: String,
    token: String,
    device_id: String,
) -> Result<(), String> {
    ensure_local_sessions_restored().await;
    runtime()
        .connect_remote(&endpoint, &token, device_id)
        .await
        .map_err(|error| format!("{error:#}"))?;
    runtime()
        .remote_command(Command::ListAccounts)
        .map_err(|error| format!("{error:#}"))?;
    Ok(())
}

#[flutter_rust_bridge::frb(sync)]
pub fn disconnect_server() -> Result<(), String> {
    runtime()
        .disconnect_remote()
        .map_err(|error| format!("{error:#}"))
}

pub async fn execute_command_json(command_json: String) -> Result<String, String> {
    ensure_local_sessions_restored().await;
    let command: Command =
        serde_json::from_str(&command_json).map_err(|error| format!("invalid command: {error}"))?;
    let request_id = Uuid::new_v4();
    let route = command_route(&command)?;

    if route == Some(RouteMode::Server) {
        let request_id = runtime()
            .remote_command(command)
            .map_err(|error| format!("{error:#}"))?;
        return Ok(serde_json::json!({
            "request_id": request_id,
            "forwarded": true,
        })
        .to_string());
    }

    let frames = commands::execute(request_id, command, &runtime().state()).await;
    serde_json::to_string(&frames).map_err(|error| error.to_string())
}

#[flutter_rust_bridge::frb(sync)]
pub fn drain_events_json() -> Result<String, String> {
    let mut receiver = event_receiver()
        .lock()
        .map_err(|_| "event receiver lock poisoned".to_owned())?;
    let mut frames = Vec::new();
    loop {
        match receiver.try_recv() {
            Ok(frame) => frames.push(frame),
            Err(broadcast::error::TryRecvError::Empty) => break,
            Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                frames.push(ServerFrame::Error {
                    request_id: None,
                    code: "client_event_lagged".into(),
                    message: format!("client event consumer skipped {skipped} frames"),
                });
            }
            Err(broadcast::error::TryRecvError::Closed) => break,
        }
    }
    serde_json::to_string(&frames).map_err(|error| error.to_string())
}

#[flutter_rust_bridge::frb(sync)]
pub fn list_accounts_json() -> Result<String, String> {
    serde_json::to_string(&runtime().list_accounts()).map_err(|error| error.to_string())
}

fn command_route(command: &Command) -> Result<Option<RouteMode>, String> {
    let route = match command {
        Command::ListAccounts => return Ok(None),
        Command::RegisterAccount { route, .. }
        | Command::SetAccountRoute { route, .. }
        | Command::MatrixLoginPassword { route, .. }
        | Command::TelegramBeginLogin { route, .. }
        | Command::SendMessage { route, .. } => *route,
        Command::TelegramSubmitCode { account_id, .. }
        | Command::TelegramSubmitPassword { account_id, .. } => account_route(&AccountRef {
            network: Network::Telegram,
            id: account_id.clone(),
        })?,
        Command::RemoveAccount { account } | Command::DisconnectAccount { account } => {
            account_route(account)?
        }
    };
    Ok(Some(route))
}

fn account_route(account: &AccountRef) -> Result<RouteMode, String> {
    if account.network == Network::Qq {
        return Ok(RouteMode::Server);
    }
    runtime()
        .list_accounts()
        .into_iter()
        .find(|snapshot| snapshot.account == *account)
        .map(|snapshot| snapshot.route)
        .ok_or_else(|| {
            format!(
                "account {}:{} is not registered",
                network_name(account.network),
                account.id
            )
        })
}

fn network_name(network: Network) -> &'static str {
    match network {
        Network::Qq => "qq",
        Network::Matrix => "matrix",
        Network::Telegram => "telegram",
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
