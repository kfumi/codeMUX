//! Codex native history: JSONL location, Codex → CodeMUX Event conversion,
//! interactive-event replay, loading and deletion of `~/.codex` artifacts.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use log::{debug, info};
use tauri::State;

use crate::config::types::AgentKind;

use super::native_jsonl::{
    first_non_empty_line, read_json_stream_values, sanitize_file_segment,
    sort_events_by_timestamp_stable,
};
use super::session_lifecycle::{get_agent_session_id, home_dir};

pub(crate) fn read_codex_session_meta_id(path: &Path) -> Option<String> {
    let line = first_non_empty_line(path)?;
    let value = serde_json::from_str::<serde_json::Value>(&line).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("session_meta") {
        return None;
    }

    value
        .get("payload")
        .and_then(|payload| payload.get("id"))
        .and_then(|entry| entry.as_str())
        .map(|id| id.to_string())
}

fn collect_codex_jsonl_files(root: &Path, output: &mut Vec<PathBuf>) {
    use std::fs;

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|ty| ty.is_dir()).unwrap_or(false) {
            collect_codex_jsonl_files(&path, output);
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

pub(crate) fn find_codex_session_jsonl(
    sessions_dir: &Path,
    codex_session_id: &str,
) -> Option<PathBuf> {
    use std::fs;

    let mut candidates = Vec::new();
    collect_codex_jsonl_files(sessions_dir, &mut candidates);

    candidates
        .into_iter()
        .filter(|path| read_codex_session_meta_id(path).as_deref() == Some(codex_session_id))
        .max_by_key(|path| {
            fs::metadata(path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0)
        })
}

pub(crate) fn codex_interactive_events_dir(home: &Path) -> PathBuf {
    home.join(".codemux").join("codex-interactive-events")
}

/// Extract the provider-assigned message id from a Codex record.
/// Codex uses: {type: "response_item"|"event_msg", payload: {type, role, content, ...}}
fn extract_codex_provider_message_id(
    value: &serde_json::Value,
    payload: &serde_json::Value,
) -> Option<String> {
    ["id", "uuid", "message_id", "messageId"]
        .iter()
        .find_map(|key| {
            payload
                .get(*key)
                .or_else(|| value.get(*key))
                .and_then(|entry| entry.as_str())
        })
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn extract_codex_reasoning_summary(value: &serde_json::Value) -> Option<String> {
    let summary = value.get("summary")?.as_array()?;
    let parts: Vec<String> = summary
        .iter()
        .filter_map(|entry| {
            let entry_type = entry.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if entry_type != "summary_text" {
                return None;
            }
            entry
                .get("text")
                .and_then(|text| text.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .collect();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

/// Build a CodeMUX `assistant_message` event from converted content blocks.
fn codex_assistant_message_event(
    content: Vec<serde_json::Value>,
    timestamp: Option<serde_json::Value>,
    provider_message_id: Option<String>,
) -> serde_json::Value {
    let mut event = serde_json::json!({
        "type": "assistant_message",
        "content": content,
        "timestamp": timestamp,
    });
    if let Some(provider_message_id) = provider_message_id {
        event["provider_message_id"] = serde_json::json!(provider_message_id);
    }
    event
}

/// Build a CodeMUX `user_message` event from converted content blocks.
///
/// Drops empty text blocks; returns `None` when no visible content remains.
fn codex_user_message_event(
    mut blocks: Vec<serde_json::Value>,
    timestamp: Option<serde_json::Value>,
    provider_message_id: Option<String>,
    line_index: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    blocks.retain(|block| {
        if block.get("type").and_then(|t| t.as_str()) != Some("text") {
            return true;
        }
        block
            .get("text")
            .and_then(|t| t.as_str())
            .is_some_and(|text| !text.is_empty())
    });
    if blocks.is_empty() {
        return None;
    }

    let mut event = serde_json::json!({
        "type": "user_message",
        "content": blocks,
        "timestamp": timestamp,
    });
    if let Some(provider_message_id) = provider_message_id {
        event["provider_message_id"] = serde_json::json!(provider_message_id);
    }
    if let Some(line_index) = line_index {
        event["__lineIndex"] = line_index;
    }
    Some(event)
}

/// Convert a Codex JSONL `response_item` directly into a CodeMUX Event.
///
/// `reasoning` payloads and assistant `message` payloads become
/// `assistant_message` events (thinking/text blocks); user `message` payloads
/// become `user_message` events (text/image blocks). Tool lifecycle payloads
/// are handled separately by [`convert_codex_tool_to_codemux`].
fn convert_codex_response_item_to_event(val: &serde_json::Value) -> Option<serde_json::Value> {
    if val.get("type").and_then(|t| t.as_str()) != Some("response_item") {
        return None;
    }
    let payload = val.get("payload")?;
    let payload_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let role = payload.get("role").and_then(|r| r.as_str());
    let timestamp = val.get("timestamp").cloned();
    let line_index = val.get("__lineIndex").cloned();

    if payload_type == "reasoning" {
        let thinking = extract_codex_reasoning_summary(payload)?;
        return Some(codex_assistant_message_event(
            vec![serde_json::json!({ "type": "thinking", "thinking": thinking })],
            timestamp,
            extract_codex_provider_message_id(val, payload),
        ));
    }

    // Assistant text message
    if payload_type == "message" && role == Some("assistant") {
        let content_blocks = payload.get("content")?;
        let mut blocks = Vec::new();
        if let Some(arr) = content_blocks.as_array() {
            for block in arr {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if block_type == "output_text" {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                } else if block_type == "reasoning" {
                    if let Some(thinking) = extract_codex_reasoning_summary(block) {
                        blocks
                            .push(serde_json::json!({ "type": "thinking", "thinking": thinking }));
                    }
                }
            }
        }
        if blocks.is_empty() {
            return None;
        }
        return Some(codex_assistant_message_event(
            blocks,
            timestamp,
            extract_codex_provider_message_id(val, payload),
        ));
    }

    // User message
    if payload_type == "message" && role == Some("user") {
        let content_blocks = payload.get("content")?;
        let mut text_parts = Vec::new();
        let mut blocks = Vec::new();
        if let Some(arr) = content_blocks.as_array() {
            for block in arr {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if block_type == "input_text" {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        if is_codex_image_text_marker(text) {
                            continue;
                        }
                        text_parts.push(text.to_string());
                        blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                } else if block_type == "input_image" {
                    if let Some(image_url) = block.get("image_url").and_then(|t| t.as_str()) {
                        if let Some((media_type, data)) = parse_image_data_url(image_url) {
                            blocks.push(serde_json::json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": data
                                }
                            }));
                        }
                    }
                }
            }
        }
        if blocks.is_empty() {
            return None;
        }
        // Skip Codex environment context injections (not real user messages)
        if text_parts.join("\n").starts_with("<environment_context>") {
            return None;
        }
        let provider_message_id = ["id", "uuid", "message_id", "messageId"]
            .iter()
            .find_map(|key| payload.get(*key).and_then(|entry| entry.as_str()))
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        return codex_user_message_event(blocks, timestamp, provider_message_id, line_index);
    }

    None
}

/// 将持久化的 Codex 工具记录转换为实时 sidecar 使用的 CodeMUX Event。
/// 插入回合结束事件后再分配 sequence 和 event_id，以最终历史顺序为准。
fn convert_codex_tool_to_codemux(
    val: &serde_json::Value,
    app_session_id: &str,
) -> Option<(&'static str, String, serde_json::Value)> {
    if val.get("type").and_then(|entry| entry.as_str()) != Some("response_item") {
        return None;
    }

    let payload = val.get("payload")?;
    let payload_type = payload.get("type")?.as_str()?;
    let timestamp = val.get("timestamp").cloned();

    match payload_type {
        "function_call" => {
            let tool_use_id = payload.get("call_id")?.as_str()?.to_string();
            let name = payload.get("name")?.as_str()?;
            let input = parse_codex_tool_input(payload.get("arguments"));
            Some((
                "tool_started",
                tool_use_id.clone(),
                serde_json::json!({
                    "type": "tool_started",
                    "session_id": app_session_id,
                    "tool_use_id": tool_use_id,
                    "name": name,
                    "input": input,
                    "timestamp": timestamp,
                    "event_id": "",
                    "sequence": 0
                }),
            ))
        }
        "custom_tool_call" => {
            let tool_use_id = payload.get("call_id")?.as_str()?.to_string();
            let name = payload.get("name")?.as_str()?;
            let input_value = payload
                .get("input")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let input = if input_value.is_object() {
                input_value
            } else if input_value.is_null() {
                serde_json::json!({})
            } else {
                serde_json::json!({ "input": input_value })
            };
            Some((
                "tool_started",
                tool_use_id.clone(),
                serde_json::json!({
                    "type": "tool_started",
                    "session_id": app_session_id,
                    "tool_use_id": tool_use_id,
                    "name": name,
                    "input": input,
                    "timestamp": timestamp,
                    "event_id": "",
                    "sequence": 0
                }),
            ))
        }
        "function_call_output" | "custom_tool_call_output" => {
            let tool_use_id = payload.get("call_id")?.as_str()?.to_string();
            let content = stringify_codex_tool_output(payload.get("output"));
            let is_error = payload.get("is_error").and_then(|entry| entry.as_bool()) == Some(true)
                || payload.get("error").and_then(|entry| entry.as_bool()) == Some(true);
            Some((
                "tool_finished",
                tool_use_id.clone(),
                serde_json::json!({
                    "type": "tool_finished",
                    "session_id": app_session_id,
                    "tool_use_id": tool_use_id,
                    "content": content,
                    "is_error": is_error,
                    "timestamp": timestamp,
                    "event_id": "",
                    "sequence": 0
                }),
            ))
        }
        _ => None,
    }
}

/// Collab (multi-agent) tool classification for the CLI-history projection.
pub(crate) enum CodexCollabToolKind {
    /// Not a collab tool — fall through to the generic tool conversion.
    None,
    /// `spawn_agent`: a track launch; the card is decided by its output.
    Spawn,
    /// `wait_agent` / `close_agent` / `send_input` / `resume_agent`:
    /// orchestration noise, same suppression rule as the live adapter.
    Orchestration,
}

pub(crate) fn codex_collab_tool_kind(name: &str) -> CodexCollabToolKind {
    // Rollout names may carry a `multi_agent_v<N>_` namespace prefix.
    let stripped = match name.strip_prefix("multi_agent_v") {
        Some(rest) => match rest.split_once('_') {
            Some((_, tail)) if !tail.is_empty() => tail,
            _ => name,
        },
        None => name,
    };
    match stripped {
        "spawn_agent" => CodexCollabToolKind::Spawn,
        "wait_agent" | "close_agent" | "send_input" | "resume_agent" => {
            CodexCollabToolKind::Orchestration
        }
        _ => CodexCollabToolKind::None,
    }
}

/// Successful `spawn_agent` outputs carry `{"agent_id": "<child thread id>",
/// "nickname": ...}`; failed retries carry plain error text.
pub(crate) fn spawn_output_agent_id(payload: &serde_json::Value) -> Option<String> {
    let output = payload.get("output")?;
    let text = match output.as_str() {
        Some(text) => text,
        None => return output.get("agent_id").and_then(agent_id_string),
    };
    let parsed: serde_json::Value = serde_json::from_str(text).ok()?;
    parsed.get("agent_id").and_then(agent_id_string)
}

fn agent_id_string(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn parse_codex_tool_input(value: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(value) = value else {
        return serde_json::json!({});
    };
    if let Some(raw) = value.as_str() {
        return serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!({ "raw": raw }));
    }
    if value.is_null() {
        serde_json::json!({})
    } else if value.is_object() {
        value.clone()
    } else {
        serde_json::json!({ "input": value })
    }
}

fn stringify_codex_tool_output(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

/// Apply the final CodeMUX Event envelope.
///
/// Tool lifecycle and turn-finished events get locally-numbered event ids
/// first, then every event receives a global sequence, a stable event id
/// (preferring provider-assigned ids over synthetic ones), the `uuid`
/// mirror of the provider message id, a normalized `line_index`, and the
/// app session id.
fn finalize_codex_history_events(events: &mut [serde_json::Value], app_session_id: &str) {
    let mut tool_sequence = 0u64;
    for event in events.iter_mut() {
        let event_type = event.get("type").and_then(|entry| entry.as_str());
        if !matches!(
            event_type,
            Some("tool_started") | Some("tool_finished") | Some("turn_finished")
        ) {
            continue;
        }
        event["event_id"] = serde_json::json!(format!(
            "codemux-history-{}-{}",
            app_session_id, tool_sequence
        ));
        event["sequence"] = serde_json::json!(tool_sequence);
        tool_sequence += 1;
    }

    for (sequence, event) in events.iter_mut().enumerate() {
        let Some(object) = event.as_object_mut() else {
            continue;
        };

        if let Some(line_index) = object.remove("__lineIndex") {
            object.insert("line_index".to_string(), line_index);
        }

        if let Some(provider_message_id) = object
            .get("provider_message_id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
        {
            object.insert("uuid".to_string(), serde_json::json!(provider_message_id));
        }

        let event_id = ["event_id", "uuid", "provider_message_id"]
            .iter()
            .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("codemux-history-{}-{}", app_session_id, sequence));
        object.insert("event_id".to_string(), serde_json::json!(event_id));
        object.insert("sequence".to_string(), serde_json::json!(sequence));
        object.insert("session_id".to_string(), serde_json::json!(app_session_id));
    }
}

fn is_codex_assistant_response_message(val: &serde_json::Value) -> bool {
    val.get("type").and_then(|t| t.as_str()) == Some("response_item")
        && val
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(|t| t.as_str())
            == Some("message")
        && val
            .get("payload")
            .and_then(|payload| payload.get("role"))
            .and_then(|role| role.as_str())
            == Some("assistant")
}

fn is_codex_user_response_message(val: &serde_json::Value) -> bool {
    val.get("type").and_then(|t| t.as_str()) == Some("response_item")
        && val
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(|t| t.as_str())
            == Some("message")
        && val
            .get("payload")
            .and_then(|payload| payload.get("role"))
            .and_then(|role| role.as_str())
            == Some("user")
}

/// event_msg/agent_message → CodeMUX `assistant_message` event.
fn convert_codex_event_msg_agent_message_to_event(
    val: &serde_json::Value,
) -> Option<serde_json::Value> {
    if !is_codex_event_msg_agent_message(val) {
        return None;
    }

    let payload = val.get("payload")?;
    let text = payload.get("message")?.as_str()?.trim();

    Some(codex_assistant_message_event(
        vec![serde_json::json!({ "type": "text", "text": text })],
        val.get("timestamp").cloned(),
        extract_codex_provider_message_id(val, payload),
    ))
}

/// event_msg/user_message → CodeMUX `user_message` event.
fn convert_codex_event_msg_user_message_to_event(
    val: &serde_json::Value,
) -> Option<serde_json::Value> {
    if !is_codex_event_msg_user_message(val) {
        return None;
    }

    let payload = val.get("payload")?;
    let text = payload
        .get("message")
        .or_else(|| payload.get("text"))
        .and_then(|entry| entry.as_str())?
        .trim();

    let provider_message_id = ["id", "uuid", "message_id", "messageId"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(|entry| entry.as_str()))
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    codex_user_message_event(
        vec![serde_json::json!({ "type": "text", "text": text })],
        val.get("timestamp").cloned(),
        provider_message_id,
        val.get("__lineIndex").cloned(),
    )
}

/// Whether the record is an event_msg carrying a non-empty agent message.
fn is_codex_event_msg_agent_message(val: &serde_json::Value) -> bool {
    val.get("type").and_then(|t| t.as_str()) == Some("event_msg")
        && val
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(|t| t.as_str())
            == Some("agent_message")
        && val
            .get("payload")
            .and_then(|payload| payload.get("message"))
            .and_then(|message| message.as_str())
            .is_some_and(|message| !message.trim().is_empty())
}

/// Whether the record is an event_msg carrying a non-empty user message.
fn is_codex_event_msg_user_message(val: &serde_json::Value) -> bool {
    val.get("type").and_then(|t| t.as_str()) == Some("event_msg")
        && val
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(|t| t.as_str())
            == Some("user_message")
        && val
            .get("payload")
            .map(|payload| payload.get("message").or_else(|| payload.get("text")))
            .and_then(|message| message.and_then(|entry| entry.as_str()))
            .is_some_and(|message| !message.trim().is_empty())
}

fn extract_codex_turn_id(value: &serde_json::Value) -> Option<String> {
    let payload = value.get("payload");
    ["turn_id", "turnId"]
        .iter()
        .find_map(|key| {
            value
                .get(*key)
                .or_else(|| payload.and_then(|entry| entry.get(*key)))
                .and_then(|entry| entry.as_str())
        })
        .map(ToOwned::to_owned)
        .or_else(|| {
            value
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(|entry| entry.as_str())
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.is_empty())
}

/// compacted record → CodeMUX `system_event` with the `compact_boundary` subtype.
fn convert_codex_compacted_to_event(val: &serde_json::Value) -> Option<serde_json::Value> {
    if val.get("type").and_then(|t| t.as_str()) != Some("compacted") {
        return None;
    }

    let payload = val.get("payload");
    let trigger = payload
        .and_then(|p| p.get("trigger"))
        .and_then(|v| v.as_str())
        .filter(|value| *value == "auto" || *value == "manual")
        .unwrap_or("auto");
    let pre_tokens = payload
        .and_then(|p| p.get("pre_tokens").or_else(|| p.get("preTokens")))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let post_tokens = payload
        .and_then(|p| p.get("post_tokens").or_else(|| p.get("postTokens")))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    Some(serde_json::json!({
        "type": "system_event",
        "subtype": "compact_boundary",
        "content": "Conversation compacted",
        "timestamp": val.get("timestamp").cloned(),
        "compact_metadata": {
            "trigger": trigger,
            "pre_tokens": pre_tokens,
            "post_tokens": post_tokens
        }
    }))
}

pub(crate) fn convert_codex_history_values_to_events(
    raw_events: &[serde_json::Value],
    app_session_id: &str,
) -> Vec<serde_json::Value> {
    #[derive(Default)]
    struct TurnInfo {
        model_context_window: Option<u64>,
        duration_ms: Option<u64>,
        last_assistant_msg_idx: Option<usize>,
        last_event_idx: Option<usize>,
        provider_turn_id: Option<String>,
        compaction_only: bool,
        terminal_outcome: Option<&'static str>,
        terminal_reason: Option<String>,
    }

    let has_agent_messages = raw_events.iter().any(is_codex_event_msg_agent_message);
    let has_user_events = raw_events.iter().any(is_codex_event_msg_user_message);
    let mut messages = Vec::new();
    let mut turns: Vec<TurnInfo> = Vec::new();
    let mut msg_idx: usize = 0;
    let mut emitted_tool_started = HashSet::new();
    let mut emitted_tool_finished = HashSet::new();
    // Collab (multi-agent) projection state — keeps the CLI-history timeline
    // aligned with the live sidecar adapter: one `subagent` card per launched
    // track, no orchestration cards, failed spawn retries dropped.
    let mut suppressed_collab_calls: HashSet<String> = HashSet::new();
    let mut pending_spawn_cards: HashMap<String, serde_json::Value> = HashMap::new();
    let mut emitted_spawn_prompts: HashSet<String> = HashSet::new();

    for val in raw_events {
        let item_type = val.get("type").and_then(|t| t.as_str());

        if item_type == Some("turn_context") {
            turns.push(TurnInfo::default());
        }

        let current_turn = if turns.is_empty() {
            turns.push(TurnInfo::default());
            turns.last_mut().unwrap()
        } else {
            turns.last_mut().unwrap()
        };

        if let Some(turn_id) = extract_codex_turn_id(val) {
            current_turn.provider_turn_id = Some(turn_id);
        }

        if let Some(converted) = convert_codex_compacted_to_event(val) {
            current_turn.last_assistant_msg_idx = None;
            current_turn.compaction_only = true;
            current_turn.last_event_idx = Some(msg_idx);
            messages.push(converted);
            msg_idx += 1;
            continue;
        }

        // Collab (multi-agent) layer: spawn cards are held until their output
        // proves a child thread launched; orchestration calls and failed spawn
        // retries never reach the parent timeline.
        if item_type == Some("response_item") {
            if let Some(payload) = val.get("payload") {
                let payload_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let call_id = payload
                    .get("call_id")
                    .and_then(|c| c.as_str())
                    .map(str::to_string);
                match payload_type {
                    "function_call" | "custom_tool_call" => {
                        match codex_collab_tool_kind(
                            payload.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                        ) {
                            CodexCollabToolKind::None => {}
                            CodexCollabToolKind::Orchestration => {
                                if let Some(id) = call_id {
                                    suppressed_collab_calls.insert(id);
                                }
                                continue;
                            }
                            CodexCollabToolKind::Spawn => {
                                if let (Some(id), Some((_, _, converted))) = (
                                    call_id.clone(),
                                    convert_codex_tool_to_codemux(val, app_session_id),
                                ) {
                                    pending_spawn_cards.insert(id, converted);
                                }
                                continue;
                            }
                        }
                    }
                    "function_call_output" | "custom_tool_call_output" => {
                        if call_id
                            .as_ref()
                            .map(|id| suppressed_collab_calls.contains(id))
                            .unwrap_or(false)
                        {
                            continue;
                        }
                        if let Some(id) = &call_id {
                            if let Some(mut started) = pending_spawn_cards.remove(id) {
                                let prompt = started
                                    .pointer("/input/message")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let duplicate =
                                    !prompt.is_empty() && emitted_spawn_prompts.contains(&prompt);
                                if spawn_output_agent_id(payload).is_some() && !duplicate {
                                    // Claim the prompt only when a card is actually
                                    // emitted — a failed retry shares its message
                                    // with the successful re-spawn and must not
                                    // burn the dedup slot.
                                    emitted_spawn_prompts.insert(prompt.clone());
                                    started["name"] = serde_json::json!("subagent");
                                    started["input"] = serde_json::json!({ "prompt": prompt });
                                    if let Some((_, tool_use_id, finished)) =
                                        convert_codex_tool_to_codemux(val, app_session_id)
                                    {
                                        emitted_tool_started.insert(tool_use_id.clone());
                                        current_turn.last_event_idx = Some(msg_idx);
                                        messages.push(started);
                                        msg_idx += 1;
                                        emitted_tool_finished.insert(tool_use_id);
                                        current_turn.last_event_idx = Some(msg_idx);
                                        messages.push(finished);
                                        msg_idx += 1;
                                        continue;
                                    }
                                }
                                // Failed retry or duplicate prompt: no track card.
                                continue;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if let Some((event_type, tool_use_id, converted)) =
            convert_codex_tool_to_codemux(val, app_session_id)
        {
            let is_new = if event_type == "tool_started" {
                emitted_tool_started.insert(tool_use_id)
            } else {
                emitted_tool_finished.insert(tool_use_id)
            };
            if is_new {
                current_turn.last_event_idx = Some(msg_idx);
                messages.push(converted);
                msg_idx += 1;
            }
            continue;
        }

        if item_type == Some("event_msg") {
            if let Some(payload) = val.get("payload") {
                let payload_type = payload.get("type").and_then(|t| t.as_str());
                match payload_type {
                    Some("user_message") => {
                        if has_matching_codex_image_response_user(raw_events, val) {
                            continue;
                        }
                        if let Some(converted) = convert_codex_event_msg_user_message_to_event(val)
                        {
                            current_turn.compaction_only = false;
                            current_turn.last_event_idx = Some(msg_idx);
                            messages.push(converted);
                            msg_idx += 1;
                        }
                    }
                    Some("agent_message") => {
                        if let Some(mut converted) =
                            convert_codex_event_msg_agent_message_to_event(val)
                        {
                            current_turn.last_assistant_msg_idx = Some(msg_idx);
                            current_turn.compaction_only = false;
                            current_turn.last_event_idx = Some(msg_idx);
                            if let Some(turn_id) = &current_turn.provider_turn_id {
                                converted["provider_turn_id"] = serde_json::json!(turn_id);
                            }
                            messages.push(converted);
                            msg_idx += 1;
                        }
                    }
                    Some("token_count") => {
                        if let Some(info) = payload.get("info") {
                            if let Some(ctx) =
                                info.get("model_context_window").and_then(|v| v.as_u64())
                            {
                                current_turn.model_context_window = Some(ctx);
                            }
                        }
                    }
                    Some("task_complete") => {
                        if let Some(dm) = payload.get("duration_ms").and_then(|d| d.as_u64()) {
                            current_turn.duration_ms = Some(dm);
                        }
                        current_turn.terminal_outcome = Some("completed");
                        current_turn.terminal_reason = payload
                            .get("reason")
                            .or_else(|| payload.get("message"))
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .map(ToOwned::to_owned);
                    }
                    Some("turn_aborted") | Some("task_aborted") | Some("turn_cancelled") => {
                        current_turn.terminal_outcome = Some("interrupted");
                        current_turn.terminal_reason = payload
                            .get("reason")
                            .or_else(|| payload.get("message"))
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .map(ToOwned::to_owned);
                    }
                    Some("turn_failed") | Some("task_failed") | Some("api_error") => {
                        current_turn.terminal_outcome = Some("failed");
                        current_turn.terminal_reason = payload
                            .get("error")
                            .or_else(|| payload.get("reason"))
                            .or_else(|| payload.get("message"))
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .map(ToOwned::to_owned);
                    }
                    _ => {}
                }
            }
            continue;
        }

        if has_agent_messages && is_codex_assistant_response_message(val) {
            continue;
        }
        if has_user_events
            && is_codex_user_response_message(val)
            && !codex_response_user_has_image(val)
        {
            continue;
        }

        if let Some(mut converted) = convert_codex_response_item_to_event(val) {
            if converted.get("type").and_then(|t| t.as_str()) == Some("assistant_message") {
                current_turn.last_assistant_msg_idx = Some(msg_idx);
                current_turn.compaction_only = false;
                if let Some(turn_id) = &current_turn.provider_turn_id {
                    converted["provider_turn_id"] = serde_json::json!(turn_id);
                }
            }
            current_turn.last_event_idx = Some(msg_idx);
            messages.push(converted);
            msg_idx += 1;
        }
    }

    struct TurnResult {
        insert_at: usize,
        result: serde_json::Value,
    }
    let mut turn_results: Vec<TurnResult> = Vec::new();

    for turn in &turns {
        if turn.compaction_only {
            continue;
        }

        let Some(insert_at) = turn.last_event_idx.or(turn.last_assistant_msg_idx) else {
            continue;
        };
        let Some(outcome) = turn.terminal_outcome else {
            continue;
        };
        let mut result = serde_json::json!({
            "type": "turn_finished",
            "session_id": app_session_id,
            "outcome": outcome,
            "duration_ms": turn.duration_ms,
            "event_id": "",
            "sequence": 0
        });
        if let Some(reason) = &turn.terminal_reason {
            result["reason"] = serde_json::json!(reason);
        }
        if let Some(ctx) = turn.model_context_window {
            result["model_context_window"] = serde_json::json!(ctx);
        }
        if let Some(turn_id) = &turn.provider_turn_id {
            result["provider_turn_id"] = serde_json::json!(turn_id);
        }
        turn_results.push(TurnResult { insert_at, result });
    }

    for turn_result in turn_results.into_iter().rev() {
        let pos = (turn_result.insert_at + 1).min(messages.len());
        messages.insert(pos, turn_result.result);
    }

    finalize_codex_history_events(&mut messages, app_session_id);

    messages
}

fn has_matching_codex_image_response_user(
    raw_events: &[serde_json::Value],
    event_msg: &serde_json::Value,
) -> bool {
    let Some(event_payload) = event_msg.get("payload") else {
        return false;
    };
    let event_id = ["id", "uuid", "message_id", "messageId"]
        .iter()
        .find_map(|key| event_payload.get(key).and_then(|entry| entry.as_str()));
    let event_text = event_payload
        .get("message")
        .or_else(|| event_payload.get("text"))
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .unwrap_or("");

    raw_events.iter().any(|candidate| {
        if !codex_response_user_has_image(candidate) {
            return false;
        }
        let Some(payload) = candidate.get("payload") else {
            return false;
        };
        let response_id = ["id", "uuid", "message_id", "messageId"]
            .iter()
            .find_map(|key| payload.get(key).and_then(|entry| entry.as_str()));
        if event_id.is_some() && event_id == response_id {
            return true;
        }
        extract_codex_response_user_text(payload) == event_text
    })
}

fn codex_response_user_has_image(value: &serde_json::Value) -> bool {
    if !is_codex_user_response_message(value) {
        return false;
    }
    let Some(content) = value
        .get("payload")
        .and_then(|payload| payload.get("content"))
        .and_then(|content| content.as_array())
    else {
        return false;
    };

    content.iter().any(|block| {
        block.get("type").and_then(|entry| entry.as_str()) == Some("input_image")
            && block
                .get("image_url")
                .and_then(|entry| entry.as_str())
                .and_then(parse_image_data_url)
                .is_some()
    })
}

fn extract_codex_response_user_text(payload: &serde_json::Value) -> String {
    payload
        .get("content")
        .and_then(|content| content.as_array())
        .map(|content| {
            content
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(|entry| entry.as_str()) != Some("input_text") {
                        return None;
                    }
                    let text = block.get("text").and_then(|entry| entry.as_str())?;
                    if is_codex_image_text_marker(text) {
                        return None;
                    }
                    Some(text)
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn is_codex_image_text_marker(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("<image ") || trimmed == "<image>" || trimmed == "</image>"
}

fn parse_image_data_url(data_url: &str) -> Option<(String, String)> {
    let rest = data_url.strip_prefix("data:")?;
    let (media_type, data) = rest.split_once(";base64,")?;
    if !media_type.starts_with("image/") || data.is_empty() {
        return None;
    }
    Some((media_type.to_string(), data.to_string()))
}

pub(crate) fn read_codex_interactive_events_from_dir(
    dir: &Path,
    app_session_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let path = dir.join(format!("{}.jsonl", sanitize_file_segment(app_session_id)));
    if !path.exists() {
        return Ok(Vec::new());
    }

    read_json_stream_values(&path)
}

#[tauri::command]
pub async fn load_codex_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    debug!(target: "agent", "Loading Codex session events for app_session_id={}", app_session_id);

    let mut messages = Vec::new();
    let Some(codex_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::Codex)?
    else {
        info!(target: "agent", "No Codex mapping found for app_session_id={}", app_session_id);
        return Ok(messages);
    };

    let sessions_dir = home_dir()?.join(".codex").join("sessions");
    let Some(jsonl_path) = find_codex_session_jsonl(&sessions_dir, &codex_session_id) else {
        info!(
            target: "agent",
            "No Codex JSONL found for app_session_id={} codex_session_id={} dir={}",
            app_session_id,
            codex_session_id,
            sessions_dir.display()
        );
        return Ok(messages);
    };

    debug!(target: "agent", "Reading Codex JSONL from {}", jsonl_path.display());
    // Collect all raw events for two-pass processing
    let mut raw_events = read_json_stream_values(&jsonl_path)?;
    let mut interactive_events = read_codex_interactive_events_from_dir(
        &codex_interactive_events_dir(&home_dir()?),
        &app_session_id,
    )?;
    if !interactive_events.is_empty() {
        raw_events.append(&mut interactive_events);
        sort_events_by_timestamp_stable(&mut raw_events);
    }

    messages = convert_codex_history_values_to_events(&raw_events, &app_session_id);

    info!(target: "agent", "Loaded {} CodeMUX events from Codex JSONL for app_session_id={}", messages.len(), app_session_id);
    Ok(messages)
}

#[tauri::command]
pub async fn delete_codex_session_files(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<String>, String> {
    use std::fs;

    let Some(codex_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::Codex)?
    else {
        debug!(target: "agent", "No Codex session mapping found for session_id={}", app_session_id);
        return Ok(vec![]);
    };

    info!(
        target: "agent",
        "Deleting Codex session files for app_session_id={} codex_session_id={}",
        app_session_id,
        codex_session_id
    );

    let mut deleted = Vec::new();
    let sessions_dir = home_dir()?.join(".codex").join("sessions");

    if sessions_dir.exists() {
        let mut candidates = Vec::new();
        collect_codex_jsonl_files(&sessions_dir, &mut candidates);

        for path in candidates {
            if read_codex_session_meta_id(&path).as_deref() == Some(&codex_session_id) {
                let _ = fs::remove_file(&path);
                deleted.push(path.to_string_lossy().to_string());
            }
        }
    }

    let interactive_events_path = codex_interactive_events_dir(&home_dir()?)
        .join(format!("{}.jsonl", sanitize_file_segment(&app_session_id)));
    if interactive_events_path.exists() {
        let _ = fs::remove_file(&interactive_events_path);
        deleted.push(interactive_events_path.to_string_lossy().to_string());
    }

    info!(
        target: "agent",
        "Deleted {} Codex session file entries for app_session_id={}",
        deleted.len(),
        app_session_id
    );

    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::super::native_jsonl::read_json_stream_values;
    use super::{
        convert_codex_history_values_to_events, convert_codex_response_item_to_event,
        convert_codex_tool_to_codemux, find_codex_session_jsonl,
        read_codex_interactive_events_from_dir, sort_events_by_timestamp_stable,
    };

    /// Golden equivalence for the Codex history pipeline:
    /// fixture JSONL → `convert_codex_history_values_to_events` →
    /// committed golden output.
    ///
    /// Regenerate the golden file with `UPDATE_GOLDEN=1 cargo test
    /// codex_history_pipeline` when the pipeline intentionally changes.
    #[test]
    fn codex_history_pipeline_matches_golden_fixture() {
        use std::fs;

        let fixtures_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("agent")
            .join("fixtures");
        let input_path = fixtures_dir.join("codex_history_session.jsonl");
        let golden_path = fixtures_dir.join("codex_history_golden.json");

        let raw_events =
            read_json_stream_values(&input_path).expect("codex history fixture should parse");
        assert!(!raw_events.is_empty());

        let events = convert_codex_history_values_to_events(&raw_events, "golden-session");
        let actual = serde_json::to_value(&events).expect("events should serialize");

        if !golden_path.exists() || std::env::var("UPDATE_GOLDEN").is_ok() {
            fs::write(
                &golden_path,
                serde_json::to_string_pretty(&actual).expect("events should serialize") + "\n",
            )
            .expect("golden fixture should be writable");
            return;
        }

        let golden_text = fs::read_to_string(&golden_path).expect("golden fixture should exist");
        let golden: serde_json::Value =
            serde_json::from_str(&golden_text).expect("golden fixture should be valid JSON");
        assert_eq!(
            actual, golden,
            "Codex history conversion should stay equivalent to the golden fixture"
        );
    }

    #[test]
    fn find_codex_session_jsonl_matches_only_session_meta_payload_id() {
        use std::fs;

        let base =
            std::env::temp_dir().join(format!("codemux-codex-test-{}", uuid::Uuid::new_v4()));
        let sessions_dir = base.join("2026").join("06").join("11");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(
            sessions_dir.join("wrong-id.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"wrong-session\",\"timestamp\":\"2026-06-11T10:00:00Z\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"wrong\"}]}}\n"
            ),
        )
        .unwrap();
        fs::write(
            sessions_dir.join("target.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"target-session\",\"timestamp\":\"2026-06-11T11:00:00Z\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}}\n"
            ),
        )
        .unwrap();

        let matched =
            find_codex_session_jsonl(&base, "target-session").expect("matching file should exist");
        assert_eq!(matched, sessions_dir.join("target.jsonl"));

        let missing = find_codex_session_jsonl(&base, "missing-session");
        assert!(missing.is_none());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn convert_codex_user_message_preserves_provider_message_id() {
        let converted = convert_codex_response_item_to_event(&serde_json::json!({
            "type": "response_item",
            "__lineIndex": 4,
            "payload": {
                "type": "message",
                "role": "user",
                "id": "codex-user-1",
                "content": [{ "type": "input_text", "text": "hello" }]
            }
        }))
        .expect("codex user message should convert");

        assert_eq!(converted["type"], "user_message");
        assert_eq!(converted["provider_message_id"], "codex-user-1");
        assert_eq!(converted["__lineIndex"], 4);
        assert_eq!(
            converted["content"],
            serde_json::json!([{ "type": "text", "text": "hello" }])
        );
    }

    #[test]
    fn codex_history_projects_collab_calls_like_the_live_adapter() {
        let raw_events = vec![
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call", "name": "spawn_agent", "call_id": "call_fail",
                    "arguments": "{\"message\":\"探索前端技术栈\",\"reasoning_effort\":\"low\"}"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output", "call_id": "call_fail",
                    "output": "Reasoning effort `low` is not supported"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call", "name": "spawn_agent", "call_id": "call_ok",
                    "arguments": "{\"message\":\"探索前端技术栈\"}"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call", "name": "wait_agent", "call_id": "call_wait",
                    "arguments": "{}"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output", "call_id": "call_wait",
                    "output": "{\"status\":{\"child-1\":{\"completed\":\"done\"}}}"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output", "call_id": "call_ok",
                    "output": "{\"agent_id\":\"child-1\",\"nickname\":\"Feynman\"}"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call", "name": "close_agent", "call_id": "call_close",
                    "arguments": "{}"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output", "call_id": "call_close",
                    "output": "{\"status\":\"completed\"}"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call", "name": "shell", "call_id": "call_shell",
                    "arguments": "{\"command\":[\"ls\"]}"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output", "call_id": "call_shell",
                    "output": "files"
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-1");
        let summaries: Vec<(String, String, String)> = converted
            .iter()
            .filter_map(|event| {
                let kind = event.get("type").and_then(|t| t.as_str())?;
                if kind != "tool_started" && kind != "tool_finished" {
                    return None;
                }
                Some((
                    kind.to_string(),
                    event
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string(),
                    event
                        .get("tool_use_id")
                        .and_then(|id| id.as_str())
                        .unwrap_or("")
                        .to_string(),
                ))
            })
            .collect();

        // Exactly one track card (the successful spawn), one orchestration-free
        // timeline, and the generic tool untouched. The failed retry, wait and
        // close calls never appear — not even as orphan outputs.
        assert_eq!(
            summaries,
            vec![
                ("tool_started".into(), "subagent".into(), "call_ok".into()),
                ("tool_finished".into(), "".into(), "call_ok".into()),
                ("tool_started".into(), "shell".into(), "call_shell".into()),
                ("tool_finished".into(), "".into(), "call_shell".into()),
            ]
        );

        let spawn_card = converted
            .iter()
            .find(|event| event.get("tool_use_id").and_then(|id| id.as_str()) == Some("call_ok"))
            .unwrap();
        assert_eq!(
            spawn_card["input"],
            serde_json::json!({ "prompt": "探索前端技术栈" })
        );
    }

    #[test]
    fn convert_codex_reasoning_summary_to_assistant_thinking_block() {
        let value = serde_json::json!({
            "timestamp": "2026-06-19T12:38:49.366Z",
            "type": "response_item",
            "payload": {
                "type": "reasoning",
                "summary": [
                    {
                        "type": "summary_text",
                        "text": "**Crafting a concise response**\n\nI can answer directly."
                    }
                ]
            }
        });

        let converted =
            convert_codex_response_item_to_event(&value).expect("reasoning should be visible");

        assert_eq!(
            converted,
            serde_json::json!({
                "type": "assistant_message",
                "timestamp": "2026-06-19T12:38:49.366Z",
                "content": [
                    {
                        "type": "thinking",
                        "thinking": "**Crafting a concise response**\n\nI can answer directly."
                    }
                ]
            })
        );
    }

    #[test]
    fn codex_history_prefers_event_msg_agent_message_over_response_item_message() {
        let raw_events = vec![
            serde_json::json!({
                "timestamp": "2026-07-03T17:31:58.239Z",
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "message": "使用 agent_message 展示",
                    "phase": "commentary"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T17:31:58.240Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "不应该展示 response_item" }],
                    "phase": "commentary"
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(
            converted[0],
            serde_json::json!({
                "type": "assistant_message",
                "timestamp": "2026-07-03T17:31:58.239Z",
                "session_id": "app-session-1",
                "sequence": 0,
                "event_id": "codemux-history-app-session-1-0",
                "content": [{ "type": "text", "text": "使用 agent_message 展示" }]
            })
        );
    }

    #[test]
    fn codex_history_converts_event_msg_user_message_with_locator_fields() {
        let raw_events = vec![serde_json::json!({
            "__lineIndex": 8,
            "timestamp": "2026-07-03T17:31:58.238Z",
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "id": "event-user-1",
                "message": "use skill"
            }
        })];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(
            converted[0],
            serde_json::json!({
                "type": "user_message",
                "provider_message_id": "event-user-1",
                "uuid": "event-user-1",
                "line_index": 8,
                "timestamp": "2026-07-03T17:31:58.238Z",
                "session_id": "app-session-1",
                "sequence": 0,
                "event_id": "event-user-1",
                "content": [{ "type": "text", "text": "use skill" }]
            })
        );
    }

    #[test]
    fn codex_history_prefers_event_msg_user_message_over_response_item_user() {
        let raw_events = vec![
            serde_json::json!({
                "__lineIndex": 8,
                "timestamp": "2026-07-03T17:31:58.238Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "id": "event-user-1",
                    "message": "use skill"
                }
            }),
            serde_json::json!({
                "__lineIndex": 9,
                "timestamp": "2026-07-03T17:31:58.239Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "id": "response-user-1",
                    "content": [{ "type": "input_text", "text": "use skill" }]
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0]["provider_message_id"], "event-user-1");
        assert_eq!(converted[0]["uuid"], "event-user-1");
        assert_eq!(converted[0]["line_index"], 8);
    }

    #[test]
    fn codex_history_keeps_response_item_user_when_it_contains_an_image() {
        let raw_events = vec![
            serde_json::json!({
                "__lineIndex": 8,
                "timestamp": "2026-07-08T15:59:12.248Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "id": "event-user-1",
                    "message": "Describe this image."
                }
            }),
            serde_json::json!({
                "__lineIndex": 9,
                "timestamp": "2026-07-08T15:59:12.249Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "id": "response-user-1",
                    "content": [
                        { "type": "input_text", "text": "<image name=[Image #1] path=\"C:\\Users\\94910\\AppData\\Local\\Temp\\image.png\">" },
                        { "type": "input_image", "image_url": "data:image/png;base64,abc123", "detail": "high" },
                        { "type": "input_text", "text": "</image>" },
                        { "type": "input_text", "text": "Describe this image." }
                    ]
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0]["provider_message_id"], "response-user-1");
        assert_eq!(converted[0]["line_index"], 9);
        assert_eq!(
            converted[0]["content"],
            serde_json::json!([
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "abc123"
                    }
                },
                { "type": "text", "text": "Describe this image." }
            ])
        );
    }

    #[test]
    fn codex_history_falls_back_to_response_item_message_without_agent_message() {
        let raw_events = vec![serde_json::json!({
            "timestamp": "2026-07-03T17:31:58.240Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "旧历史消息" }],
                "phase": "commentary"
            }
        })];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0]["type"], "assistant_message");
        assert_eq!(
            converted[0]["content"],
            serde_json::json!([{ "type": "text", "text": "旧历史消息" }])
        );
    }

    #[test]
    fn codex_history_converts_compacted_record_to_compact_boundary() {
        let raw_events = vec![serde_json::json!({
            "timestamp": "2026-07-03T18:00:00.000Z",
            "type": "compacted",
            "payload": {
                "trigger": "auto",
                "pre_tokens": 40956,
                "post_tokens": 2876
            }
        })];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(
            converted[0],
            serde_json::json!({
                "type": "system_event",
                "subtype": "compact_boundary",
                "content": "Conversation compacted",
                "timestamp": "2026-07-03T18:00:00.000Z",
                "compact_metadata": {
                    "trigger": "auto",
                    "pre_tokens": 40956,
                    "post_tokens": 2876
                },
                "session_id": "app-session-1",
                "sequence": 0,
                "event_id": "codemux-history-app-session-1-0"
            })
        );
    }

    #[test]
    fn codex_history_does_not_attach_compaction_usage_to_previous_assistant() {
        let raw_events = vec![
            serde_json::json!({
                "timestamp": "2026-07-03T17:59:00.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "message": "压缩前的助手消息"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:00.000Z",
                "type": "compacted",
                "payload": {
                    "message": "Another language model started to solve this problem and produced a summary.",
                    "pre_tokens": 40956,
                    "post_tokens": 2876
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:01.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 237119,
                            "cached_input_tokens": 1209,
                            "output_tokens": 0,
                            "reasoning_output_tokens": 0
                        },
                        "model_context_window": 200000
                    }
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:02.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "task_complete",
                    "duration_ms": 1
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 2);
        assert_eq!(
            converted[0].get("type").and_then(|v| v.as_str()),
            Some("assistant_message")
        );
        assert_eq!(
            converted[1].get("subtype").and_then(|v| v.as_str()),
            Some("compact_boundary")
        );
        assert!(!converted
            .iter()
            .any(|event| event.get("type").and_then(|v| v.as_str()) == Some("result")));
    }

    #[test]
    fn codex_history_keeps_normal_assistant_usage_result() {
        let raw_events = vec![
            serde_json::json!({
                "timestamp": "2026-07-03T17:59:00.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "message": "普通助手消息"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:01.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 10,
                            "cached_input_tokens": 2,
                            "output_tokens": 4,
                            "reasoning_output_tokens": 0
                        }
                    }
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:02.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "task_complete",
                    "duration_ms": 123
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 2);
        assert_eq!(
            converted[0].get("type").and_then(|v| v.as_str()),
            Some("assistant_message")
        );
        assert_eq!(
            converted[1].get("type").and_then(|v| v.as_str()),
            Some("turn_finished")
        );
        assert_eq!(converted[1]["outcome"], "completed");
        assert_eq!(converted[1]["sequence"], 1);
    }

    #[test]
    fn codex_history_keeps_explicit_completion_without_usage() {
        let raw_events = vec![
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "agent_message", "message": "完成" }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "task_complete", "duration_ms": 12 }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 2);
        assert_eq!(converted[1]["type"], "turn_finished");
        assert_eq!(converted[1]["outcome"], "completed");
        assert_eq!(converted[1]["duration_ms"], 12);
        assert!(converted[1].get("usage").is_none());
    }

    #[test]
    fn codex_history_emits_deduplicated_codemux_tool_lifecycle_and_turn_outcome() {
        let raw_events = vec![
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:00.000Z",
                "type": "event_msg",
                "payload": { "type": "agent_message", "message": "先执行工具" }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:01.000Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "call_id": "call-read",
                    "name": "read_file",
                    "arguments": "{\"path\":\"README.md\"}"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:02.000Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "call_id": "call-read",
                    "name": "read_file",
                    "arguments": "{\"path\":\"README.md\"}"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:03.000Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-read",
                    "output": "内容"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:04.000Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-read",
                    "output": "内容"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:05.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 10,
                            "cached_input_tokens": 2,
                            "output_tokens": 4,
                            "reasoning_output_tokens": 1
                        }
                    }
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:06.000Z",
                "type": "event_msg",
                "payload": { "type": "task_complete", "duration_ms": 123 }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");
        let codemux_events: Vec<&serde_json::Value> = converted
            .iter()
            .filter(|event| {
                matches!(
                    event.get("type").and_then(|value| value.as_str()),
                    Some("tool_started") | Some("tool_finished") | Some("turn_finished")
                )
            })
            .collect();

        assert_eq!(codemux_events.len(), 3);
        assert_eq!(codemux_events[0]["type"], "tool_started");
        assert_eq!(codemux_events[1]["type"], "tool_finished");
        assert_eq!(codemux_events[2]["type"], "turn_finished");
        assert_eq!(
            codemux_events
                .iter()
                .map(|event| event["sequence"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(codemux_events[2].get("usage").is_none());
    }

    #[test]
    fn convert_codex_custom_tool_call_to_tool_started() {
        let value = serde_json::json!({
            "timestamp": "2026-06-29T10:00:00.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "call_id": "call_apply_patch_1",
                "name": "apply_patch",
                "input": "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch"
            }
        });

        let (event_type, tool_use_id, converted) =
            convert_codex_tool_to_codemux(&value, "app-session-1")
                .expect("custom tool call should be visible");

        assert_eq!(event_type, "tool_started");
        assert_eq!(tool_use_id, "call_apply_patch_1");
        assert_eq!(
            converted,
            serde_json::json!({
                "type": "tool_started",
                "session_id": "app-session-1",
                "tool_use_id": "call_apply_patch_1",
                "name": "apply_patch",
                "input": {
                    "input": "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch"
                },
                "timestamp": "2026-06-29T10:00:00.000Z",
                "event_id": "",
                "sequence": 0
            })
        );
    }

    #[test]
    fn convert_codex_custom_tool_call_output_to_tool_finished() {
        let value = serde_json::json!({
            "timestamp": "2026-06-29T10:00:01.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_apply_patch_1",
                "output": "Success. Updated the following files:\nM src/app.ts"
            }
        });

        let (event_type, tool_use_id, converted) =
            convert_codex_tool_to_codemux(&value, "app-session-1")
                .expect("custom tool output should be visible");

        assert_eq!(event_type, "tool_finished");
        assert_eq!(tool_use_id, "call_apply_patch_1");
        assert_eq!(
            converted,
            serde_json::json!({
                "type": "tool_finished",
                "session_id": "app-session-1",
                "tool_use_id": "call_apply_patch_1",
                "content": "Success. Updated the following files:\nM src/app.ts",
                "is_error": false,
                "timestamp": "2026-06-29T10:00:01.000Z",
                "event_id": "",
                "sequence": 0
            })
        );
    }

    #[test]
    fn reads_codex_interactive_events_from_codemux_jsonl() {
        use std::fs;

        let base = std::env::temp_dir().join(format!(
            "codemux-interactive-events-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&base).unwrap();
        fs::write(
            base.join("app-session-1.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-07-02T10:00:00.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call_question\",\"name\":\"AskUserQuestion\",\"arguments\":\"{\\\"questions\\\":[{\\\"question\\\":\\\"继续吗？\\\",\\\"options\\\":[{\\\"label\\\":\\\"继续\\\"}]}]}\"}}\n",
                "{\"timestamp\":\"2026-07-02T10:00:00.001Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_question\",\"output\":\"[\\\"继续\\\"]\"}}\n"
            ),
        )
        .unwrap();

        let values = read_codex_interactive_events_from_dir(&base, "app-session-1")
            .expect("interactive events should be readable");

        let mut raw_events = vec![serde_json::json!({
            "timestamp": "2026-07-02T09:59:59.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "先确认一个问题。" }]
            }
        })];
        raw_events.extend(values);
        sort_events_by_timestamp_stable(&mut raw_events);

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 3);
        assert_eq!(converted[0]["type"], "assistant_message");
        assert_eq!(converted[1]["type"], "tool_started");
        assert_eq!(
            converted[1],
            serde_json::json!({
                "type": "tool_started",
                "session_id": "app-session-1",
                "tool_use_id": "call_question",
                "name": "AskUserQuestion",
                "input": {
                    "questions": [{
                        "question": "继续吗？",
                        "options": [{ "label": "继续" }]
                    }]
                },
                "timestamp": "2026-07-02T10:00:00.000Z",
                "event_id": "codemux-history-app-session-1-0",
                "sequence": 1
            })
        );
        assert_eq!(converted[2]["type"], "tool_finished");
        assert_eq!(
            converted[2],
            serde_json::json!({
                "type": "tool_finished",
                "session_id": "app-session-1",
                "tool_use_id": "call_question",
                "content": "[\"继续\"]",
                "is_error": false,
                "timestamp": "2026-07-02T10:00:00.001Z",
                "event_id": "codemux-history-app-session-1-1",
                "sequence": 2
            })
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn convert_codex_user_input_image_to_image_block() {
        let value = serde_json::json!({
            "timestamp": "2026-06-28T13:04:49.643Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "<image name=[Image #1] path=\"C:\\Users\\94910\\AppData\\Local\\Temp\\screen.jpg\">"
                    },
                    {
                        "type": "input_image",
                        "image_url": "data:image/jpeg;base64,abc123",
                        "detail": "high"
                    },
                    {
                        "type": "input_text",
                        "text": "</image>"
                    },
                    {
                        "type": "input_text",
                        "text": "这是谁"
                    }
                ]
            }
        });

        let converted =
            convert_codex_response_item_to_event(&value).expect("user image should be visible");

        assert_eq!(
            converted,
            serde_json::json!({
                "type": "user_message",
                "timestamp": "2026-06-28T13:04:49.643Z",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": "abc123"
                        }
                    },
                    {
                        "type": "text",
                        "text": "这是谁"
                    }
                ]
            })
        );
    }
}
