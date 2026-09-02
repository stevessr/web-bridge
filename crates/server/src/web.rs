use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Query, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{info, warn};
use uuid::Uuid;
use web_bridge_protocol::{ClientFrame, Command, Network, PROTOCOL_VERSION, RouteMode, ServerFrame};

use crate::{napcat, state::AppState};

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/info", get(info_handler))
        .route("/v1/ws", get(client_upgrade))
        .route("/onebot/v11/ws", get(napcat_upgrade))
        .with_state(state)
}

async fn info_handler() -> Json<Value> {
    Json(json!({
        "name": "web-bridge-server",
        "protocol": PROTOCOL_VERSION,
        "routing": {"qq":"server_only","matrix":"server_or_client","telegram":"server_or_client"}
    }))
}

async fn client_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if query.get("token") != Some(&state.config.client_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| client_socket(socket, state))
}

async fn napcat_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !bearer_matches(&headers, &state.config.napcat_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let self_id = match headers.get("x-self-id").and_then(|v| v.to_str().ok()) {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ => return (StatusCode::BAD_REQUEST, "missing X-Self-ID").into_response(),
    };
    ws.on_upgrade(move |socket| napcat_socket(socket, state, self_id))
}

async fn client_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sink, mut stream) = socket.split();
    let mut events = state.events.subscribe();

    if send_frame(&mut sink, &ServerFrame::Ready { protocol: PROTOCOL_VERSION }).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else { continue };
                match serde_json::from_str::<ClientFrame>(&text) {
                    Ok(frame) => handle_client_frame(frame, &state).await,
                    Err(err) => {
                        let _ = state.events.send(ServerFrame::Error {
                            request_id: None,
                            code: "invalid_frame".into(),
                            message: err.to_string(),
                        });
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

async fn handle_client_frame(frame: ClientFrame, state: &Arc<AppState>) {
    match frame {
        ClientFrame::Ping { nonce } => { let _ = state.events.send(ServerFrame::Pong { nonce }); }
        ClientFrame::Hello { protocol, .. } if protocol != PROTOCOL_VERSION => {
            let _ = state.events.send(ServerFrame::Error {
                request_id: None,
                code: "protocol_mismatch".into(),
                message: format!("server protocol is {PROTOCOL_VERSION}"),
            });
        }
        ClientFrame::Hello { .. } => {}
        ClientFrame::Command { request_id, command } => match command {
            Command::SendMessage { account, route, conversation, parts } => {
                if !account.network.permits_route(route) {
                    let _ = state.events.send(ServerFrame::Error {
                        request_id: Some(request_id),
                        code: "route_forbidden".into(),
                        message: "QQ must be routed through the server".into(),
                    });
                    return;
                }
                if account.network != Network::Qq || route != RouteMode::Server {
                    let _ = state.events.send(ServerFrame::Error {
                        request_id: Some(request_id),
                        code: "provider_not_implemented".into(),
                        message: "bootstrap server currently implements the QQ/NapCat provider".into(),
                    });
                    return;
                }
                let Some(sender) = state.qq.get(&account.id) else {
                    let _ = state.events.send(ServerFrame::Error {
                        request_id: Some(request_id),
                        code: "qq_offline".into(),
                        message: format!("QQ account {} has no NapCat connection", account.id),
                    });
                    return;
                };
                match napcat::build_send_action(&conversation, &parts, request_id.to_string()) {
                    Ok(action) if sender.send(action.to_string()).is_ok() => {
                        let _ = state.events.send(ServerFrame::Ack { request_id });
                    }
                    Ok(_) => {
                        let _ = state.events.send(ServerFrame::Error { request_id: Some(request_id), code: "qq_disconnected".into(), message: "NapCat writer closed".into() });
                    }
                    Err(message) => {
                        let _ = state.events.send(ServerFrame::Error { request_id: Some(request_id), code: "unsupported_message".into(), message: message.into() });
                    }
                }
            }
        }
    }
}

async fn napcat_socket(socket: WebSocket, state: Arc<AppState>, self_id: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    state.qq.insert(self_id.clone(), tx);
    let _ = state.events.send(ServerFrame::ProviderState { network: Network::Qq, account_id: self_id.clone(), online: true });
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
                        // Action responses currently do not need a separate client frame;
                        // request echo correlation is reserved for the durable command ledger.
                    }
                    Err(err) => warn!(qq = %self_id, %err, "invalid OneBot JSON"),
                }
            }
            Some(outgoing) = rx.recv() => {
                if sink.send(Message::Text(outgoing.into())).await.is_err() { break; }
            }
        }
    }

    state.qq.remove(&self_id);
    let _ = state.events.send(ServerFrame::ProviderState { network: Network::Qq, account_id: self_id.clone(), online: false });
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
    if expected.is_empty() { return true; }
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected)
}
