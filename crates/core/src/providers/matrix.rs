use std::sync::Arc;

use anyhow::{Context, Result, bail};
use chrono::Utc;
use matrix_sdk::{
    Client, Room,
    attachment::AttachmentConfig,
    authentication::matrix::MatrixSession,
    config::SyncSettings,
    room::reply::{EnforceThread, Reply},
    ruma::{
        EventId, OwnedUserId, RoomId, UserId,
        events::{
            Mentions,
            room::message::{
                AddMentions, OriginalSyncRoomMessageEvent, RoomMessageEventContent,
                RoomMessageEventContentWithoutRelation, TextMessageEventContent,
            },
        },
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::AbortHandle;
use tracing::warn;
use web_bridge_protocol::{
    AccountRef, AccountSnapshot, AccountStatus, ConversationKind, ConversationRef, MessagePart,
    Network, RouteMode, ServerFrame, UnifiedMessage,
};

use crate::{
    private_fs::{restrict_dir, restrict_file},
    state::CoreState,
};

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

struct OutgoingMatrixParts {
    body: String,
    html_body: String,
    mentions: Vec<OwnedUserId>,
    reply: Option<matrix_sdk::ruma::OwnedEventId>,
    attachment: Option<OutgoingAttachment>,
}

enum OutgoingAttachment {
    Image { reference: String },
    File { reference: String, name: String },
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
            mark_error(
                &state,
                &account,
                &format!("Matrix session restore failed: {error:#}"),
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
    let _ = state.events.send(ServerFrame::AccountChanged {
        account: connecting,
    });

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
    let outgoing = parse_outgoing_parts(parts)?;

    if let Some(attachment) = outgoing.attachment {
        let (reference, requested_name) = match attachment {
            OutgoingAttachment::Image { reference } => (reference, None),
            OutgoingAttachment::File { reference, name } => (reference, Some(name)),
        };
        let loaded = state
            .media
            .load_reference(account, &reference)
            .await
            .context("resolve Matrix attachment")?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "matrix_remote_attachment_url_unsupported: upload the attachment to MediaStore first"
                )
            })?;
        let mime = loaded
            .info
            .content_type
            .parse()
            .context("invalid Matrix attachment MIME type")?;
        let filename = requested_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| loaded.info.name.clone());
        let mentions = mentions(&outgoing.mentions);
        let caption = if outgoing.body.is_empty() {
            None
        } else if outgoing.html_body == escape_html(&outgoing.body) {
            Some(TextMessageEventContent::plain(outgoing.body))
        } else {
            Some(TextMessageEventContent::html(
                outgoing.body,
                outgoing.html_body,
            ))
        };
        let config = AttachmentConfig::new()
            .caption(caption)
            .mentions(mentions)
            .reply(outgoing.reply.map(matrix_reply));
        room.send_attachment(filename, &mime, loaded.bytes, config)
            .await
            .context("send Matrix attachment")?;
        return Ok(());
    }

    if outgoing.body.is_empty() {
        bail!("message contains no text or attachment");
    }
    let mut content = if outgoing.html_body == escape_html(&outgoing.body) {
        RoomMessageEventContentWithoutRelation::text_plain(outgoing.body)
    } else {
        RoomMessageEventContentWithoutRelation::text_html(outgoing.body, outgoing.html_body)
    };
    if let Some(mentions) = mentions(&outgoing.mentions) {
        content = content.add_mentions(mentions);
    }
    let content = if let Some(reply) = outgoing.reply {
        room.make_reply_event(content, matrix_reply(reply))
            .await
            .context("build Matrix reply relation")?
    } else {
        RoomMessageEventContent::from(content)
    };
    room.send(content).await.context("send Matrix message")?;
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
    let account_dir = state.account_data_dir(account);
    let store_path = account_dir.join("matrix-store");
    tokio::fs::create_dir_all(&store_path)
        .await
        .context("create Matrix store directory")?;
    restrict_dir(&account_dir).context("restrict Matrix account directory permissions")?;
    restrict_dir(&store_path).context("restrict Matrix store directory permissions")?;
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
    restrict_dir(&account_dir).context("restrict Matrix account directory permissions")?;
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
    restrict_file(&temp).context("restrict Matrix session temp file permissions")?;
    tokio::fs::rename(&temp, &path)
        .await
        .context("commit Matrix session file")?;
    restrict_file(&path).context("restrict Matrix session file permissions")?;
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
            let content = serde_json::to_value(&event.content).unwrap_or(Value::Null);
            let parts = incoming_parts(&content);
            let raw = Some(serde_json::json!({
                "event_id": event.event_id.to_string(),
                "sender": event.sender.to_string(),
                "room_id": room.room_id().to_string(),
                "content": content,
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
                parts,
                raw,
            };
            if let Err(error) = state.storage.store_message(&message) {
                warn!(%error, "failed to persist Matrix message");
            }
            let _ = state.events.send(ServerFrame::Message { message });
        }
    });
}

fn parse_outgoing_parts(parts: &[MessagePart]) -> Result<OutgoingMatrixParts> {
    let mut body = String::new();
    let mut html_body = String::new();
    let mut user_ids = Vec::new();
    let mut reply = None;
    let mut attachment = None;

    for part in parts {
        match part {
            MessagePart::Text { text } => {
                body.push_str(text);
                html_body.push_str(&escape_html(text));
            }
            MessagePart::Mention { id, display_name } => {
                let user_id = UserId::parse(id.clone())
                    .with_context(|| format!("invalid Matrix mention user id {id}"))?;
                let label = display_name.as_deref().unwrap_or(id);
                maybe_separate(&mut body, &mut html_body);
                body.push_str(label);
                html_body.push_str("<a href=\"https://matrix.to/#/");
                html_body.push_str(&escape_html(id));
                html_body.push_str("\">");
                html_body.push_str(&escape_html(label));
                html_body.push_str("</a>");
                user_ids.push(user_id);
            }
            MessagePart::Reply { message_id } => {
                if reply.is_some() {
                    bail!("matrix_multiple_reply_parts_unsupported");
                }
                reply = Some(
                    EventId::parse(message_id.clone())
                        .with_context(|| format!("invalid Matrix reply event id {message_id}"))?,
                );
            }
            MessagePart::Image { url, .. } => {
                if attachment.is_some() {
                    bail!("matrix_multiple_attachments_unsupported");
                }
                attachment = Some(OutgoingAttachment::Image {
                    reference: url.clone(),
                });
            }
            MessagePart::File { url, name } => {
                if attachment.is_some() {
                    bail!("matrix_multiple_attachments_unsupported");
                }
                attachment = Some(OutgoingAttachment::File {
                    reference: url.clone(),
                    name: name.clone(),
                });
            }
            MessagePart::Unsupported { kind, .. } => {
                bail!("matrix_unsupported_message_part: {kind}");
            }
        }
    }

    Ok(OutgoingMatrixParts {
        body,
        html_body,
        mentions: user_ids,
        reply,
        attachment,
    })
}

fn matrix_reply(event_id: matrix_sdk::ruma::OwnedEventId) -> Reply {
    Reply {
        event_id,
        enforce_thread: EnforceThread::Unthreaded,
        add_mentions: AddMentions::Yes,
    }
}

fn mentions(user_ids: &[OwnedUserId]) -> Option<Mentions> {
    (!user_ids.is_empty()).then(|| Mentions::with_user_ids(user_ids.iter().cloned()))
}

fn maybe_separate(body: &mut String, html: &mut String) {
    if !body.is_empty() && !body.ends_with(char::is_whitespace) {
        body.push(' ');
        html.push(' ');
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn incoming_parts(content: &Value) -> Vec<MessagePart> {
    let mut parts = Vec::new();
    if let Some(reply_id) = content
        .pointer("/m.relates_to/m.in_reply_to/event_id")
        .and_then(Value::as_str)
    {
        parts.push(MessagePart::Reply {
            message_id: reply_id.to_owned(),
        });
    }
    if let Some(user_ids) = content
        .pointer("/m.mentions/user_ids")
        .and_then(Value::as_array)
    {
        for id in user_ids.iter().filter_map(Value::as_str) {
            parts.push(MessagePart::Mention {
                id: id.to_owned(),
                display_name: None,
            });
        }
    }

    let kind = content
        .get("msgtype")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let body = content
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "m.text" | "m.notice" | "m.emote" => {
            if !body.is_empty() {
                parts.push(MessagePart::Text {
                    text: body.to_owned(),
                });
            }
        }
        "m.image" => {
            if let Some(url) = content.get("url").and_then(Value::as_str) {
                parts.push(MessagePart::Image {
                    url: url.to_owned(),
                    alt: (!body.is_empty()).then(|| body.to_owned()),
                });
            }
        }
        "m.file" => {
            if let Some(url) = content.get("url").and_then(Value::as_str) {
                parts.push(MessagePart::File {
                    url: url.to_owned(),
                    name: if body.is_empty() {
                        "attachment".into()
                    } else {
                        body.to_owned()
                    },
                });
            }
        }
        other => parts.push(MessagePart::Unsupported {
            kind: other.to_owned(),
            details: content.clone(),
        }),
    }
    if parts.is_empty() {
        parts.push(MessagePart::Unsupported {
            kind: kind.to_owned(),
            details: content.clone(),
        });
    }
    parts
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts::RuntimeRole, state::CoreConfig};

    async fn test_handle() -> Arc<MatrixHandle> {
        let client = Client::builder()
            .homeserver_url("http://127.0.0.1:9")
            .build()
            .await
            .unwrap();
        let task = tokio::spawn(std::future::pending::<()>());
        Arc::new(MatrixHandle {
            client,
            sync_task: task.abort_handle(),
        })
    }

    fn matrix(id: &str) -> AccountRef {
        AccountRef {
            network: Network::Matrix,
            id: id.into(),
        }
    }

    #[test]
    fn maps_matrix_outgoing_reply_mentions_and_attachment() {
        let parts = parse_outgoing_parts(&[
            MessagePart::Reply {
                message_id: "$event:example.org".into(),
            },
            MessagePart::Text {
                text: "hello".into(),
            },
            MessagePart::Mention {
                id: "@alice:example.org".into(),
                display_name: Some("Alice <admin>".into()),
            },
            MessagePart::Image {
                url: "media:11111111-1111-4111-8111-111111111111".into(),
                alt: None,
            },
        ])
        .unwrap();
        assert_eq!(parts.body, "hello Alice <admin>");
        assert!(parts.html_body.contains("https://matrix.to/#/@alice:example.org"));
        assert!(parts.html_body.contains("Alice &lt;admin&gt;"));
        assert_eq!(parts.mentions.len(), 1);
        assert!(parts.reply.is_some());
        assert!(matches!(parts.attachment, Some(OutgoingAttachment::Image { .. })));
    }

    #[test]
    fn maps_matrix_incoming_media_reply_and_mentions() {
        let content = serde_json::json!({
            "msgtype": "m.image",
            "body": "cat.png",
            "url": "mxc://example.org/cat",
            "m.relates_to": {"m.in_reply_to": {"event_id": "$reply:example.org"}},
            "m.mentions": {"user_ids": ["@alice:example.org"]}
        });
        let parts = incoming_parts(&content);
        assert!(matches!(&parts[0], MessagePart::Reply { message_id } if message_id == "$reply:example.org"));
        assert!(matches!(&parts[1], MessagePart::Mention { id, .. } if id == "@alice:example.org"));
        assert!(matches!(&parts[2], MessagePart::Image { url, .. } if url == "mxc://example.org/cat"));
    }

    #[tokio::test]
    async fn disconnecting_one_matrix_account_keeps_the_other_online() {
        let state = CoreState::new(RuntimeRole::Client, CoreConfig::default());
        let account_a = matrix("matrix-a");
        let account_b = matrix("matrix-b");
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
        state.matrix.insert(account_a.clone(), test_handle().await);
        state.matrix.insert(account_b.clone(), test_handle().await);

        disconnect(&state, &account_a);

        assert!(!state.matrix.contains_key(&account_a));
        assert!(state.matrix.contains_key(&account_b));
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
