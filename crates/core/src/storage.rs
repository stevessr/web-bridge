use std::{path::Path, sync::Mutex};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params, types::Type};
use web_bridge_protocol::{
    AccountRef, ConversationKind, ConversationRef, ConversationSnapshot, MessagePart, Network,
    UnifiedMessage,
};

const MAX_QUERY_LIMIT: u32 = 500;

pub struct MessageStore {
    db: Mutex<Connection>,
}

struct StoredMessageRow {
    id: String,
    sender_id: String,
    sender_name: Option<String>,
    timestamp: DateTime<Utc>,
    raw: Option<serde_json::Value>,
}

impl MessageStore {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    pub fn memory() -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> rusqlite::Result<Self> {
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS conversations (
                 network TEXT NOT NULL,
                 account_id TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 conversation_id TEXT NOT NULL,
                 last_message_at TEXT,
                 PRIMARY KEY (network, account_id, kind, conversation_id)
             );
             CREATE TABLE IF NOT EXISTS messages (
                 network TEXT NOT NULL,
                 account_id TEXT NOT NULL,
                 message_id TEXT NOT NULL,
                 conversation_kind TEXT NOT NULL,
                 conversation_id TEXT NOT NULL,
                 sender_id TEXT NOT NULL,
                 sender_name TEXT,
                 timestamp TEXT NOT NULL,
                 raw_json TEXT,
                 PRIMARY KEY (network, account_id, message_id)
             );
             CREATE TABLE IF NOT EXISTS message_parts (
                 network TEXT NOT NULL,
                 account_id TEXT NOT NULL,
                 message_id TEXT NOT NULL,
                 part_index INTEGER NOT NULL,
                 part_json TEXT NOT NULL,
                 PRIMARY KEY (network, account_id, message_id, part_index)
             );
             CREATE TABLE IF NOT EXISTS account_cursors (
                 network TEXT NOT NULL,
                 account_id TEXT NOT NULL,
                 cursor_key TEXT NOT NULL,
                 cursor_value TEXT NOT NULL,
                 PRIMARY KEY (network, account_id, cursor_key)
             );
             CREATE INDEX IF NOT EXISTS messages_conversation_time
                 ON messages(network, account_id, conversation_kind, conversation_id, timestamp);",
        )?;
        Ok(Self {
            db: Mutex::new(connection),
        })
    }

    pub fn store_message(&self, message: &UnifiedMessage) -> rusqlite::Result<()> {
        let mut connection = self.db.lock().map_err(|_| lock_error())?;
        let transaction = connection.transaction()?;
        let network = network_name(message.account.network);
        let kind = conversation_kind_name(message.conversation.kind);
        let timestamp = message.timestamp.to_rfc3339();
        let raw_json = message
            .raw
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(json_error)?;

        transaction.execute(
            "INSERT INTO conversations (
                 network, account_id, kind, conversation_id, last_message_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(network, account_id, kind, conversation_id) DO UPDATE SET
                 last_message_at = excluded.last_message_at",
            params![
                network,
                &message.account.id,
                kind,
                &message.conversation.id,
                &timestamp,
            ],
        )?;
        transaction.execute(
            "INSERT INTO messages (
                 network, account_id, message_id, conversation_kind, conversation_id,
                 sender_id, sender_name, timestamp, raw_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(network, account_id, message_id) DO UPDATE SET
                 conversation_kind = excluded.conversation_kind,
                 conversation_id = excluded.conversation_id,
                 sender_id = excluded.sender_id,
                 sender_name = excluded.sender_name,
                 timestamp = excluded.timestamp,
                 raw_json = excluded.raw_json",
            params![
                network,
                &message.account.id,
                &message.id,
                kind,
                &message.conversation.id,
                &message.sender_id,
                message.sender_name.as_deref(),
                &timestamp,
                raw_json.as_deref(),
            ],
        )?;
        transaction.execute(
            "DELETE FROM message_parts
             WHERE network = ?1 AND account_id = ?2 AND message_id = ?3",
            params![network, &message.account.id, &message.id],
        )?;
        for (index, part) in message.parts.iter().enumerate() {
            let part_json = serde_json::to_string(part).map_err(json_error)?;
            transaction.execute(
                "INSERT INTO message_parts (
                     network, account_id, message_id, part_index, part_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    network,
                    &message.account.id,
                    &message.id,
                    index as i64,
                    part_json,
                ],
            )?;
        }
        transaction.commit()
    }

    pub fn list_conversations(
        &self,
        account: &AccountRef,
        limit: u32,
    ) -> rusqlite::Result<Vec<ConversationSnapshot>> {
        let connection = self.db.lock().map_err(|_| lock_error())?;
        let mut statement = connection.prepare(
            "SELECT kind, conversation_id, last_message_at
             FROM conversations
             WHERE network = ?1 AND account_id = ?2
             ORDER BY last_message_at DESC, conversation_id ASC
             LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                network_name(account.network),
                &account.id,
                bounded_limit(limit)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )?;

        let mut conversations = Vec::new();
        for row in rows {
            let (kind, id, last_message_at) = row?;
            conversations.push(ConversationSnapshot {
                account: account.clone(),
                conversation: ConversationRef {
                    kind: parse_conversation_kind(&kind)?,
                    id,
                },
                last_message_at: last_message_at
                    .as_deref()
                    .map(parse_timestamp)
                    .transpose()?,
            });
        }
        Ok(conversations)
    }

    pub fn list_messages(
        &self,
        account: &AccountRef,
        conversation: &ConversationRef,
        before: Option<DateTime<Utc>>,
        limit: u32,
    ) -> rusqlite::Result<Vec<UnifiedMessage>> {
        let connection = self.db.lock().map_err(|_| lock_error())?;
        let network = network_name(account.network);
        let kind = conversation_kind_name(conversation.kind);
        let before = before.map(|value| value.to_rfc3339());
        let rows = if let Some(before) = before.as_deref() {
            let mut statement = connection.prepare(
                "SELECT message_id, sender_id, sender_name, timestamp, raw_json
                 FROM messages
                 WHERE network = ?1 AND account_id = ?2
                   AND conversation_kind = ?3 AND conversation_id = ?4
                   AND timestamp < ?5
                 ORDER BY timestamp DESC, message_id DESC
                 LIMIT ?6",
            )?;
            statement
                .query_map(
                    params![
                        network,
                        &account.id,
                        kind,
                        &conversation.id,
                        before,
                        bounded_limit(limit)
                    ],
                    read_message_row,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            let mut statement = connection.prepare(
                "SELECT message_id, sender_id, sender_name, timestamp, raw_json
                 FROM messages
                 WHERE network = ?1 AND account_id = ?2
                   AND conversation_kind = ?3 AND conversation_id = ?4
                 ORDER BY timestamp DESC, message_id DESC
                 LIMIT ?5",
            )?;
            statement
                .query_map(
                    params![
                        network,
                        &account.id,
                        kind,
                        &conversation.id,
                        bounded_limit(limit)
                    ],
                    read_message_row,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut messages = Vec::with_capacity(rows.len());
        let mut parts_statement = connection.prepare(
            "SELECT part_json FROM message_parts
             WHERE network = ?1 AND account_id = ?2 AND message_id = ?3
             ORDER BY part_index ASC",
        )?;
        for row in rows.into_iter().rev() {
            let parts = parts_statement
                .query_map(params![network, &account.id, &row.id], |part_row| {
                    let raw = part_row.get::<_, String>(0)?;
                    serde_json::from_str::<MessagePart>(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(error))
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            messages.push(UnifiedMessage {
                id: row.id,
                account: account.clone(),
                conversation: conversation.clone(),
                sender_id: row.sender_id,
                sender_name: row.sender_name,
                timestamp: row.timestamp,
                parts,
                raw: row.raw,
            });
        }
        Ok(messages)
    }

    pub fn set_cursor(&self, account: &AccountRef, key: &str, value: &str) -> rusqlite::Result<()> {
        let connection = self.db.lock().map_err(|_| lock_error())?;
        connection.execute(
            "INSERT INTO account_cursors (network, account_id, cursor_key, cursor_value)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(network, account_id, cursor_key) DO UPDATE SET
                 cursor_value = excluded.cursor_value",
            params![network_name(account.network), &account.id, key, value],
        )?;
        Ok(())
    }

    pub fn cursor(&self, account: &AccountRef, key: &str) -> rusqlite::Result<Option<String>> {
        let connection = self.db.lock().map_err(|_| lock_error())?;
        connection
            .query_row(
                "SELECT cursor_value FROM account_cursors
                 WHERE network = ?1 AND account_id = ?2 AND cursor_key = ?3",
                params![network_name(account.network), &account.id, key],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn remove_account(&self, account: &AccountRef) -> rusqlite::Result<()> {
        let mut connection = self.db.lock().map_err(|_| lock_error())?;
        let transaction = connection.transaction()?;
        let network = network_name(account.network);
        transaction.execute(
            "DELETE FROM message_parts WHERE network = ?1 AND account_id = ?2",
            params![network, &account.id],
        )?;
        transaction.execute(
            "DELETE FROM messages WHERE network = ?1 AND account_id = ?2",
            params![network, &account.id],
        )?;
        transaction.execute(
            "DELETE FROM conversations WHERE network = ?1 AND account_id = ?2",
            params![network, &account.id],
        )?;
        transaction.execute(
            "DELETE FROM account_cursors WHERE network = ?1 AND account_id = ?2",
            params![network, &account.id],
        )?;
        transaction.commit()
    }
}

fn read_message_row(row: &Row<'_>) -> rusqlite::Result<StoredMessageRow> {
    let timestamp = row.get::<_, String>(3)?;
    let raw = row
        .get::<_, Option<String>>(4)?
        .map(|value| {
            serde_json::from_str(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(4, Type::Text, Box::new(error))
            })
        })
        .transpose()?;
    Ok(StoredMessageRow {
        id: row.get(0)?,
        sender_id: row.get(1)?,
        sender_name: row.get(2)?,
        timestamp: parse_timestamp(&timestamp)?,
        raw,
    })
}

fn bounded_limit(limit: u32) -> i64 {
    limit.clamp(1, MAX_QUERY_LIMIT) as i64
}

const fn network_name(network: Network) -> &'static str {
    match network {
        Network::Qq => "qq",
        Network::Matrix => "matrix",
        Network::Telegram => "telegram",
    }
}

const fn conversation_kind_name(kind: ConversationKind) -> &'static str {
    match kind {
        ConversationKind::Private => "private",
        ConversationKind::Group => "group",
        ConversationKind::Room => "room",
        ConversationKind::Channel => "channel",
    }
}

fn parse_conversation_kind(value: &str) -> rusqlite::Result<ConversationKind> {
    match value {
        "private" => Ok(ConversationKind::Private),
        "group" => Ok(ConversationKind::Group),
        "room" => Ok(ConversationKind::Room),
        "channel" => Ok(ConversationKind::Channel),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            Type::Text,
            format!("invalid conversation kind: {value}").into(),
        )),
    }
}

fn parse_timestamp(value: &str) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(error)))
}

fn lock_error() -> rusqlite::Error {
    rusqlite::Error::InvalidQuery
}

fn json_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn message(account: &AccountRef, id: &str, timestamp: DateTime<Utc>) -> UnifiedMessage {
        UnifiedMessage {
            id: id.into(),
            account: account.clone(),
            conversation: ConversationRef {
                kind: ConversationKind::Room,
                id: "!room:example.org".into(),
            },
            sender_id: "@bob:example.org".into(),
            sender_name: Some("Bob".into()),
            timestamp,
            parts: vec![
                MessagePart::Text {
                    text: format!("hello {id}"),
                },
                MessagePart::Mention {
                    id: "@alice:example.org".into(),
                    display_name: Some("Alice".into()),
                },
            ],
            raw: Some(serde_json::json!({"event_id": id})),
        }
    }

    #[test]
    fn stores_and_queries_messages_conversations_and_cursors() {
        let store = MessageStore::memory().unwrap();
        let account = AccountRef {
            network: Network::Matrix,
            id: "alice".into(),
        };
        let first_time = Utc.with_ymd_and_hms(2026, 9, 2, 10, 0, 0).unwrap();
        let second_time = Utc.with_ymd_and_hms(2026, 9, 2, 11, 0, 0).unwrap();
        let first = message(&account, "$event-1", first_time);
        let second = message(&account, "$event-2", second_time);

        store.store_message(&first).unwrap();
        store.store_message(&first).unwrap();
        store.store_message(&second).unwrap();
        store.set_cursor(&account, "sync", "next-batch").unwrap();

        assert_eq!(
            store.cursor(&account, "sync").unwrap().as_deref(),
            Some("next-batch")
        );
        let conversations = store.list_conversations(&account, 50).unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].conversation, first.conversation);
        assert_eq!(conversations[0].last_message_at, Some(second_time));

        assert_eq!(
            store
                .list_messages(&account, &first.conversation, None, 50)
                .unwrap(),
            vec![first.clone(), second.clone()]
        );
        assert_eq!(
            store
                .list_messages(&account, &first.conversation, Some(second_time), 50)
                .unwrap(),
            vec![first]
        );

        let connection = store.db.lock().unwrap();
        let message_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        let part_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM message_parts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(message_count, 2);
        assert_eq!(part_count, 4);
    }

    #[test]
    fn remove_account_purges_only_that_account_history_and_cursor() {
        let store = MessageStore::memory().unwrap();
        let account_a = AccountRef {
            network: Network::Matrix,
            id: "account-a".into(),
        };
        let account_b = AccountRef {
            network: Network::Matrix,
            id: "account-b".into(),
        };
        let timestamp = Utc.with_ymd_and_hms(2026, 9, 3, 1, 0, 0).unwrap();
        let message_a = message(&account_a, "$a", timestamp);
        let message_b = message(&account_b, "$b", timestamp);
        store.store_message(&message_a).unwrap();
        store.store_message(&message_b).unwrap();
        store.set_cursor(&account_a, "sync", "cursor-a").unwrap();
        store.set_cursor(&account_b, "sync", "cursor-b").unwrap();

        store.remove_account(&account_a).unwrap();

        assert!(store.list_conversations(&account_a, 50).unwrap().is_empty());
        assert!(
            store
                .list_messages(&account_a, &message_a.conversation, None, 50)
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.cursor(&account_a, "sync").unwrap(), None);
        assert_eq!(
            store
                .list_messages(&account_b, &message_b.conversation, None, 50)
                .unwrap(),
            vec![message_b]
        );
        assert_eq!(
            store.cursor(&account_b, "sync").unwrap().as_deref(),
            Some("cursor-b")
        );
    }
}
