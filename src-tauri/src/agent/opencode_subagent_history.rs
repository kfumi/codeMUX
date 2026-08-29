//! Restores subagent descriptors and timelines from OpenCode's on-disk SQLite
//! storage (`opencode.db`) when session history is hydrated or re-synced from
//! the CLI. OpenCode runs each subagent in a child session
//! (`session.parent_id = parent`); the parent session's Task tool part carries
//! `state.metadata.sessionId`, and that part's `callID` is the canonical
//! `subagent_id` — the same id the live sidecar adapter derives from the same
//! part on the event bus.
//!
//! Parts are persisted in their final state, so restored timelines carry the
//! complete tool arguments even when the live capture (older sidecar builds)
//! only recorded the empty-input `pending` update.
//!
//! Live sidecar captures always win: callers skip descriptors that already
//! exist in the database, so a resync never rewrites or terminates children
//! recorded while the session was running.

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::history_events::normalize_history_events;
use super::opencode_history::{
    load_opencode_parts, sort_opencode_parts, stringify_value, timestamp_string, OpenCodePart,
};

pub(crate) struct OpenCodeSubagentHistory {
    pub subagent_id: String,
    /// Sidecar-shaped `subagent_upsert` event, ready for
    /// `operations::upsert_session_subagent`.
    pub upsert: Value,
    /// Sidecar-shaped `subagent_timeline` envelopes, ready for
    /// `operations::append_session_subagent_event`.
    pub timeline: Vec<Value>,
}

struct ChildSession {
    id: String,
    agent: Option<String>,
    title: Option<String>,
}

/// The parent-side Task tool part that spawned a child session.
struct TaskBinding {
    call_id: String,
    input: Value,
}

pub(crate) fn load_opencode_session_subagent_history(
    connection: &Connection,
    opencode_session_id: &str,
    app_session_id: &str,
) -> Vec<OpenCodeSubagentHistory> {
    let children = match query_child_sessions(connection, opencode_session_id) {
        Ok(children) => children,
        Err(error) => {
            log::warn!(
                target: "agent",
                "Failed to query OpenCode child sessions for {}: {}",
                opencode_session_id,
                error
            );
            return Vec::new();
        }
    };
    if children.is_empty() {
        return Vec::new();
    }
    let bindings = load_parent_task_bindings(connection, opencode_session_id);

    let mut entries = Vec::new();
    for child in children {
        let binding = bindings.get(&child.id);
        // The parent Task tool callID is the canonical subagent id — the same
        // id the parent conversation's Task card uses as tool_use_id.
        let subagent_id = binding
            .map(|binding| binding.call_id.clone())
            .unwrap_or_else(|| format!("opencode-subagent-{}", child.id));

        let raw_events = build_child_raw_events(connection, &child.id, app_session_id);
        if raw_events.is_empty() {
            continue;
        }
        let inner_events = normalize_history_events(raw_events, app_session_id);
        if inner_events.is_empty() {
            continue;
        }

        let timeline = inner_events
            .into_iter()
            .map(|inner| {
                json!({
                    "type": "subagent_timeline",
                    "session_id": app_session_id,
                    "subagent_id": subagent_id,
                    "provider": "opencode",
                    "event": inner,
                    "event_id": inner.get("event_id").cloned().unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string())),
                    "timestamp": inner.get("timestamp").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();

        let input = binding
            .map(|binding| binding.input.clone())
            .unwrap_or_else(|| json!({}));
        let title =
            string_field(&input, &["subagent_type", "agent"]).or_else(|| child.agent.clone());
        let description = string_field(&input, &["description"]).or(child.title.clone());

        let upsert = json!({
            "type": "subagent_upsert",
            "session_id": app_session_id,
            "subagent_id": subagent_id,
            "provider": "opencode",
            "title": title,
            "description": description,
            // Restored child sessions are finished runs; live captures own any
            // richer status and are skipped by the caller anyway.
            "status": "completed",
            "tool_call_id": binding.map(|binding| Value::from(binding.call_id.clone())).unwrap_or(Value::Null),
        });

        entries.push(OpenCodeSubagentHistory {
            subagent_id,
            upsert,
            timeline,
        });
    }
    entries
}

fn query_child_sessions(
    connection: &Connection,
    parent_session_id: &str,
) -> Result<Vec<ChildSession>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, agent, title FROM session WHERE parent_id = ?1 ORDER BY time_created ASC, id ASC",
        )
        .map_err(|error| format!("Failed to query OpenCode child sessions: {}", error))?;
    let rows = statement
        .query_map([parent_session_id], |row| {
            let id: String = row.get(0)?;
            let agent: Option<String> = row.get(1)?;
            let title: Option<String> = row.get(2)?;
            Ok((id, agent, title))
        })
        .map_err(|error| format!("Failed to read OpenCode child sessions: {}", error))?;
    let mut children = Vec::new();
    for row in rows {
        let (id, agent, title) =
            row.map_err(|error| format!("Failed to decode OpenCode child session: {}", error))?;
        children.push(ChildSession { id, agent, title });
    }
    Ok(children)
}

/// Map child session id → the parent Task tool part that spawned it. Several
/// parent parts may reference the same child (pending → running → completed);
/// keep the first with a non-empty callID.
fn load_parent_task_bindings(
    connection: &Connection,
    parent_session_id: &str,
) -> HashMap<String, TaskBinding> {
    let mut bindings: HashMap<String, TaskBinding> = HashMap::new();
    let Ok(parts) = load_session_parts(connection, parent_session_id) else {
        return bindings;
    };
    for part in &parts {
        if !is_task_tool_part(&part.data) {
            continue;
        }
        let Some(child_session_id) = part
            .data
            .pointer("/state/metadata/sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if bindings.contains_key(child_session_id) {
            continue;
        }
        let Some(call_id) = part
            .data
            .get("callID")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        let input = part
            .data
            .pointer("/state/input")
            .cloned()
            .unwrap_or_else(|| json!({}));
        bindings.insert(child_session_id.to_owned(), TaskBinding { call_id, input });
    }
    bindings
}

fn is_task_tool_part(part: &Value) -> bool {
    part.get("type").and_then(Value::as_str) == Some("tool")
        && part
            .get("tool")
            .and_then(Value::as_str)
            .map(|tool| {
                let tool = tool.to_ascii_lowercase();
                tool == "task" || tool == "agent"
            })
            .unwrap_or(false)
}

/// Build sidecar-shaped raw events (the same Claude-JSONL shapes
/// `normalize_history_events` consumes for the parent timeline) from the
/// child session's messages and parts. Parts carry their final state, so tool
/// arguments come out complete.
fn build_child_raw_events(
    connection: &Connection,
    child_session_id: &str,
    app_session_id: &str,
) -> Vec<Value> {
    let mut raw_events = Vec::new();
    let Ok(messages) = query_child_messages(connection, child_session_id) else {
        return raw_events;
    };
    for (message_id, time_created, role) in messages {
        let Ok(parts) = load_opencode_parts(connection, child_session_id, &message_id) else {
            continue;
        };
        let mut parts = parts;
        sort_opencode_parts(&mut parts);

        if role == "user" {
            if let Some(event) =
                build_user_raw_event(&parts, &message_id, time_created, app_session_id)
            {
                raw_events.push(event);
            }
            continue;
        }
        if role != "assistant" {
            continue;
        }
        let (assistant, tool_results) = build_assistant_raw_event(
            &parts,
            &message_id,
            time_created,
            child_session_id,
            app_session_id,
        );
        raw_events.push(assistant);
        raw_events.extend(tool_results);
    }
    raw_events
}

type ChildMessage = (String, i64, String);

fn query_child_messages(
    connection: &Connection,
    child_session_id: &str,
) -> Result<Vec<ChildMessage>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ?1 ORDER BY time_created ASC, id ASC",
        )
        .map_err(|error| format!("Failed to query OpenCode child messages: {}", error))?;
    let rows = statement
        .query_map([child_session_id], |row| {
            let id: String = row.get(0)?;
            let time_created: i64 = row.get(1)?;
            let data: String = row.get(2)?;
            Ok((id, time_created, data))
        })
        .map_err(|error| format!("Failed to read OpenCode child messages: {}", error))?;
    let mut messages = Vec::new();
    for row in rows {
        let (id, time_created, data) =
            row.map_err(|error| format!("Failed to decode OpenCode child message: {}", error))?;
        let message: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({}));
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        messages.push((id, time_created, role));
    }
    Ok(messages)
}

/// The child's opening user message is the task prompt (text part); a
/// `@agent`-invoked task carries it on a `subtask` part instead.
fn build_user_raw_event(
    parts: &[OpenCodePart],
    message_id: &str,
    time_created: i64,
    app_session_id: &str,
) -> Option<Value> {
    let mut text = String::new();
    for part in parts {
        let part_type = part.data.get("type").and_then(Value::as_str).unwrap_or("");
        match part_type {
            "text" => {
                if let Some(value) = part.data.get("text").and_then(Value::as_str) {
                    text.push_str(value);
                }
            }
            "subtask" => {
                if let Some(value) = part.data.get("prompt").and_then(Value::as_str) {
                    text.push_str(value);
                }
            }
            _ => {}
        }
    }
    if text.trim().is_empty() {
        return None;
    }
    Some(json!({
        "type": "user",
        "uuid": message_id,
        "session_id": app_session_id,
        "timestamp": timestamp_string(time_created),
        "message": { "role": "user", "content": text },
        "parent_tool_use_id": Value::Null,
    }))
}

/// Assistant parts become one assistant event (text/thinking/tool_use blocks)
/// plus separate tool_result events, mirroring the parent timeline projection.
fn build_assistant_raw_event(
    parts: &[OpenCodePart],
    message_id: &str,
    time_created: i64,
    child_session_id: &str,
    app_session_id: &str,
) -> (Value, Vec<Value>) {
    let mut content = Vec::new();
    let mut tool_results = Vec::new();
    for part in parts {
        let part_type = part.data.get("type").and_then(Value::as_str).unwrap_or("");
        match part_type {
            "text" => {
                if let Some(text) = part
                    .data
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    content.push(json!({ "type": "text", "text": text }));
                }
            }
            "reasoning" => {
                if let Some(text) = part
                    .data
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    content.push(json!({ "type": "thinking", "thinking": text }));
                }
            }
            "tool" => {
                let call_id = part
                    .data
                    .get("callID")
                    .and_then(Value::as_str)
                    .unwrap_or(&part.id);
                let tool_name = part
                    .data
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let state = part.data.get("state").cloned().unwrap_or(Value::Null);
                let input = state.get("input").cloned().unwrap_or_else(|| json!({}));
                content.push(json!({
                    "type": "tool_use",
                    "id": call_id,
                    "name": tool_name,
                    "input": input,
                }));
                let status = state
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if status == "completed" || status == "error" {
                    let output = if status == "completed" {
                        state.get("output")
                    } else {
                        state.get("error")
                    };
                    tool_results.push(json!({
                        "type": "user",
                        "uuid": format!("{}-result", part.id),
                        "session_id": child_session_id,
                        "timestamp": timestamp_string(part.time_created),
                        "message": {
                            "role": "user",
                            "content": [{
                                "type": "tool_result",
                                "tool_use_id": call_id,
                                    "content": stringify_value(output.unwrap_or(&Value::Null)),
                                "is_error": status == "error",
                            }]
                        },
                        "parent_tool_use_id": Value::Null,
                    }));
                }
            }
            // step-start/step-finish/patch/file/compaction parts carry no
            // child-visible conversation content.
            _ => {}
        }
    }
    let assistant = json!({
        "type": "assistant",
        "uuid": message_id,
        "session_id": app_session_id,
        "timestamp": timestamp_string(time_created),
        "message": { "role": "assistant", "content": content },
        "parent_tool_use_id": Value::Null,
    });
    (assistant, tool_results)
}

fn load_session_parts(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<OpenCodePart>, String> {
    let mut statement = connection
        .prepare("SELECT id, time_created, data FROM part WHERE session_id = ?1 ORDER BY time_created ASC, id ASC")
        .map_err(|error| format!("Failed to query OpenCode parts: {}", error))?;
    let rows = statement
        .query_map([session_id], |row| {
            let data: String = row.get(2)?;
            Ok(OpenCodePart {
                id: row.get(0)?,
                time_created: row.get(1)?,
                data: serde_json::from_str(&data).unwrap_or_else(|_| json!({})),
            })
        })
        .map_err(|error| format!("Failed to read OpenCode parts: {}", error))?;
    let mut parts = Vec::new();
    for row in rows {
        parts.push(row.map_err(|error| format!("Failed to decode OpenCode part: {}", error))?);
    }
    Ok(parts)
}

fn string_field(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        input
            .get(*key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, title TEXT, time_created INTEGER NOT NULL);\
                 CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);\
                 CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
            )
            .unwrap();
        connection
    }

    fn insert_message(connection: &Connection, id: &str, session_id: &str, time: i64, role: &str) {
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![id, session_id, time, format!(r#"{{"role":"{}"}}"#, role)],
            )
            .unwrap();
    }

    fn insert_part(
        connection: &Connection,
        id: &str,
        message_id: &str,
        session_id: &str,
        time: i64,
        data: &str,
    ) {
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![id, message_id, session_id, time, data],
            )
            .unwrap();
    }

    #[test]
    fn restores_child_sessions_with_bindings_and_full_tool_arguments() {
        let connection = setup_db();
        connection
            .execute(
                "INSERT INTO session VALUES ('parent-1', NULL, 'build', 'root session', 1000)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES ('child-1', 'parent-1', 'explore', 'Explore frontend tech stack (@explore subagent)', 2000)",
                [],
            )
            .unwrap();

        // Parent Task tool part binds the child session; input carries the
        // declaration fields the live adapter reads from the same part.
        insert_part(
            &connection,
            "part-task",
            "assistant-0",
            "parent-1",
            1500,
            r#"{"type":"tool","tool":"task","callID":"call_1","state":{"status":"completed","input":{"description":"探索前端","prompt":"探索前端技术栈","subagent_type":"explore"},"metadata":{"sessionId":"child-1"}}}"#,
        );
        insert_message(&connection, "child-user-1", "child-1", 2100, "user");
        insert_part(
            &connection,
            "part-prompt",
            "child-user-1",
            "child-1",
            2101,
            r#"{"type":"text","text":"探索前端技术栈"}"#,
        );
        insert_message(
            &connection,
            "child-assistant-1",
            "child-1",
            2200,
            "assistant",
        );
        insert_part(
            &connection,
            "part-reasoning",
            "child-assistant-1",
            "child-1",
            2201,
            r#"{"type":"reasoning","text":"先看配置"}"#,
        );
        insert_part(
            &connection,
            "part-tool",
            "child-assistant-1",
            "child-1",
            2202,
            r#"{"type":"tool","tool":"read","callID":"call_tool_1","state":{"status":"completed","input":{"filePath":"D:/demo/package.json"},"output":"file body"}}"#,
        );
        insert_part(
            &connection,
            "part-text",
            "child-assistant-1",
            "child-1",
            2203,
            r#"{"type":"text","text":"结论"}"#,
        );

        let entries = load_opencode_session_subagent_history(&connection, "parent-1", "app-1");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        // The parent Task callID is the canonical subagent id.
        assert_eq!(entry.subagent_id, "call_1");
        assert_eq!(entry.upsert["type"], "subagent_upsert");
        assert_eq!(entry.upsert["session_id"], "app-1");
        assert_eq!(entry.upsert["provider"], "opencode");
        assert_eq!(entry.upsert["title"], "explore");
        assert_eq!(entry.upsert["description"], "探索前端");
        assert_eq!(entry.upsert["status"], "completed");
        assert_eq!(entry.upsert["tool_call_id"], "call_1");

        // prompt → assistant (thinking/text) → tool_started/finished pair.
        let kinds: Vec<&str> = entry
            .timeline
            .iter()
            .map(|event| event["event"]["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "user_message",
                "assistant_message",
                "tool_started",
                "tool_finished"
            ]
        );
        // Tool arguments come from the persisted final state — complete even
        // when a live capture only recorded the empty pending update.
        let tool_start = entry
            .timeline
            .iter()
            .find(|event| event["event"]["type"] == "tool_started")
            .unwrap();
        assert_eq!(tool_start["event"]["tool_use_id"], "call_tool_1");
        assert_eq!(
            tool_start["event"]["input"]["filePath"],
            "D:/demo/package.json"
        );
        assert_eq!(
            entry.timeline[0]["event"]["content"][0]["text"], "探索前端技术栈",
            "the child's own user message opens the timeline"
        );
    }

    #[test]
    fn falls_back_to_synthetic_id_without_parent_binding() {
        let connection = setup_db();
        connection
            .execute(
                "INSERT INTO session VALUES ('parent-1', NULL, 'build', 'root', 1000)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES ('child-9', 'parent-1', 'general', 'helper', 2000)",
                [],
            )
            .unwrap();
        insert_message(&connection, "child-user-9", "child-9", 2100, "user");
        insert_part(
            &connection,
            "part-prompt-9",
            "child-user-9",
            "child-9",
            2101,
            r#"{"type":"text","text":"帮忙"}"#,
        );

        let entries = load_opencode_session_subagent_history(&connection, "parent-1", "app-1");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].subagent_id, "opencode-subagent-child-9");
        assert_eq!(entries[0].upsert["tool_call_id"], Value::Null);
        assert_eq!(entries[0].upsert["title"], "general");
    }

    #[test]
    fn returns_empty_without_child_sessions() {
        let connection = setup_db();
        connection
            .execute(
                "INSERT INTO session VALUES ('parent-1', NULL, 'build', 'root', 1000)",
                [],
            )
            .unwrap();
        let entries = load_opencode_session_subagent_history(&connection, "parent-1", "app-1");
        assert!(entries.is_empty());
    }
}
