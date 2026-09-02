use std::{mem, sync::Arc};

use anyhow::{Context, Result, bail};
use dashmap::DashMap;
use grammers_client::{
    Client, SignInError,
    client::{LoginToken, PasswordToken, UpdatesConfiguration},
    peer::Peer,
    update::Update,
};
use grammers_mtsender::SenderPool;
use grammers_session::{storages::SqliteSession, types::PeerRef, updates::UpdatesLike};
use serde_json::json;
use tokio::{
    sync::{Mutex, mpsc::UnboundedReceiver},
    task::AbortHandle,
};
use web_bridge_protocol::{
    AccountRef, AccountSnapshot, AccountStatus, AuthChallenge, ConversationKind, ConversationRef,
    MessagePart, Network, RouteMode, ServerFrame, UnifiedMessage,
};

use crate::state::CoreState;

pub struct TelegramHandle {
    pub client: Client,
    login: Mutex<LoginStage>,
    updates: Mutex<Option<UnboundedReceiver<UpdatesLike>>>,
    update_task: Mutex<Option<AbortHandle>>,
    pool_task: AbortHandle,
    peers: Arc<DashMap<String, PeerRef>>,
}

enum LoginStage {
    None,
    Code(LoginToken),
    Password(Box<PasswordToken>),
    Authorized,
}

pub async fn begin_login(
    state: Arc<CoreState>,
    account_id: String,
    route: RouteMode,
    api_id: i32,
    api_hash: String,
    phone: String,
) -> Result<(AccountSnapshot, Option<AuthChallenge>)> {
    if !state.role.route_is_local(route) {
        bail!("requested Telegram route is owned by the other runtime");
    }

    let account = AccountRef {
        network: Network::Telegram,
        id: account_id,
    };
    disconnect(&state, &account).await;

    let snapshot = state
        .accounts
        .upsert(account.clone(), Some(phone.clone()), route)
        .map_err(anyhow::Error::msg)?;
    state
        .accounts
        .set_provider_metadata(&account, json!({"api_id": api_id, "phone": phone}))
        .map_err(anyhow::Error::msg)?;
    let snapshot = state
        .accounts
        .set_status(&account, AccountStatus::Connecting, None)
        .unwrap_or(snapshot);
    let _ = state.events.send(ServerFrame::AccountChanged {
        account: snapshot.clone(),
    });

    let telegram = build_handle(&state, &account, api_id).await?;
    let client = telegram.client.clone();
    state.telegram.insert(account.clone(), telegram.clone());

    if client
        .is_authorized()
        .await
        .context("check Telegram session")?
    {
        *telegram.login.lock().await = LoginStage::Authorized;
        let snapshot = finish_authorized(state, account, telegram).await?;
        return Ok((snapshot, None));
    }

    let token = client
        .request_login_code(&phone, &api_hash)
        .await
        .context("request Telegram login code")?;
    *telegram.login.lock().await = LoginStage::Code(token);
    Ok((snapshot, Some(AuthChallenge::TelegramCode)))
}

pub async fn restore_sessions(state: Arc<CoreState>) {
    let accounts: Vec<_> = state
        .accounts
        .list()
        .into_iter()
        .filter(|snapshot| {
            snapshot.account.network == Network::Telegram
                && state.role.route_is_local(snapshot.route)
        })
        .map(|snapshot| snapshot.account)
        .collect();

    for account in accounts {
        if let Err(error) = restore_account(state.clone(), &account).await {
            mark_error(
                &state,
                &account,
                &format!("Telegram session restore failed: {error:#}"),
            );
        }
    }
}

pub async fn restore_account(
    state: Arc<CoreState>,
    account: &AccountRef,
) -> Result<AccountSnapshot> {
    let snapshot = state
        .accounts
        .get(account)
        .context("Telegram account is not registered")?;
    if account.network != Network::Telegram {
        bail!("account is not a Telegram account");
    }
    if !state.role.route_is_local(snapshot.route) {
        bail!("Telegram account route belongs to the other runtime");
    }

    let metadata = state
        .accounts
        .provider_metadata(account)
        .context("Telegram restore metadata is missing")?;
    let api_id = metadata
        .get("api_id")
        .and_then(|value| value.as_i64())
        .and_then(|value| i32::try_from(value).ok())
        .context("Telegram restore metadata has no valid api_id")?;

    let connecting = state
        .accounts
        .set_status(account, AccountStatus::Connecting, None)
        .context("Telegram account disappeared during restore")?;
    let _ = state.events.send(ServerFrame::AccountChanged {
        account: connecting,
    });

    let telegram = build_handle(&state, account, api_id).await?;
    if !telegram
        .client
        .is_authorized()
        .await
        .context("check restored Telegram session")?
    {
        stop_handle(&telegram).await;
        return state
            .accounts
            .set_status(account, AccountStatus::Offline, None)
            .context("Telegram account disappeared after unauthorised restore");
    }

    *telegram.login.lock().await = LoginStage::Authorized;
    if let Some((_, old)) = state.telegram.insert(account.clone(), telegram.clone()) {
        stop_handle(&old).await;
    }
    finish_authorized(state, account.clone(), telegram).await
}

pub async fn submit_code(
    state: Arc<CoreState>,
    account: &AccountRef,
    code: String,
) -> Result<(AccountSnapshot, Option<AuthChallenge>)> {
    let telegram = get_handle(&state, account)?;
    let stage = {
        let mut login = telegram.login.lock().await;
        mem::replace(&mut *login, LoginStage::None)
    };
    let LoginStage::Code(token) = stage else {
        bail!("Telegram account is not waiting for a login code");
    };

    match telegram.client.sign_in(&token, code.trim()).await {
        Ok(_) => {
            *telegram.login.lock().await = LoginStage::Authorized;
            let snapshot = finish_authorized(state, account.clone(), telegram).await?;
            Ok((snapshot, None))
        }
        Err(SignInError::PasswordRequired(token)) => {
            let hint = token.hint().map(ToOwned::to_owned);
            *telegram.login.lock().await = LoginStage::Password(Box::new(token));
            let snapshot = state
                .accounts
                .get(account)
                .context("Telegram account disappeared")?;
            Ok((snapshot, Some(AuthChallenge::TelegramPassword { hint })))
        }
        Err(error) => {
            mark_error(&state, account, &error.to_string());
            Err(error).context("Telegram sign-in failed")
        }
    }
}

pub async fn submit_password(
    state: Arc<CoreState>,
    account: &AccountRef,
    password: String,
) -> Result<AccountSnapshot> {
    let telegram = get_handle(&state, account)?;
    let stage = {
        let mut login = telegram.login.lock().await;
        mem::replace(&mut *login, LoginStage::None)
    };
    let LoginStage::Password(token) = stage else {
        bail!("Telegram account is not waiting for a 2FA password");
    };

    match telegram
        .client
        .check_password(*token, password.as_bytes())
        .await
    {
        Ok(_) => {
            *telegram.login.lock().await = LoginStage::Authorized;
            finish_authorized(state, account.clone(), telegram).await
        }
        Err(SignInError::InvalidPassword(token)) => {
            *telegram.login.lock().await = LoginStage::Password(Box::new(token));
            mark_error(&state, account, "invalid Telegram 2FA password");
            bail!("invalid Telegram 2FA password")
        }
        Err(error) => {
            mark_error(&state, account, &error.to_string());
            Err(error).context("Telegram 2FA failed")
        }
    }
}

pub async fn send_message(
    state: &CoreState,
    account: &AccountRef,
    conversation: &ConversationRef,
    parts: &[MessagePart],
) -> Result<()> {
    let telegram = get_handle(state, account)?;
    let body = text_body(parts)?;

    let peer_ref = if let Some(peer) = telegram.peers.get(&conversation.id) {
        *peer.value()
    } else if let Some(username) = conversation.id.strip_prefix('@') {
        let peer = telegram
            .client
            .resolve_username(username)
            .await
            .context("resolve Telegram username")?
            .context("Telegram username not found")?;
        peer.to_ref()
            .await
            .map_err(|error| anyhow::anyhow!("build Telegram peer reference: {error}"))?
            .context("Telegram peer is missing an access hash")?
    } else {
        bail!("Telegram peer is not cached; use @username or receive/load the dialog first");
    };

    telegram
        .client
        .send_message(peer_ref, body)
        .await
        .context("send Telegram message")?;
    Ok(())
}

pub async fn disconnect(state: &CoreState, account: &AccountRef) {
    if let Some((_, handle)) = state.telegram.remove(account) {
        stop_handle(&handle).await;
    }
    if let Some(snapshot) = state
        .accounts
        .set_status(account, AccountStatus::Offline, None)
    {
        let _ = state
            .events
            .send(ServerFrame::AccountChanged { account: snapshot });
    }
}

async fn build_handle(
    state: &CoreState,
    account: &AccountRef,
    api_id: i32,
) -> Result<Arc<TelegramHandle>> {
    let account_dir = state.account_data_dir(account);
    tokio::fs::create_dir_all(&account_dir)
        .await
        .context("create Telegram account directory")?;
    let session = Arc::new(
        SqliteSession::open(account_dir.join("telegram.session"))
            .await
            .context("open Telegram session")?,
    );
    let SenderPool {
        runner,
        updates,
        handle,
    } = SenderPool::new(session, api_id);
    let client = Client::new(handle);
    let pool_task = tokio::spawn(runner.run());
    Ok(Arc::new(TelegramHandle {
        client,
        login: Mutex::new(LoginStage::None),
        updates: Mutex::new(Some(updates)),
        update_task: Mutex::new(None),
        pool_task: pool_task.abort_handle(),
        peers: Arc::new(DashMap::new()),
    }))
}

async fn stop_handle(handle: &TelegramHandle) {
    handle.client.disconnect();
    handle.pool_task.abort();
    if let Some(task) = handle.update_task.lock().await.take() {
        task.abort();
    }
}

async fn finish_authorized(
    state: Arc<CoreState>,
    account: AccountRef,
    telegram: Arc<TelegramHandle>,
) -> Result<AccountSnapshot> {
    let user = telegram
        .client
        .get_me()
        .await
        .context("read Telegram profile")?;
    let display_name = user
        .first_name()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| account.id.clone());
    let route = state
        .accounts
        .get(&account)
        .context("Telegram account disappeared")?
        .route;
    state
        .accounts
        .upsert(account.clone(), Some(display_name), route)
        .map_err(anyhow::Error::msg)?;
    let snapshot = state
        .accounts
        .set_status(&account, AccountStatus::Online, None)
        .context("Telegram account disappeared")?;
    let _ = state.events.send(ServerFrame::AccountChanged {
        account: snapshot.clone(),
    });

    start_updates(state, account, telegram).await?;
    Ok(snapshot)
}

async fn start_updates(
    state: Arc<CoreState>,
    account: AccountRef,
    telegram: Arc<TelegramHandle>,
) -> Result<()> {
    if telegram.update_task.lock().await.is_some() {
        return Ok(());
    }
    let updates = telegram
        .updates
        .lock()
        .await
        .take()
        .context("Telegram update receiver already consumed")?;
    let mut stream = telegram
        .client
        .stream_updates(
            updates,
            UpdatesConfiguration {
                catch_up: true,
                ..Default::default()
            },
        )
        .await
        .map_err(|error| anyhow::anyhow!("start Telegram update stream: {error}"))?;
    let peers = telegram.peers.clone();
    let task_state = state.clone();
    let task_account = account.clone();
    let task = tokio::spawn(async move {
        loop {
            match stream.next().await {
                Ok(Update::NewMessage(message)) => {
                    let conversation_id = message.peer_id().to_string();
                    if let Ok(Some(peer_ref)) = message.peer_ref().await {
                        peers.insert(conversation_id.clone(), peer_ref);
                    }
                    let kind = match message.peer() {
                        Some(Peer::User(_)) => ConversationKind::Private,
                        Some(Peer::Group(_)) => ConversationKind::Group,
                        Some(Peer::Channel(_)) => ConversationKind::Channel,
                        None => ConversationKind::Private,
                    };
                    let sender_name = message
                        .sender()
                        .and_then(|peer| peer.name())
                        .map(str::to_owned);
                    let message = UnifiedMessage {
                        id: message.id().to_string(),
                        account: task_account.clone(),
                        conversation: ConversationRef {
                            kind,
                            id: conversation_id,
                        },
                        sender_id: message
                            .sender_id()
                            .map(|id| id.to_string())
                            .unwrap_or_default(),
                        sender_name,
                        timestamp: chrono::Utc::now(),
                        parts: vec![MessagePart::Text {
                            text: message.text().to_owned(),
                        }],
                        raw: None,
                    };
                    let _ = task_state.events.send(ServerFrame::Message { message });
                }
                Ok(_) => {}
                Err(error) => {
                    mark_error(&task_state, &task_account, &error.to_string());
                    break;
                }
            }
        }
    });
    *telegram.update_task.lock().await = Some(task.abort_handle());
    Ok(())
}

fn get_handle(state: &CoreState, account: &AccountRef) -> Result<Arc<TelegramHandle>> {
    state
        .telegram
        .get(account)
        .map(|entry| Arc::clone(entry.value()))
        .context("Telegram account is not connected in this runtime")
}

fn mark_error(state: &CoreState, account: &AccountRef, error: &str) {
    if let Some(snapshot) =
        state
            .accounts
            .set_status(account, AccountStatus::Error, Some(error.to_owned()))
    {
        let _ = state
            .events
            .send(ServerFrame::AccountChanged { account: snapshot });
    }
}

fn text_body(parts: &[MessagePart]) -> Result<String> {
    let mut body = String::new();
    for part in parts {
        match part {
            MessagePart::Text { text } => body.push_str(text),
            MessagePart::Reply { .. } => {}
            _ => bail!("Telegram bootstrap sender currently supports text/reply metadata only"),
        }
    }
    if body.is_empty() {
        bail!("message contains no text");
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts::RuntimeRole, state::CoreConfig};
    use uuid::Uuid;

    fn telegram(id: &str) -> AccountRef {
        AccountRef {
            network: Network::Telegram,
            id: id.into(),
        }
    }

    async fn test_handle() -> Arc<TelegramHandle> {
        let path =
            std::env::temp_dir().join(format!("web-bridge-telegram-{}.session", Uuid::new_v4()));
        let session = Arc::new(SqliteSession::open(&path).await.unwrap());
        let SenderPool {
            runner: _,
            updates,
            handle,
        } = SenderPool::new(session, 1);
        let client = Client::new(handle);
        let pool_task = tokio::spawn(std::future::pending::<()>());
        Arc::new(TelegramHandle {
            client,
            login: Mutex::new(LoginStage::None),
            updates: Mutex::new(Some(updates)),
            update_task: Mutex::new(None),
            pool_task: pool_task.abort_handle(),
            peers: Arc::new(DashMap::new()),
        })
    }

    #[tokio::test]
    async fn disconnecting_one_telegram_account_keeps_the_other_online() {
        let state = CoreState::new(RuntimeRole::Client, CoreConfig::default());
        let account_a = telegram("telegram-a");
        let account_b = telegram("telegram-b");
        for account in [&account_a, &account_b] {
            state
                .accounts
                .upsert(account.clone(), None, RouteMode::Client)
                .unwrap();
            state
                .accounts
                .set_status(account, AccountStatus::Online, None)
                .unwrap();
        }
        state
            .telegram
            .insert(account_a.clone(), test_handle().await);
        state
            .telegram
            .insert(account_b.clone(), test_handle().await);

        disconnect(&state, &account_a).await;

        assert!(!state.telegram.contains_key(&account_a));
        assert!(state.telegram.contains_key(&account_b));
        assert_eq!(
            state.accounts.get(&account_a).unwrap().status,
            AccountStatus::Offline
        );
        assert_eq!(
            state.accounts.get(&account_b).unwrap().status,
            AccountStatus::Online
        );
    }
}
