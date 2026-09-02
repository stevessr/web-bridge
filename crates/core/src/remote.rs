use std::sync::Arc;

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;
use web_bridge_protocol::{ClientFrame, Command, PROTOCOL_VERSION, ServerFrame};

use crate::state::CoreState;

pub struct RemoteBridge {
    outgoing: mpsc::UnboundedSender<ClientFrame>,
    task: AbortHandle,
}

impl RemoteBridge {
    pub async fn connect(
        state: Arc<CoreState>,
        endpoint: &str,
        token: &str,
        device_id: String,
    ) -> Result<Self> {
        let endpoint = with_token(endpoint, token);
        let (socket, _) = connect_async(&endpoint)
            .await
            .with_context(|| format!("connect web-bridge server at {endpoint}"))?;
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut outbound) = mpsc::unbounded_channel::<ClientFrame>();

        sink.send(Message::Text(
            serde_json::to_string(&ClientFrame::Hello {
                protocol: PROTOCOL_VERSION,
                device_id,
            })?
            .into(),
        ))
        .await
        .context("send server hello")?;

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    incoming = stream.next() => {
                        let Some(Ok(message)) = incoming else { break };
                        let Message::Text(text) = message else { continue };
                        match serde_json::from_str::<ServerFrame>(&text) {
                            Ok(frame) => apply_server_frame(&state, frame),
                            Err(error) => {
                                let _ = state.events.send(ServerFrame::Error {
                                    request_id: None,
                                    code: "remote_invalid_frame".into(),
                                    message: error.to_string(),
                                });
                            }
                        }
                    }
                    Some(frame) = outbound.recv() => {
                        let Ok(text) = serde_json::to_string(&frame) else { continue };
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = state.events.send(ServerFrame::Error {
                request_id: None,
                code: "remote_disconnected".into(),
                message: "server connection closed".into(),
            });
        });

        Ok(Self {
            outgoing,
            task: task.abort_handle(),
        })
    }

    pub fn command(&self, command: Command) -> Result<Uuid> {
        let request_id = Uuid::new_v4();
        self.outgoing
            .send(ClientFrame::Command {
                request_id,
                command,
            })
            .map_err(|_| anyhow::anyhow!("server connection is closed"))?;
        Ok(request_id)
    }

    pub fn ping(&self, nonce: String) -> Result<()> {
        self.outgoing
            .send(ClientFrame::Ping { nonce })
            .map_err(|_| anyhow::anyhow!("server connection is closed"))
    }

    pub fn close(&self) {
        self.task.abort();
    }
}

fn apply_server_frame(state: &CoreState, frame: ServerFrame) {
    match &frame {
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
        ServerFrame::Accounts { accounts, .. } => {
            for snapshot in accounts {
                mirror_account(state, snapshot);
            }
        }
        ServerFrame::AccountChanged { account } => mirror_account(state, account),
        ServerFrame::AccountRemoved { account } => {
            state.accounts.remove(account);
        }
        _ => {}
    }
    let _ = state.events.send(frame);
}

fn mirror_account(state: &CoreState, snapshot: &web_bridge_protocol::AccountSnapshot) {
    if snapshot.route != web_bridge_protocol::RouteMode::Server {
        return;
    }
    let Ok(_) = state.accounts.upsert(
        snapshot.account.clone(),
        snapshot.display_name.clone(),
        snapshot.route,
    ) else {
        return;
    };
    state.accounts.set_status(
        &snapshot.account,
        snapshot.status,
        snapshot.last_error.clone(),
    );
}

fn with_token(endpoint: &str, token: &str) -> String {
    if token.is_empty() {
        endpoint.to_owned()
    } else if endpoint.contains('?') {
        format!("{endpoint}&token={token}")
    } else {
        format!("{endpoint}?token={token}")
    }
}

pub fn ensure_client_role(state: &CoreState) -> Result<()> {
    if state.role != crate::accounts::RuntimeRole::Client {
        bail!("remote server bridge is only valid in client runtime mode");
    }
    Ok(())
}
