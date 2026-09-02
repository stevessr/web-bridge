use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    Qq,
    Matrix,
    Telegram,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteMode {
    Server,
    Client,
}

impl Network {
    pub const fn permits_route(self, route: RouteMode) -> bool {
        match self {
            Self::Qq => matches!(route, RouteMode::Server),
            Self::Matrix | Self::Telegram => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountRef {
    pub network: Network,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    Private,
    Group,
    Room,
    Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationRef {
    pub kind: ConversationKind,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MessagePart {
    Text { text: String },
    Image { url: String, alt: Option<String> },
    File { url: String, name: Option<String> },
    Mention { id: String, display_name: Option<String> },
    Reply { message_id: String },
    Unsupported { raw: Value },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnifiedMessage {
    pub id: String,
    pub account: AccountRef,
    pub conversation: ConversationRef,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub parts: Vec<MessagePart>,
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Hello { protocol: u16, device_id: String },
    Command { request_id: Uuid, command: Command },
    Ping { nonce: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    SendMessage {
        account: AccountRef,
        route: RouteMode,
        conversation: ConversationRef,
        parts: Vec<MessagePart>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Ready { protocol: u16 },
    Message { message: UnifiedMessage },
    Ack { request_id: Uuid },
    Error { request_id: Option<Uuid>, code: String, message: String },
    Pong { nonce: String },
    ProviderState { network: Network, account_id: String, online: bool },
}
