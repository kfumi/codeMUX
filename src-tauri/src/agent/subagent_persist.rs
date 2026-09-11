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

/// Persist one raw sidecar event if it is a subagent event. Returns `true`
/// when consumed; the caller still forwards the event to the frontend.
pub(crate) fn handle_sidecar_subagent_event(state: &crate::AppState, raw_event: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(raw_event) else {
        return false;
    };
    if !is_subagent_event(&value) {
        return false;
    }

    let result = {
        let mut db = match state.db.lock() {
            Ok(db) => db,
            Err(_) => return true,
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
    true
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
