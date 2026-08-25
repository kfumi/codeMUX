use log::warn;
use tauri::{AppHandle, Manager};

use crate::agent::timeline_persist::{
    append_domain_events, is_code_mux_domain_event, should_persist_domain_event,
};
use crate::companion::actions::send_companion_message;
use crate::companion::state::CompanionBroadcastEvent;
use crate::companion::CompanionState;

pub fn handle_sidecar_event_for_companion(app: &AppHandle, raw_event: &str) {
    let companion_state = app.state::<CompanionState>();
    if !companion_state.inner.is_enabled() {
        return;
    }

    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw_event) else {
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
        let all_domain_events: Vec<serde_json::Value> = events
            .iter()
            .filter(|event| is_code_mux_domain_event(event))
            .cloned()
            .collect();
        let persistable_events: Vec<serde_json::Value> = all_domain_events
            .iter()
            .filter(|event| should_persist_domain_event(event))
            .cloned()
            .collect();
        if !persistable_events.is_empty() {
            let app_state = app.state::<crate::AppState>();
            append_domain_events(app_state.inner(), session_id, &persistable_events);
        }
        for event in all_domain_events {
            maybe_finish_turn_and_drain_queue(app, session_id, &event);
            broadcast_event(&companion_state, session_id, event);
        }
        return;
    }

    if !should_persist_domain_event(&value) {
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
    let app_state = app.state::<crate::AppState>();
    append_domain_events(app_state.inner(), &session_id, std::slice::from_ref(&value));
    maybe_finish_turn_and_drain_queue(app, &session_id, &value);
    broadcast_event(&companion_state, &session_id, value);
}

fn maybe_finish_turn_and_drain_queue(app: &AppHandle, session_id: &str, event: &serde_json::Value) {
    if session_id.is_empty() {
        return;
    }
    let companion_state = app.state::<CompanionState>();
    let event_type = event
        .get("type")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    if event_type == "user_message" {
        companion_state.mark_turn_active(session_id);
    }
    if event_type != "turn_finished" {
        return;
    }

    let queued = companion_state.finish_turn(session_id);
    if queued.is_empty() {
        return;
    }

    let app = app.clone();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        for message in queued {
            if let Err(error) =
                send_companion_message(&app, &session_id, &message.prompt, message.input_payload)
                    .await
            {
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

#[cfg(test)]
mod tests {
    use crate::agent::timeline_persist::{is_code_mux_domain_event, should_persist_domain_event};

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
