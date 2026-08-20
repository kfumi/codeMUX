use serde_json::{json, Value};
use std::collections::HashSet;

use crate::config::types::AgentKind;

const RECENT_TURN_LIMIT: usize = 8;
const MAX_TOUCHED_FILES: usize = 20;
const MAX_SNIPPET_CHARS: usize = 500;
const SWITCH_BRIEFING_MARKER: &str = "[CodeMUX runtime switch]";
const USER_FOLLOW_UP_SEPARATOR: &str = "\n---\nUser follow-up:\n";

pub fn build_switch_briefing(events: &[Value], from_kind: AgentKind, to_kind: AgentKind) -> String {
    let mut lines = vec![
        "[CodeMUX runtime switch]".to_string(),
        format!(
            "Previous driver: {}. Current driver: {}.",
            agent_kind_label(from_kind),
            agent_kind_label(to_kind)
        ),
        "The CodeMUX session is unchanged. Do not assume prior tool calls, approvals, or plan mode still apply. Native session was rebuilt; this briefing is a lossy summary, not a full transcript.".to_string(),
    ];

    let touched_files = collect_touched_files(events);
    if !touched_files.is_empty() {
        lines.push(String::new());
        lines.push("Touched files:".to_string());
        for path in touched_files {
            lines.push(format!("- {path}"));
        }
    }

    let recent = collect_recent_text_turns(events);
    if !recent.is_empty() {
        lines.push(String::new());
        lines.push("Recent conversation:".to_string());
        for (role, text) in recent {
            lines.push(format!("{role}: {text}"));
        }
    }

    if let Some(outcome) = last_turn_outcome(events) {
        lines.push(String::new());
        lines.push(format!("Last turn outcome: {outcome}"));
    }

    lines.join("\n")
}

pub fn apply_switch_briefing(
    prompt: String,
    input_payload: Option<&mut Value>,
    briefing: Option<&str>,
) -> String {
    let Some(briefing) = briefing.filter(|value| !value.is_empty()) else {
        return prompt;
    };
    let combined = format!("{briefing}\n\n---\nUser follow-up:\n{prompt}");
    if let Some(Value::Object(payload)) = input_payload {
        payload.insert("text".to_string(), json!(combined.clone()));
    }
    combined
}

pub fn strip_switch_briefing_prefix(text: &str) -> String {
    let normalized = text.trim_start();
    if !normalized.starts_with(SWITCH_BRIEFING_MARKER) {
        return text.to_string();
    }
    match normalized.find(USER_FOLLOW_UP_SEPARATOR) {
        Some(index) => normalized[index + USER_FOLLOW_UP_SEPARATOR.len()..].to_string(),
        None => String::new(),
    }
}

fn agent_kind_label(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::ClaudeCode => "Claude Code",
        AgentKind::Codex => "Codex",
        AgentKind::GeminiCli => "Gemini CLI",
        AgentKind::Opencode => "OpenCode",
    }
}

fn event_type(event: &Value) -> &str {
    event.get("type").and_then(Value::as_str).unwrap_or("")
}

fn collect_text_blocks(content: &Value) -> String {
    match content {
        Value::String(text) => text.trim().to_string(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

fn truncate_snippet(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX_SNIPPET_CHARS {
        return trimmed.to_string();
    }
    let shortened: String = trimmed.chars().take(MAX_SNIPPET_CHARS).collect();
    format!("{shortened}…")
}

fn extract_path_from_input(input: &Value) -> Option<String> {
    const KEYS: [&str; 5] = ["file_path", "filePath", "path", "target_file", "targetFile"];
    for key in KEYS {
        if let Some(path) = input.get(key).and_then(Value::as_str) {
            let path = path.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

fn collect_touched_files(events: &[Value]) -> Vec<String> {
    let mut files = Vec::new();
    for event in events {
        if event_type(event) != "tool_started" {
            continue;
        }
        let Some(path) = event.get("input").and_then(extract_path_from_input) else {
            continue;
        };
        if !files.iter().any(|existing| existing == &path) {
            files.push(path);
        }
        if files.len() >= MAX_TOUCHED_FILES {
            break;
        }
    }
    files
}

fn collect_recent_text_turns(events: &[Value]) -> Vec<(String, String)> {
    let mut turns = Vec::new();
    for event in events {
        let role = match event_type(event) {
            "user_message" => "User",
            "assistant_message" => "Assistant",
            _ => continue,
        };
        let text = truncate_snippet(&strip_switch_briefing_prefix(&collect_text_blocks(
            event.get("content").unwrap_or(&Value::Null),
        )));
        if text.is_empty() {
            continue;
        }
        turns.push((role.to_string(), text));
    }

    let user_keep = turns
        .iter()
        .filter(|(role, _)| role == "User")
        .count()
        .saturating_sub(RECENT_TURN_LIMIT);
    let assistant_keep = turns
        .iter()
        .filter(|(role, _)| role == "Assistant")
        .count()
        .saturating_sub(RECENT_TURN_LIMIT);

    let mut skipped_users = 0;
    let mut skipped_assistants = 0;
    turns
        .into_iter()
        .filter(|(role, _)| {
            if role == "User" {
                if skipped_users < user_keep {
                    skipped_users += 1;
                    false
                } else {
                    true
                }
            } else if skipped_assistants < assistant_keep {
                skipped_assistants += 1;
                false
            } else {
                true
            }
        })
        .collect()
}

fn last_turn_outcome(events: &[Value]) -> Option<String> {
    events.iter().rev().find_map(|event| {
        if event_type(event) == "turn_finished" {
            event
                .get("outcome")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        } else {
            None
        }
    })
}

pub fn merge_history_events(snapshot: Vec<Value>, native: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for event in snapshot.into_iter().chain(native) {
        let identities = event_identities(&event);
        if identities.iter().any(|id| seen.contains(id)) {
            continue;
        }
        for id in identities {
            seen.insert(id);
        }
        merged.push(event);
    }
    for (sequence, event) in merged.iter_mut().enumerate() {
        if let Some(object) = event.as_object_mut() {
            object.insert("sequence".to_string(), json!(sequence));
        }
    }
    merged
}

fn event_identities(event: &Value) -> Vec<String> {
    ["event_id", "uuid", "provider_message_id"]
        .iter()
        .filter_map(|key| event.get(*key).and_then(Value::as_str))
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

pub fn build_runtime_switch_system_event(
    session_id: &str,
    from_kind: AgentKind,
    to_kind: AgentKind,
    sequence: usize,
    briefing: &str,
) -> Value {
    json!({
        "type": "system_event",
        "subtype": "runtime_switch",
        "session_id": session_id,
        "event_id": format!("codemux-runtime-switch-{session_id}-{sequence}"),
        "sequence": sequence,
        "from_kind": from_kind.as_str(),
        "to_kind": to_kind.as_str(),
        "content": format!(
            "已切换到 {}。以下由该智能体继续。原生会话已重建，未共用上一驾驶席的 session ID。",
            agent_kind_label(to_kind)
        ),
        "briefing": briefing,
    })
}

pub fn is_switchable_agent_kind(kind: AgentKind) -> bool {
    matches!(
        kind,
        AgentKind::ClaudeCode | AgentKind::Codex | AgentKind::Opencode
    )
}

pub fn default_permission_config_json(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Codex => {
            r#"{"kind":"codex","sandboxMode":"danger-full-access","approvalPolicy":"never","networkAccessEnabled":true}"#
        }
        AgentKind::Opencode => r#"{"kind":"opencode","permissionMode":"full_access"}"#,
        AgentKind::ClaudeCode | AgentKind::GeminiCli => {
            r#"{"kind":"claude_code","permissionMode":"default"}"#
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{agent_kind_label, build_switch_briefing};
    use crate::config::types::AgentKind;
    use serde_json::json;

    #[test]
    fn briefing_names_previous_and_incoming_kinds() {
        let briefing = build_switch_briefing(&[], AgentKind::ClaudeCode, AgentKind::Codex);

        assert!(briefing.contains("[CodeMUX runtime switch]"));
        assert!(briefing.contains(agent_kind_label(AgentKind::ClaudeCode)));
        assert!(briefing.contains(agent_kind_label(AgentKind::Codex)));
        assert!(briefing.contains("Native session was rebuilt"));
    }

    #[test]
    fn briefing_includes_recent_user_and_assistant_text_not_tools() {
        let events = vec![
            json!({
                "type": "user_message",
                "content": [{ "type": "text", "text": "Please refactor auth.ts" }]
            }),
            json!({
                "type": "tool_started",
                "name": "Read",
                "input": { "file_path": "src/auth.ts" }
            }),
            json!({
                "type": "assistant_message",
                "content": [{ "type": "text", "text": "I updated the login flow." }]
            }),
            json!({
                "type": "permission_requested",
                "description": "run bash"
            }),
            json!({
                "type": "turn_finished",
                "outcome": "completed"
            }),
        ];

        let briefing = build_switch_briefing(&events, AgentKind::ClaudeCode, AgentKind::Opencode);

        assert!(briefing.contains("User: Please refactor auth.ts"));
        assert!(briefing.contains("Assistant: I updated the login flow."));
        assert!(briefing.contains("src/auth.ts"));
        assert!(briefing.contains("Last turn outcome: completed"));
        assert!(!briefing.contains("run bash"));
        assert!(!briefing.contains("tool_started"));
    }

    #[test]
    fn briefing_keeps_only_the_most_recent_text_turns() {
        let mut events = Vec::new();
        for index in 1..=10 {
            events.push(json!({
                "type": "user_message",
                "content": format!("user-{index}")
            }));
            events.push(json!({
                "type": "assistant_message",
                "content": format!("assistant-{index}")
            }));
        }

        let briefing = build_switch_briefing(&events, AgentKind::Codex, AgentKind::ClaudeCode);
        let lines: Vec<&str> = briefing.lines().collect();

        assert!(!lines.contains(&"User: user-1"));
        assert!(!lines.contains(&"Assistant: assistant-2"));
        assert!(lines.contains(&"User: user-3"));
        assert!(lines.contains(&"Assistant: assistant-10"));
        assert!(lines.contains(&"User: user-10"));
    }

    #[test]
    fn merge_keeps_snapshot_events_and_appends_new_native_ones() {
        let snapshot = vec![
            json!({ "type": "user_message", "event_id": "u1", "content": "old" }),
            json!({
                "type": "system_event",
                "subtype": "runtime_switch",
                "event_id": "switch-1"
            }),
        ];
        let native = vec![
            json!({ "type": "user_message", "event_id": "u1", "content": "old-dup" }),
            json!({ "type": "user_message", "event_id": "u2", "content": "new" }),
        ];

        let merged = super::merge_history_events(snapshot, native);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0]["event_id"], "u1");
        assert_eq!(merged[0]["content"], "old");
        assert_eq!(merged[2]["event_id"], "u2");
        assert_eq!(merged[2]["sequence"], 2);
    }

    #[test]
    fn merge_treats_provider_message_id_as_the_same_event_across_id_schemes() {
        let snapshot = vec![json!({
            "type": "assistant_message",
            "event_id": "codemux-history-app-1-1",
            "provider_message_id": "d4eaab75-5a56-4824-8bdc-fd08e144da0e",
            "content": [{ "type": "text", "text": "snapshot copy" }]
        })];
        let native = vec![json!({
            "type": "assistant_message",
            "event_id": "d4eaab75-5a56-4824-8bdc-fd08e144da0e",
            "provider_message_id": "d4eaab75-5a56-4824-8bdc-fd08e144da0e",
            "content": [{ "type": "text", "text": "native reimport" }]
        })];

        let merged = super::merge_history_events(snapshot, native);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["content"][0]["text"], "snapshot copy");
    }

    #[test]
    fn merge_keeps_incoming_native_assistant_when_snapshot_already_used_history_sequence_ids() {
        let snapshot = vec![json!({
            "type": "assistant_message",
            "event_id": "codemux-history-app-1-3",
            "content": [{ "type": "text", "text": "Claude 侧旧回复" }]
        })];
        let native = crate::agent::history_events::normalize_history_events(
            vec![json!({
                "type": "assistant",
                "uuid": "msg_opencode_assistant_1",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "OpenCode 第一轮回答" }]
                }
            })],
            "app-1",
        );

        let merged = super::merge_history_events(snapshot, native);
        let texts: Vec<String> = merged
            .iter()
            .filter(|event| event["type"] == "assistant_message")
            .map(|event| event["content"][0]["text"].as_str().unwrap().to_string())
            .collect();

        assert!(texts.iter().any(|text| text.contains("Claude 侧旧回复")));
        assert!(
            texts
                .iter()
                .any(|text| text.contains("OpenCode 第一轮回答")),
            "native assistant was dropped because its event_id collided with the snapshot"
        );
    }

    #[test]
    fn runtime_switch_event_stores_briefing_for_the_timeline() {
        let briefing = "[CodeMUX runtime switch]\nPrevious driver: Claude Code.";
        let event = super::build_runtime_switch_system_event(
            "sess-1",
            AgentKind::ClaudeCode,
            AgentKind::Codex,
            3,
            briefing,
        );

        assert_eq!(event["subtype"], "runtime_switch");
        assert_eq!(event["from_kind"], "claude_code");
        assert_eq!(event["to_kind"], "codex");
        assert_eq!(event["briefing"], briefing);
        assert!(event["content"].as_str().unwrap().contains("Codex"));
    }

    #[test]
    fn strip_switch_briefing_prefix_keeps_the_user_follow_up() {
        let combined = super::apply_switch_briefing(
            "刚才我问了你哪些问题？".to_string(),
            None,
            Some("[CodeMUX runtime switch]\nPrevious driver: Claude Code."),
        );

        assert_eq!(
            super::strip_switch_briefing_prefix(&combined),
            "刚才我问了你哪些问题？"
        );
    }

    #[test]
    fn briefing_recent_turns_use_follow_up_not_previous_switch_prefix() {
        let events = vec![json!({
            "type": "user_message",
            "content": "[CodeMUX runtime switch]\nPrevious driver: Claude Code. Current driver: Codex.\n\n---\nUser follow-up:\n刚才问了什么？"
        })];

        let briefing = build_switch_briefing(&events, AgentKind::Codex, AgentKind::Opencode);

        assert!(briefing.contains("User: 刚才问了什么？"));
        assert!(!briefing.contains("User follow-up"));
        assert!(!briefing.contains("Previous driver: Claude Code"));
    }

    #[test]
    fn apply_switch_briefing_updates_model_payload_text_not_just_prompt() {
        let mut payload = json!({ "text": "刚才我问了你哪些问题？" });
        let prompt = super::apply_switch_briefing(
            "刚才我问了你哪些问题？".to_string(),
            Some(&mut payload),
            Some("[CodeMUX runtime switch]\nUser: 你好"),
        );

        assert!(prompt.starts_with("[CodeMUX runtime switch]"));
        assert!(prompt.contains("刚才我问了你哪些问题？"));
        assert_eq!(payload["text"], prompt);
    }
}
