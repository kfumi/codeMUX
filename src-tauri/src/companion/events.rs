use log::warn;
use tauri::{AppHandle, Manager};

use crate::companion::actions::send_companion_message;
use crate::companion::state::CompanionBroadcastEvent;
use crate::companion::CompanionState;

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
    "permission_mode_changed",
    "system_event",
    "diagnostic",
    "error",
    "turn_finished",
];

pub fn handle_sidecar_event_for_companion(app: &AppHandle, raw_event: &str) {
    let companion_state = app.state::<CompanionState>();
    if !companion_state.inner.is_enabled() {
        return;
    }

    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw_event) else {
        return;
    };

    let event_type = value.get("type").and_then(|item| item.as_str()).unwrap_or("");
    if event_type == "codemux_event_batch" {
        let session_id = value
            .get("session_id")
            .and_then(|item| item.as_str())
            .unwrap_or("");
        let Some(events) = value.get("events").and_then(|item| item.as_array()) else {
            return;
        };
        let all_domain_events: Vec<serde_json::Value> = events
            .iter()
            .filter(|event| is_code_mux_domain_event(event))
            .cloned()
            .collect();
        let persistable_events: Vec<serde_json::Value> = all_domain_events
            .iter()
            .filter(|event| should_persist_companion_domain_event(event))
            .cloned()
            .collect();
        if !persistable_events.is_empty() {
            persist_domain_events(app, session_id, &persistable_events);
        }
        for event in all_domain_events {
            maybe_finish_turn_and_drain_queue(app, session_id, &event);
            broadcast_event(&companion_state, session_id, event);
        }
        return;
    }

    if !should_persist_companion_domain_event(&value) {
        if is_code_mux_domain_event(&value) {
            let session_id = value
                .get("session_id")
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .to_string();
            maybe_finish_turn_and_drain_queue(app, &session_id, &value);
            broadcast_event(&companion_state, &session_id, value);
        }
        return;
    }

    let session_id = value
        .get("session_id")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    persist_domain_events(app, &session_id, std::slice::from_ref(&value));
    maybe_finish_turn_and_drain_queue(app, &session_id, &value);
    broadcast_event(&companion_state, &session_id, value);
}

fn maybe_finish_turn_and_drain_queue(
    app: &AppHandle,
    session_id: &str,
    event: &serde_json::Value,
) {
    if session_id.is_empty() {
        return;
    }
    let event_type = event.get("type").and_then(|item| item.as_str()).unwrap_or("");
    if event_type != "turn_finished" {
        return;
    }

    let companion_state = app.state::<CompanionState>();
    let queued = companion_state.finish_turn(session_id);
    if queued.is_empty() {
        return;
    }

    let app = app.clone();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        for prompt in queued {
            if let Err(error) = send_companion_message(&app, &session_id, &prompt).await {
                warn!(
                    target: "companion",
                    "Failed to dispatch queued companion message for session_id={}: {}",
                    session_id,
                    error
                );
            }
        }
    });
}

fn broadcast_event(companion_state: &CompanionState, session_id: &str, event: serde_json::Value) {
    let payload = CompanionBroadcastEvent {
        session_id: session_id.to_string(),
        event,
    };
    let _ = companion_state.inner.event_tx.send(payload);
}

fn persist_domain_events(
    app: &AppHandle,
    session_id: &str,
    events: &[serde_json::Value],
) {
    if session_id.is_empty() || events.is_empty() {
        return;
    }

    let app_state = app.state::<crate::AppState>();
    let mut db = match app_state.db.lock() {
        Ok(db) => db,
        Err(_) => return,
    };

    if let Err(error) =
        crate::db::operations::append_snapshot_events(&mut db, session_id, events)
    {
        warn!(
            target: "companion",
            "Failed to persist snapshot events for session_id={}: {}",
            session_id,
            error
        );
    }
}

fn is_code_mux_domain_event(value: &serde_json::Value) -> bool {
    let Some(event_type) = value.get("type").and_then(|item| item.as_str()) else {
        return false;
    };
    CODE_MUX_DOMAIN_EVENT_TYPES.contains(&event_type)
}

fn should_persist_companion_domain_event(value: &serde_json::Value) -> bool {
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

#[cfg(test)]
mod tests {
    use super::{is_code_mux_domain_event, should_persist_companion_domain_event};

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
        assert!(!should_persist_companion_domain_event(&event));
    }

    #[test]
    fn persists_session_summary_system_events() {
        let event = serde_json::json!({
            "type": "system_event",
            "subtype": "session_summary",
            "diffs": []
        });
        assert!(should_persist_companion_domain_event(&event));
    }
}
