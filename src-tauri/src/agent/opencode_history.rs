use log::{debug, info};
use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

use super::history_events::normalize_history_events;
use super::session_lifecycle::{
    get_agent_session_id, home_dir, invalidate_session_generation,
    parse_session_delete_result_event, session_lifecycle_lock, AgentState,
};
use super::{spawn_sidecar, SidecarHandle};
use crate::agent::context_usage::{ThreadTokenUsageSnapshot, TokenUsageBreakdown};
use crate::agent_runtime::opencode::OpenCodeRuntime;
use crate::config::types::AgentKind;

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn converts_opencode_sqlite_messages_into_ordered_codex_compatible_events() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);\
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
            rusqlite::params!["assistant-1", "session-1", 2000_i64, r#"{"role":"assistant","tokens":{"input":3,"output":2,"reasoning":1,"cache":{"read":4,"write":0}},"providerID":"openai","modelID":"model-1"}"#],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-reasoning",
                    "assistant-1",
                    "session-1",
                    2001_i64,
                    r#"{"type":"reasoning","text":"thinking"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-text",
                    "assistant-1",
                    "session-1",
                    2002_i64,
                    r#"{"type":"text","text":"answer"}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();

        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["type"], "user");
        assert_eq!(events[0]["message"]["content"][0]["text"], "hello");
        assert_eq!(events[1]["type"], "assistant");
        assert_eq!(events[1]["message"]["content"][0]["type"], "thinking");
        assert_eq!(events[1]["message"]["content"][1]["text"], "answer");
        assert_eq!(events[1]["usage"]["input_tokens"], 3);
        assert_eq!(events[2]["type"], "result");
        assert_eq!(events[2]["subtype"], "success");
        assert!(events[2].get("usage").is_none());
    }

    #[test]
    fn adds_success_result_event_after_opencode_assistant() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);\
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-1",
                    "session-1",
                    2000_i64,
                    2600_i64,
                    r#"{"role":"assistant","tokens":{"input":3,"output":2,"reasoning":1,"cache":{"read":4,"write":0}},"providerID":"openai","modelID":"model-1"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-text",
                    "assistant-1",
                    "session-1",
                    2002_i64,
                    r#"{"type":"text","text":"answer"}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();

        assert_eq!(events.len(), 3);
        assert_eq!(events[1]["type"], "assistant");
        assert_eq!(events[2]["type"], "result");
        assert_eq!(events[2]["subtype"], "success");
        assert_eq!(events[2]["is_error"], false);
        assert_eq!(events[2]["duration_ms"], 1600);
        assert_eq!(events[2]["timestamp"], "1970-01-01T00:00:02.600Z");
        assert!(events[2].get("usage").is_none());
        assert!(events[2].get("last_token_usage").is_none());
    }

    #[test]
    fn normalized_opencode_history_emits_codemux_domain_events() {
        use super::super::history_events::normalize_history_events;

        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-1",
                    "session-1",
                    2000_i64,
                    2600_i64,
                    r#"{"role":"assistant","tokens":{"input":3,"output":2,"reasoning":1,"cache":{"read":4,"write":0}},"providerID":"openai","modelID":"model-1"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-text",
                    "assistant-1",
                    "session-1",
                    2002_i64,
                    r#"{"type":"text","text":"answer"}"#
                ],
            )
            .unwrap();

        let raw = load_opencode_events_from_connection(&connection, "session-1").unwrap();
        let normalized = normalize_history_events(raw, "app-session-1");

        assert!(!normalized.is_empty());
        for (sequence, event) in normalized.iter().enumerate() {
            assert_eq!(event["sequence"], sequence);
            assert_eq!(event["session_id"], "app-session-1");
            let event_type = event["type"].as_str().unwrap_or_default();
            assert!(
                matches!(
                    event_type,
                    "user_message"
                        | "assistant_message"
                        | "text_delta"
                        | "tool_started"
                        | "tool_finished"
                        | "turn_finished"
                        | "system_event"
                        | "diagnostic"
                ),
                "unexpected event type: {event_type}"
            );
        }
        assert_eq!(normalized[0]["type"], "user_message");
        assert!(normalized
            .iter()
            .any(|event| event["type"] == "assistant_message" || event["type"] == "text_delta"));
        assert!(normalized
            .iter()
            .any(|event| event["type"] == "turn_finished"));
    }

    #[test]
    fn keeps_one_success_result_for_a_multi_assistant_turn() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);\
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-1",
                    "session-1",
                    2000_i64,
                    2300_i64,
                    r#"{"role":"assistant","tokens":{"input":5346,"output":126,"reasoning":5918,"cache":{"read":50432,"write":0}},"providerID":"openai","modelID":"model-1"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-2",
                    "session-1",
                    2400_i64,
                    2800_i64,
                    r#"{"role":"assistant","tokens":{"input":13348,"output":1591,"reasoning":0,"cache":{"read":48640,"write":0}},"providerID":"openai","modelID":"model-1"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-tool",
                    "assistant-1",
                    "session-1",
                    2001_i64,
                    r#"{"type":"tool","callID":"call-1","tool":"bash","state":{"status":"completed","input":{"command":"pwd"},"output":"ok"}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-text",
                    "assistant-2",
                    "session-1",
                    2402_i64,
                    r#"{"type":"text","text":"answer"}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();
        let result_count = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("result"))
            .count();
        let result = events
            .iter()
            .find(|event| event.get("type").and_then(Value::as_str) == Some("result"))
            .expect("turn result should exist");

        assert_eq!(result_count, 1);
        assert_eq!(result["subtype"], "success");
        assert_eq!(result["duration_ms"], 1800);
    }

    #[test]
    fn measures_turn_duration_from_user_prompt_through_last_assistant_message() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);\
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1_000_000_i64,
                    1_000_000_i64,
                    r#"{"role":"user"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1_000_001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-1",
                    "session-1",
                    1_100_000_i64,
                    1_127_785_i64,
                    r#"{"role":"assistant","tokens":{"input":3,"output":2}}"#
                ],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            rusqlite::params![
                "part-tool", "assistant-1", "session-1", 1_100_001_i64,
                r#"{"type":"tool","callID":"call-1","tool":"bash","state":{"status":"completed","input":{"command":"pwd"},"output":"ok"}}"#
            ],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-2",
                    "session-1",
                    1_424_456_i64,
                    1_433_801_i64,
                    r#"{"role":"assistant","tokens":{"input":3,"output":2}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-text",
                    "assistant-2",
                    "session-1",
                    1_424_457_i64,
                    r#"{"type":"text","text":"done"}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();
        let result = events
            .iter()
            .find(|event| event.get("type").and_then(Value::as_str) == Some("result"))
            .expect("turn result should exist");

        assert_eq!(result["duration_ms"], 433_801);
        assert_eq!(result["duration_api_ms"], 433_801);
    }

    #[test]
    fn emits_opencode_tool_results_before_the_terminal_result() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);\
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    1000_i64,
                    r#"{"role":"user"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user-text",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"run it"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-1",
                    "session-1",
                    2000_i64,
                    2600_i64,
                    r#"{"role":"assistant","tokens":{"input":3,"output":2}}"#
                ],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            rusqlite::params![
                "part-tool", "assistant-1", "session-1", 2001_i64,
                r#"{"type":"tool","callID":"call-1","tool":"bash","state":{"status":"completed","input":{"command":"pwd"},"output":"ok"}}"#
            ],
        ).unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();
        let types: Vec<&str> = events
            .iter()
            .filter_map(|event| event.get("type").and_then(Value::as_str))
            .collect();

        assert_eq!(types, vec!["user", "assistant", "user", "result"]);
        assert_eq!(events[2]["message"]["content"][0]["type"], "tool_result");
        assert_eq!(events[3]["subtype"], "success");
    }

    #[test]
    fn adds_success_result_event_when_opencode_tokens_are_missing_or_zero() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);\
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-missing",
                    "session-1",
                    1000_i64,
                    1400_i64,
                    r#"{"role":"assistant","providerID":"openai","modelID":"model-1"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-missing",
                    "assistant-missing",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"answer without tokens"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-zero",
                    "session-1",
                    2000_i64,
                    2600_i64,
                    r#"{"role":"assistant","tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"providerID":"openai","modelID":"model-1"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-zero",
                    "assistant-zero",
                    "session-1",
                    2001_i64,
                    r#"{"type":"text","text":"answer with zero tokens"}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();

        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["type"], "assistant");
        assert_eq!(events[1]["type"], "assistant");
        assert_eq!(events[2]["type"], "result");
        assert_eq!(events[2]["subtype"], "success");
        assert_eq!(events[2]["is_error"], false);
        assert_eq!(events[2]["duration_ms"], 600);
        assert!(events[2].get("usage").is_none());
        assert!(events[2].get("last_token_usage").is_none());
    }

    #[test]
    fn converts_failed_assistant_messages_into_visible_error_events() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection.execute(
            "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
            rusqlite::params![
                "assistant-error",
                "session-error",
                1000_i64,
                r#"{"role":"assistant","modelID":"model-1","error":{"name":"APIError","data":{"message":"Missing Authorization"}}}"#,
            ],
        ).unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-error").unwrap();

        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "error");
        assert_eq!(events[0]["error"], "Missing Authorization");
        assert_eq!(events[1]["type"], "result");
        assert_eq!(events[1]["subtype"], "error");
        assert_eq!(events[1]["is_error"], true);
    }

    #[test]
    fn converts_compaction_part_into_compact_boundary_event() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "compaction-1",
                    "session-1",
                    2000_i64,
                    r#"{"role":"assistant","time":{"created":2000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-compaction",
                    "compaction-1",
                    "session-1",
                    2001_i64,
                    r#"{"type":"compaction","auto":true,"overflow":false,"tail_start_id":"msg_abc123"}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();

        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "user");
        assert_eq!(events[1]["type"], "system");
        assert_eq!(events[1]["subtype"], "compact_boundary");
        assert_eq!(events[1]["content"], "Conversation compacted");
        assert_eq!(events[1]["compact_metadata"]["trigger"], "auto");
        assert_eq!(events[1]["compact_metadata"]["overflow"], false);
    }

    #[test]
    fn converts_compaction_mode_message_into_compact_boundary_event() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "compaction-summary-1",
                    "session-1",
                    2000_i64,
                    r#"{"role":"assistant","mode":"compaction","summary":true,"time":{"created":2000}}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();

        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "user");
        assert_eq!(events[1]["type"], "system");
        assert_eq!(events[1]["subtype"], "compact_boundary");
        assert_eq!(events[1]["content"], "Conversation compacted");
        assert_eq!(events[1]["compact_metadata"]["trigger"], "auto");
    }

    #[test]
    fn filters_textual_user_compaction_summary_from_history() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "compaction-summary-1",
                    "session-1",
                    2000_i64,
                    r#"{"role":"user","mode":"compaction","summary":true,"time":{"created":2000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-compaction-summary",
                    "compaction-summary-1",
                    "session-1",
                    2001_i64,
                    r#"{"type":"text","text":"summary generated by compaction"}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();
        let user_events: Vec<&Value> = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("user"))
            .collect();

        assert_eq!(user_events.len(), 1);
        assert_eq!(user_events[0]["message"]["content"][0]["text"], "hello");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.get("type").and_then(Value::as_str) == Some("system"))
                .count(),
            1
        );
        assert_eq!(events[1]["subtype"], "compact_boundary");
    }

    #[test]
    fn filters_textual_assistant_compaction_summary_from_history() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "compaction-user-1",
                    "session-1",
                    1500_i64,
                    r#"{"role":"user","time":{"created":1500}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-compaction-marker",
                    "compaction-user-1",
                    "session-1",
                    1501_i64,
                    r#"{"type":"compaction","auto":true,"overflow":false}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "compaction-summary-1",
                    "session-1",
                    2000_i64,
                    r#"{"role":"assistant","mode":"compaction","summary":true,"time":{"created":2000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-compaction-reasoning",
                    "compaction-summary-1",
                    "session-1",
                    2001_i64,
                    r#"{"type":"reasoning","text":"Objective: summarize context"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-compaction-text",
                    "compaction-summary-1",
                    "session-1",
                    2002_i64,
                    r#"{"type":"text","text":"Important details from compaction"}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();
        let assistant_events: Vec<&Value> = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("assistant"))
            .collect();
        let compact_events: Vec<&Value> = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("system")
                    && event.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
            })
            .collect();

        assert_eq!(assistant_events.len(), 0);
        assert_eq!(compact_events.len(), 1);
        assert_eq!(compact_events[0]["compact_metadata"]["trigger"], "auto");
    }

    #[test]
    fn filters_synthetic_compaction_continue_user_message_from_history() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "compaction-continue-1",
                    "session-1",
                    2000_i64,
                    r#"{"role":"user","agent":"build","time":{"created":2000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-compaction-continue",
                    "compaction-continue-1",
                    "session-1",
                    2001_i64,
                    r#"{"type":"text","metadata":{"compaction_continue":true},"synthetic":true,"text":"Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();

        assert!(
            events.is_empty(),
            "synthetic compaction continuation should not become a user event"
        );
    }

    #[test]
    fn restores_user_image_file_parts_from_opencode_history() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-text",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"describe this"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-image",
                    "user-1",
                    "session-1",
                    1002_i64,
                    r#"{"type":"file","mime":"image/png","filename":"screen.png","url":"data:image/png;base64,ZmFrZQ=="}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "user");
        let content = events[0]["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["name"], "screen.png");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "ZmFrZQ==");
    }

    #[test]
    fn ignores_opencode_git_summary_messages() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"hello"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "assistant-1",
                    "session-1",
                    2000_i64,
                    r#"{"role":"assistant","modelID":"test-model","time":{"created":2000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-assistant",
                    "assistant-1",
                    "session-1",
                    2001_i64,
                    r#"{"type":"text","text":"done"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "summary-1",
                    "session-1",
                    3000_i64,
                    r#"{"role":"user","agent":"build","summary":{"diffs":[{"file":"src/foo.ts","patch":"--- a\n+++ b\n","additions":3,"deletions":1,"status":"modified"}]},"time":{"created":3000}}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();
        assert!(
            !events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("system")
                    && event.get("subtype").and_then(Value::as_str) == Some("session_summary")
            }),
            "git summary messages should not emit session_summary"
        );

        let user_events: Vec<&Value> = events
            .iter()
            .filter(|e| e.get("type").and_then(Value::as_str) == Some("user"))
            .collect();
        assert_eq!(
            user_events.len(),
            1,
            "should only have the original user message, not the summary"
        );
    }

    #[test]
    fn skips_session_summary_when_diffs_is_empty() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "summary-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","summary":{"diffs":[]},"time":{"created":1000}}"#
                ],
            )
            .unwrap();

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();
        assert!(
            events.is_empty(),
            "empty diffs should not produce any event"
        );
    }

    #[test]
    fn synthesizes_session_summary_from_opencode_edit_tool_history() {
        use super::super::history_events::normalize_history_events;

        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","time":{"created":1000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-user",
                    "user-1",
                    "session-1",
                    1001_i64,
                    r#"{"type":"text","text":"fix the bug"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "assistant-1",
                    "session-1",
                    2000_i64,
                    2600_i64,
                    r#"{"role":"assistant","modelID":"test","time":{"created":2000}}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![
                    "part-edit",
                    "assistant-1",
                    "session-1",
                    2002_i64,
                    r#"{"type":"tool","callID":"call-1","tool":"edit","state":{"status":"completed","input":{"filePath":"src/foo.ts","oldString":"old\n","newString":"new\n"},"output":"ok"}}"#
                ],
            )
            .unwrap();

        let raw = load_opencode_events_from_connection(&connection, "session-1").unwrap();
        let normalized = normalize_history_events(raw, "app-session-1");
        let summary_pos = normalized.iter().position(|event| {
            event.get("type").and_then(Value::as_str) == Some("system_event")
                && event.get("subtype").and_then(Value::as_str) == Some("session_summary")
        });
        let turn_finished_pos = normalized
            .iter()
            .position(|event| event.get("type").and_then(Value::as_str) == Some("turn_finished"));

        assert!(
            summary_pos.is_some(),
            "expected synthesized session_summary"
        );
        assert!(turn_finished_pos.is_some(), "expected turn_finished");
        assert!(
            summary_pos.unwrap() < turn_finished_pos.unwrap(),
            "session_summary should come before turn_finished"
        );

        let summary_event = &normalized[summary_pos.unwrap()];
        let diffs = summary_event["diffs"]
            .as_array()
            .expect("diffs should be an array");
        assert_eq!(diffs.len(), 1);
        assert!(diffs[0]["file"]
            .as_str()
            .unwrap_or_default()
            .ends_with("src/foo.ts"));
        assert_eq!(diffs[0]["additions"], 1);
        assert_eq!(diffs[0]["deletions"], 1);
    }

    fn rewind_fixture_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);\
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        let messages: [(&str, i64, &str); 4] = [
            ("user-1", 1000, r#"{"role":"user"}"#),
            ("assistant-1", 1500, r#"{"role":"assistant"}"#),
            ("user-2", 2000, r#"{"role":"user"}"#),
            ("assistant-2", 2500, r#"{"role":"assistant"}"#),
        ];
        for (id, time_created, data) in messages {
            connection
                .execute(
                    "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                    rusqlite::params![id, "session-1", time_created, data],
                )
                .unwrap();
        }
        connection.execute(
            "INSERT INTO part VALUES ('part-user-1', 'user-1', 'session-1', 1001, 1001, '{\"type\":\"text\",\"text\":\"first question\"}')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO part VALUES ('part-assistant-1', 'assistant-1', 'session-1', 1501, 1501, '{\"type\":\"text\",\"text\":\"first answer\"}')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO part VALUES ('part-user-2', 'user-2', 'session-1', 2001, 2001, '{\"type\":\"text\",\"text\":\"second question\"}')",
            [],
        ).unwrap();
        connection
    }

    fn count_messages(connection: &Connection) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM message WHERE session_id = 'session-1'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn rewinds_opencode_messages_from_target_message_id() {
        let connection = rewind_fixture_connection();
        let target = super::super::rewind::RewindTarget {
            provider_message_id: Some("user-2".to_string()),
            source_event_index: None,
            line_index: None,
            role: None,
            text_fingerprint: None,
            turn_ordinal: None,
        };

        let truncated_to_empty =
            rewind_opencode_events_from_connection(&connection, "session-1", Some(&target))
                .unwrap();

        assert!(!truncated_to_empty);
        assert_eq!(count_messages(&connection), 2);
        let remaining_parts: i64 = connection
            .query_row("SELECT COUNT(*) FROM part", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining_parts, 2);
    }

    #[test]
    fn rewinds_opencode_to_latest_turn_without_target() {
        let connection = rewind_fixture_connection();

        let truncated_to_empty =
            rewind_opencode_events_from_connection(&connection, "session-1", None).unwrap();

        assert!(!truncated_to_empty);
        assert_eq!(count_messages(&connection), 2);
    }

    #[test]
    fn rewinds_opencode_target_by_ordinal_and_fingerprint_truncates_to_empty() {
        let connection = rewind_fixture_connection();
        let target = super::super::rewind::RewindTarget {
            provider_message_id: None,
            source_event_index: None,
            line_index: None,
            role: None,
            text_fingerprint: Some("first question".to_string()),
            turn_ordinal: Some(1),
        };

        let truncated_to_empty =
            rewind_opencode_events_from_connection(&connection, "session-1", Some(&target))
                .unwrap();

        assert!(truncated_to_empty);
        assert_eq!(count_messages(&connection), 0);
    }

    #[test]
    fn errors_when_opencode_rewind_target_message_missing_and_leaves_db_unchanged() {
        let connection = rewind_fixture_connection();
        let target = super::super::rewind::RewindTarget {
            provider_message_id: Some("missing-message".to_string()),
            source_event_index: None,
            line_index: None,
            role: None,
            text_fingerprint: None,
            turn_ordinal: None,
        };

        let result =
            rewind_opencode_events_from_connection(&connection, "session-1", Some(&target));

        assert!(result.is_err());
        assert_eq!(count_messages(&connection), 4);
    }

    #[test]
    fn errors_when_opencode_rewind_target_history_is_empty_instead_of_clearing_mapping() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);\
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        let target = super::super::rewind::RewindTarget {
            provider_message_id: Some("msg_missing".to_string()),
            source_event_index: None,
            line_index: None,
            role: None,
            text_fingerprint: None,
            turn_ordinal: None,
        };

        let result =
            rewind_opencode_events_from_connection(&connection, "session-empty", Some(&target));

        assert!(result.is_err());
    }

    #[test]
    fn errors_when_opencode_rewind_fingerprint_mismatches() {
        let connection = rewind_fixture_connection();
        let target = super::super::rewind::RewindTarget {
            provider_message_id: None,
            source_event_index: None,
            line_index: None,
            role: None,
            text_fingerprint: Some("different text".to_string()),
            turn_ordinal: Some(1),
        };

        let result =
            rewind_opencode_events_from_connection(&connection, "session-1", Some(&target));

        assert!(result.is_err());
        assert_eq!(count_messages(&connection), 4);
    }
}

pub fn load_opencode_native_events(
    home: &std::path::Path,
    session_id: &str,
) -> Result<Vec<Value>, String> {
    let Some(path) = find_opencode_database(home) else {
        return Ok(Vec::new());
    };
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Failed to open OpenCode database: {}", error))?;
    load_opencode_events_from_connection(&connection, session_id)
}

pub fn load_latest_opencode_token_usage(
    home: &std::path::Path,
    session_id: &str,
    freshness: &str,
) -> Result<Option<ThreadTokenUsageSnapshot>, String> {
    let Some(path) = find_opencode_database(home) else {
        return Ok(None);
    };
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Failed to open OpenCode database: {}", error))?;
    load_latest_opencode_token_usage_from_connection(&connection, session_id, freshness)
}

pub fn rewind_opencode_session(
    home: &std::path::Path,
    session_id: &str,
    target: Option<&super::rewind::RewindTarget>,
) -> Result<bool, String> {
    let Some(path) = find_opencode_database(home) else {
        return Ok(false);
    };
    let connection = Connection::open(path)
        .map_err(|error| format!("Failed to open OpenCode database for rewind: {}", error))?;
    rewind_opencode_events_from_connection(&connection, session_id, target)
}

/// Resolve the message ID at which the rewind boundary starts: the boundary
/// message itself and every ordered message after it are removed.
fn resolve_opencode_rewind_boundary(
    connection: &Connection,
    ordered_rows: &[(String, String)],
    session_id: &str,
    target: Option<&super::rewind::RewindTarget>,
) -> Result<Option<String>, String> {
    if ordered_rows.is_empty() {
        // An explicit target against an empty native history means the mapped
        // session no longer matches the conversation (e.g. the mapping drifted).
        // Fail loudly instead of reporting an empty truncation, which would
        // clear the session mapping and orphan the real native conversation.
        if target.is_some() {
            return Err(format!(
                "Target rewind user message not found in session history {}",
                session_id
            ));
        }
        return Ok(None);
    }

    let target_not_found = || {
        format!(
            "Target rewind user message not found in session history {}",
            session_id
        )
    };

    let Some(target) = target else {
        return Ok(ordered_rows
            .iter()
            .rev()
            .find(|(_, role)| role == "user")
            .map(|(id, _)| id.clone()));
    };

    let provider_message_id = target
        .provider_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(provider_message_id) = provider_message_id {
        if !ordered_rows.iter().any(|(id, _)| id == provider_message_id) {
            return Err(target_not_found());
        }
        return Ok(Some(provider_message_id.to_string()));
    }

    if let Some(turn_ordinal) = target.turn_ordinal {
        if turn_ordinal == 0 {
            return Err(format!(
                "Invalid rewind turn ordinal 0 in session history {}",
                session_id
            ));
        }
        let user_rows: Vec<&(String, String)> = ordered_rows
            .iter()
            .filter(|(_, role)| role == "user")
            .collect();
        let Some((candidate_id, _)) = user_rows.get(turn_ordinal - 1) else {
            return Err(target_not_found());
        };
        let candidate_id = candidate_id.clone();

        if let Some(fingerprint) = target
            .text_fingerprint
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let text = load_opencode_user_text(connection, session_id, &candidate_id)?;
            if super::rewind::normalize_rewind_text(&text)
                != super::rewind::normalize_rewind_text(fingerprint)
            {
                return Err(target_not_found());
            }
        }
        return Ok(Some(candidate_id));
    }

    Err(format!(
        "OpenCode rewind target requires a provider message id or turn ordinal (session {})",
        session_id
    ))
}

fn load_opencode_user_text(
    connection: &Connection,
    session_id: &str,
    message_id: &str,
) -> Result<String, String> {
    let parts = load_opencode_parts(connection, session_id, message_id)?;
    let mut texts = Vec::new();
    for part in parts {
        if part.data.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = part.data.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    texts.push(text.to_string());
                }
            }
        }
    }
    Ok(texts.join("\n"))
}

fn delete_opencode_rows_by_ids(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
    column: &str,
    ids: &[String],
) -> Result<(), String> {
    for chunk in ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "DELETE FROM {} WHERE {} IN ({})",
            table, column, placeholders
        );
        let params: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        transaction
            .execute(&sql, params.as_slice())
            .map_err(|e| format!("Failed to delete OpenCode rows during rewind: {}", e))?;
    }
    Ok(())
}

fn rewind_opencode_events_from_connection(
    connection: &Connection,
    session_id: &str,
    target: Option<&super::rewind::RewindTarget>,
) -> Result<bool, String> {
    let mut statement = connection
        .prepare("SELECT id, json_extract(data, '$.role') FROM message WHERE session_id = ?1 ORDER BY time_created ASC, id ASC")
        .map_err(|e| format!("Failed to query OpenCode messages for rewind: {}", e))?;
    let ordered_rows = statement
        .query_map([session_id], |row| {
            let id: String = row.get(0)?;
            let role: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
            Ok((id, role))
        })
        .map_err(|e| format!("Failed to query OpenCode messages for rewind: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read OpenCode messages for rewind: {}", e))?;
    let Some(boundary_id) =
        resolve_opencode_rewind_boundary(connection, &ordered_rows, session_id, target)?
    else {
        return Ok(true);
    };
    let boundary_index = ordered_rows
        .iter()
        .position(|(id, _)| id == &boundary_id)
        .ok_or_else(|| {
            format!(
                "Target rewind user message not found in session history {}",
                session_id
            )
        })?;
    let delete_ids: Vec<String> = ordered_rows[boundary_index..]
        .iter()
        .map(|(id, _)| id.clone())
        .collect();
    if delete_ids.is_empty() {
        return Ok(false);
    }

    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin OpenCode rewind transaction: {}", e))?;

    delete_opencode_rows_by_ids(&transaction, "part", "message_id", &delete_ids)?;
    delete_opencode_rows_by_ids(&transaction, "message", "id", &delete_ids)?;

    transaction
        .commit()
        .map_err(|e| format!("Failed to commit OpenCode rewind: {}", e))?;

    let remaining: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM message WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Ok(remaining == 0)
}

pub(crate) fn find_opencode_database(home: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        candidates.push(std::path::PathBuf::from(data_home).join("opencode/opencode.db"));
    }
    candidates.push(home.join(".local/share/opencode/opencode.db"));
    candidates.push(home.join(".config/opencode/opencode.db"));
    candidates.push(home.join("Library/Application Support/opencode/opencode.db"));
    candidates.push(home.join("AppData/Local/opencode/opencode.db"));
    candidates.push(home.join("AppData/Roaming/opencode/opencode.db"));
    candidates.into_iter().find(|path| path.exists())
}

fn load_opencode_events_from_connection(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<Value>, String> {
    let mut message_statement = connection
        .prepare("SELECT id, time_created, time_updated, data FROM message WHERE session_id = ?1 ORDER BY time_created ASC, id ASC")
        .map_err(|error| format!("Failed to query OpenCode messages: {}", error))?;
    let message_rows = message_statement
        .query_map([session_id], |row| {
            let id: String = row.get(0)?;
            let time_created: i64 = row.get(1)?;
            let time_updated: i64 = row.get(2)?;
            let data: String = row.get(3)?;
            Ok((id, time_created, time_updated, data))
        })
        .map_err(|error| format!("Failed to read OpenCode messages: {}", error))?;

    let mut events = Vec::new();
    let mut pending_success_result: Option<Value> = None;
    let mut turn_start_time: Option<i64> = None;

    for row in message_rows {
        let (message_id, time_created, time_updated, data) =
            row.map_err(|error| format!("Failed to decode OpenCode message row: {}", error))?;
        let message: Value = serde_json::from_str(&data).map_err(|error| {
            format!(
                "Failed to decode OpenCode message {}: {}",
                message_id, error
            )
        })?;
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            events.push(serde_json::json!({
                "type": "diagnostic",
                "subtype": "unknown_opencode_message_role",
                "role": role,
                "raw": message,
                "session_id": session_id,
                "timestamp": timestamp_string(time_created),
            }));
            continue;
        }

        let mut parts = load_opencode_parts(connection, session_id, &message_id)?;
        sort_opencode_parts(&mut parts);
        let mut content = Vec::new();
        let mut tool_results = Vec::new();
        let mut diagnostics = Vec::new();
        let mut has_compaction_part = false;
        let mut has_compaction_continue_part = false;
        for part in parts {
            let part_type = part
                .data
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if part
                .data
                .get("metadata")
                .and_then(|metadata| metadata.get("compaction_continue"))
                .and_then(Value::as_bool)
                == Some(true)
                && part.data.get("synthetic").and_then(Value::as_bool) == Some(true)
            {
                has_compaction_continue_part = true;
            }
            match part_type {
                "text" => {
                    if let Some(text) = part
                        .data
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        content.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                }
                "file" => {
                    if let Some(image_block) = opencode_file_part_to_image_block(&part.data) {
                        content.push(image_block);
                    } else {
                        diagnostics.push(serde_json::json!({
                            "type": "diagnostic",
                            "subtype": "unknown_opencode_part",
                            "part_type": part_type,
                            "raw": part.data,
                            "session_id": session_id,
                            "timestamp": timestamp_string(part.time_created),
                        }));
                    }
                }
                "reasoning" => {
                    if let Some(text) = part
                        .data
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        content.push(serde_json::json!({ "type": "thinking", "thinking": text }));
                    }
                }
                "step-start" | "step-finish" => {}
                "tool" if role == "assistant" => {
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
                    let input = state
                        .get("input")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    content.push(serde_json::json!({
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
                        tool_results.push(serde_json::json!({
                            "type": "user",
                            "uuid": format!("{}-result", part.id),
                            "session_id": session_id,
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
                            "timestamp": timestamp_string(part.time_created),
                        }));
                    }
                }
                "compaction" => {
                    has_compaction_part = true;
                    flush_pending_opencode_result(&mut events, &mut pending_success_result);
                    let auto = part
                        .data
                        .get("auto")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let overflow = part
                        .data
                        .get("overflow")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    events.push(serde_json::json!({
                        "type": "system",
                        "subtype": "compact_boundary",
                        "content": "Conversation compacted",
                        "compact_metadata": {
                            "trigger": if auto { "auto" } else { "manual" },
                            "pre_tokens": 0,
                            "overflow": overflow,
                        },
                        "uuid": format!("{}-compaction", part.id),
                        "session_id": session_id,
                        "timestamp": timestamp_string(part.time_created),
                    }));
                }
                _ => diagnostics.push(serde_json::json!({
                    "type": "diagnostic",
                    "subtype": "unknown_opencode_part",
                    "part_type": part_type,
                    "raw": part.data,
                    "session_id": session_id,
                    "timestamp": timestamp_string(part.time_created),
                })),
            }
        }

        events.extend(diagnostics);

        if role == "user" && has_compaction_continue_part {
            continue;
        }

        let mode = message
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role == "user" && mode == "compaction" && !has_compaction_part {
            flush_pending_opencode_result(&mut events, &mut pending_success_result);
            events.push(serde_json::json!({
                "type": "system",
                "subtype": "compact_boundary",
                "content": "Conversation compacted",
                "compact_metadata": {
                    "trigger": "auto",
                    "pre_tokens": 0,
                },
                "uuid": format!("{}-compaction", message_id),
                "session_id": session_id,
                "timestamp": timestamp_string(time_created),
            }));
            continue;
        }

        if content.is_empty() && role == "user" {
            continue;
        }
        let timestamp = timestamp_string(time_created);
        if role == "user" {
            flush_pending_opencode_result(&mut events, &mut pending_success_result);
            turn_start_time = Some(time_created);
            events.push(serde_json::json!({
                "type": "user",
                "uuid": message_id,
                "session_id": session_id,
                "message": { "role": "user", "content": content },
                "parent_tool_use_id": Value::Null,
                "timestamp": timestamp,
            }));
        } else {
            if let Some(error) = message.get("error") {
                pending_success_result = None;
                let error_text = opencode_error_message(error);
                events.push(serde_json::json!({
                    "type": "error",
                    "subtype": "error",
                    "error": error_text,
                    "uuid": format!("{}-error", message_id),
                    "session_id": session_id,
                    "timestamp": timestamp_string(time_created),
                }));
                events.extend(tool_results);
                events.push(serde_json::json!({
                    "type": "result",
                    "subtype": "error",
                    "is_error": true,
                    "uuid": format!("{}-result", message_id),
                    "session_id": session_id,
                    "duration_ms": 0,
                    "duration_api_ms": 0,
                    "num_turns": 1,
                    "result": "error",
                    "timestamp": timestamp_string(time_created),
                }));
                continue;
            }

            if mode == "compaction" {
                let is_summary = message
                    .get("summary")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if is_summary {
                    // OpenCode compaction summaries may include reasoning/text parts.
                    // They are internal context, not user-facing assistant output.
                    if content.is_empty() {
                        flush_pending_opencode_result(&mut events, &mut pending_success_result);
                        events.push(serde_json::json!({
                            "type": "system",
                            "subtype": "compact_boundary",
                            "content": "Conversation compacted",
                            "compact_metadata": {
                                "trigger": "auto",
                                "pre_tokens": 0,
                            },
                            "uuid": format!("{}-compaction", message_id),
                            "session_id": session_id,
                            "timestamp": timestamp_string(time_created),
                        }));
                    }
                    continue;
                }
            }

            if content.is_empty() {
                continue;
            }
            let mut event = serde_json::json!({
                "type": "assistant",
                "uuid": message_id,
                "session_id": session_id,
                "message": {
                    "role": "assistant",
                    "content": content,
                    "model": message.get("modelID").cloned().unwrap_or(Value::Null),
                },
                "parent_tool_use_id": Value::Null,
                "timestamp": timestamp,
            });
            if let Some(tokens) = message.get("tokens") {
                event["usage"] = serde_json::json!({
                    "input_tokens": tokens.get("input").and_then(Value::as_i64).unwrap_or(0),
                    "output_tokens": tokens.get("output").and_then(Value::as_i64).unwrap_or(0),
                    "reasoning_output_tokens": tokens.get("reasoning").and_then(Value::as_i64).unwrap_or(0),
                    "cached_input_tokens": tokens.get("cache").and_then(|cache| cache.get("read")).and_then(Value::as_i64).unwrap_or(0),
                    "cache_write_input_tokens": tokens.get("cache").and_then(|cache| cache.get("write")).and_then(Value::as_i64).unwrap_or(0),
                });
            }
            events.push(event);
            // Tool results are part of the current Turn and must be reduced
            // before its terminal event. Otherwise the reducer sees a
            // completed Turn with still-pending tools.
            events.extend(tool_results);
            pending_success_result = build_opencode_success_result_event(
                &message_id,
                session_id,
                turn_start_time.unwrap_or(time_created),
                time_updated,
            );
        }
    }
    flush_pending_opencode_result(&mut events, &mut pending_success_result);
    Ok(events)
}

fn flush_pending_opencode_result(events: &mut Vec<Value>, pending: &mut Option<Value>) {
    if let Some(result) = pending.take() {
        events.push(result);
    }
}

fn build_opencode_success_result_event(
    message_id: &str,
    session_id: &str,
    turn_started_at: i64,
    completed_at: i64,
) -> Option<Value> {
    let duration_ms = (completed_at - turn_started_at).max(0);
    Some(serde_json::json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "uuid": format!("{}-result", message_id),
        "session_id": session_id,
        "duration_ms": duration_ms,
        "duration_api_ms": duration_ms,
        "num_turns": 1,
        "result": "ok",
        "timestamp": timestamp_string(completed_at),
    }))
}

fn load_latest_opencode_token_usage_from_connection(
    connection: &Connection,
    session_id: &str,
    freshness: &str,
) -> Result<Option<ThreadTokenUsageSnapshot>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created DESC, id DESC",
        )
        .map_err(|error| format!("Failed to query OpenCode token usage: {}", error))?;
    let rows = statement
        .query_map([session_id], |row| {
            let id: String = row.get(0)?;
            let data: String = row.get(1)?;
            Ok((id, data))
        })
        .map_err(|error| format!("Failed to read OpenCode token usage rows: {}", error))?;

    for row in rows {
        let (message_id, data) =
            row.map_err(|error| format!("Failed to decode OpenCode token usage row: {}", error))?;
        let message: Value = serde_json::from_str(&data).map_err(|error| {
            format!(
                "Failed to decode OpenCode token usage message {}: {}",
                message_id, error
            )
        })?;
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(tokens) = message.get("tokens") else {
            continue;
        };

        let input_tokens = read_u64_value(tokens.get("input"));
        let output_tokens = read_u64_value(tokens.get("output"));
        let total_tokens_from_api = read_u64_value(tokens.get("total"));
        let cached_input_tokens =
            read_u64_value(tokens.get("cache").and_then(|cache| cache.get("read")));
        let cache_write_input_tokens =
            read_u64_value(tokens.get("cache").and_then(|cache| cache.get("write")));
        let reasoning_output_tokens = read_u64_value(tokens.get("reasoning"));
        if input_tokens == 0
            && output_tokens == 0
            && cached_input_tokens == 0
            && cache_write_input_tokens == 0
            && reasoning_output_tokens == 0
            && total_tokens_from_api == 0
        {
            continue;
        }

        let total_tokens = if total_tokens_from_api > 0 {
            total_tokens_from_api
        } else {
            input_tokens.saturating_add(output_tokens)
        };

        let breakdown = TokenUsageBreakdown {
            total_tokens,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
        };
        return Ok(Some(ThreadTokenUsageSnapshot {
            total: breakdown.clone(),
            last: breakdown,
            model_context_window: None,
            context_usage_source: "history_database".to_string(),
            context_usage_freshness: freshness.to_string(),
        }));
    }

    Ok(None)
}

pub(crate) struct OpenCodePart {
    pub id: String,
    pub time_created: i64,
    pub data: Value,
}

fn opencode_part_logical_time(part: &OpenCodePart) -> i64 {
    part.data
        .get("time")
        .and_then(|time| time.get("start"))
        .and_then(Value::as_i64)
        .unwrap_or(part.time_created)
}

pub(crate) fn sort_opencode_parts(parts: &mut [OpenCodePart]) {
    parts.sort_by(|left, right| {
        opencode_part_logical_time(left)
            .cmp(&opencode_part_logical_time(right))
            .then_with(|| left.id.cmp(&right.id))
    });
}

pub(crate) fn load_opencode_parts(
    connection: &Connection,
    session_id: &str,
    message_id: &str,
) -> Result<Vec<OpenCodePart>, String> {
    let mut statement = connection
        .prepare("SELECT id, time_created, data FROM part WHERE session_id = ?1 AND message_id = ?2 ORDER BY time_created ASC, id ASC")
        .map_err(|error| format!("Failed to query OpenCode parts: {}", error))?;
    let rows = statement
        .query_map(rusqlite::params![session_id, message_id], |row| {
            let data: String = row.get(2)?;
            Ok(OpenCodePart {
                id: row.get(0)?,
                time_created: row.get(1)?,
                data: serde_json::from_str(&data).unwrap_or(Value::Null),
            })
        })
        .map_err(|error| format!("Failed to read OpenCode parts: {}", error))?;
    rows.map(|row| row.map_err(|error| format!("Failed to decode OpenCode part: {}", error)))
        .collect()
}

fn opencode_file_part_to_image_block(part: &Value) -> Option<Value> {
    let mime = part.get("mime").and_then(Value::as_str).unwrap_or("");
    if !mime.starts_with("image/") {
        return None;
    }
    let url = part.get("url").and_then(Value::as_str).unwrap_or("");
    let (media_type, data) = parse_data_image_url(url)?;
    let filename = part
        .get("filename")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("image");
    Some(serde_json::json!({
        "type": "image",
        "name": filename,
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        }
    }))
}

fn parse_data_image_url(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim();
    let rest = trimmed.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    if !meta.ends_with("base64") {
        return None;
    }
    let media_type = meta.trim_end_matches(";base64").trim().to_string();
    if media_type.is_empty() || data.is_empty() {
        return None;
    }
    Some((media_type, data.to_string()))
}

fn opencode_error_message(error: &Value) -> String {
    error
        .get("data")
        .and_then(|data| data.get("message"))
        .or_else(|| error.get("message"))
        .or_else(|| error.get("name"))
        .map(stringify_value)
        .unwrap_or_else(|| stringify_value(error))
}

pub(crate) fn stringify_value(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn read_u64_value(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(Value::String(text)) => text.parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

pub(crate) fn timestamp_string(timestamp: i64) -> String {
    chrono::DateTime::from_timestamp_millis(timestamp)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| timestamp.to_string())
}

#[tauri::command]
pub async fn load_opencode_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<Value>, String> {
    debug!(target: "agent", "Loading OpenCode SQLite session events for app_session_id={}", app_session_id);
    let Some(opencode_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::Opencode)?
    else {
        info!(target: "agent", "No OpenCode mapping found for app_session_id={}", app_session_id);
        return Ok(Vec::new());
    };
    let home = home_dir()?;
    let events = tokio::task::spawn_blocking(move || {
        load_opencode_native_events(&home, &opencode_session_id)
    })
    .await
    .map_err(|error| format!("Failed to join OpenCode history loader: {}", error))??;
    Ok(normalize_history_events(events, &app_session_id))
}

#[tauri::command]
pub async fn delete_opencode_session(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    app_session_id: String,
) -> Result<(), String> {
    delete_opencode_session_for_companion(&app, state.inner(), agent_state.inner(), app_session_id).await
}

pub async fn delete_opencode_session_for_companion(
    app: &AppHandle,
    state: &crate::AppState,
    agent_state: &AgentState,
    app_session_id: String,
) -> Result<(), String> {
    debug!(target: "agent", "Deleting OpenCode session through the official SDK for app_session_id={}", app_session_id);
    let lifecycle_lock = session_lifecycle_lock(agent_state, &app_session_id).await;
    let _lifecycle_guard = lifecycle_lock.lock().await;
    invalidate_session_generation(agent_state, &app_session_id).await;
    let Some(opencode_session_id) =
        get_agent_session_id(state, &app_session_id, AgentKind::Opencode)?
    else {
        return Ok(());
    };
    delete_opencode_native_session(
        app,
        state,
        agent_state,
        &app_session_id,
        &opencode_session_id,
    )
    .await
}

pub(crate) async fn delete_opencode_native_session(
    app: &AppHandle,
    state: &crate::AppState,
    agent_state: &AgentState,
    app_session_id: &str,
    opencode_session_id: &str,
) -> Result<(), String> {
    let runtime_ref = state
        .runtime_resolver
        .resolve_runtime_ref(crate::runtime::Provider::OpenCode)
        .ok_or_else(|| "OpenCode Runtime 未安装或不可用，请先在设置中安装".to_string())?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let command = OpenCodeRuntime::delete_session_command(
        app_session_id,
        opencode_session_id,
        &request_id,
        None,
        &runtime_ref,
    );
    let active_sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars
            .get(app_session_id)
            .map(SidecarHandle::command_sender)
    };

    if let Some(sender) = active_sender {
        let (result_sender, result_receiver) = oneshot::channel();
        agent_state
            .session_delete_waiters
            .lock()
            .await
            .insert(request_id.clone(), result_sender);
        if sender.send(command.to_string()).await.is_err() {
            agent_state
                .session_delete_waiters
                .lock()
                .await
                .remove(&request_id);
            return Err("Failed to send OpenCode session deletion command to sidecar".to_string());
        }
        return match tokio::time::timeout(std::time::Duration::from_secs(30), result_receiver).await
        {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                Err("OpenCode sidecar stopped before confirming session deletion".to_string())
            }
            Err(_) => {
                agent_state
                    .session_delete_waiters
                    .lock()
                    .await
                    .remove(&request_id);
                Err("Timed out waiting for OpenCode session deletion".to_string())
            }
        };
    }

    // No session sidecar is alive after an app restart. Use a short-lived
    // sidecar so the cleanup still goes through OpenCode's official SDK.
    let (mut handle, mut events) = spawn_sidecar(app, tauri::ipc::Channel::new(|_| Ok(()))).await?;
    let send_result = handle.send_command(&command.to_string()).await;
    if let Err(error) = send_result {
        handle.shutdown().await;
        return Err(error);
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while let Some(event) = events.recv().await {
            if let Some(result) = parse_session_delete_result_event(&event) {
                if result.request_id == request_id {
                    return result.result;
                }
            }
        }
        Err("OpenCode sidecar stopped before confirming session deletion".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for OpenCode session deletion".to_string())?;
    handle.shutdown().await;
    result
}
