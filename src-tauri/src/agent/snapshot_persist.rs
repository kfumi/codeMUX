use log::warn;
use serde_json::Value;

use crate::db::operations;

const CODE_MUX_DOMAIN_EVENT_TYPES: &[&str] = &[
    "content_started",
    "text_delta",
    "reasoning_delta",
    "tool_input_delta",
    "content_finished",
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
];

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
    if value.get("type").and_then(|item| item.as_str()) != Some("system_event") {
        return true;
    }
    let subtype = value
        .get("subtype")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    !matches!(subtype, "connected" | "retrying" | "disconnected")
}

pub(crate) fn append_domain_events(
    state: &crate::AppState,
    session_id: &str,
    events: &[Value],
) {
    if session_id.is_empty() || events.is_empty() {
        return;
    }

    let persistable: Vec<Value> = events
        .iter()
        .filter(|event| should_persist_domain_event(event))
        .cloned()
        .collect();
    if persistable.is_empty() {
        return;
    }

    let mut db = match state.db.lock() {
        Ok(db) => db,
        Err(_) => return,
    };

    if let Err(error) = operations::append_snapshot_events(&mut db, session_id, &persistable) {
        warn!(
            target: "agent",
            "Failed to persist snapshot events for session_id={}: {}",
            session_id,
            error
        );
    }
}

pub(crate) fn handle_sidecar_snapshot_event(state: &crate::AppState, raw_event: &str) {
    let Ok(value) = serde_json::from_str::<Value>(raw_event) else {
        return;
    };

    let event_type = value
        .get("type")
        .and_then(|item| item.as_str())
        .unwrap_or("");

    if event_type == "codemux_event_batch" {
        let session_id = value
            .get("session_id")
            .and_then(|item| item.as_str())
            .unwrap_or("");
        let Some(events) = value.get("events").and_then(|item| item.as_array()) else {
            return;
        };
        let persistable: Vec<Value> = events
            .iter()
            .filter(|event| should_persist_domain_event(event))
            .cloned()
            .collect();
        append_domain_events(state, session_id, &persistable);
        return;
    }

    if !should_persist_domain_event(&value) {
        return;
    }

    let session_id = value
        .get("session_id")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    append_domain_events(state, session_id, std::slice::from_ref(&value));
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
    fn persists_session_summary_system_events() {
        let event = serde_json::json!({
            "type": "system_event",
            "subtype": "session_summary",
            "diffs": []
        });
        assert!(should_persist_domain_event(&event));
    }
}
