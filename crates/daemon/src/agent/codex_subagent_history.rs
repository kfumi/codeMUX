//! Restores subagent descriptors and timelines from Codex's on-disk rollout
//! files (`~/.codex/sessions`) when session history is hydrated or re-synced
//! from the CLI. Codex runs each collab subagent in its own rollout file
//! (`session_meta.thread_source = "subagent"`, `parent_thread_id` pointing at
//! the parent thread); the parent rollout's successful `spawn_agent` output
//! carries `{"agent_id": "<child thread id>", "nickname": ...}`, which binds
//! the parent-side `call_id` — the canonical `subagent_id`, the same id the
//! live sidecar adapter derives from the collab item — to the child rollout.
//!
//! Live sidecar captures always win: callers skip descriptors that already
//! exist in the database, so a resync never rewrites children recorded while
//! the session was running.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::codex_history::{
    codex_collab_tool_kind, convert_codex_history_values_to_events, find_codex_session_jsonl,
    read_codex_session_meta_id, spawn_output_agent_id, CodexCollabToolKind,
};
use super::native_jsonl::read_json_stream_values;

pub(crate) struct CodexSubagentHistory {
    pub subagent_id: String,
    /// Sidecar-shaped `subagent_upsert` event, ready for
    /// `operations::upsert_session_subagent`.
    pub upsert: Value,
    /// Sidecar-shaped `subagent_timeline` envelopes, ready for
    /// `operations::append_session_subagent_event`.
    pub timeline: Vec<Value>,
}

/// The parent-side `spawn_agent` call that launched a child thread.
struct SpawnBinding {
    call_id: String,
    agent_id: String,
    nickname: Option<String>,
    message: Option<String>,
}

pub(crate) fn load_codex_session_subagent_history(
    home: &Path,
    parent_session_id: &str,
    app_session_id: &str,
) -> Vec<CodexSubagentHistory> {
    let sessions_dir = home.join(".codex").join("sessions");
    let Some(parent_path) = find_codex_session_jsonl(&sessions_dir, parent_session_id) else {
        return Vec::new();
    };
    let Ok(parent_values) = read_json_stream_values(&parent_path) else {
        return Vec::new();
    };
    let bindings = extract_spawn_bindings(&parent_values);
    if bindings.is_empty() {
        return Vec::new();
    }

    let mut entries = Vec::new();
    for binding in bindings {
        let Some(child_path) = find_rollout_by_thread_id(&sessions_dir, &binding.agent_id) else {
            continue;
        };
        let Ok(child_values) = read_json_stream_values(&child_path) else {
            continue;
        };
        // Reuse the exact parent-timeline projection; turn boundaries are a
        // parent-timeline concept and are dropped from the child track.
        let inner_events: Vec<Value> =
            convert_codex_history_values_to_events(&child_values, app_session_id)
                .into_iter()
                .filter(|event| event.get("type").and_then(Value::as_str) != Some("turn_finished"))
                .collect();
        if inner_events.is_empty() {
            continue;
        }

        let timeline = inner_events
            .into_iter()
            .map(|inner| {
                json!({
                    "type": "subagent_timeline",
                    "session_id": app_session_id,
                    "subagent_id": binding.call_id,
                    "provider": "codex",
                    "event": inner,
                    "event_id": inner.get("event_id").cloned().unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string())),
                    "timestamp": inner.get("timestamp").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();

        let upsert = json!({
            "type": "subagent_upsert",
            "session_id": app_session_id,
            "subagent_id": binding.call_id,
            "provider": "codex",
            "title": binding.nickname.clone().unwrap_or_else(|| "Sub-agent".to_string()),
            "description": binding.message,
            // Restored child runs are finished runs; live captures own any
            // richer status and are skipped by the caller anyway.
            "status": "completed",
            "tool_call_id": binding.call_id,
        });

        entries.push(CodexSubagentHistory {
            subagent_id: binding.call_id,
            upsert,
            timeline,
        });
    }
    entries
}

/// Pair each successful `spawn_agent` call with the child thread its output
/// announced. Failed retries (plain error output, no `agent_id`) produce no
/// binding, mirroring the live adapter's suppression of retry attempts.
fn extract_spawn_bindings(parent_values: &[Value]) -> Vec<SpawnBinding> {
    // call_id → (message from the spawn arguments)
    let mut pending: HashMap<String, Option<String>> = HashMap::new();
    let mut bindings: Vec<SpawnBinding> = Vec::new();

    for val in parent_values {
        if val.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let Some(payload) = val.get("payload") else {
            continue;
        };
        let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let call_id = payload
            .get("call_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if call_id.is_empty() {
            continue;
        }
        match payload_type {
            "function_call" | "custom_tool_call" => {
                if matches!(
                    codex_collab_tool_kind(
                        payload.get("name").and_then(Value::as_str).unwrap_or("")
                    ),
                    CodexCollabToolKind::Spawn
                ) {
                    let message = decode_json_string_field(payload.get("arguments"), "message");
                    pending.insert(call_id, message);
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                if let Some(message) = pending.remove(&call_id) {
                    let Some(agent_id) = spawn_output_agent_id(payload) else {
                        // Failed retry — no child thread launched.
                        continue;
                    };
                    let nickname = spawn_output_nickname(payload);
                    bindings.push(SpawnBinding {
                        call_id,
                        agent_id,
                        nickname,
                        message,
                    });
                }
            }
            _ => {}
        }
    }
    bindings
}

fn decode_json_string_field(raw: Option<&Value>, field: &str) -> Option<String> {
    let raw = raw?;
    let value = match raw.as_str() {
        Some(text) => serde_json::from_str::<Value>(text).ok()?,
        None => raw.clone(),
    };
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn spawn_output_nickname(payload: &Value) -> Option<String> {
    let output = payload.get("output")?;
    let text = output.as_str()?;
    let parsed: Value = serde_json::from_str(text).ok()?;
    parsed
        .get("nickname")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Child rollouts are named `rollout-<timestamp>-<thread id>.jsonl`; the
/// session meta `id` must equal the requested thread id (a filename match
/// alone could collide on shared prefixes).
fn find_rollout_by_thread_id(sessions_dir: &Path, thread_id: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    collect_jsonl_files(sessions_dir, &mut candidates, 0);
    candidates.into_iter().find(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.contains(thread_id))
            .unwrap_or(false)
            && read_codex_session_meta_id(path).as_deref() == Some(thread_id)
    })
}

fn collect_jsonl_files(root: &Path, output: &mut Vec<PathBuf>, depth: usize) {
    use std::fs;

    if depth > 8 || output.len() > 5_000 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|ty| ty.is_dir()).unwrap_or(false) {
            collect_jsonl_files(&path, output, depth + 1);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_rollout(path: &Path, lines: &[String]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, lines.join("\n")).unwrap();
    }

    fn parent_lines() -> Vec<String> {
        vec![
            r#"{"type":"session_meta","payload":{"id":"parent-thread-1","cwd":"C:/workspace"}}"#.to_string(),
            // Failed spawn retry (no agent_id in the output).
            r#"{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call_fail","arguments":"{\"message\":\"探索\"}"}}"#.to_string(),
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_fail","output":"Reasoning effort `low` is not supported"}}"#.to_string(),
            // Successful spawn.
            r#"{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call_ok","arguments":"{\"message\":\"探索前端技术栈\"}"}}"#.to_string(),
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_ok","output":"{\"agent_id\":\"child-thread-1\",\"nickname\":\"Feynman\"}"}}"#.to_string(),
        ]
    }

    fn child_lines() -> Vec<String> {
        vec![
            r#"{"type":"session_meta","payload":{"id":"child-thread-1","parent_thread_id":"parent-thread-1","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-thread-1","depth":1}}},"thread_source":"subagent"}}"#.to_string(),
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"探索前端技术栈"}}"#.to_string(),
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"先看配置"}]}}"#.to_string(),
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"结论"}]}}"#.to_string(),
            r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"结论"}}"#.to_string(),
        ]
    }

    #[test]
    fn binds_spawn_calls_to_child_rollouts_and_projects_timelines() {
        let home =
            std::env::temp_dir().join(format!("codemux-codex-subhist-{}", std::process::id()));
        let sessions = home.join(".codex/sessions/2026/08/30");
        let _ = fs::remove_dir_all(&home);
        write_rollout(
            &sessions.join("rollout-2026-08-30T14-09-45-parent-thread-1.jsonl"),
            &parent_lines(),
        );
        write_rollout(
            &sessions.join("rollout-2026-08-30T14-10-19-child-thread-1.jsonl"),
            &child_lines(),
        );

        let entries = load_codex_session_subagent_history(&home, "parent-thread-1", "app-1");
        assert_eq!(entries.len(), 1, "the failed retry produces no track");
        let entry = &entries[0];
        assert_eq!(entry.subagent_id, "call_ok");
        assert_eq!(entry.upsert["type"], "subagent_upsert");
        assert_eq!(entry.upsert["provider"], "codex");
        assert_eq!(entry.upsert["title"], "Feynman");
        assert_eq!(entry.upsert["description"], "探索前端技术栈");
        assert_eq!(entry.upsert["status"], "completed");
        assert_eq!(entry.upsert["tool_call_id"], "call_ok");

        let kinds: Vec<&str> = entry
            .timeline
            .iter()
            .map(|event| event["event"]["type"].as_str().unwrap())
            .collect();
        // reasoning block + final text — each projects to its own
        // assistant_message, mirroring the parent timeline projection.
        assert_eq!(
            kinds,
            vec!["user_message", "assistant_message", "assistant_message"]
        );
        assert!(
            kinds.iter().all(|kind| *kind != "turn_finished"),
            "turn boundaries stay out of the child track"
        );
        assert_eq!(
            entry.timeline[0]["event"]["content"][0]["text"],
            "探索前端技术栈"
        );
        assert_eq!(entry.timeline[0]["subagent_id"], "call_ok");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn returns_empty_without_parent_rollout() {
        let home = std::env::temp_dir().join(format!(
            "codemux-codex-subhist-empty-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".codex/sessions")).unwrap();
        let entries = load_codex_session_subagent_history(&home, "missing", "app-1");
        assert!(entries.is_empty());
        let _ = fs::remove_dir_all(&home);
    }
}
