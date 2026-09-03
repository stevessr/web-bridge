use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header::ORIGIN},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tracing::{info, warn};
use web_bridge_protocol::{
    AccountRef, AccountStatus, ClientFrame, Network, PROTOCOL_VERSION, RouteMode, ServerFrame,
};

use crate::{
    auth::{ClientPolicy, resolve_client_policy},
    commands, napcat,
    state::CoreState,
};

pub fn router(state: Arc<CoreState>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/info", get(info_handler))
        .route("/v1/ws", get(client_upgrade))
        .route("/onebot/v11/ws", get(napcat_upgrade))
        .with_state(state)
}

async fn info_handler(State(state): State<Arc<CoreState>>) -> Json<Value> {
    Json(json!({
        "name": "web-bridge-core",
        "protocol": PROTOCOL_VERSION,
        "role": format!("{:?}", state.role).to_lowercase(),
        "routing": {"qq":"server_only","matrix":"server_or_client","telegram":"server_or_client"},
    }))
}

async fn client_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<CoreState>>,
    headers: HeaderMap,
) -> Response {
    let Some(token) = bearer_token(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(policy) = resolve_client_policy(
        token,
        &state.config.client_token,
        &state.config.client_credentials,
    ) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !client_origin_allowed(&headers, &state.config.client_allowed_origins) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(move |socket| client_socket(socket, state, policy))
}

async fn napcat_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<CoreState>>,
    headers: HeaderMap,
) -> Response {
    let self_id = match headers
        .get("x-self-id")
        .and_then(|value| value.to_str().ok())
    {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ => return (StatusCode::BAD_REQUEST, "missing X-Self-ID").into_response(),
    };
    let expected = if state.config.napcat_tokens.is_empty() {
        Some(state.config.napcat_token.as_str())
    } else {
        state.config.napcat_tokens.get(&self_id).map(String::as_str)
    };
    let Some(expected) = expected else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !bearer_matches(&headers, expected) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| napcat_socket(socket, state, self_id))
}

async fn client_socket(socket: WebSocket, state: Arc<CoreState>, policy: ClientPolicy) {
    let (mut sink, mut stream) = socket.split();
    let mut events = state.events.subscribe();
    let mut session_device = None;

    if send_frame(
        &mut sink,
        &ServerFrame::Ready {
            protocol: PROTOCOL_VERSION,
        },
    )
    .await
    .is_err()
    {
        return;
    }

    info!(principal = policy.principal(), "client websocket connected");
    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else { continue };
                match serde_json::from_str::<ClientFrame>(&text) {
                    Ok(frame) => {
                        for response in handle_client_frame(
                            frame,
                            &state,
                            &policy,
                            &mut session_device,
                        ).await {
                            if send_frame(&mut sink, &response).await.is_err() {
                                return;
                            }
                        }
                    }
                    Err(error) => {
                        let frame = ServerFrame::Error {
                            request_id: None,
                            code: "invalid_frame".into(),
                            message: error.to_string(),
                        };
                        if send_frame(&mut sink, &frame).await.is_err() {
                            return;
                        }
                    }
                }
            }
            outbound = events.recv() => {
                match outbound {
                    Ok(frame) => {
                        if let Some(frame) = policy.filter_frame(frame)
                            && send_frame(&mut sink, &frame).await.is_err()
                        {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
    info!(principal = policy.principal(), "client websocket disconnected");
}

async fn handle_client_frame(
    frame: ClientFrame,
    state: &Arc<CoreState>,
    policy: &ClientPolicy,
    session_device: &mut Option<String>,
) -> Vec<ServerFrame> {
    match frame {
        ClientFrame::Hello { protocol, .. } if protocol != PROTOCOL_VERSION => {
            vec![ServerFrame::Error {
                request_id: None,
                code: "protocol_mismatch".into(),
                message: format!("server protocol is {PROTOCOL_VERSION}"),
            }]
        }
        ClientFrame::Hello { device_id, .. } => {
            if let Some(bound) = session_device.as_deref()
                && bound != device_id
            {
                return vec![session_error(
                    "device_mismatch",
                    "this websocket is already bound to a different device_id",
                )];
            }
            if !policy.allows_device(&device_id) {
                return vec![session_error(
                    "device_forbidden",
                    "this credential is not allowed for the requested device_id",
                )];
            }
            *session_device = Some(device_id);
            vec![]
        }
        _ if session_device.is_none() => vec![session_error(
            "hello_required",
            "send a valid Hello frame before using the websocket",
        )],
        ClientFrame::Ping { nonce } => vec![ServerFrame::Pong { nonce }],
        ClientFrame::Command {
            request_id,
            command,
        } => {
            if !policy.allows_command(&command) {
                return vec![ServerFrame::Error {
                    request_id: Some(request_id),
                    code: "forbidden".into(),
                    message: "this credential is not allowed to execute the requested command"
                        .into(),
                }];
            }
            commands::execute(request_id, command, state)
                .await
                .into_iter()
                .filter_map(|frame| policy.filter_frame(frame))
                .collect()
        }
    }
}

async fn napcat_socket(socket: WebSocket, state: Arc<CoreState>, self_id: String) {
    let account = AccountRef {
        network: Network::Qq,
        id: self_id.clone(),
    };
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let snapshot = state
        .accounts
        .upsert(account.clone(), None, RouteMode::Server)
        .expect("QQ server route is always valid");
    let snapshot = state
        .accounts
        .set_status(&account, AccountStatus::Online, None)
        .unwrap_or(snapshot);
    state.qq.insert(account.clone(), tx);
    let _ = state
        .events
        .send(ServerFrame::AccountChanged { account: snapshot });
    info!(qq = %self_id, "NapCat connected");

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else { continue };
                match serde_json::from_str::<Value>(&text) {
                    Ok(value) => {
                        if let Some((echo, result)) = napcat::action_response(&value) {
                            resolve_napcat_action(&state, &account, &self_id, echo, result);
                        } else if let Some(message) = napcat::event_to_message(&value) {
                            if let Err(error) = state.storage.store_message(&message) {
                                warn!(qq = %self_id, %error, "failed to persist QQ message");
                            }
                            let _ = state.events.send(ServerFrame::Message { message });
                        }
                    }
                    Err(error) => warn!(qq = %self_id, %error, "invalid OneBot JSON"),
                }
            }
            Some(outgoing) = rx.recv() => {
                if sink.send(Message::Text(outgoing.into())).await.is_err() { break; }
            }
        }
    }

    state.qq.remove(&account);
    state.fail_qq_pending(&account, "NapCat disconnected before action response");
    if let Some(snapshot) = state
        .accounts
        .set_status(&account, AccountStatus::Offline, None)
    {
        let _ = state
            .events
            .send(ServerFrame::AccountChanged { account: snapshot });
    }
    info!(qq = %self_id, "NapCat disconnected");
}

fn resolve_napcat_action(
    state: &CoreState,
    account: &AccountRef,
    self_id: &str,
    echo: String,
    result: Result<(), String>,
) {
    let Some((_, pending)) = state.qq_pending.remove(&echo) else {
        warn!(qq = %self_id, %echo, "NapCat action response has no pending request");
        return;
    };

    if pending.account != *account {
        let _ = pending.response.send(Err(format!(
            "NapCat action response account mismatch: expected {}, got {}",
            pending.account.id, account.id
        )));
        return;
    }
    let _ = pending.response.send(result);
}

async fn send_frame<S>(sink: &mut S, frame: &ServerFrame) -> Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let text = serde_json::to_string(frame).map_err(|_| ())?;
    sink.send(Message::Text(text.into())).await.map_err(|_| ())
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

fn bearer_matches(headers: &HeaderMap, expected: &str) -> bool {
    !expected.is_empty() && bearer_token(headers).is_some_and(|token| token == expected)
}

fn client_origin_allowed(headers: &HeaderMap, allowed_origins: &[String]) -> bool {
    let Some(origin) = headers.get(ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    allowed_origins.iter().any(|allowed| allowed == origin)
}

fn session_error(code: &str, message: &str) -> ServerFrame {
    ServerFrame::Error {
        request_id: None,
        code: code.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts::RuntimeRole, auth::ClientCredential, state::CoreConfig};
    use web_bridge_protocol::{Command, Network};

    #[test]
    fn bearer_auth_requires_exact_token() {
        let mut headers = HeaderMap::new();
        assert!(!bearer_matches(&headers, "secret"));
        headers.insert("authorization", "Bearer wrong".parse().unwrap());
        assert!(!bearer_matches(&headers, "secret"));
        headers.insert("authorization", "Bearer secret".parse().unwrap());
        assert!(bearer_matches(&headers, "secret"));
    }

    #[test]
    fn native_clients_need_no_origin_but_browsers_need_allowlist_match() {
        let mut headers = HeaderMap::new();
        let allowed = vec!["https://client.example".to_owned()];
        assert!(client_origin_allowed(&headers, &allowed));

        headers.insert(ORIGIN, "https://client.example".parse().unwrap());
        assert!(client_origin_allowed(&headers, &allowed));

        headers.insert(ORIGIN, "https://evil.example".parse().unwrap());
        assert!(!client_origin_allowed(&headers, &allowed));
        assert!(!client_origin_allowed(&headers, &[]));
    }

    #[tokio::test]
    async fn commands_require_hello_and_respect_read_only_acl() {
        let state = Arc::new(CoreState::new(RuntimeRole::Server, CoreConfig::default()));
        let credential = ClientCredential {
            token: "reader".into(),
            principal: "reader".into(),
            devices: vec!["device-a".into()],
            networks: vec![Network::Matrix],
            read_only: true,
        };
        let policy = resolve_client_policy("reader", "legacy", &[credential]).unwrap();
        let mut device = None;

        let before_hello = handle_client_frame(
            ClientFrame::Command {
                request_id: uuid::Uuid::new_v4(),
                command: Command::ListAccounts,
            },
            &state,
            &policy,
            &mut device,
        )
        .await;
        assert!(matches!(
            before_hello.as_slice(),
            [ServerFrame::Error { code, .. }] if code == "hello_required"
        ));

        assert!(
            handle_client_frame(
                ClientFrame::Hello {
                    protocol: PROTOCOL_VERSION,
                    device_id: "device-a".into(),
                },
                &state,
                &policy,
                &mut device,
            )
            .await
            .is_empty()
        );

        let forbidden = handle_client_frame(
            ClientFrame::Command {
                request_id: uuid::Uuid::new_v4(),
                command: Command::RegisterAccount {
                    account: AccountRef {
                        network: Network::Matrix,
                        id: "matrix-a".into(),
                    },
                    display_name: None,
                    route: RouteMode::Server,
                },
            },
            &state,
            &policy,
            &mut device,
        )
        .await;
        assert!(matches!(
            forbidden.as_slice(),
            [ServerFrame::Error { code, .. }] if code == "forbidden"
        ));
    }
}
