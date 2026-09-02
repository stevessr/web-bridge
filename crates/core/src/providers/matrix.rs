use std::sync::Arc;

use anyhow::{Context, Result, bail};
use chrono::Utc;
use matrix_sdk::{
    Client, Room,
    config::SyncSettings,
    ruma::{
        RoomId,
        events::room::message::{OriginalSyncRoomMessageEvent, RoomMessageEventContent},
    },
};
use tokio::task::AbortHandle;
use web_bridge_protocol::{
    AccountRef, AccountSnapshot, AccountStatus, ConversationKind, ConversationRef, MessagePart,
    Network, RouteMode, ServerFrame, UnifiedMessage,
};

use crate::state::CoreState;

pub struct MatrixHandle {
    pub client: Client,
    pub sync_task: AbortHandle,
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

    let store_path = state.account_data_dir(&account).join("matrix-store");
    tokio::fs::create_dir_all(&store_path)
        .await
        .context("create Matrix store directory")?;

    let client = Client::builder()
        .homeserver_url(&homeserver)
        .sqlite_store(&store_path, None)
        .build()
        .await
        .context("build Matrix client")?;

    client
        .matrix_auth()
        .login_username(&username, &password)
        .initial_device_display_name("web-bridge")
        .send()
        .await
        .context("Matrix login failed")?;

    install_message_handler(&client, account.clone(), state.clone());

    let sync_client = client.clone();
    let sync_state = state.clone();
    let sync_account = account.clone();
    let task = tokio::spawn(async move {
        if let Err(error) = sync_client.sync(SyncSettings::default()).await {
            if let Some(snapshot) = sync_state.accounts.set_status(
                &sync_account,
                AccountStatus::Error,
                Some(error.to_string()),
            ) {
                let _ = sync_state
                    .events
                    .send(ServerFrame::AccountChanged { account: snapshot });
            }
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
        .context("Matrix account disappeared during login")?;
    let _ = state.events.send(ServerFrame::AccountChanged {
        account: snapshot.clone(),
    });
    Ok(snapshot)
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

fn install_message_handler(client: &Client, account: AccountRef, state: Arc<CoreState>) {
    client.add_event_handler(move |event: OriginalSyncRoomMessageEvent, room: Room| {
        let account = account.clone();
        let state = state.clone();
        async move {
            let raw = serde_json::to_value(&event).ok();
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
                parts: vec![MessagePart::Text {
                    text: event.content.body().to_owned(),
                }],
                raw,
            };
            let _ = state.events.send(ServerFrame::Message { message });
        }
    });
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
