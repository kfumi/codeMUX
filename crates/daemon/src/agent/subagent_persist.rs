//! Subagent timeline persistence: routes `subagent_upsert` /
//! `subagent_timeline` sidecar events into their own SQLite tables and serves
//! them back via `load_session_subagents`. These events are never members of
//! the parent timeline (`session_event_snapshots`).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::db::operations::{self, SessionSubagentsPayload};

pub(crate) fn is_subagent_event(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("subagent_upsert") | Some("subagent_timeline")
    )
}

/// Persist one raw sidecar event if it is a subagent event. Returns the
/// broadcast copies for the session WS channel (empty when the event is not a
/// subagent event or carries no session id). Copies stay unstamped: subagent
/// events never enter the parent timeline's sequence space, and a stray
/// `sequence` would make clients drop them against the timeline watermark.
/// 从原始 wire 行解析并持久化。生产路径统一走 `timeline_persist::ingest_sidecar_event`
/// （它只解析一次再分派），这里保留给单测直接喂 JSON 字符串用。
#[cfg(test)]
pub(crate) fn handle_sidecar_subagent_event(
    state: &crate::AppState,
    raw_event: &str,
) -> Vec<Value> {
    let Ok(value) = serde_json::from_str::<Value>(raw_event) else {
        return Vec::new();
    };
    handle_sidecar_subagent_value(state, value)
}

/// Same as [`handle_sidecar_subagent_event`] but for a caller that has already
/// parsed the wire line. `ingest_sidecar_event` uses this so a single line is
/// deserialized once instead of once per persistence owner.
pub(crate) fn handle_sidecar_subagent_value(state: &crate::AppState, value: Value) -> Vec<Value> {
    if !is_subagent_event(&value) {
        return Vec::new();
    }

    let result = {
        let mut db = match state.db.lock() {
            Ok(db) => db,
            Err(_) => return broadcast_copies(value),
        };
        match value.get("type").and_then(Value::as_str) {
            Some("subagent_upsert") => operations::upsert_session_subagent(&mut db, &value),
            Some("subagent_timeline") => operations::append_session_subagent_event(&mut db, &value),
            _ => Ok(()),
        }
    };
    if let Err(error) = result {
        log::warn!(
            target: "agent",
            "Failed to persist subagent event for session_id={}: {}",
            value.get("session_id").and_then(Value::as_str).unwrap_or(""),
            error
        );
    }
    broadcast_copies(value)
}

/// Subagent frames are only meaningful on a session-scoped channel; without a
/// session id they would fall into the control-plane broadcast.
fn broadcast_copies(value: Value) -> Vec<Value> {
    let has_session = value
        .get("session_id")
        .and_then(Value::as_str)
        .is_some_and(|session_id| !session_id.is_empty());
    if has_session {
        vec![value]
    } else {
        Vec::new()
    }
}

/// Load descriptors + per-subagent timelines. Reconciles stale `running`
/// descriptors to `failed` — but only when no live sidecar owns the session,
/// so switching between sessions never fails children that are still running.
pub async fn load_session_subagents_for_companion(
    agent_state: &Arc<crate::agent::session_lifecycle::AgentState>,
    state: &crate::AppState,
    app_session_id: String,
) -> Result<SessionSubagentsPayload, String> {
    let sidecar_alive = agent_state
        .sidecars
        .lock()
        .await
        .contains_key(&app_session_id);

    // Short-lived lock, matching the load_session_events command pattern.
    let db = state.db.lock().map_err(|_| "Database lock poisoned")?;
    if !sidecar_alive {
        operations::reconcile_running_session_subagents(&db, &app_session_id)
            .map_err(|e| e.to_string())?;
    }
    let subagents =
        operations::list_session_subagents(&db, &app_session_id).map_err(|e| e.to_string())?;
    let mut timelines: HashMap<String, Vec<Value>> = HashMap::new();
    for subagent in &subagents {
        let events =
            operations::load_session_subagent_events(&db, &app_session_id, &subagent.subagent_id)
                .map_err(|e| e.to_string())?;
        timelines.insert(subagent.subagent_id.clone(), events);
    }
    drop(db);

    Ok(SessionSubagentsPayload {
        subagents,
        timelines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> crate::AppState {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        }
    }

    #[test]
    fn broadcast_copies_require_a_session_scoped_channel() {
        let with_session = serde_json::json!({
            "type": "subagent_upsert",
            "session_id": "session-1",
            "subagent_id": "toolu_1",
            "status": "running"
        });
        assert_eq!(broadcast_copies(with_session).len(), 1);

        let without_session = serde_json::json!({
            "type": "subagent_upsert",
            "subagent_id": "toolu_1",
            "status": "running"
        });
        assert!(broadcast_copies(without_session).is_empty());
    }

    #[test]
    fn subagent_events_are_persisted_and_returned_for_broadcast() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "S", "claude_code", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let raw = serde_json::json!({
            "type": "subagent_upsert",
            "session_id": "session-1",
            "subagent_id": "toolu_1",
            "provider": "claude",
            "status": "running"
        })
        .to_string();

        let broadcast = handle_sidecar_subagent_event(&state, &raw);
        assert_eq!(broadcast.len(), 1);
        assert_eq!(broadcast[0]["subagent_id"], serde_json::json!("toolu_1"));
        assert!(
            broadcast[0].get("sequence").is_none(),
            "subagent frames must stay outside the parent timeline sequence space"
        );

        // Persisted alongside: the descriptor is queryable for history loads.
        let db = state.db.lock().unwrap();
        let subagents = operations::list_session_subagents(&db, "session-1").unwrap();
        assert_eq!(subagents.len(), 1);
    }

    #[test]
    fn non_subagent_events_are_not_broadcast() {
        let state = test_state();
        assert!(handle_sidecar_subagent_event(
            &state,
            r#"{"type":"text_delta","session_id":"session-1","text":"hi"}"#
        )
        .is_empty());
        assert!(handle_sidecar_subagent_event(&state, "not-json").is_empty());
    }
}
