use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use tokio::{net::TcpStream, sync::mpsc, task::AbortHandle, time::sleep};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        handshake::client::Request,
        http::{HeaderValue, header::AUTHORIZATION},
    },
};
use uuid::Uuid;
use web_bridge_protocol::{
    AccountRef, AccountSnapshot, ClientFrame, Command, Network, PROTOCOL_VERSION, RouteMode,
    ServerFrame,
};

use crate::state::CoreState;

const RECONNECT_INITIAL: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);

type RemoteSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone)]
struct PendingRemoteRequest {
    operation: &'static str,
    account: Option<AccountRef>,
}

impl PendingRemoteRequest {
    fn from_command(command: &Command) -> Self {
        match command {
            Command::ListAccounts => Self::new("list accounts", None),
            Command::RegisterAccount { account, .. } => {
                Self::new("register account", Some(account.clone()))
            }
            Command::RemoveAccount { account } => {
                Self::new("remove account", Some(account.clone()))
            }
            Command::SetAccountRoute { account, .. } => {
                Self::new("change account route", Some(account.clone()))
            }
            Command::MatrixLoginPassword { account_id, .. } => Self::new(
                "Matrix login",
                Some(AccountRef {
                    network: Network::Matrix,
                    id: account_id.clone(),
                }),
            ),
            Command::TelegramBeginLogin { account_id, .. } => Self::new(
                "Telegram login",
                Some(AccountRef {
                    network: Network::Telegram,
                    id: account_id.clone(),
                }),
            ),
            Command::TelegramSubmitCode { account_id, .. } => Self::new(
                "Telegram code verification",
                Some(AccountRef {
                    network: Network::Telegram,
                    id: account_id.clone(),
                }),
            ),
            Command::TelegramSubmitPassword { account_id, .. } => Self::new(
                "Telegram 2FA",
                Some(AccountRef {
                    network: Network::Telegram,
                    id: account_id.clone(),
                }),
            ),
            Command::DisconnectAccount { account } => {
                Self::new("disconnect account", Some(account.clone()))
            }
            Command::SendMessage { account, .. } => {
                Self::new("send message", Some(account.clone()))
            }
            Command::ListConversations { account, .. } => {
                Self::new("list conversations", Some(account.clone()))
            }
            Command::ListMessages { account, .. } => {
                Self::new("list messages", Some(account.clone()))
            }
            Command::GetCursor { account, .. } => {
                Self::new("read sync cursor", Some(account.clone()))
            }
            Command::SetCursor { account, .. } => {
                Self::new("write sync cursor", Some(account.clone()))
            }
        }
    }

    fn new(operation: &'static str, account: Option<AccountRef>) -> Self {
        Self { operation, account }
    }

    fn context(&self) -> String {
        match &self.account {
            Some(account) => format!(
                "{} for {}:{}",
                self.operation,
                network_name(account.network),
                account.id
            ),
            None => self.operation.to_owned(),
        }
    }
}

pub struct RemoteBridge {
    outgoing: mpsc::UnboundedSender<ClientFrame>,
    task: AbortHandle,
    connected: Arc<AtomicBool>,
    pending: Arc<DashMap<Uuid, PendingRemoteRequest>>,
}

impl RemoteBridge {
    pub async fn connect(
        state: Arc<CoreState>,
        endpoint: &str,
        token: &str,
        device_id: String,
    ) -> Result<Self> {
        let request = connection_request(endpoint, token)?;
        let (initial_socket, _) = connect_async(request)
            .await
            .with_context(|| format!("connect web-bridge server at {endpoint}"))?;
        let (outgoing, outbound) = mpsc::unbounded_channel::<ClientFrame>();
        let connected = Arc::new(AtomicBool::new(true));
        let pending = Arc::new(DashMap::new());

        let task_connected = Arc::clone(&connected);
        let task_pending = Arc::clone(&pending);
        let task = tokio::spawn(run_remote_manager(
            state,
            endpoint.to_owned(),
            token.to_owned(),
            device_id,
            initial_socket,
            outbound,
            task_connected,
            task_pending,
        ));

        Ok(Self {
            outgoing,
            task: task.abort_handle(),
            connected,
            pending,
        })
    }

    pub fn command(&self, command: Command) -> Result<Uuid> {
        if !self.connected.load(Ordering::Acquire) {
            bail!("server connection is reconnecting");
        }

        let request_id = Uuid::new_v4();
        self.pending
            .insert(request_id, PendingRemoteRequest::from_command(&command));
        if self
            .outgoing
            .send(ClientFrame::Command {
                request_id,
                command,
            })
            .is_err()
        {
            self.pending.remove(&request_id);
            bail!("server connection is closed");
        }
        Ok(request_id)
    }

    pub fn ping(&self, nonce: String) -> Result<()> {
        if !self.connected.load(Ordering::Acquire) {
            bail!("server connection is reconnecting");
        }
        self.outgoing
            .send(ClientFrame::Ping { nonce })
            .map_err(|_| anyhow::anyhow!("server connection is closed"))
    }

    pub fn close(&self) {
        self.connected.store(false, Ordering::Release);
        self.task.abort();
    }
}

async fn run_remote_manager(
    state: Arc<CoreState>,
    endpoint: String,
    token: String,
    device_id: String,
    initial_socket: RemoteSocket,
    mut outbound: mpsc::UnboundedReceiver<ClientFrame>,
    connected: Arc<AtomicBool>,
    pending: Arc<DashMap<Uuid, PendingRemoteRequest>>,
) {
    let mut socket = Some(initial_socket);
    let mut reconnect_delay = RECONNECT_INITIAL;

    loop {
        let current = match socket.take() {
            Some(socket) => socket,
            None => {
                sleep(reconnect_delay).await;
                let request = match connection_request(&endpoint, &token) {
                    Ok(request) => request,
                    Err(error) => {
                        connected.store(false, Ordering::Release);
                        let _ = state.events.send(ServerFrame::Error {
                            request_id: None,
                            code: "remote_reconnect_failed".into(),
                            message: format!(
                                "server reconnect request failed; retrying in {}s: {error:#}",
                                next_backoff(reconnect_delay).as_secs()
                            ),
                        });
                        reconnect_delay = next_backoff(reconnect_delay);
                        continue;
                    }
                };
                match connect_async(request).await {
                    Ok((socket, _)) => socket,
                    Err(error) => {
                        connected.store(false, Ordering::Release);
                        let _ = state.events.send(ServerFrame::Error {
                            request_id: None,
                            code: "remote_reconnect_failed".into(),
                            message: format!(
                                "server reconnect failed; retrying in {}s: {error}",
                                next_backoff(reconnect_delay).as_secs()
                            ),
                        });
                        reconnect_delay = next_backoff(reconnect_delay);
                        continue;
                    }
                }
            }
        };

        connected.store(true, Ordering::Release);
        let result = run_connection(&state, current, &device_id, &mut outbound, &pending).await;

        connected.store(false, Ordering::Release);
        fail_pending_requests(&state, &pending, "server connection was interrupted");
        let message = match result {
            Ok(()) => "server connection closed; reconnecting automatically".to_owned(),
            Err(error) => format!("server connection lost; reconnecting automatically: {error:#}"),
        };
        let _ = state.events.send(ServerFrame::Error {
            request_id: None,
            code: "remote_disconnected".into(),
            message,
        });
        reconnect_delay = RECONNECT_INITIAL;
    }
}

async fn run_connection(
    state: &CoreState,
    socket: RemoteSocket,
    device_id: &str,
    outbound: &mut mpsc::UnboundedReceiver<ClientFrame>,
    pending: &DashMap<Uuid, PendingRemoteRequest>,
) -> Result<()> {
    let (mut sink, mut stream) = socket.split();
    send_client_frame(
        &mut sink,
        &ClientFrame::Hello {
            protocol: PROTOCOL_VERSION,
            device_id: device_id.to_owned(),
        },
    )
    .await
    .context("send server hello")?;
    send_client_frame(
        &mut sink,
        &ClientFrame::Command {
            request_id: Uuid::new_v4(),
            command: Command::ListAccounts,
        },
    )
    .await
    .context("request full account snapshot")?;

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(message) = incoming else {
                    return Ok(());
                };
                let message = message.context("read server websocket")?;
                let Message::Text(text) = message else { continue };
                match serde_json::from_str::<ServerFrame>(&text) {
                    Ok(frame) => apply_server_frame(state, pending, frame),
                    Err(error) => {
                        let _ = state.events.send(ServerFrame::Error {
                            request_id: None,
                            code: "remote_invalid_frame".into(),
                            message: error.to_string(),
                        });
                    }
                }
            }
            frame = outbound.recv() => {
                let Some(frame) = frame else {
                    return Ok(());
                };
                if let ClientFrame::Command { request_id, .. } = &frame
                    && !pending.contains_key(request_id)
                {
                    continue;
                }
                send_client_frame(&mut sink, &frame)
                    .await
                    .context("send server websocket frame")?;
            }
        }
    }
}

async fn send_client_frame<S>(sink: &mut S, frame: &ClientFrame) -> Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let text = serde_json::to_string(frame).context("serialize client frame")?;
    sink.send(Message::Text(text.into()))
        .await
        .context("write client frame")
}

fn apply_server_frame(
    state: &CoreState,
    pending: &DashMap<Uuid, PendingRemoteRequest>,
    mut frame: ServerFrame,
) {
    match &mut frame {
        ServerFrame::Ready { protocol } if *protocol != PROTOCOL_VERSION => {
            let _ = state.events.send(ServerFrame::Error {
                request_id: None,
                code: "protocol_mismatch".into(),
                message: format!(
                    "remote protocol is {protocol}, client protocol is {PROTOCOL_VERSION}"
                ),
            });
            return;
        }
        ServerFrame::Accounts {
            request_id,
            accounts,
        } => {
            reconcile_server_accounts(state, accounts);
            if let Some(request_id) = request_id {
                pending.remove(request_id);
            }
        }
        ServerFrame::AccountChanged { account } => mirror_account(state, account),
        ServerFrame::AccountRemoved { account } => remove_server_mirror(state, account),
        ServerFrame::Conversations { request_id, .. }
        | ServerFrame::Messages { request_id, .. }
        | ServerFrame::Cursor { request_id, .. }
        | ServerFrame::Ack { request_id } => {
            pending.remove(request_id);
        }
        ServerFrame::Error {
            request_id: Some(request_id),
            message,
            ..
        } => {
            if let Some((_, metadata)) = pending.remove(request_id) {
                *message = format!("{} failed: {message}", metadata.context());
            }
        }
        ServerFrame::AuthChallenge {
            request_id: Some(request_id),
            account,
            ..
        } => {
            if let Some(metadata) = pending.get(request_id)
                && let Some(expected) = &metadata.account
                && expected != account
            {
                let _ = state.events.send(ServerFrame::Error {
                    request_id: Some(request_id.to_owned()),
                    code: "remote_request_mismatch".into(),
                    message: format!(
                        "{} returned an auth challenge for {}:{}",
                        metadata.context(),
                        network_name(account.network),
                        account.id
                    ),
                });
            }
        }
        _ => {}
    }
    let _ = state.events.send(frame);
}

fn fail_pending_requests(
    state: &CoreState,
    pending: &DashMap<Uuid, PendingRemoteRequest>,
    reason: &str,
) {
    let requests: Vec<_> = pending
        .iter()
        .map(|entry| (entry.key().to_owned(), entry.value().clone()))
        .collect();
    for (request_id, metadata) in requests {
        if pending.remove(&request_id).is_some() {
            let _ = state.events.send(ServerFrame::Error {
                request_id: Some(request_id),
                code: "remote_request_interrupted".into(),
                message: format!("{} failed: {reason}", metadata.context()),
            });
        }
    }
}

fn reconcile_server_accounts(state: &CoreState, accounts: &[AccountSnapshot]) {
    let remote_accounts: HashSet<_> = accounts
        .iter()
        .filter(|snapshot| snapshot.route == RouteMode::Server)
        .map(|snapshot| snapshot.account.clone())
        .collect();

    for snapshot in accounts {
        mirror_account(state, snapshot);
    }

    let stale_accounts: Vec<_> = state
        .accounts
        .list()
        .into_iter()
        .filter(|snapshot| {
            snapshot.route == RouteMode::Server && !remote_accounts.contains(&snapshot.account)
        })
        .map(|snapshot| snapshot.account)
        .collect();

    for account in stale_accounts {
        remove_server_mirror(state, &account);
    }
}

fn remove_server_mirror(state: &CoreState, account: &AccountRef) {
    if state
        .accounts
        .get(account)
        .is_some_and(|snapshot| snapshot.route == RouteMode::Server)
    {
        state.accounts.remove(account);
    }
}

fn mirror_account(state: &CoreState, snapshot: &AccountSnapshot) {
    if snapshot.route != RouteMode::Server {
        return;
    }
    if state
        .accounts
        .get(&snapshot.account)
        .is_some_and(|current| current.route == RouteMode::Client)
    {
        return;
    }
    let Ok(_) = state.accounts.upsert(
        snapshot.account.clone(),
        snapshot.display_name.clone(),
        snapshot.route,
    ) else {
        return;
    };
    let _ = state.accounts.set_status(
        &snapshot.account,
        snapshot.status,
        snapshot.last_error.clone(),
    );
}

fn next_backoff(current: Duration) -> Duration {
    current.saturating_mul(2).min(RECONNECT_MAX)
}

fn connection_request(endpoint: &str, token: &str) -> Result<Request> {
    let mut request = endpoint
        .into_client_request()
        .context("build server websocket request")?;
    if !token.is_empty() {
        let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
            .context("build server authorization header")?;
        value.set_sensitive(true);
        request.headers_mut().insert(AUTHORIZATION, value);
    }
    Ok(request)
}

fn network_name(network: Network) -> &'static str {
    match network {
        Network::Qq => "qq",
        Network::Matrix => "matrix",
        Network::Telegram => "telegram",
    }
}

pub fn ensure_client_role(state: &CoreState) -> Result<()> {
    if state.role != crate::accounts::RuntimeRole::Client {
        bail!("remote server bridge is only valid in client runtime mode");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts::RuntimeRole, state::CoreConfig};
    use web_bridge_protocol::AccountStatus;

    fn client_state() -> CoreState {
        CoreState::new(RuntimeRole::Client, CoreConfig::default())
    }

    fn account(network: Network, id: &str) -> AccountRef {
        AccountRef {
            network,
            id: id.into(),
        }
    }

    fn snapshot(network: Network, id: &str, route: RouteMode) -> AccountSnapshot {
        AccountSnapshot {
            account: account(network, id),
            display_name: Some(format!("{id} display")),
            route,
            status: AccountStatus::Online,
            last_error: None,
        }
    }

    #[test]
    fn websocket_auth_uses_sensitive_header_not_query() {
        let request = connection_request(
            "wss://bridge.example/v1/ws?transport=native",
            "do-not-put-me-in-the-url",
        )
        .unwrap();
        assert_eq!(
            request.uri().to_string(),
            "wss://bridge.example/v1/ws?transport=native"
        );
        assert_eq!(
            request.headers().get(AUTHORIZATION).unwrap(),
            "Bearer do-not-put-me-in-the-url"
        );
        assert!(request.headers().get(AUTHORIZATION).unwrap().is_sensitive());
        assert!(
            !request
                .uri()
                .to_string()
                .contains("do-not-put-me-in-the-url")
        );
    }

    #[test]
    fn full_snapshot_removes_stale_server_mirror() {
        let state = client_state();
        let keep = account(Network::Matrix, "keep");
        let stale = account(Network::Matrix, "stale");
        state
            .accounts
            .upsert(keep.clone(), None, RouteMode::Server)
            .unwrap();
        state
            .accounts
            .upsert(stale.clone(), None, RouteMode::Server)
            .unwrap();

        apply_server_frame(
            &state,
            &DashMap::new(),
            ServerFrame::Accounts {
                request_id: None,
                accounts: vec![snapshot(Network::Matrix, "keep", RouteMode::Server)],
            },
        );

        assert_eq!(
            state.accounts.get(&keep).map(|item| item.route),
            Some(RouteMode::Server)
        );
        assert!(state.accounts.get(&stale).is_none());
    }

    #[test]
    fn full_snapshot_keeps_client_owned_account() {
        let state = client_state();
        let local = account(Network::Telegram, "local");
        state
            .accounts
            .upsert(local.clone(), None, RouteMode::Client)
            .unwrap();

        apply_server_frame(
            &state,
            &DashMap::new(),
            ServerFrame::Accounts {
                request_id: None,
                accounts: Vec::new(),
            },
        );

        assert_eq!(
            state.accounts.get(&local).map(|item| item.route),
            Some(RouteMode::Client)
        );
    }

    #[test]
    fn late_account_removed_does_not_delete_client_owned_account() {
        let state = client_state();
        let switched = account(Network::Matrix, "switched");
        state
            .accounts
            .upsert(switched.clone(), None, RouteMode::Server)
            .unwrap();
        state
            .accounts
            .set_route(&switched, RouteMode::Client)
            .unwrap();

        apply_server_frame(
            &state,
            &DashMap::new(),
            ServerFrame::AccountRemoved {
                account: switched.clone(),
            },
        );

        assert_eq!(
            state.accounts.get(&switched).map(|item| item.route),
            Some(RouteMode::Client)
        );
    }

    #[test]
    fn late_account_changed_does_not_take_client_ownership() {
        let state = client_state();
        let switched = account(Network::Telegram, "switched");
        state
            .accounts
            .upsert(switched.clone(), Some("local".into()), RouteMode::Client)
            .unwrap();

        apply_server_frame(
            &state,
            &DashMap::new(),
            ServerFrame::AccountChanged {
                account: snapshot(Network::Telegram, "switched", RouteMode::Server),
            },
        );

        let current = state.accounts.get(&switched).unwrap();
        assert_eq!(current.route, RouteMode::Client);
        assert_eq!(current.display_name.as_deref(), Some("local"));
    }

    #[test]
    fn qq_server_mirrors_are_reconciled() {
        let state = client_state();
        let old = account(Network::Qq, "10001");
        let current = account(Network::Qq, "10002");
        state
            .accounts
            .upsert(old.clone(), None, RouteMode::Server)
            .unwrap();

        apply_server_frame(
            &state,
            &DashMap::new(),
            ServerFrame::Accounts {
                request_id: None,
                accounts: vec![snapshot(Network::Qq, "10002", RouteMode::Server)],
            },
        );

        assert!(state.accounts.get(&old).is_none());
        let current_snapshot = state.accounts.get(&current).unwrap();
        assert_eq!(current_snapshot.route, RouteMode::Server);
        assert_eq!(current_snapshot.status, AccountStatus::Online);
    }

    #[test]
    fn reconnect_backoff_caps_at_thirty_seconds() {
        let mut delay = RECONNECT_INITIAL;
        let mut values = Vec::new();
        for _ in 0..6 {
            values.push(delay.as_secs());
            delay = next_backoff(delay);
        }
        assert_eq!(values, vec![1, 2, 4, 8, 16, 30]);
        assert_eq!(next_backoff(delay), RECONNECT_MAX);
    }

    #[test]
    fn pending_metadata_never_contains_login_secrets() {
        let metadata = PendingRemoteRequest::from_command(&Command::MatrixLoginPassword {
            account_id: "matrix-a".into(),
            route: RouteMode::Server,
            homeserver: "https://matrix.example".into(),
            username: "alice".into(),
            password: "do-not-log-this".into(),
        });
        let context = metadata.context();
        assert_eq!(context, "Matrix login for matrix:matrix-a");
        assert!(!context.contains("do-not-log-this"));
    }

    #[test]
    fn pending_metadata_never_contains_cursor_values() {
        let metadata = PendingRemoteRequest::from_command(&Command::SetCursor {
            account: account(Network::Telegram, "telegram-a"),
            key: "sync".into(),
            value: "do-not-log-this-cursor".into(),
        });
        let context = metadata.context();
        assert_eq!(context, "write sync cursor for telegram:telegram-a");
        assert!(!context.contains("do-not-log-this-cursor"));
    }

    #[test]
    fn history_response_completes_pending_request() {
        let state = client_state();
        let request_id = Uuid::new_v4();
        let pending = DashMap::new();
        let account = account(Network::Matrix, "history");
        pending.insert(
            request_id,
            PendingRemoteRequest::from_command(&Command::GetCursor {
                account: account.clone(),
                key: "sync".into(),
            }),
        );

        apply_server_frame(
            &state,
            &pending,
            ServerFrame::Cursor {
                request_id,
                account,
                key: "sync".into(),
                value: Some("cursor".into()),
            },
        );

        assert!(!pending.contains_key(&request_id));
    }
}
