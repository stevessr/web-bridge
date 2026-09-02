use std::{collections::HashSet, sync::Arc};

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;
use web_bridge_protocol::{
    AccountRef, AccountSnapshot, ClientFrame, Command, PROTOCOL_VERSION, RouteMode, ServerFrame,
};

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
        ServerFrame::Accounts { accounts, .. } => reconcile_server_accounts(state, accounts),
        ServerFrame::AccountChanged { account } => mirror_account(state, account),
        ServerFrame::AccountRemoved { account } => remove_server_mirror(state, account),
        _ => {}
    }
    let _ = state.events.send(frame);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts::RuntimeRole, state::CoreConfig};
    use web_bridge_protocol::{AccountStatus, Network};

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
}
