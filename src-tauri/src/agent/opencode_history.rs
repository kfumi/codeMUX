use crate::agent::context_usage::{ThreadTokenUsageSnapshot, TokenUsageBreakdown};
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

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
        assert_eq!(events[2]["usage"]["cache_read_input_tokens"], 4);
    }

    #[test]
    fn adds_success_result_event_after_opencode_assistant_for_footer_stats() {
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
        assert_eq!(events[2]["duration_ms"], 600);
        assert_eq!(events[2]["timestamp"], "1970-01-01T00:00:02.600Z");
        assert_eq!(events[2]["usage"]["input_tokens"], 3);
        assert_eq!(events[2]["usage"]["output_tokens"], 2);
        assert_eq!(events[2]["usage"]["cache_read_input_tokens"], 4);
        assert_eq!(events[2]["last_token_usage"]["input_tokens"], 3);
        assert_eq!(events[2]["last_token_usage"]["output_tokens"], 2);
        assert_eq!(events[2]["last_token_usage"]["cached_input_tokens"], 4);
        assert_eq!(events[2]["last_token_usage"]["total_tokens"], 5);
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
        assert_eq!(events[2]["usage"]["input_tokens"], 0);
        assert_eq!(events[2]["usage"]["output_tokens"], 0);
        assert_eq!(events[2]["usage"]["cache_read_input_tokens"], 0);
        assert_eq!(events[2]["usage"]["cache_write_input_tokens"], 0);
        assert_eq!(events[2]["last_token_usage"]["total_tokens"], 0);
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
    fn emits_session_summary_event_from_opencode_summary_message() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        // user message
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
        // assistant message with text
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
        // summary message (role: user, summary with diffs)
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

        // user, assistant, result (from assistant), session_summary
        let summary_event = events
            .iter()
            .find(|e| {
                e.get("type").and_then(Value::as_str) == Some("system")
                    && e.get("subtype").and_then(Value::as_str) == Some("session_summary")
            })
            .expect("expected a session_summary system event");

        assert_eq!(summary_event["uuid"], "summary-1-summary");
        assert_eq!(summary_event["session_id"], "session-1");
        let diffs = summary_event["diffs"]
            .as_array()
            .expect("diffs should be an array");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0]["file"], "src/foo.ts");
        assert_eq!(diffs[0]["additions"], 3);
        assert_eq!(diffs[0]["deletions"], 1);
        assert_eq!(diffs[0]["status"], "modified");

        // The summary message should NOT produce an empty user event
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
    fn emits_session_summary_after_assistant_when_user_msg_has_both_text_and_diffs() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        ).unwrap();
        // user message WITH both text part AND summary.diffs (real OpenCode format)
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "user-1",
                    "session-1",
                    1000_i64,
                    r#"{"role":"user","agent":"build","summary":{"diffs":[{"file":"src/foo.ts","additions":3,"deletions":1,"status":"modified"}]},"time":{"created":1000}}"#
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
        // assistant message
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "assistant-1",
                    "session-1",
                    2000_i64,
                    r#"{"role":"assistant","modelID":"test","time":{"created":2000}}"#
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

        let events = load_opencode_events_from_connection(&connection, "session-1").unwrap();

        // Find positions
        let user_pos = events
            .iter()
            .position(|e| e.get("type").and_then(Value::as_str) == Some("user"));
        let assistant_pos = events
            .iter()
            .position(|e| e.get("type").and_then(Value::as_str) == Some("assistant"));
        let summary_pos = events.iter().position(|e| {
            e.get("type").and_then(Value::as_str) == Some("system")
                && e.get("subtype").and_then(Value::as_str) == Some("session_summary")
        });

        // All three should be present
        assert!(user_pos.is_some(), "user event should be present");
        assert!(assistant_pos.is_some(), "assistant event should be present");
        assert!(
            summary_pos.is_some(),
            "session_summary event should be present"
        );

        // session_summary should come AFTER assistant
        assert!(
            summary_pos.unwrap() > assistant_pos.unwrap(),
            "session_summary should come after assistant message, got summary at {} and assistant at {}",
            summary_pos.unwrap(),
            assistant_pos.unwrap()
        );

        // User message should contain the original text
        let user_event = &events[user_pos.unwrap()];
        let user_text = user_event["message"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert_eq!(user_text, "fix the bug");

        // Summary should have correct diffs
        let summary_event = &events[summary_pos.unwrap()];
        assert_eq!(summary_event["diffs"][0]["file"], "src/foo.ts");
    }

    #[test]
    fn deletes_only_the_requested_opencode_session_and_children() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL);",
        ).unwrap();
        connection.execute_batch(
            "INSERT INTO session VALUES ('session-1'), ('session-2');
             INSERT INTO message VALUES ('message-1', 'session-1'), ('message-2', 'session-2');
             INSERT INTO part VALUES ('part-1', 'message-1', 'session-1'), ('part-2', 'message-2', 'session-2');",
        ).unwrap();

        assert!(delete_opencode_session_from_connection(&connection, "session-1").unwrap());

        let counts: (i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM session WHERE id = 'session-1'),
                    (SELECT COUNT(*) FROM message WHERE session_id = 'session-1'),
                    (SELECT COUNT(*) FROM part WHERE session_id = 'session-1')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (0, 0, 0));
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM session WHERE id = 'session-2'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM message WHERE session_id = 'session-2'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM part WHERE session_id = 'session-2'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
}

pub fn load_opencode_session_events(
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

pub fn delete_opencode_session(home: &std::path::Path, session_id: &str) -> Result<bool, String> {
    let Some(path) = find_opencode_database(home) else {
        return Ok(false);
    };
    let connection = Connection::open(path)
        .map_err(|error| format!("Failed to open OpenCode database for deletion: {}", error))?;
    delete_opencode_session_from_connection(&connection, session_id)
}

fn delete_opencode_session_from_connection(
    connection: &Connection,
    session_id: &str,
) -> Result<bool, String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Failed to begin OpenCode session deletion: {}", error))?;
    let mut deleted = false;
    for (table, column) in [
        ("part", "session_id"),
        ("message", "session_id"),
        ("session", "id"),
    ] {
        let statement = format!("DELETE FROM {table} WHERE {column} = ?1");
        let affected = transaction
            .execute(&statement, [session_id])
            .map_err(|error| format!("Failed to delete OpenCode {table} data: {}", error))?;
        deleted |= affected > 0;
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit OpenCode session deletion: {}", error))?;
    Ok(deleted)
}
pub fn rewind_opencode_session_to_latest_turn(
    home: &std::path::Path,
    session_id: &str,
) -> Result<bool, String> {
    let Some(path) = find_opencode_database(home) else {
        return Ok(false);
    };
    let connection = Connection::open(path)
        .map_err(|error| format!("Failed to open OpenCode database for rewind: {}", error))?;
    rewind_opencode_events_from_connection(&connection, session_id)
}

fn rewind_opencode_events_from_connection(
    connection: &Connection,
    session_id: &str,
) -> Result<bool, String> {
    let latest_user_time: Option<i64> = connection
        .query_row(
            "SELECT time_created FROM message WHERE session_id = ?1 AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC, id DESC LIMIT 1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query latest user message in OpenCode session: {}", e))?;

    let Some(latest_user_time) = latest_user_time else {
        return Ok(true);
    };

    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin OpenCode rewind transaction: {}", e))?;

    transaction
        .execute(
            "DELETE FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ?1 AND time_created >= ?2)",
            rusqlite::params![session_id, latest_user_time],
        )
        .map_err(|e| format!("Failed to delete OpenCode parts during rewind: {}", e))?;

    transaction
        .execute(
            "DELETE FROM message WHERE session_id = ?1 AND time_created >= ?2",
            rusqlite::params![session_id, latest_user_time],
        )
        .map_err(|e| format!("Failed to delete OpenCode messages during rewind: {}", e))?;

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

fn find_opencode_database(home: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        candidates.push(std::path::PathBuf::from(data_home).join("opencode/opencode.db"));
    }
    candidates.push(home.join(".local/share/opencode/opencode.db"));
    candidates.push(home.join("AppData/Local/opencode/opencode.db"));
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
    let mut pending_session_summary: Option<Value> = None;

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
            continue;
        }

        let parts = load_opencode_parts(connection, session_id, &message_id)?;
        let mut content = Vec::new();
        let mut tool_results = Vec::new();
        for part in parts {
            let part_type = part
                .data
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
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
                _ => {}
            }
        }

        if content.is_empty() && role == "user" {
            // Even if content is empty, check for summary.diffs on this user message.
            if let Some(summary_obj) = message.get("summary").filter(|v| v.is_object()) {
                if let Some(diffs) = summary_obj
                    .get("diffs")
                    .and_then(Value::as_array)
                    .filter(|d| !d.is_empty())
                {
                    pending_session_summary = Some(serde_json::json!({
                        "type": "system",
                        "subtype": "session_summary",
                        "diffs": diffs,
                        "uuid": format!("{}-summary", message_id),
                        "session_id": session_id,
                        "timestamp": timestamp_string(time_created),
                    }));
                }
            }
            continue;
        }
        let timestamp = timestamp_string(time_created);
        if role == "user" {
            flush_pending_opencode_result(&mut events, &mut pending_success_result);
            flush_pending_session_summary(&mut events, &mut pending_session_summary);
            events.push(serde_json::json!({
                "type": "user",
                "uuid": message_id,
                "session_id": session_id,
                "message": { "role": "user", "content": content },
                "parent_tool_use_id": Value::Null,
                "timestamp": timestamp,
            }));
            // Save summary.diffs for emission after this turn's assistant messages.
            if let Some(summary_obj) = message.get("summary").filter(|v| v.is_object()) {
                if let Some(diffs) = summary_obj
                    .get("diffs")
                    .and_then(Value::as_array)
                    .filter(|d| !d.is_empty())
                {
                    pending_session_summary = Some(serde_json::json!({
                        "type": "system",
                        "subtype": "session_summary",
                        "diffs": diffs,
                        "uuid": format!("{}-summary", message_id),
                        "session_id": session_id,
                        "timestamp": timestamp,
                    }));
                }
            }
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
                    "usage": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cache_read_input_tokens": 0,
                        "cache_write_input_tokens": 0,
                    },
                    "timestamp": timestamp_string(time_created),
                }));
                continue;
            }

            let mode = message
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if mode == "compaction" {
                let is_summary = message
                    .get("summary")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if is_summary && content.is_empty() {
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
                time_created,
                time_updated,
                &message,
            );
        }
    }
    flush_pending_opencode_result(&mut events, &mut pending_success_result);
    flush_pending_session_summary(&mut events, &mut pending_session_summary);
    Ok(events)
}

fn flush_pending_opencode_result(events: &mut Vec<Value>, pending: &mut Option<Value>) {
    if let Some(result) = pending.take() {
        events.push(result);
    }
}

fn flush_pending_session_summary(events: &mut Vec<Value>, pending: &mut Option<Value>) {
    if let Some(summary) = pending.take() {
        events.push(summary);
    }
}

fn build_opencode_success_result_event(
    message_id: &str,
    session_id: &str,
    time_created: i64,
    time_updated: i64,
    message: &Value,
) -> Option<Value> {
    let tokens = message.get("tokens");
    let input_tokens = tokens
        .and_then(|tokens| tokens.get("input"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output_tokens = tokens
        .and_then(|tokens| tokens.get("output"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let total_tokens_from_api = tokens
        .and_then(|tokens| tokens.get("total"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let reasoning_output_tokens = tokens
        .and_then(|tokens| tokens.get("reasoning"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cached_input_tokens = tokens
        .and_then(|tokens| tokens.get("cache"))
        .and_then(|cache| cache.get("read"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_write_input_tokens = tokens
        .and_then(|tokens| tokens.get("cache"))
        .and_then(|cache| cache.get("write"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let total_tokens = if total_tokens_from_api > 0 {
        total_tokens_from_api
    } else {
        input_tokens.saturating_add(output_tokens)
    };

    let duration_ms = (time_updated - time_created).max(0);
    let mut result = serde_json::json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "uuid": format!("{}-result", message_id),
        "session_id": session_id,
        "duration_ms": duration_ms,
        "duration_api_ms": duration_ms,
        "num_turns": 1,
        "result": "ok",
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": cached_input_tokens,
            "cache_write_input_tokens": cache_write_input_tokens,
        },
        "last_token_usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_input_tokens": cached_input_tokens,
            "cache_write_input_tokens": cache_write_input_tokens,
            "total_tokens": total_tokens,
        },
        "timestamp": timestamp_string(time_updated),
    });
    if reasoning_output_tokens > 0 {
        result["usage"]["reasoning_output_tokens"] = serde_json::json!(reasoning_output_tokens);
        result["last_token_usage"]["reasoning_output_tokens"] =
            serde_json::json!(reasoning_output_tokens);
    }
    Some(result)
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

struct OpenCodePart {
    id: String,
    time_created: i64,
    data: Value,
}

fn load_opencode_parts(
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

fn opencode_error_message(error: &Value) -> String {
    error
        .get("data")
        .and_then(|data| data.get("message"))
        .or_else(|| error.get("message"))
        .or_else(|| error.get("name"))
        .map(stringify_value)
        .unwrap_or_else(|| stringify_value(error))
}

fn stringify_value(value: &Value) -> String {
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

fn timestamp_string(timestamp: i64) -> String {
    chrono::DateTime::from_timestamp_millis(timestamp)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| timestamp.to_string())
}
