use std::{path::Path, sync::Mutex};

use rusqlite::{Connection, OptionalExtension, params};
use web_bridge_protocol::{
    AccountRef, ConversationKind, ConversationRef, MessagePart, Network, UnifiedMessage,
};

pub struct MessageStore {
    db: Mutex<Connection>,
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

    pub fn set_cursor(
        &self,
        account: &AccountRef,
        key: &str,
        value: &str,
    ) -> rusqlite::Result<()> {
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

fn lock_error() -> rusqlite::Error {
    rusqlite::Error::InvalidQuery
}

fn json_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use web_bridge_protocol::MessagePart;

    #[test]
    fn stores_messages_and_account_cursors() {
        let store = MessageStore::memory().unwrap();
        let account = AccountRef {
            network: Network::Matrix,
            id: "alice".into(),
        };
        let message = UnifiedMessage {
            id: "$event".into(),
            account: account.clone(),
            conversation: ConversationRef {
                kind: ConversationKind::Room,
                id: "!room:example.org".into(),
            },
            sender_id: "@bob:example.org".into(),
            sender_name: Some("Bob".into()),
            timestamp: Utc::now(),
            parts: vec![
                MessagePart::Text {
                    text: "hello".into(),
                },
                MessagePart::Mention {
                    id: "@alice:example.org".into(),
                    display_name: Some("Alice".into()),
                },
            ],
            raw: None,
        };

        store.store_message(&message).unwrap();
        store.store_message(&message).unwrap();
        store.set_cursor(&account, "sync", "next-batch").unwrap();

        assert_eq!(
            store.cursor(&account, "sync").unwrap().as_deref(),
            Some("next-batch")
        );
        let connection = store.db.lock().unwrap();
        let message_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        let part_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM message_parts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(message_count, 1);
        assert_eq!(part_count, 2);
    }
}
