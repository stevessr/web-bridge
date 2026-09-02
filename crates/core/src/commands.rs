use std::{sync::Arc, time::Duration};

use tokio::{sync::oneshot, time::timeout};
use web_bridge_protocol::{AccountRef, AccountStatus, Command, Network, ServerFrame};

use crate::{
    napcat,
    providers::{matrix, telegram},
    state::{CoreState, PendingQqAction},
};

const QQ_ACTION_TIMEOUT: Duration = Duration::from_secs(15);

pub async fn execute(
    request_id: uuid::Uuid,
    command: Command,
    state: &Arc<CoreState>,
) -> Vec<ServerFrame> {
    match command {
        Command::ListAccounts => vec![ServerFrame::Accounts {
            request_id: Some(request_id),
            accounts: state.accounts.list(),
        }],
        Command::RegisterAccount {
            account,
            display_name,
            route,
        } => {
            if !state.role.route_is_local(route) {
                return vec![route_not_local(request_id)];
            }
            match state.accounts.upsert(account, display_name, route) {
                Ok(account) => {
                    let _ = state.events.send(ServerFrame::AccountChanged { account });
                    vec![ServerFrame::Ack { request_id }]
                }
                Err(message) => vec![policy_error(request_id, message)],
            }
        }
        Command::RemoveAccount { account } => {
            if state.accounts.get(&account).is_none() {
                return vec![account_not_found(request_id)];
            }
            disconnect_provider(state, &account).await;
            if let Err(error) = purge_provider_data(state, &account).await {
                return vec![provider_error(
                    request_id,
                    "account_data_purge_failed",
                    error,
                )];
            }
            if state.accounts.remove(&account).is_some() {
                let _ = state.events.send(ServerFrame::AccountRemoved { account });
                vec![ServerFrame::Ack { request_id }]
            } else {
                vec![account_not_found(request_id)]
            }
        }
        Command::SetAccountRoute { account, route } => {
            if !state.role.route_is_local(route) {
                return vec![route_not_local(request_id)];
            }
            match state.accounts.set_route(&account, route) {
                Ok(account) => {
                    let _ = state.events.send(ServerFrame::AccountChanged { account });
                    vec![ServerFrame::Ack { request_id }]
                }
                Err(message) => vec![policy_error(request_id, message)],
            }
        }
        Command::MatrixLoginPassword {
            account_id,
            route,
            homeserver,
            username,
            password,
        } => match matrix::login_password(
            Arc::clone(state),
            account_id,
            route,
            homeserver,
            username,
            password,
        )
        .await
        {
            Ok(_) => vec![ServerFrame::Ack { request_id }],
            Err(error) => vec![provider_error(request_id, "matrix_login_failed", error)],
        },
        Command::TelegramBeginLogin {
            account_id,
            route,
            api_id,
            api_hash,
            phone,
        } => match telegram::begin_login(
            Arc::clone(state),
            account_id.clone(),
            route,
            api_id,
            api_hash,
            phone,
        )
        .await
        {
            Ok((_, challenge)) => {
                let account = AccountRef {
                    network: Network::Telegram,
                    id: account_id,
                };
                let mut frames = Vec::new();
                if let Some(challenge) = challenge {
                    frames.push(ServerFrame::AuthChallenge {
                        request_id: Some(request_id),
                        account,
                        challenge,
                    });
                }
                frames.push(ServerFrame::Ack { request_id });
                frames
            }
            Err(error) => vec![provider_error(request_id, "telegram_login_failed", error)],
        },
        Command::TelegramSubmitCode { account_id, code } => {
            let account = AccountRef {
                network: Network::Telegram,
                id: account_id,
            };
            match telegram::submit_code(Arc::clone(state), &account, code).await {
                Ok((_, challenge)) => {
                    let mut frames = Vec::new();
                    if let Some(challenge) = challenge {
                        frames.push(ServerFrame::AuthChallenge {
                            request_id: Some(request_id),
                            account,
                            challenge,
                        });
                    }
                    frames.push(ServerFrame::Ack { request_id });
                    frames
                }
                Err(error) => vec![provider_error(request_id, "telegram_code_failed", error)],
            }
        }
        Command::TelegramSubmitPassword {
            account_id,
            password,
        } => {
            let account = AccountRef {
                network: Network::Telegram,
                id: account_id,
            };
            match telegram::submit_password(Arc::clone(state), &account, password).await {
                Ok(_) => vec![ServerFrame::Ack { request_id }],
                Err(error) => {
                    vec![provider_error(
                        request_id,
                        "telegram_password_failed",
                        error,
                    )]
                }
            }
        }
        Command::DisconnectAccount { account } => {
            disconnect_provider(state, &account).await;
            vec![ServerFrame::Ack { request_id }]
        }
        Command::SendMessage {
            account,
            route,
            conversation,
            parts,
        } => {
            if !account.network.permits_route(route) {
                return vec![policy_error(
                    request_id,
                    "QQ must be routed through the server",
                )];
            }
            if !state.role.route_is_local(route) {
                return vec![route_not_local(request_id)];
            }

            let result = match account.network {
                Network::Qq => send_qq(state, &account, &conversation, &parts, request_id).await,
                Network::Matrix => {
                    matrix::send_message(state, &account, &conversation, &parts).await
                }
                Network::Telegram => {
                    telegram::send_message(state, &account, &conversation, &parts).await
                }
            };

            match result {
                Ok(()) => vec![ServerFrame::Ack { request_id }],
                Err(error) => vec![provider_error(request_id, "send_failed", error)],
            }
        }
    }
}

async fn send_qq(
    state: &CoreState,
    account: &AccountRef,
    conversation: &web_bridge_protocol::ConversationRef,
    parts: &[web_bridge_protocol::MessagePart],
    request_id: uuid::Uuid,
) -> anyhow::Result<()> {
    let sender = state
        .qq
        .get(account)
        .map(|entry| entry.value().clone())
        .ok_or_else(|| anyhow::anyhow!("QQ account {} has no NapCat connection", account.id))?;
    let echo = request_id.to_string();
    let action =
        napcat::build_send_action(conversation, parts, echo.clone()).map_err(anyhow::Error::msg)?;
    let (response_tx, response_rx) = oneshot::channel();
    state.qq_pending.insert(
        echo.clone(),
        PendingQqAction {
            account: account.clone(),
            response: response_tx,
        },
    );

    if sender.send(action.to_string()).is_err() {
        state.qq_pending.remove(&echo);
        anyhow::bail!("NapCat writer closed");
    }

    match timeout(QQ_ACTION_TIMEOUT, response_rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(message))) => Err(anyhow::anyhow!(message)),
        Ok(Err(_)) => Err(anyhow::anyhow!("NapCat action response channel closed")),
        Err(_) => {
            state.qq_pending.remove(&echo);
            anyhow::bail!(
                "NapCat action response timed out after {}s",
                QQ_ACTION_TIMEOUT.as_secs()
            )
        }
    }
}

pub async fn disconnect_provider(state: &CoreState, account: &AccountRef) {
    match account.network {
        Network::Qq => {
            state.qq.remove(account);
            state.fail_qq_pending(account, "QQ account disconnected before action response");
            if let Some(snapshot) = state
                .accounts
                .set_status(account, AccountStatus::Offline, None)
            {
                let _ = state
                    .events
                    .send(ServerFrame::AccountChanged { account: snapshot });
            }
        }
        Network::Matrix => matrix::disconnect(state, account),
        Network::Telegram => telegram::disconnect(state, account).await,
    }
}

async fn purge_provider_data(state: &CoreState, account: &AccountRef) -> anyhow::Result<()> {
    if account.network == Network::Qq {
        return Ok(());
    }
    let path = state.account_data_dir(account);
    match tokio::fs::remove_dir_all(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::anyhow!(
            "remove provider data {}: {error}",
            path.display()
        )),
    }
}

fn route_not_local(request_id: uuid::Uuid) -> ServerFrame {
    ServerFrame::Error {
        request_id: Some(request_id),
        code: "route_not_local".into(),
        message: "this runtime does not own the requested route".into(),
    }
}

fn policy_error(request_id: uuid::Uuid, message: &str) -> ServerFrame {
    ServerFrame::Error {
        request_id: Some(request_id),
        code: "route_forbidden".into(),
        message: message.into(),
    }
}

fn account_not_found(request_id: uuid::Uuid) -> ServerFrame {
    ServerFrame::Error {
        request_id: Some(request_id),
        code: "account_not_found".into(),
        message: "account not found".into(),
    }
}

fn provider_error(request_id: uuid::Uuid, code: &str, error: anyhow::Error) -> ServerFrame {
    ServerFrame::Error {
        request_id: Some(request_id),
        code: code.into(),
        message: format!("{error:#}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts::RuntimeRole, state::CoreConfig};
    use uuid::Uuid;
    use web_bridge_protocol::RouteMode;

    #[tokio::test]
    async fn disconnect_preserves_provider_data_but_remove_purges_it() {
        for network in [Network::Matrix, Network::Telegram] {
            let root = std::env::temp_dir().join(format!(
                "web-bridge-remove-account-{}-{}",
                match network {
                    Network::Matrix => "matrix",
                    Network::Telegram => "telegram",
                    Network::Qq => unreachable!(),
                },
                Uuid::new_v4()
            ));
            let state = Arc::new(CoreState::new(
                RuntimeRole::Client,
                CoreConfig {
                    data_dir: root.clone(),
                    ..CoreConfig::default()
                },
            ));
            let account = AccountRef {
                network,
                id: "account-a".into(),
            };
            state
                .accounts
                .upsert(account.clone(), None, RouteMode::Client)
                .unwrap();
            let account_dir = state.account_data_dir(&account);
            tokio::fs::create_dir_all(&account_dir).await.unwrap();
            let sentinel = account_dir.join("session-sentinel");
            tokio::fs::write(&sentinel, b"session").await.unwrap();

            let disconnect = execute(
                Uuid::new_v4(),
                Command::DisconnectAccount {
                    account: account.clone(),
                },
                &state,
            )
            .await;
            assert!(matches!(disconnect.as_slice(), [ServerFrame::Ack { .. }]));
            assert!(sentinel.exists());
            assert!(state.accounts.get(&account).is_some());

            let remove = execute(
                Uuid::new_v4(),
                Command::RemoveAccount {
                    account: account.clone(),
                },
                &state,
            )
            .await;
            assert!(matches!(remove.as_slice(), [ServerFrame::Ack { .. }]));
            assert!(!account_dir.exists());
            assert!(state.accounts.get(&account).is_none());

            let _ = tokio::fs::remove_dir_all(root).await;
        }
    }
}
