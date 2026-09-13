use log::warn;
use serde_json::{json, Value};

use crate::db::operations;

const CODE_MUX_DOMAIN_EVENT_TYPES: &[&str] = &[
    "content_started",
    "text_delta",
    "reasoning_delta",
    "tool_input_delta",
    "content_finished",
    "file_snapshot",
    "user_message",
    "assistant_message",
    "tool_started",
    "tool_finished",
    "user_input_requested",
    "permission_requested",
    "permission_resolved",
    "permission_mode_changed",
    "system_event",
    "diagnostic",
    "error",
    "turn_finished",
    "proxy_status",
];

/// Live-streaming scaffolding is broadcast to clients but never persisted: the
/// snapshot keeps complete messages only (same shape as native-history
/// imports), so reload renders from full content and the timeline stays
/// message-sized. Streaming deltas without their start/stop markers would also
/// leave empty blocks behind on reload.
const LIVE_STREAMING_EVENT_TYPES: &[&str] = &[
    "text_delta",
    "reasoning_delta",
    "tool_input_delta",
    "content_started",
    "content_finished",
];

/// 会话侧带运行状态(如 compat 代理启停):只广播给在线客户端,不进时间线。
/// 刷新/重放后由下一次 ensure 触发的新 proxy_status 刷新指示。
const BROADCAST_ONLY_EVENT_TYPES: &[&str] = &["proxy_status"];

pub(crate) fn is_code_mux_domain_event(value: &Value) -> bool {
    let Some(event_type) = value.get("type").and_then(|item| item.as_str()) else {
        return false;
    };
    CODE_MUX_DOMAIN_EVENT_TYPES.contains(&event_type)
}

pub(crate) fn should_persist_domain_event(value: &Value) -> bool {
    if !is_code_mux_domain_event(value) {
        return false;
    }
    let event_type = value.get("type").and_then(|item| item.as_str());
    if event_type.is_some_and(|event_type| LIVE_STREAMING_EVENT_TYPES.contains(&event_type)) {
        return false;
    }
    if event_type.is_some_and(|event_type| BROADCAST_ONLY_EVENT_TYPES.contains(&event_type)) {
        return false;
    }
    if event_type != Some("system_event") {
        return true;
    }
    let subtype = value
        .get("subtype")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    !matches!(subtype, "connected" | "retrying" | "disconnected")
}

/// Single persistence owner for the sidecar domain-event stream: persists
/// persistable events into the session timeline and returns the broadcast
/// copies for every domain event the message carries (batch messages are
/// flattened). Persisted copies are stamped with the snapshot sequence assigned
/// on append, so live WS frames, catch-up replay and the stored timeline share
/// one sequence space; non-persistable copies have their sidecar sequence
/// stripped so clients never admit them into that watermark.
pub(crate) fn handle_sidecar_timeline_event(
    state: &crate::AppState,
    raw_event: &str,
) -> Vec<Value> {
    let Ok(value) = serde_json::from_str::<Value>(raw_event) else {
        return Vec::new();
    };

    if value.get("type").and_then(Value::as_str) == Some("codemux_event_batch") {
        let Some(session_id) = sidecar_session_id(&value) else {
            return Vec::new();
        };
        let Some(events) = value.get("events").and_then(Value::as_array) else {
            return Vec::new();
        };
        let domain: Vec<Value> = events
            .iter()
            .filter(|event| is_code_mux_domain_event(event))
            .cloned()
            .collect();
        return persist_and_stamp(state, &session_id, domain);
    }

    if !is_code_mux_domain_event(&value) {
        return Vec::new();
    }
    let Some(session_id) = sidecar_session_id(&value) else {
        return Vec::new();
    };
    persist_and_stamp(state, &session_id, vec![value])
}

fn sidecar_session_id(event: &Value) -> Option<String> {
    event
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn persist_and_stamp(
    state: &crate::AppState,
    session_id: &str,
    mut events: Vec<Value>,
) -> Vec<Value> {
    if events.is_empty() {
        return events;
    }

    let candidates: Vec<(usize, Value)> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| should_persist_domain_event(event))
        .map(|(index, event)| (index, event.clone()))
        .collect();

    // 序号章只有一条路径能盖：持久化成功的事件拿 DB 序号，其余剥掉 sidecar
    // 序号，保证客户端去重水位线只见 DB 序号一种空间。
    let stamped: std::collections::HashMap<usize, i64> = if candidates.is_empty() {
        std::collections::HashMap::new()
    } else {
        let mut db = match state.db.lock() {
            Ok(db) => db,
            Err(_) => return Vec::new(),
        };
        let candidate_events: Vec<Value> =
            candidates.iter().map(|(_, event)| event.clone()).collect();
        match operations::filter_new_timeline_event_indexes(&db, session_id, &candidate_events) {
            Ok(new_indexes) => {
                let new_events: Vec<Value> = new_indexes
                    .iter()
                    .map(|&index| candidate_events[index].clone())
                    .collect();
                match operations::append_timeline_events(&mut db, session_id, &new_events) {
                    Ok(first_sequence) => new_indexes
                        .iter()
                        .enumerate()
                        .map(|(offset, &index)| {
                            (candidates[index].0, first_sequence + offset as i64)
                        })
                        .collect(),
                    Err(error) => {
                        warn!(
                            target: "agent",
                            "Failed to persist timeline events for session_id={}: {}",
                            session_id,
                            error
                        );
                        std::collections::HashMap::new()
                    }
                }
            }
            Err(error) => {
                warn!(
                    target: "agent",
                    "Failed to check timeline event ids for session_id={}: {}",
                    session_id,
                    error
                );
                std::collections::HashMap::new()
            }
        }
    };

    for (index, event) in events.iter_mut().enumerate() {
        match stamped.get(&index) {
            Some(sequence) => event["sequence"] = json!(sequence),
            None => {
                if let Some(object) = event.as_object_mut() {
                    object.remove("sequence");
                }
            }
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::{is_code_mux_domain_event, should_persist_domain_event};

    #[test]
    fn recognizes_codemux_domain_events() {
        let event = serde_json::json!({ "type": "turn_finished", "session_id": "s1" });
        assert!(is_code_mux_domain_event(&event));
    }

    #[test]
    fn ignores_control_events() {
        let event = serde_json::json!({ "type": "sidecar_ready" });
        assert!(!is_code_mux_domain_event(&event));
    }

    #[test]
    fn does_not_persist_connection_status_events() {
        let event = serde_json::json!({
            "type": "system_event",
            "subtype": "connected",
            "status": "connected"
        });
        assert!(is_code_mux_domain_event(&event));
        assert!(!should_persist_domain_event(&event));
    }

    #[test]
    fn persists_file_snapshot_events() {
        let event = serde_json::json!({
            "type": "file_snapshot",
            "file_path": "README.md",
            "original_content": "before",
        });
        assert!(is_code_mux_domain_event(&event));
        assert!(should_persist_domain_event(&event));
    }

    #[test]
    fn persists_session_summary_system_events() {
        let event = serde_json::json!({
            "type": "system_event",
            "subtype": "session_summary",
            "diffs": []
        });
        assert!(should_persist_domain_event(&event));
    }

    #[test]
    fn streaming_events_stay_broadcast_only() {
        for event_type in [
            "text_delta",
            "reasoning_delta",
            "tool_input_delta",
            "content_started",
            "content_finished",
        ] {
            let event = serde_json::json!({ "type": event_type, "session_id": "s1", "text": "x" });
            assert!(
                is_code_mux_domain_event(&event),
                "{event_type} must still broadcast"
            );
            assert!(
                !should_persist_domain_event(&event),
                "{event_type} must not persist"
            );
        }
    }

    #[test]
    fn proxy_status_is_broadcast_only_domain_event() {
        let event = serde_json::json!({
            "type": "proxy_status",
            "session_id": "s1",
            "running": true,
            "port": 15722,
        });
        assert!(is_code_mux_domain_event(&event));
        assert!(!should_persist_domain_event(&event));
    }

    #[test]
    fn stamps_persisted_events_with_snapshot_sequence_and_strips_the_rest() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-stamp", "Stamp", "claude_code", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let batch = serde_json::json!({
            "type": "codemux_event_batch",
            "session_id": "session-stamp",
            "events": [
                { "type": "text_delta", "session_id": "session-stamp", "sequence": 7, "event_id": "delta-1", "text": "he" },
                { "type": "user_message", "session_id": "session-stamp", "sequence": 8, "event_id": "user-1", "content": "hi" },
                { "type": "system_event", "session_id": "session-stamp", "sequence": 9, "subtype": "connected", "event_id": "conn-1" },
                { "type": "turn_finished", "session_id": "session-stamp", "sequence": 10, "event_id": "turn-1" }
            ]
        })
        .to_string();

        let broadcast = super::handle_sidecar_timeline_event(&state, &batch);
        assert_eq!(broadcast.len(), 4);
        assert!(
            broadcast[0].get("sequence").is_none(),
            "streaming delta must not carry a snapshot sequence"
        );
        assert_eq!(broadcast[1]["sequence"], serde_json::json!(0));
        assert!(
            broadcast[2].get("sequence").is_none(),
            "non-persistable system event must not carry a snapshot sequence"
        );
        assert_eq!(broadcast[3]["sequence"], serde_json::json!(1));

        let duplicate = serde_json::json!({
            "type": "user_message",
            "session_id": "session-stamp",
            "sequence": 11,
            "event_id": "user-1",
            "content": "hi"
        })
        .to_string();
        let broadcast = super::handle_sidecar_timeline_event(&state, &duplicate);
        assert_eq!(broadcast.len(), 1, "duplicates still broadcast");
        assert!(
            broadcast[0].get("sequence").is_none(),
            "duplicate delivery must not extend the watermark"
        );

        let stored: i64 = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM session_event_snapshots WHERE session_id = 'session-stamp'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, 2, "duplicate event_id must not persist twice");
    }
}
