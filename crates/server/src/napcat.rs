use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use web_bridge_protocol::{
    AccountRef, ConversationKind, ConversationRef, MessagePart, Network, UnifiedMessage,
};

pub fn event_to_message(value: &Value) -> Option<UnifiedMessage> {
    if value.get("post_type")?.as_str()? != "message" {
        return None;
    }

    let self_id = numberish(value.get("self_id")?)?;
    let message_id = numberish(value.get("message_id")?)?;
    let sender_id = numberish(value.get("user_id")?)?;
    let message_type = value.get("message_type")?.as_str()?;
    let (kind, conversation_id) = match message_type {
        "private" => (ConversationKind::Private, sender_id.clone()),
        "group" => (ConversationKind::Group, numberish(value.get("group_id")?)?),
        _ => return None,
    };

    let ts = value
        .get("time")
        .and_then(Value::as_i64)
        .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
        .unwrap_or_else(Utc::now);

    let sender_name = value
        .pointer("/sender/card")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| value.pointer("/sender/nickname").and_then(Value::as_str))
        .map(ToOwned::to_owned);

    Some(UnifiedMessage {
        id: message_id,
        account: AccountRef { network: Network::Qq, id: self_id },
        conversation: ConversationRef { kind, id: conversation_id },
        sender_id,
        sender_name,
        timestamp: ts,
        parts: parse_parts(value.get("message")),
        raw: Some(value.clone()),
    })
}

pub fn build_send_action(
    conversation: &ConversationRef,
    parts: &[MessagePart],
    echo: String,
) -> Result<Value, &'static str> {
    let message = parts.iter().map(to_onebot_segment).collect::<Result<Vec<_>, _>>()?;
    let (action, target_key) = match conversation.kind {
        ConversationKind::Private => ("send_private_msg", "user_id"),
        ConversationKind::Group => ("send_group_msg", "group_id"),
        _ => return Err("QQ only supports private/group conversations"),
    };

    Ok(json!({
        "action": action,
        "params": { target_key: conversation.id, "message": message },
        "echo": echo,
    }))
}

fn parse_parts(message: Option<&Value>) -> Vec<MessagePart> {
    match message {
        Some(Value::Array(items)) => items.iter().map(from_onebot_segment).collect(),
        Some(Value::String(text)) => vec![MessagePart::Text { text: text.clone() }],
        Some(other) => vec![MessagePart::Unsupported { raw: other.clone() }],
        None => vec![],
    }
}

fn from_onebot_segment(segment: &Value) -> MessagePart {
    let ty = segment.get("type").and_then(Value::as_str).unwrap_or("unknown");
    let data = segment.get("data").unwrap_or(&Value::Null);
    match ty {
        "text" => MessagePart::Text {
            text: data.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
        },
        "image" => MessagePart::Image {
            url: data.get("url").or_else(|| data.get("file")).and_then(Value::as_str).unwrap_or_default().to_owned(),
            alt: data.get("summary").and_then(Value::as_str).map(ToOwned::to_owned),
        },
        "file" => MessagePart::File {
            url: data.get("url").or_else(|| data.get("file")).and_then(Value::as_str).unwrap_or_default().to_owned(),
            name: data.get("name").and_then(Value::as_str).map(ToOwned::to_owned),
        },
        "at" => MessagePart::Mention {
            id: data.get("qq").map(value_string).unwrap_or_default(),
            display_name: data.get("name").and_then(Value::as_str).map(ToOwned::to_owned),
        },
        "reply" => MessagePart::Reply {
            message_id: data.get("id").map(value_string).unwrap_or_default(),
        },
        _ => MessagePart::Unsupported { raw: segment.clone() },
    }
}

fn to_onebot_segment(part: &MessagePart) -> Result<Value, &'static str> {
    Ok(match part {
        MessagePart::Text { text } => json!({"type":"text","data":{"text":text}}),
        MessagePart::Image { url, .. } => json!({"type":"image","data":{"file":url}}),
        MessagePart::File { url, name } => json!({"type":"file","data":{"file":url,"name":name}}),
        MessagePart::Mention { id, .. } => json!({"type":"at","data":{"qq":id}}),
        MessagePart::Reply { message_id } => json!({"type":"reply","data":{"id":message_id}}),
        MessagePart::Unsupported { .. } => return Err("cannot send unsupported message part"),
    })
}

fn numberish(value: &Value) -> Option<String> {
    match value {
        Value::String(v) => Some(v.clone()),
        Value::Number(v) => Some(v.to_string()),
        _ => None,
    }
}

fn value_string(value: &Value) -> String {
    numberish(value).unwrap_or_else(|| value.to_string())
}
