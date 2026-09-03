use std::{path::Path, sync::{Mutex, OnceLock}};

use tokio::sync::{OnceCell, broadcast};
use uuid::Uuid;
use web_bridge_core::{
    CoreConfig, CoreRuntime, RuntimeRole, commands,
    media::{MAX_MEDIA_BYTES, MediaStore},
    remote_media::RemoteMediaClient,
};
use web_bridge_protocol::{AccountRef, Command, Network, PROTOCOL_VERSION, RouteMode, ServerFrame};

static RUNTIME: OnceLock<CoreRuntime> = OnceLock::new();
static EVENT_RECEIVER: OnceLock<Mutex<broadcast::Receiver<ServerFrame>>> = OnceLock::new();
static REMOTE_MEDIA: OnceLock<Mutex<Option<RemoteMediaClient>>> = OnceLock::new();
static LOCAL_SESSION_RESTORE: OnceCell<()> = OnceCell::const_new();

fn runtime() -> &'static CoreRuntime {
    RUNTIME.get_or_init(|| CoreRuntime::new(RuntimeRole::Client, CoreConfig::default()))
}

fn event_receiver() -> &'static Mutex<broadcast::Receiver<ServerFrame>> {
    EVENT_RECEIVER.get_or_init(|| Mutex::new(runtime().state().events.subscribe()))
}

fn remote_media() -> &'static Mutex<Option<RemoteMediaClient>> {
    REMOTE_MEDIA.get_or_init(|| Mutex::new(None))
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
    let media = RemoteMediaClient::new(&endpoint, &token, &device_id)
        .map_err(|error| format!("{error:#}"))?;
    runtime()
        .connect_remote(&endpoint, &token, device_id)
        .await
        .map_err(|error| format!("{error:#}"))?;
    *remote_media()
        .lock()
        .map_err(|_| "remote media client lock poisoned".to_owned())? = Some(media);
    Ok(())
}

#[flutter_rust_bridge::frb(sync)]
pub fn disconnect_server() -> Result<(), String> {
    *remote_media()
        .lock()
        .map_err(|_| "remote media client lock poisoned".to_owned())? = None;
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

pub async fn upload_media(
    network: String,
    account_id: String,
    route: String,
    path: String,
    filename: String,
    content_type: String,
) -> Result<String, String> {
    ensure_local_sessions_restored().await;
    let network = parse_network(&network).ok_or_else(|| "unsupported network".to_owned())?;
    let route = parse_route(&route).ok_or_else(|| "unsupported route".to_owned())?;
    if !web_bridge_core::route_is_allowed(network, route) {
        return Err("requested route is forbidden for this network".into());
    }
    let account = AccountRef {
        network,
        id: account_id,
    };
    let registered_route = account_route(&account)?;
    if registered_route != route {
        return Err("requested media route does not match the registered account route".into());
    }

    let source = Path::new(&path);
    let metadata = tokio::fs::metadata(source)
        .await
        .map_err(|error| format!("inspect attachment: {error}"))?;
    if !metadata.is_file() {
        return Err("attachment path is not a regular file".into());
    }
    if metadata.len() > MAX_MEDIA_BYTES as u64 {
        return Err(format!("attachment exceeds {MAX_MEDIA_BYTES} bytes"));
    }
    let bytes = tokio::fs::read(source)
        .await
        .map_err(|error| format!("read attachment: {error}"))?;
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(format!("attachment exceeds {MAX_MEDIA_BYTES} bytes"));
    }
    let name = if filename.trim().is_empty() {
        source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment")
            .to_owned()
    } else {
        filename
    };
    let content_type = if content_type.trim().is_empty() {
        mime_guess::from_path(&name)
            .first_or_octet_stream()
            .essence_str()
            .to_owned()
    } else {
        content_type
    };

    let info = match route {
        RouteMode::Client => runtime()
            .state()
            .media
            .store(&account, name, content_type, &bytes)
            .await
            .map_err(|error| format!("store local media: {error:#}"))?,
        RouteMode::Server => {
            let client = remote_media()
                .lock()
                .map_err(|_| "remote media client lock poisoned".to_owned())?
                .clone()
                .ok_or_else(|| "server media transport is not connected".to_owned())?;
            client
                .upload(&account, &name, &content_type, bytes)
                .await
                .map_err(|error| format!("{error:#}"))?
        }
    };

    Ok(serde_json::json!({
        "reference": MediaStore::reference(&info),
        "name": info.name,
        "content_type": info.content_type,
        "size": info.size,
    })
    .to_string())
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
        Command::RemoveAccount { account }
        | Command::DisconnectAccount { account }
        | Command::ListConversations { account, .. }
        | Command::ListMessages { account, .. }
        | Command::GetCursor { account, .. }
        | Command::SetCursor { account, .. } => account_route(account)?,
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
