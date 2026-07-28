use serde_json::{json, Map, Value};

/// Converts provider history records into the CodeMUX Event interface.
///
/// Provider-specific loaders may keep their native parsing logic and fixtures;
/// this module is the single seam exposed by the history commands.
pub(crate) fn normalize_history_events(raw_events: Vec<Value>, app_session_id: &str) -> Vec<Value> {
    let mut events = Vec::new();
    for raw in raw_events {
        events.extend(normalize_one(raw));
    }

    for (sequence, event) in events.iter_mut().enumerate() {
        normalize_envelope(event, app_session_id, sequence as u64);
    }
    events
}

fn normalize_one(raw: Value) -> Vec<Value> {
    let Some(event_type) = raw.get("type").and_then(Value::as_str) else {
        return vec![diagnostic_for_raw(raw, "missing_event_type")];
    };

    match event_type {
        "assistant" | "assistant_message" => normalize_assistant(raw),
        "user" | "user_message" => normalize_user(raw),
        "result" => normalize_result(raw),
        "system" | "system_event" | "compact_boundary" => normalize_system(raw),
        "error" | "diagnostic" => vec![raw],
        "tool_started" | "tool_finished" | "turn_finished" => vec![raw],
        "user_input_requested" | "permission_requested" => vec![raw],
        _ => vec![diagnostic_for_raw(raw, "unknown_event")],
    }
}

fn diagnostic_for_raw(raw: Value, subtype: &str) -> Value {
    let event_type = raw.get("type").and_then(Value::as_str).unwrap_or("unknown");
    let mut diagnostic = json!({
        "type": "diagnostic",
        "subtype": subtype,
        "event_type": event_type,
        "raw": raw,
    });
    if let Some(timestamp) = diagnostic
        .get("raw")
        .and_then(|value| value.get("timestamp"))
    {
        diagnostic["timestamp"] = timestamp.clone();
    }
    diagnostic
}

fn normalize_assistant(raw: Value) -> Vec<Value> {
    let is_code_mux_assistant =
        raw.get("type").and_then(Value::as_str) == Some("assistant_message");
    let content = if is_code_mux_assistant {
        raw.get("content").cloned().unwrap_or_else(|| json!([]))
    } else {
        raw.get("message")
            .and_then(|message| message.get("content"))
            .cloned()
            .unwrap_or_else(|| json!([]))
    };
    let assistant_usage = if is_code_mux_assistant {
        raw.get("usage")
    } else {
        raw.get("message").and_then(|message| message.get("usage"))
    };
    let assistant_stop_reason = raw.get("stop_reason").or_else(|| {
        raw.get("message")
            .and_then(|message| message.get("stop_reason"))
    });
    let blocks = content_blocks(content);
    let mut events = Vec::new();
    let mut assistant_content = Vec::new();

    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
            if let Some(tool) = tool_started_from_block(&block, &raw) {
                events.push(tool);
            }
        } else {
            assistant_content.push(block);
        }
    }

    if !assistant_content.is_empty() {
        let mut assistant = json!({
            "type": "assistant_message",
            "content": assistant_content,
        });
        if let Some(usage) = assistant_usage {
            assistant["usage"] = usage.clone();
        }
        if let Some(stop_reason) = assistant_stop_reason {
            assistant["stop_reason"] = stop_reason.clone();
        }
        copy_history_fields(&mut assistant, &raw);
        events.insert(0, assistant);
    }
    events
}

fn normalize_user(raw: Value) -> Vec<Value> {
    let content = if raw.get("type").and_then(Value::as_str) == Some("user_message") {
        raw.get("content").cloned().unwrap_or_else(|| json!(""))
    } else {
        raw.get("message")
            .and_then(|message| message.get("content"))
            .cloned()
            .unwrap_or_else(|| json!(""))
    };

    let blocks = content.as_array().cloned();
    let mut events = Vec::new();
    let mut user_content = Vec::new();

    if let Some(blocks) = blocks {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                if let Some(tool) = tool_finished_from_block(&block, &raw) {
                    events.push(tool);
                }
            } else {
                user_content.push(block);
            }
        }
    } else if !content.is_null()
        && content
            .as_str()
            .map(|text| !text.is_empty())
            .unwrap_or(true)
    {
        user_content.push(json!({
            "type": "text",
            "text": content.as_str().unwrap_or_default(),
        }));
    }

    if !user_content.is_empty() {
        let mut user = json!({
            "type": "user_message",
            "content": user_content,
        });
        copy_history_fields(&mut user, &raw);
        events.insert(0, user);
    }
    events
}

fn normalize_result(raw: Value) -> Vec<Value> {
    let subtype = raw.get("subtype").and_then(Value::as_str).unwrap_or("");
    let is_error = raw
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let outcome = if is_error || subtype != "success" {
        match subtype {
            "interrupted" | "cancelled" => subtype,
            _ => "failed",
        }
    } else {
        "completed"
    };

    let mut event = json!({
        "type": "turn_finished",
        "outcome": outcome,
    });
    if let Some(reason) = raw.get("result").and_then(Value::as_str).filter(|value| {
        !value.is_empty() && *value != "ok" && *value != "success" && outcome == "completed"
    }) {
        event["reason"] = json!(reason);
    } else if outcome != "completed" {
        if let Some(reason) = raw
            .get("result")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            event["reason"] = json!(reason);
        }
    }
    if let Some(duration) = raw.get("duration_ms").and_then(as_u64) {
        event["duration_ms"] = json!(duration);
    }
    if let Some(usage) = normalize_usage(raw.get("usage")) {
        event["usage"] = usage;
    }
    copy_history_fields(&mut event, &raw);
    vec![event]
}

fn normalize_system(raw: Value) -> Vec<Value> {
    let subtype = raw
        .get("subtype")
        .and_then(Value::as_str)
        .unwrap_or("system");
    let mut event = json!({
        "type": "system_event",
        "subtype": subtype,
    });
    for key in [
        "content",
        "compact_metadata",
        "metadata",
        "attempt",
        "max_retries",
        "retry_delay_ms",
        "error_status",
        "error",
        "status",
    ] {
        if let Some(value) = raw.get(key) {
            event[key] = value.clone();
        }
    }
    copy_history_fields(&mut event, &raw);
    vec![event]
}

fn tool_started_from_block(block: &Value, source: &Value) -> Option<Value> {
    let tool_use_id = first_string(block, &["id", "tool_use_id"])?;
    let name = first_string(block, &["name", "tool_name"]).unwrap_or_else(|| "unknown".to_string());
    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
    let input = if input.is_object() {
        input
    } else {
        json!({ "input": input })
    };
    let mut event = json!({
        "type": "tool_started",
        "tool_use_id": tool_use_id,
        "name": name,
        "input": input,
    });
    copy_history_fields(&mut event, source);
    Some(event)
}

fn tool_finished_from_block(block: &Value, source: &Value) -> Option<Value> {
    let tool_use_id = first_string(block, &["tool_use_id", "id"])?;
    let content = stringify(block.get("content").unwrap_or(&Value::Null));
    let is_error = block
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut event = json!({
        "type": "tool_finished",
        "tool_use_id": tool_use_id,
        "content": content,
        "is_error": is_error,
    });
    copy_history_fields(&mut event, source);
    Some(event)
}

fn content_blocks(content: Value) -> Vec<Value> {
    match content {
        Value::Array(blocks) => blocks
            .into_iter()
            .filter(|block| block.is_object())
            .collect(),
        Value::String(text) if !text.is_empty() => vec![json!({ "type": "text", "text": text })],
        _ => Vec::new(),
    }
}

fn normalize_usage(value: Option<&Value>) -> Option<Value> {
    let usage = value?.as_object()?;
    let input = number(usage, &["input_tokens", "inputTokens"]);
    let output = number(usage, &["output_tokens", "outputTokens"]);
    let cached = number(
        usage,
        &[
            "cached_input_tokens",
            "cachedInputTokens",
            "cache_read_input_tokens",
            "cacheReadInputTokens",
        ],
    );
    let reasoning = number(usage, &["reasoning_output_tokens", "reasoningOutputTokens"]);
    Some(json!({
        "input_tokens": input,
        "output_tokens": output,
        "cached_input_tokens": cached,
        "reasoning_output_tokens": reasoning,
    }))
}

fn normalize_envelope(event: &mut Value, app_session_id: &str, sequence: u64) {
    let Some(object) = event.as_object_mut() else {
        return;
    };

    let provider_session_id = object
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && *value != app_session_id)
        .map(ToOwned::to_owned);
    if let Some(provider_session_id) = provider_session_id {
        object
            .entry("agent_session_id")
            .or_insert_with(|| json!(provider_session_id));
    }
    object.insert("session_id".to_string(), json!(app_session_id));

    let existing_event_id = object
        .get("event_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            object
                .get("uuid")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        })
        .map(ToOwned::to_owned);
    object.insert(
        "event_id".to_string(),
        json!(existing_event_id
            .unwrap_or_else(|| { format!("codemux-history-{}-{}", app_session_id, sequence) })),
    );
    object.insert("sequence".to_string(), json!(sequence));
}

fn copy_history_fields(target: &mut Value, source: &Value) {
    let Some(target) = target.as_object_mut() else {
        return;
    };
    for key in [
        "session_id",
        "timestamp",
        "agent_id",
        "agent_session_id",
        "opencode_session_id",
    ] {
        if let Some(value) = source.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }

    if let Some(provider_message_id) = first_string(
        source,
        &[
            "provider_message_id",
            "uuid",
            "id",
            "message_id",
            "messageId",
        ],
    ) {
        target.insert(
            "provider_message_id".to_string(),
            json!(provider_message_id),
        );
        if target.get("type").and_then(Value::as_str) == Some("user_message") {
            target.insert("uuid".to_string(), json!(provider_message_id));
        }
    }
    for (target_key, source_keys) in [
        ("line_index", &["line_index", "__lineIndex"][..]),
        (
            "source_event_index",
            &["source_event_index", "sourceEventIndex"][..],
        ),
        ("turn_ordinal", &["turn_ordinal", "turnOrdinal"][..]),
    ] {
        if let Some(value) = source_keys.iter().find_map(|key| source.get(*key)) {
            target.insert(target_key.to_string(), value.clone());
        }
    }
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn number(object: &Map<String, Value>, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(as_u64))
        .unwrap_or(0)
}

fn as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
        .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()))
}

fn stringify(value: &Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::normalize_history_events;
    use serde_json::json;

    #[test]
    fn normalizes_legacy_messages_and_assigns_one_envelope_sequence() {
        let events = normalize_history_events(
            vec![
                json!({
                    "type": "user",
                    "uuid": "user-1",
                    "message": { "role": "user", "content": "你好" }
                }),
                json!({
                    "type": "assistant",
                    "message": { "role": "assistant", "content": [
                        { "type": "text", "text": "收到" },
                        { "type": "tool_use", "id": "tool-1", "name": "shell", "input": { "command": "pwd" } }
                    ] }
                }),
                json!({
                    "type": "user",
                    "message": { "role": "user", "content": [
                        { "type": "tool_result", "tool_use_id": "tool-1", "content": "ok" }
                    ] }
                }),
                json!({ "type": "result", "subtype": "success", "is_error": false }),
            ],
            "app-1",
        );

        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "user_message",
                "assistant_message",
                "tool_started",
                "tool_finished",
                "turn_finished"
            ]
        );
        for (sequence, event) in events.iter().enumerate() {
            assert_eq!(event["session_id"], "app-1");
            assert_eq!(event["sequence"], sequence as u64);
            assert!(event["event_id"].as_str().is_some());
        }
        assert_eq!(events[0]["provider_message_id"], "user-1");
    }

    #[test]
    fn preserves_compaction_as_a_system_event() {
        let events = normalize_history_events(
            vec![json!({
                "type": "system",
                "subtype": "compact_boundary",
                "compact_metadata": { "trigger": "auto", "pre_tokens": 10 }
            })],
            "app-1",
        );

        assert_eq!(events[0]["type"], "system_event");
        assert_eq!(events[0]["subtype"], "compact_boundary");
        assert_eq!(events[0]["sequence"], 0);
    }

    #[test]
    fn maps_provider_session_id_and_failed_result_without_leaking_old_envelope() {
        let events = normalize_history_events(
            vec![
                json!({
                    "type": "assistant",
                    "session_id": "provider-session-1",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": "失败前的回复" }] }
                }),
                json!({
                    "type": "result",
                    "session_id": "provider-session-1",
                    "subtype": "error",
                    "is_error": true,
                    "result": "upstream down",
                    "usage": { "input_tokens": 3, "output_tokens": 1, "cache_read_input_tokens": 2 }
                }),
            ],
            "app-1",
        );

        assert_eq!(events[0]["type"], "assistant_message");
        assert_eq!(events[1]["type"], "turn_finished");
        assert_eq!(events[1]["outcome"], "failed");
        assert_eq!(events[1]["reason"], "upstream down");
        assert_eq!(events[1]["usage"]["cached_input_tokens"], 2);
        for event in events {
            assert_eq!(event["session_id"], "app-1");
            assert_eq!(event["agent_session_id"], "provider-session-1");
            assert!(event.get("type").and_then(|value| value.as_str()) != Some("assistant"));
            assert!(event.get("type").and_then(|value| value.as_str()) != Some("result"));
        }
    }
}
