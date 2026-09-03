use chrono::{TimeZone, Utc};
use serde_json::{Map, Value, json};
use web_bridge_protocol::{
    AccountRef, ConversationKind, ConversationRef, MessagePart, Network, UnifiedMessage,
};

pub fn action_response(value: &Value) -> Option<(String, Result<(), String>)> {
    let echo = value.get("echo").and_then(value_string_option)?;
    let status = value.get("status")?.as_str()?;
    let retcode = value.get("retcode").and_then(Value::as_i64).unwrap_or(-1);
    if status == "ok" && retcode == 0 {
        return Some((echo, Ok(())));
    }

    let detail = value
        .get("wording")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            value
                .get("message")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("NapCat action failed");
    Some((
        echo,
        Err(format!("{detail} (status={status}, retcode={retcode})")),
    ))
}

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
        account: AccountRef {
            network: Network::Qq,
            id: self_id,
        },
        conversation: ConversationRef {
            kind,
            id: conversation_id,
        },
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
    let mut actions = build_send_actions(conversation, parts, echo)?;
    if actions.len() != 1 {
        return Err("message requires multiple NapCat actions");
    }
    Ok(actions.remove(0).1)
}

pub fn build_send_actions(
    conversation: &ConversationRef,
    parts: &[MessagePart],
    echo: String,
) -> Result<Vec<(String, Value)>, &'static str> {
    if parts.is_empty() {
        return Err("QQ message has no parts");
    }
    let has_file = parts
        .iter()
        .any(|part| matches!(part, MessagePart::File { .. }));
    if has_file
        && parts
            .iter()
            .any(|part| matches!(part, MessagePart::Reply { .. }))
    {
        return Err("QQ file upload cannot preserve reply relation");
    }

    let message_segments = parts
        .iter()
        .filter(|part| !matches!(part, MessagePart::File { .. }))
        .map(to_onebot_segment)
        .collect::<Result<Vec<_>, _>>()?;
    let files: Vec<_> = parts
        .iter()
        .filter_map(|part| match part {
            MessagePart::File { url, name } => Some((url, name)),
            _ => None,
        })
        .collect();
    let action_count = usize::from(!message_segments.is_empty()) + files.len();
    let mut actions = Vec::with_capacity(action_count);

    if !message_segments.is_empty() {
        let action_echo = if action_count == 1 {
            echo.clone()
        } else {
            format!("{echo}:message")
        };
        actions.push((
            action_echo.clone(),
            build_message_action(conversation, message_segments, action_echo)?,
        ));
    }

    for (index, (file, name)) in files.into_iter().enumerate() {
        if file.trim().is_empty() {
            return Err("QQ file reference is empty");
        }
        let action_echo = if action_count == 1 {
            echo.clone()
        } else {
            format!("{echo}:file:{index}")
        };
        actions.push((
            action_echo.clone(),
            build_file_action(
                conversation,
                file,
                name.as_deref().filter(|value| !value.trim().is_empty()),
                action_echo,
            )?,
        ));
    }

    if actions.is_empty() {
        return Err("QQ message has no sendable parts");
    }
    Ok(actions)
}

fn build_message_action(
    conversation: &ConversationRef,
    message: Vec<Value>,
    echo: String,
) -> Result<Value, &'static str> {
    let (action, target_key) = match conversation.kind {
        ConversationKind::Private => ("send_private_msg", "user_id"),
        ConversationKind::Group => ("send_group_msg", "group_id"),
        _ => return Err("QQ only supports private/group conversations"),
    };

    let mut params = Map::new();
    params.insert(
        target_key.to_owned(),
        Value::String(conversation.id.clone()),
    );
    params.insert("message".to_owned(), Value::Array(message));

    Ok(json!({
        "action": action,
        "params": params,
        "echo": echo,
    }))
}

fn build_file_action(
    conversation: &ConversationRef,
    file: &str,
    name: Option<&str>,
    echo: String,
) -> Result<Value, &'static str> {
    let (action, target_key) = match conversation.kind {
        ConversationKind::Private => ("upload_private_file", "user_id"),
        ConversationKind::Group => ("upload_group_file", "group_id"),
        _ => return Err("QQ files only support private/group conversations"),
    };
    let name = name
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| default_file_name(file));
    Ok(json!({
        "action": action,
        "params": {
            target_key: conversation.id,
            "file": file,
            "name": name,
        },
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
    let ty = segment
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let data = segment.get("data").unwrap_or(&Value::Null);
    match ty {
        "text" => MessagePart::Text {
            text: data
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        },
        "image" => MessagePart::Image {
            url: data
                .get("url")
                .or_else(|| data.get("file"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            alt: data
                .get("summary")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        },
        "file" => MessagePart::File {
            url: data
                .get("url")
                .or_else(|| data.get("file_id"))
                .or_else(|| data.get("file"))
                .map(value_string)
                .unwrap_or_default(),
            name: data
                .get("name")
                .or_else(|| data.get("file"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        },
        "at" => MessagePart::Mention {
            id: data.get("qq").map(value_string).unwrap_or_default(),
            display_name: data
                .get("name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        },
        "reply" => MessagePart::Reply {
            message_id: data.get("id").map(value_string).unwrap_or_default(),
        },
        _ => MessagePart::Unsupported {
            raw: segment.clone(),
        },
    }
}

fn to_onebot_segment(part: &MessagePart) -> Result<Value, &'static str> {
    Ok(match part {
        MessagePart::Text { text } => json!({"type":"text","data":{"text":text}}),
        MessagePart::Image { url, .. } => json!({"type":"image","data":{"file":url}}),
        MessagePart::Mention { id, .. } => json!({"type":"at","data":{"qq":id}}),
        MessagePart::Reply { message_id } => {
            json!({"type":"reply","data":{"id":message_id}})
        }
        MessagePart::File { .. } => return Err("QQ files require an upload action"),
        MessagePart::Unsupported { .. } => return Err("cannot send unsupported message part"),
    })
}

fn default_file_name(file: &str) -> String {
    file.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .filter(|part| !part.contains(':'))
        .unwrap_or("attachment")
        .to_owned()
}

fn numberish(value: &Value) -> Option<String> {
    match value {
        Value::String(v) => Some(v.clone()),
        Value::Number(v) => Some(v.to_string()),
        _ => None,
    }
}

fn value_string_option(value: &Value) -> Option<String> {
    numberish(value)
}

fn value_string(value: &Value) -> String {
    numberish(value).unwrap_or_else(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private(id: &str) -> ConversationRef {
        ConversationRef {
            kind: ConversationKind::Private,
            id: id.into(),
        }
    }

    fn group(id: &str) -> ConversationRef {
        ConversationRef {
            kind: ConversationKind::Group,
            id: id.into(),
        }
    }

    #[test]
    fn parses_successful_action_response() {
        let response = json!({
            "status": "ok",
            "retcode": 0,
            "data": {"message_id": 42},
            "echo": "request-1"
        });
        assert_eq!(
            action_response(&response),
            Some(("request-1".into(), Ok(())))
        );
    }

    #[test]
    fn parses_failed_action_response_wording() {
        let response = json!({
            "status": "failed",
            "retcode": 1200,
            "message": "bad request",
            "wording": "group not found",
            "echo": "request-2"
        });
        let (echo, result) = action_response(&response).unwrap();
        assert_eq!(echo, "request-2");
        assert_eq!(
            result.unwrap_err(),
            "group not found (status=failed, retcode=1200)"
        );
    }

    #[test]
    fn message_event_is_not_an_action_response() {
        assert!(
            action_response(&json!({
                "post_type": "message",
                "self_id": 10001,
                "message_id": 1
            }))
            .is_none()
        );
    }

    #[test]
    fn qq_message_parts_map_to_onebot_segments() {
        let action = build_send_action(
            &group("123"),
            &[
                MessagePart::Reply {
                    message_id: "44".into(),
                },
                MessagePart::Mention {
                    id: "10001".into(),
                    display_name: None,
                },
                MessagePart::Text {
                    text: "hello".into(),
                },
                MessagePart::Image {
                    url: "https://example.test/cat.png".into(),
                    alt: None,
                },
            ],
            "echo-a".into(),
        )
        .unwrap();
        assert_eq!(action["action"], "send_group_msg");
        assert_eq!(action["params"]["message"][0]["type"], "reply");
        assert_eq!(action["params"]["message"][1]["type"], "at");
        assert_eq!(action["params"]["message"][2]["type"], "text");
        assert_eq!(action["params"]["message"][3]["type"], "image");
    }

    #[test]
    fn qq_files_use_private_or_group_upload_actions() {
        let file = MessagePart::File {
            url: "/srv/media/a.bin".into(),
            name: Some("report.bin".into()),
        };
        let private_action =
            build_send_action(&private("10001"), &[file.clone()], "p".into()).unwrap();
        assert_eq!(private_action["action"], "upload_private_file");
        assert_eq!(private_action["params"]["user_id"], "10001");
        assert_eq!(private_action["params"]["name"], "report.bin");

        let group_action = build_send_action(&group("20001"), &[file], "g".into()).unwrap();
        assert_eq!(group_action["action"], "upload_group_file");
        assert_eq!(group_action["params"]["group_id"], "20001");
    }

    #[test]
    fn qq_text_and_file_split_into_independent_ack_actions() {
        let actions = build_send_actions(
            &private("10001"),
            &[
                MessagePart::Text {
                    text: "caption".into(),
                },
                MessagePart::File {
                    url: "/srv/media/a.bin".into(),
                    name: Some("a.bin".into()),
                },
            ],
            "request".into(),
        )
        .unwrap();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].0, "request:message");
        assert_eq!(actions[0].1["action"], "send_private_msg");
        assert_eq!(actions[1].0, "request:file:0");
        assert_eq!(actions[1].1["action"], "upload_private_file");
    }

    #[test]
    fn incoming_qq_media_mentions_and_replies_are_unified_parts() {
        let message = event_to_message(&json!({
            "post_type":"message",
            "message_type":"group",
            "self_id":10000,
            "user_id":10001,
            "group_id":20000,
            "message_id":30000,
            "time":1,
            "message":[
                {"type":"reply","data":{"id":"12"}},
                {"type":"at","data":{"qq":"10002"}},
                {"type":"image","data":{"url":"https://img.test/a.jpg"}},
                {"type":"file","data":{"file_id":"file-1","file":"a.zip"}}
            ]
        }))
        .unwrap();
        assert!(
            matches!(&message.parts[0], MessagePart::Reply { message_id } if message_id == "12")
        );
        assert!(matches!(&message.parts[1], MessagePart::Mention { id, .. } if id == "10002"));
        assert!(
            matches!(&message.parts[2], MessagePart::Image { url, .. } if url == "https://img.test/a.jpg")
        );
        assert!(
            matches!(&message.parts[3], MessagePart::File { url, name } if url == "file-1" && name.as_deref() == Some("a.zip"))
        );
    }
}
