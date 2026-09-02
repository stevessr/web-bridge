use std::sync::Arc;

use anyhow::{Context, Result, bail};
use chrono::Utc;
use matrix_sdk::{
    Client, Room,
    authentication::matrix::MatrixSession,
    config::SyncSettings,
    ruma::{
        RoomId,
        events::room::message::{OriginalSyncRoomMessageEvent, RoomMessageEventContent},
    },
};
use serde::{Deserialize, Serialize};
use tokio::task::AbortHandle;
use web_bridge_protocol::{
    AccountRef, AccountSnapshot, AccountStatus, ConversationKind, ConversationRef, MessagePart,
    Network, RouteMode, ServerFrame, UnifiedMessage,
};

use crate::state::CoreState;

const SESSION_FILE: &str = "matrix-session.json";

pub struct MatrixHandle {
    pub client: Client,
    pub sync_task: AbortHandle,
}

#[derive(Serialize, Deserialize)]
struct StoredMatrixSession {
    homeserver: String,
    session: MatrixSession,
}

pub async fn login_password(
    state: Arc<CoreState>,
    account_id: String,
    route: RouteMode,
    homeserver: String,
    username: String,
    password: String,
) -> Result<AccountSnapshot> {
    if !state.role.route_is_local(route) {
        bail!("requested Matrix route is owned by the other runtime");
    }

    let account = AccountRef {
        network: Network::Matrix,
        id: account_id,
    };
    let snapshot = state
        .accounts
        .upsert(account.clone(), Some(username.clone()), route)
        .map_err(anyhow::Error::msg)?;
    let snapshot = state
        .accounts
        .set_status(&account, AccountStatus::Connecting, None)
        .unwrap_or(snapshot);
    let _ = state
        .events
        .send(ServerFrame::AccountChanged { account: snapshot });

    let client = build_client(&state, &account, &homeserver).await?;
    client
        .matrix_auth()
        .login_username(&username, &password)
        .initial_device_display_name("web-bridge")
        .send()
        .await
        .context("Matrix login failed")?;

    let session = client
        .matrix_auth()
        .session()
        .context("Matrix login succeeded without a native session")?;
    persist_session(&state, &account, &homeserver, session).await?;
    activate_client(state, account, client).await
}

pub async fn restore_sessions(state: Arc<CoreState>) {
    let accounts: Vec<_> = state
        .accounts
        .list()
        .into_iter()
        .filter(|snapshot| {
            snapshot.account.network == Network::Matrix && state.role.route_is_local(snapshot.route)
        })
        .map(|snapshot| snapshot.account)
        .collect();

    for account in accounts {
        if let Err(error) = restore_account(state.clone(), &account).await {
            mark_error(&state, &account, &format!("Matrix session restore failed: {error:#}"));
        }
    }
}

pub async fn restore_account(state: Arc<CoreState>, account: &AccountRef) -> Result<AccountSnapshot> {
    let snapshot = state
        .accounts
        .get(account)
        .context("Matrix account is not registered")?;
    if account.network != Network::Matrix {
        bail!("account is not a Matrix account");
    }
    if !state.role.route_is_local(snapshot.route) {
        bail!("Matrix account route belongs to the other runtime");
    }

    let session_path = state.account_data_dir(account).join(SESSION_FILE);
    let bytes = tokio::fs::read(&session_path)
        .await
        .with_context(|| format!("read Matrix session from {}", session_path.display()))?;
    let stored: StoredMatrixSession =
        serde_json::from_slice(&bytes).context("decode Matrix session")?;

    let connecting = state
        .accounts
        .set_status(account, AccountStatus::Connecting, None)
        .context("Matrix account disappeared during restore")?;
    let _ = state
        .events
        .send(ServerFrame::AccountChanged { account: connecting });

    let client = build_client(&state, account, &stored.homeserver).await?;
    client
        .restore_session(stored.session)
        .await
        .context("restore Matrix SDK session")?;
    activate_client(state, account.clone(), client).await
}

pub async fn send_message(
    state: &CoreState,
    account: &AccountRef,
    conversation: &ConversationRef,
    parts: &[MessagePart],
) -> Result<()> {
    let handle = state
        .matrix
        .get(account)
        .map(|entry| Arc::clone(entry.value()))
        .context("Matrix account is not connected in this runtime")?;

    if conversation.kind != ConversationKind::Room {
        bail!("Matrix messages require a room conversation");
    }
    let room_id = RoomId::parse(&conversation.id).context("invalid Matrix room id")?;
    let room = handle
        .client
        .get_room(&room_id)
        .context("Matrix room is not known to this account")?;
    let body = text_body(parts)?;
    room.send(RoomMessageEventContent::text_plain(body))
        .await
        .context("send Matrix message")?;
    Ok(())
}

pub fn disconnect(state: &CoreState, account: &AccountRef) {
    if let Some((_, handle)) = state.matrix.remove(account) {
        handle.sync_task.abort();
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

async fn build_client(state: &CoreState, account: &AccountRef, homeserver: &str) -> Result<Client> {
    let store_path = state.account_data_dir(account).join("matrix-store");
    tokio::fs::create_dir_all(&store_path)
        .await
        .context("create Matrix store directory")?;
    Client::builder()
        .homeserver_url(homeserver)
        .sqlite_store(&store_path, None)
        .build()
        .await
        .context("build Matrix client")
}

async fn persist_session(
    state: &CoreState,
    account: &AccountRef,
    homeserver: &str,
    session: MatrixSession,
) -> Result<()> {
    let account_dir = state.account_data_dir(account);
    tokio::fs::create_dir_all(&account_dir)
        .await
        .context("create Matrix account directory")?;
    let bytes = serde_json::to_vec(&StoredMatrixSession {
        homeserver: homeserver.to_owned(),
        session,
    })
    .context("encode Matrix session")?;
    let path = account_dir.join(SESSION_FILE);
    let temp = account_dir.join(format!("{SESSION_FILE}.tmp"));
    tokio::fs::write(&temp, bytes)
        .await
        .context("write Matrix session temp file")?;
    tokio::fs::rename(&temp, &path)
        .await
        .context("commit Matrix session file")?;
    Ok(())
}

async fn activate_client(
    state: Arc<CoreState>,
    account: AccountRef,
    client: Client,
) -> Result<AccountSnapshot> {
    install_message_handler(&client, account.clone(), state.clone());

    let sync_client = client.clone();
    let sync_state = state.clone();
    let sync_account = account.clone();
    let task = tokio::spawn(async move {
        if let Err(error) = sync_client.sync(SyncSettings::default()).await
            && let Some(snapshot) = sync_state.accounts.set_status(
                &sync_account,
                AccountStatus::Error,
                Some(error.to_string()),
            )
        {
            let _ = sync_state
                .events
                .send(ServerFrame::AccountChanged { account: snapshot });
        }
    });

    if let Some((_, old)) = state.matrix.remove(&account) {
        old.sync_task.abort();
    }
    state.matrix.insert(
        account.clone(),
        Arc::new(MatrixHandle {
            client,
            sync_task: task.abort_handle(),
        }),
    );

    let snapshot = state
        .accounts
        .set_status(&account, AccountStatus::Online, None)
        .context("Matrix account disappeared during activation")?;
    let _ = state.events.send(ServerFrame::AccountChanged {
        account: snapshot.clone(),
    });
    Ok(snapshot)
}

fn install_message_handler(client: &Client, account: AccountRef, state: Arc<CoreState>) {
    client.add_event_handler(move |event: OriginalSyncRoomMessageEvent, room: Room| {
        let account = account.clone();
        let state = state.clone();
        async move {
            let body = event.content.body().to_owned();
            let raw = Some(serde_json::json!({
                "event_id": event.event_id.to_string(),
                "sender": event.sender.to_string(),
                "room_id": room.room_id().to_string(),
                "body": body,
            }));
            let message = UnifiedMessage {
                id: event.event_id.to_string(),
                account,
                conversation: ConversationRef {
                    kind: ConversationKind::Room,
                    id: room.room_id().to_string(),
                },
                sender_id: event.sender.to_string(),
                sender_name: None,
                timestamp: Utc::now(),
                parts: vec![MessagePart::Text { text: body }],
                raw,
            };
            let _ = state.events.send(ServerFrame::Message { message });
        }
    });
}

fn mark_error(state: &CoreState, account: &AccountRef, error: &str) {
    if let Some(snapshot) = state.accounts.set_status(
        account,
        AccountStatus::Error,
        Some(error.to_owned()),
    ) {
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
            _ => bail!("Matrix bootstrap sender currently supports text/reply metadata only"),
        }
    }
    if body.is_empty() {
        bail!("message contains no text");
    }
    Ok(body)
}
