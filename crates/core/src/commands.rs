use std::sync::Arc;

use web_bridge_protocol::{AccountRef, AccountStatus, Command, Network, ServerFrame};

use crate::{
    napcat,
    providers::{matrix, telegram},
    state::CoreState,
};

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
            disconnect_provider(state, &account).await;
            if state.accounts.remove(&account).is_some() {
                let _ = state.events.send(ServerFrame::AccountRemoved { account });
                vec![ServerFrame::Ack { request_id }]
            } else {
                vec![ServerFrame::Error {
                    request_id: Some(request_id),
                    code: "account_not_found".into(),
                    message: "account not found".into(),
                }]
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
                let mut frames = vec![ServerFrame::Ack { request_id }];
                if let Some(challenge) = challenge {
                    frames.push(ServerFrame::AuthChallenge {
                        request_id: Some(request_id),
                        account,
                        challenge,
                    });
                }
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
                    let mut frames = vec![ServerFrame::Ack { request_id }];
                    if let Some(challenge) = challenge {
                        frames.push(ServerFrame::AuthChallenge {
                            request_id: Some(request_id),
                            account,
                            challenge,
                        });
                    }
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
        .ok_or_else(|| anyhow::anyhow!("QQ account {} has no NapCat connection", account.id))?;
    let action = napcat::build_send_action(conversation, parts, request_id.to_string())
        .map_err(anyhow::Error::msg)?;
    sender
        .send(action.to_string())
        .map_err(|_| anyhow::anyhow!("NapCat writer closed"))?;
    Ok(())
}

pub async fn disconnect_provider(state: &CoreState, account: &AccountRef) {
    match account.network {
        Network::Qq => {
            state.qq.remove(account);
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

fn provider_error(request_id: uuid::Uuid, code: &str, error: anyhow::Error) -> ServerFrame {
    ServerFrame::Error {
        request_id: Some(request_id),
        code: code.into(),
        message: format!("{error:#}"),
    }
}
