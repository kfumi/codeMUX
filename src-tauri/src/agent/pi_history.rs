//! pi native history: load CodeMUX-managed session JSONL and convert to timeline events.

use std::path::Path;

use log::{debug, info};
use serde_json::{json, Value};
use tauri::State;

use crate::config::types::AgentKind;

use super::history_events::normalize_history_events;
use super::native_jsonl::read_json_stream_values;
use super::session_lifecycle::get_agent_session_id;

pub(crate) fn convert_pi_history_values_to_events(
    raw_events: &[Value],
    app_session_id: &str,
) -> Vec<Value> {
    let mut intermediate = Vec::new();

    for raw in raw_events {
        let Some(entry_type) = raw.get("type").and_then(Value::as_str) else {
            continue;
        };

        match entry_type {
            "message" => {
                if let Some(converted) = convert_pi_message_entry(raw) {
                    intermediate.push(converted);
                }
            }
            "compaction_end" if raw.get("aborted").and_then(Value::as_bool) != Some(true) => {
                let reason = raw.get("reason").and_then(Value::as_str).unwrap_or("auto");
                intermediate.push(json!({
                    "type": "system",
                    "subtype": "compact_boundary",
                    "content": "Conversation compacted",
                    "compact_metadata": {
                        "trigger": if reason == "manual" { "manual" } else { "auto" },
                    },
                }));
            }
            _ => {}
        }
    }

    let normalized = normalize_history_events(intermediate, app_session_id);
    inject_pi_turn_boundaries(normalized)
}

/// Pi JSONL records one assistant `message` per speak/tool step. A single user
/// prompt can span many of those rows; only the end of the user turn should
/// receive `turn_finished`, not every intermediate assistant message.
fn inject_pi_turn_boundaries(mut events: Vec<Value>) -> Vec<Value> {
    if events.is_empty() {
        return events;
    }

    let turn_ranges = collect_pi_user_turn_ranges(&events);
    for (start, end) in turn_ranges.into_iter().rev() {
        if !pi_turn_segment_needs_boundary(&events[start..=end]) {
            continue;
        }
        if events[end].get("type").and_then(Value::as_str) == Some("turn_finished") {
            continue;
        }
        events.insert(end + 1, pi_turn_boundary_event(&events[start..=end]));
    }

    events
}

fn collect_pi_user_turn_ranges(events: &[Value]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut turn_start: Option<usize> = None;

    for (index, event) in events.iter().enumerate() {
        if !is_real_pi_user_turn_start(event) {
            continue;
        }
        if let Some(start) = turn_start {
            if index > start {
                ranges.push((start, index - 1));
            }
        }
        // 范围包含用户消息本身：pi_turn_boundary_event 依赖段首的
        // user_message 时间戳推算 turn 时长（duration_ms）。
        turn_start = Some(index);
    }

    if let Some(start) = turn_start {
        if start < events.len() {
            ranges.push((start, events.len() - 1));
        }
    } else {
        ranges.push((0, events.len() - 1));
    }

    ranges
}

fn is_real_pi_user_turn_start(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("user_message")
}

fn pi_turn_segment_needs_boundary(segment: &[Value]) -> bool {
    segment.iter().any(|event| {
        matches!(
            event.get("type").and_then(Value::as_str),
            Some("assistant_message") | Some("tool_started")
        )
    })
}

fn pi_turn_boundary_event(segment: &[Value]) -> Value {
    for event in segment.iter().rev() {
        if event.get("type").and_then(Value::as_str) != Some("assistant_message") {
            continue;
        }
        let stop_reason = event
            .get("stop_reason")
            .and_then(Value::as_str)
            .unwrap_or("stop");
        if stop_reason == "error" {
            let mut boundary = pi_turn_result_for_assistant_message(stop_reason, event);
            pi_attach_duration(&mut boundary, segment);
            return boundary;
        }
        break;
    }

    let mut boundary = pi_turn_completed_event();
    pi_attach_duration(&mut boundary, segment);
    boundary
}

/// 从段内事件时间戳推算 turn 时长（用户消息 → 最后一条助手消息），
/// 供前端 footer 的「耗时」展示，避免 duration_ms 缺失被当成 0。
fn pi_attach_duration(event: &mut Value, segment: &[Value]) {
    if let Some(duration_ms) = pi_segment_duration_ms(segment) {
        event["duration_ms"] = json!(duration_ms);
    }
}

fn pi_segment_duration_ms(segment: &[Value]) -> Option<u64> {
    let start = segment
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("user_message"))
        .and_then(|event| event.get("timestamp"))
        .and_then(pi_timestamp_ms)?;
    let end = segment
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("assistant_message"))
        .and_then(|event| event.get("timestamp"))
        .and_then(pi_timestamp_ms)?;
    (end > start).then_some(end - start)
}

fn pi_timestamp_ms(value: &Value) -> Option<u64> {
    if let Some(text) = value.as_str() {
        return chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|time| time.timestamp_millis().max(0) as u64);
    }
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|millis| u64::try_from(millis).ok()))
}

fn pi_turn_completed_event() -> Value {
    json!({
        "type": "turn_finished",
        "outcome": "completed",
    })
}

fn convert_pi_message_entry(raw: &Value) -> Option<Value> {
    let message = raw.get("message")?;
    let role = message.get("role").and_then(Value::as_str)?;
    // pi 把工具结果记录为独立的 `role:"toolResult"` 消息条目（toolCallId /
    // isError 在 message 层），必须转成 normalize 可配对的 tool_result 块，
    // 否则 tool_started 永远悬空（turn 卡在 running、工具状态/响应丢失）。
    if role == "toolResult" {
        return convert_pi_tool_result_entry(raw, message);
    }
    if role != "user" && role != "assistant" {
        return None;
    }

    let content = message
        .get("content")
        .map(convert_pi_content_blocks)
        .unwrap_or_else(|| json!([]));

    let mut converted = json!({
        "type": role,
        "message": {
            "role": role,
            "content": content,
        },
    });

    if let Some(id) = raw.get("id") {
        converted["uuid"] = id.clone();
        converted["provider_message_id"] = id.clone();
    }
    if let Some(timestamp) = raw.get("timestamp") {
        converted["timestamp"] = timestamp.clone();
    }
    if let Some(message) = raw.get("message") {
        if let Some(stop_reason) = message.get("stopReason").and_then(Value::as_str) {
            converted["stop_reason"] = json!(stop_reason);
        }
    }
    if let Some(line_index) = raw.get("__lineIndex") {
        converted["line_index"] = line_index.clone();
        converted["source_event_index"] = line_index.clone();
    }

    Some(converted)
}

/// pi 的工具结果条目 → normalize 可识别的 user tool_result 块。
/// `tool_finished_from_block` 会把 content 字符串化，这里把 pi 的
/// `[{type:"text",...}]` 块数组拍平为纯文本，避免渲染成 JSON 转储。
fn convert_pi_tool_result_entry(raw: &Value, message: &Value) -> Option<Value> {
    let tool_use_id = message.get("toolCallId").and_then(Value::as_str)?;
    let content = flatten_pi_content_text(message.get("content").unwrap_or(&Value::Null));
    let mut converted = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": message.get("isError").and_then(Value::as_bool).unwrap_or(false),
            }],
        },
    });
    if let Some(timestamp) = raw.get("timestamp") {
        converted["timestamp"] = timestamp.clone();
    }
    if let Some(line_index) = raw.get("__lineIndex") {
        converted["line_index"] = line_index.clone();
        converted["source_event_index"] = line_index.clone();
    }
    Some(converted)
}

/// 把 pi 内容块数组拍平为纯文本（拼接 text 块）；字符串原样返回。
fn flatten_pi_content_text(content: &Value) -> Value {
    match content {
        Value::Array(blocks) => {
            let mut texts: Vec<String> = Vec::new();
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            texts.push(text.to_string());
                        }
                    }
                }
            }
            if texts.is_empty() {
                json!("")
            } else {
                json!(texts.join("\n\n"))
            }
        }
        Value::String(text) => json!(text),
        Value::Null => json!(""),
        other => other.clone(),
    }
}

fn convert_pi_content_blocks(content: &Value) -> Value {
    let Some(blocks) = content.as_array() else {
        return json!([]);
    };

    let converted: Vec<Value> = blocks
        .iter()
        .filter_map(|block| {
            let block_type = block.get("type").and_then(Value::as_str)?;
            match block_type {
                "text" | "thinking" | "image" => Some(block.clone()),
                "toolCall" => {
                    let id = block.get("id").and_then(Value::as_str)?;
                    let name = block.get("name").and_then(Value::as_str)?;
                    Some(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": block.get("arguments").cloned().unwrap_or_else(|| json!({})),
                    }))
                }
                "toolResult" => {
                    let tool_use_id = block
                        .get("toolCallId")
                        .or_else(|| block.get("tool_use_id"))
                        .and_then(Value::as_str)?;
                    let content = block
                        .get("content")
                        .or_else(|| block.get("result"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    Some(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": content,
                        "is_error": block.get("isError").and_then(Value::as_bool).unwrap_or(false),
                    }))
                }
                _ => None,
            }
        })
        .collect();

    json!(converted)
}

fn pi_turn_result_for_assistant_message(stop_reason: &str, _event: &Value) -> Value {
    let is_error = stop_reason == "error";
    json!({
        "type": "turn_finished",
        "outcome": if is_error { "failed" } else { "completed" },
        "is_error": is_error,
    })
}

fn looks_like_pi_session_path(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
}

#[tauri::command]
pub async fn load_pi_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<Value>, String> {
    debug!(
        target: "agent",
        "Loading pi session events for app_session_id={}",
        app_session_id
    );

    let Some(session_file) = get_agent_session_id(state.inner(), &app_session_id, AgentKind::Pi)?
    else {
        info!(
            target: "agent",
            "No pi mapping found for app_session_id={}",
            app_session_id
        );
        return Ok(Vec::new());
    };

    if !looks_like_pi_session_path(&session_file) {
        return Err(format!(
            "Invalid pi session mapping for app_session_id={}: expected absolute .jsonl path",
            app_session_id
        ));
    }

    let path = Path::new(&session_file).to_path_buf();
    if !path.exists() {
        info!(
            target: "agent",
            "pi session file not found for app_session_id={} path={}",
            app_session_id,
            path.display()
        );
        return Ok(Vec::new());
    }

    let normalize_session_id = app_session_id.clone();
    let normalized = tokio::task::spawn_blocking(move || -> Result<Vec<Value>, String> {
        let raw_events = read_json_stream_values(&path)?;
        Ok(convert_pi_history_values_to_events(
            &raw_events,
            &normalize_session_id,
        ))
    })
    .await
    .map_err(|error| format!("Failed to join pi history loader: {}", error))??;

    info!(
        target: "agent",
        "Loaded {} CodeMUX events from pi JSONL for app_session_id={}",
        normalized.len(),
        app_session_id
    );
    Ok(normalized)
}

pub(crate) async fn load_pi_session_events_internal(
    state: State<'_, crate::AppState>,
    app_session_id: &str,
) -> Result<Vec<Value>, String> {
    load_pi_session_events(state, app_session_id.to_string()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    fn test_home(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("codemux-pi-history-{}-{}", name, Uuid::new_v4()))
    }

    #[test]
    fn converts_pi_message_entries_and_turn_boundaries() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "session",
                    "id": "pi-session-1",
                    "cwd": "C:/workspace"
                }),
                json!({
                    "type": "message",
                    "id": "user-1",
                    "timestamp": "2026-09-03T08:05:53.950Z",
                    "message": {
                        "role": "user",
                        "content": [{ "type": "text", "text": "你好" }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "timestamp": "2026-09-03T08:06:07.481Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [
                            { "type": "thinking", "thinking": "greeting" },
                            { "type": "text", "text": "你好！" }
                        ],
                        "usage": {
                            "input": 10,
                            "output": 5,
                            "cacheRead": 0,
                            "cacheWrite": 0
                        }
                    }
                }),
            ],
            "app-1",
        );

        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["user_message", "assistant_message", "turn_finished"]
        );
        assert_eq!(events[0]["provider_message_id"], "user-1");
        assert_eq!(events[1]["provider_message_id"], "assistant-1");
        assert_eq!(events[2]["outcome"], "completed");
        // turn 时长由段内条目时间戳推算（用户消息 → 最后一条助手消息）。
        assert_eq!(events[2]["duration_ms"], 13531);
        assert_eq!(events[0]["session_id"], "app-1");
    }

    #[test]
    fn converts_tool_calls_and_results() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "message": {
                        "role": "assistant",
                        "stopReason": "toolUse",
                        "content": [
                            {
                                "type": "toolCall",
                                "id": "call-1",
                                "name": "read",
                                "arguments": { "path": "a.ts" }
                            }
                        ]
                    }
                }),
                // pi 真实形状：工具结果是独立的 role:"toolResult" 消息条目。
                json!({
                    "type": "message",
                    "id": "result-1",
                    "timestamp": "2026-09-03T08:34:23.014Z",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call-1",
                        "toolName": "read",
                        "content": [{ "type": "text", "text": "file body" }],
                        "isError": false
                    }
                }),
            ],
            "app-1",
        );

        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["tool_started", "tool_finished", "turn_finished"]
        );
        assert_eq!(events[1]["tool_use_id"], "call-1");
        assert_eq!(events[1]["content"], "file body");
        assert_eq!(events[1]["is_error"], false);
    }

    #[test]
    fn flattens_error_tool_result_content() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "message": {
                        "role": "assistant",
                        "content": [{
                            "type": "toolCall",
                            "id": "call-err",
                            "name": "bash",
                            "arguments": { "command": "tree" }
                        }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "result-err",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call-err",
                        "toolName": "bash",
                        "content": [
                            { "type": "text", "text": "tree: command not found" },
                            { "type": "text", "text": "Command exited with code 127" }
                        ],
                        "details": {},
                        "isError": true
                    }
                }),
            ],
            "app-1",
        );

        let finished = events
            .iter()
            .find(|event| event["type"] == "tool_finished")
            .expect("tool_finished event");
        assert_eq!(finished["tool_use_id"], "call-err");
        assert_eq!(
            finished["content"],
            "tree: command not found\n\nCommand exited with code 127"
        );
        assert_eq!(finished["is_error"], true);
    }

    #[test]
    fn emits_one_turn_finished_after_a_multi_step_user_turn() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message",
                    "id": "user-1",
                    "timestamp": "2026-09-03T08:40:00.000Z",
                    "message": {
                        "role": "user",
                        "content": [{ "type": "text", "text": "按方案1改" }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "timestamp": "2026-09-03T08:40:03.000Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [
                            { "type": "thinking", "thinking": "planning" },
                            { "type": "text", "text": "好的，开始修改。" }
                        ]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-2",
                    "message": {
                        "role": "assistant",
                        "stopReason": "toolUse",
                        "content": [{
                            "type": "toolCall",
                            "id": "call-1",
                            "name": "bash",
                            "arguments": { "command": "ls" }
                        }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "result-1",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call-1",
                        "toolName": "bash",
                        "content": [{ "type": "text", "text": "ok" }],
                        "isError": false
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-3",
                    "timestamp": "2026-09-03T08:40:10.000Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [
                            { "type": "thinking", "thinking": "done" },
                            { "type": "text", "text": "修改完成。" }
                        ]
                    }
                }),
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
                "assistant_message",
                "turn_finished",
            ]
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"].as_str() == Some("turn_finished"))
                .count(),
            1
        );
        let boundary = events
            .iter()
            .find(|event| event["type"] == "turn_finished")
            .unwrap();
        assert_eq!(boundary["duration_ms"], 10000);
    }

    #[test]
    fn converts_compaction_end_to_compact_boundary() {
        let events = convert_pi_history_values_to_events(
            &[json!({
                "type": "compaction_end",
                "reason": "manual",
                "aborted": false
            })],
            "app-1",
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "system_event");
        assert_eq!(events[0]["subtype"], "compact_boundary");
        assert_eq!(events[0]["compact_metadata"]["trigger"], "manual");
    }

    #[test]
    fn reads_pi_session_file_from_mapping_path() {
        let home = test_home("read");
        let session_dir = home.join("pi-agent/sessions/demo");
        fs::create_dir_all(&session_dir).unwrap();
        let session_file = session_dir.join("session.jsonl");
        fs::write(
            &session_file,
            concat!(
                "{\"type\":\"session\",\"id\":\"pi-session-1\"}\n",
                "{\"type\":\"message\",\"id\":\"user-1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n",
                "{\"type\":\"message\",\"id\":\"assistant-1\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n",
            ),
        )
        .unwrap();

        let raw = read_json_stream_values(&session_file).unwrap();
        let events = convert_pi_history_values_to_events(&raw, "app-1");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["type"], "user_message");
        assert_eq!(events[1]["type"], "assistant_message");

        let _ = fs::remove_dir_all(home);
    }
}
