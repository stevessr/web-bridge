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
            if let Some(frame) = local_account_error(state, &account, request_id) {
                return vec![frame];
            }
            disconnect_provider(state, &account).await;
            if let Err(error) = purge_provider_data(state, &account).await {
                return vec![provider_error(
                    request_id,
                    "account_data_purge_failed",
                    error,
                )];
            }
            if let Err(error) = state.media.remove_account(&account).await {
                return vec![provider_error(
                    request_id,
                    "account_media_purge_failed",
                    error,
                )];
            }
            if let Err(error) = state.storage.remove_account(&account) {
                return vec![provider_error(
                    request_id,
                    "account_history_purge_failed",
                    error.into(),
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
            if let Some(frame) = local_account_error(state, &account, request_id) {
                return vec![frame];
            }
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
        Command::ListConversations { account, limit } => {
            if let Some(frame) = local_account_error(state, &account, request_id) {
                return vec![frame];
            }
            match state.storage.list_conversations(&account, limit) {
                Ok(conversations) => vec![ServerFrame::Conversations {
                    request_id,
                    conversations,
                }],
                Err(error) => vec![storage_error(request_id, error)],
            }
        }
        Command::ListMessages {
            account,
            conversation,
            before,
            limit,
        } => {
            if let Some(frame) = local_account_error(state, &account, request_id) {
                return vec![frame];
            }
            match state
                .storage
                .list_messages(&account, &conversation, before, limit)
            {
                Ok(messages) => vec![ServerFrame::Messages {
                    request_id,
                    messages,
                }],
                Err(error) => vec![storage_error(request_id, error)],
            }
        }
        Command::GetCursor { account, key } => {
            if let Some(frame) = local_account_error(state, &account, request_id) {
                return vec![frame];
            }
            match state.storage.cursor(&account, &key) {
                Ok(value) => vec![ServerFrame::Cursor {
                    request_id,
                    account,
                    key,
                    value,
                }],
                Err(error) => vec![storage_error(request_id, error)],
            }
        }
        Command::SetCursor {
            account,
            key,
            value,
        } => {
            if let Some(frame) = local_account_error(state, &account, request_id) {
                return vec![frame];
            }
            match state.storage.set_cursor(&account, &key, &value) {
                Ok(()) => vec![ServerFrame::Ack { request_id }],
                Err(error) => vec![storage_error(request_id, error)],
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

fn local_account_error(
    state: &CoreState,
    account: &AccountRef,
    request_id: uuid::Uuid,
) -> Option<ServerFrame> {
    let Some(snapshot) = state.accounts.get(account) else {
        return Some(account_not_found(request_id));
    };
    if !state.role.route_is_local(snapshot.route) {
        return Some(route_not_local(request_id));
    }
    None
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

fn storage_error(request_id: uuid::Uuid, error: rusqlite::Error) -> ServerFrame {
    provider_error(request_id, "storage_failed", error.into())
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
    use chrono::{TimeZone, Utc};
    use uuid::Uuid;
    use web_bridge_protocol::{
        ConversationKind, ConversationRef, MessagePart, RouteMode, UnifiedMessage,
    };

    #[tokio::test]
    async fn disconnect_preserves_and_remove_purges_account_data_for_all_networks() {
        for network in [Network::Matrix, Network::Telegram, Network::Qq] {
            let (role, route) = match network {
                Network::Qq => (RuntimeRole::Server, RouteMode::Server),
                Network::Matrix | Network::Telegram => (RuntimeRole::Client, RouteMode::Client),
            };
            let root = std::env::temp_dir().join(format!(
                "web-bridge-account-lifecycle-{}-{}",
                match network {
                    Network::Matrix => "matrix",
                    Network::Telegram => "telegram",
                    Network::Qq => "qq",
                },
                Uuid::new_v4()
            ));
            let state = Arc::new(CoreState::new(
                role,
                CoreConfig {
                    data_dir: root.clone(),
                    ..CoreConfig::default()
                },
            ));
            let account = AccountRef {
                network,
                id: "account-a".into(),
            };
            state.accounts.upsert(account.clone(), None, route).unwrap();

            let provider_sentinel = if network == Network::Qq {
                None
            } else {
                let account_dir = state.account_data_dir(&account);
                tokio::fs::create_dir_all(&account_dir).await.unwrap();
                let sentinel = account_dir.join("session-sentinel");
                tokio::fs::write(&sentinel, b"session").await.unwrap();
                Some(sentinel)
            };

            let media = state
                .media
                .store(
                    &account,
                    "attachment.bin".into(),
                    "application/octet-stream".into(),
                    b"media",
                )
                .await
                .unwrap();
            let conversation = ConversationRef {
                kind: match network {
                    Network::Matrix => ConversationKind::Room,
                    Network::Telegram | Network::Qq => ConversationKind::Private,
                },
                id: "conversation-a".into(),
            };
            state
                .storage
                .store_message(&UnifiedMessage {
                    id: "message-a".into(),
                    account: account.clone(),
                    conversation: conversation.clone(),
                    sender_id: "sender-a".into(),
                    sender_name: None,
                    timestamp: Utc.with_ymd_and_hms(2026, 9, 3, 1, 0, 0).unwrap(),
                    parts: vec![MessagePart::Text {
                        text: "stored".into(),
                    }],
                    raw: None,
                })
                .unwrap();
            state
                .storage
                .set_cursor(&account, "sync", "cursor-a")
                .unwrap();

            let disconnect = execute(
                Uuid::new_v4(),
                Command::DisconnectAccount {
                    account: account.clone(),
                },
                &state,
            )
            .await;
            assert!(matches!(disconnect.as_slice(), [ServerFrame::Ack { .. }]));
            if let Some(sentinel) = &provider_sentinel {
                assert!(sentinel.exists());
            }
            assert_eq!(
                state.media.load(&account, &media.id).await.unwrap().bytes,
                b"media"
            );
            assert_eq!(
                state
                    .storage
                    .list_messages(&account, &conversation, None, 50)
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                state.storage.cursor(&account, "sync").unwrap().as_deref(),
                Some("cursor-a")
            );
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
            if let Some(sentinel) = &provider_sentinel {
                assert!(!sentinel.exists());
            }
            assert!(state.media.load(&account, &media.id).await.is_err());
            assert!(
                state
                    .storage
                    .list_conversations(&account, 50)
                    .unwrap()
                    .is_empty()
            );
            assert!(
                state
                    .storage
                    .list_messages(&account, &conversation, None, 50)
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(state.storage.cursor(&account, "sync").unwrap(), None);
            assert!(state.accounts.get(&account).is_none());

            let _ = tokio::fs::remove_dir_all(root).await;
        }
    }

    #[tokio::test]
    async fn history_commands_use_the_local_account_store() {
        let state = Arc::new(CoreState::new(RuntimeRole::Client, CoreConfig::default()));
        let account = AccountRef {
            network: Network::Matrix,
            id: "history-account".into(),
        };
        state
            .accounts
            .upsert(account.clone(), None, RouteMode::Client)
            .unwrap();
        let conversation = ConversationRef {
            kind: ConversationKind::Room,
            id: "!history:example.org".into(),
        };
        state
            .storage
            .store_message(&UnifiedMessage {
                id: "$history".into(),
                account: account.clone(),
                conversation: conversation.clone(),
                sender_id: "@alice:example.org".into(),
                sender_name: Some("Alice".into()),
                timestamp: Utc.with_ymd_and_hms(2026, 9, 2, 12, 0, 0).unwrap(),
                parts: vec![MessagePart::Text {
                    text: "stored".into(),
                }],
                raw: None,
            })
            .unwrap();

        let frames = execute(
            Uuid::new_v4(),
            Command::ListMessages {
                account: account.clone(),
                conversation: conversation.clone(),
                before: None,
                limit: 50,
            },
            &state,
        )
        .await;
        assert!(matches!(
            frames.as_slice(),
            [ServerFrame::Messages { messages, .. }] if messages.len() == 1
        ));

        let remote_account = AccountRef {
            network: Network::Matrix,
            id: "server-owned".into(),
        };
        state
            .accounts
            .upsert(remote_account.clone(), None, RouteMode::Server)
            .unwrap();
        let frames = execute(
            Uuid::new_v4(),
            Command::GetCursor {
                account: remote_account,
                key: "sync".into(),
            },
            &state,
        )
        .await;
        assert!(matches!(
            frames.as_slice(),
            [ServerFrame::Error { code, .. }] if code == "route_not_local"
        ));
    }
}
