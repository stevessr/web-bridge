use std::{collections::HashMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
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

use crate::{commands, napcat, state::CoreState};

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
        "accounts": state.accounts.list(),
    }))
}

async fn client_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<CoreState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if query.get("token") != Some(&state.config.client_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| client_socket(socket, state))
}

async fn napcat_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<CoreState>>,
    headers: HeaderMap,
) -> Response {
    if !bearer_matches(&headers, &state.config.napcat_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let self_id = match headers
        .get("x-self-id")
        .and_then(|value| value.to_str().ok())
    {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ => return (StatusCode::BAD_REQUEST, "missing X-Self-ID").into_response(),
    };
    ws.on_upgrade(move |socket| napcat_socket(socket, state, self_id))
}

async fn client_socket(socket: WebSocket, state: Arc<CoreState>) {
    let (mut sink, mut stream) = socket.split();
    let mut events = state.events.subscribe();

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

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else { continue };
                match serde_json::from_str::<ClientFrame>(&text) {
                    Ok(frame) => {
                        for response in handle_client_frame(frame, &state).await {
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
                    Ok(frame) => if send_frame(&mut sink, &frame).await.is_err() { break; },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

async fn handle_client_frame(frame: ClientFrame, state: &Arc<CoreState>) -> Vec<ServerFrame> {
    match frame {
        ClientFrame::Ping { nonce } => vec![ServerFrame::Pong { nonce }],
        ClientFrame::Hello { protocol, .. } if protocol != PROTOCOL_VERSION => {
            vec![ServerFrame::Error {
                request_id: None,
                code: "protocol_mismatch".into(),
                message: format!("server protocol is {PROTOCOL_VERSION}"),
            }]
        }
        ClientFrame::Hello { .. } => vec![],
        ClientFrame::Command {
            request_id,
            command,
        } => commands::execute(request_id, command, state).await,
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
                        if let Some(message) = napcat::event_to_message(&value) {
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

async fn send_frame<S>(sink: &mut S, frame: &ServerFrame) -> Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let text = serde_json::to_string(frame).map_err(|_| ())?;
    sink.send(Message::Text(text.into())).await.map_err(|_| ())
}

fn bearer_matches(headers: &HeaderMap, expected: &str) -> bool {
    if expected.is_empty() {
        return true;
    }
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected)
}
