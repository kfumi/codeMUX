use log::warn;
use tauri::{AppHandle, Manager};

use crate::companion::actions::send_companion_message;
use crate::companion::state::CompanionBroadcastEvent;
use crate::companion::CompanionState;

/// Broadcast sidecar domain events (already persisted and sequence-stamped by
/// the timeline owner) to companion clients and drive turn lifecycle. This hook
/// must not persist: the sidecar event loop is the single persistence owner,
/// and persisting here again wrote every event twice.
pub fn handle_sidecar_event_for_companion(app: &AppHandle, events: Vec<serde_json::Value>) {
    let companion_state = app.state::<CompanionState>();
    let companion_enabled = companion_state.inner.is_enabled();

    for event in events {
        let session_id = event
            .get("session_id")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .to_string();
        maybe_finish_turn_and_drain_queue(app, &session_id, &event);
        if companion_enabled {
            broadcast_event(&companion_state, &session_id, event);
        }
    }
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
    if event_type != "turn_finished" && event_type != "error" {
        return;
    }

    let task_ids = {
        let app_state = app.state::<crate::AppState>();
        let conn = app_state.db.lock().unwrap();
        crate::scheduled_tasks::reconcile_runs_for_session(&conn, session_id)
    };
    if !task_ids.is_empty() {
        crate::scheduled_tasks::emit_scheduled_tasks_changed(app, task_ids, "turn_finished");
    }

    let queued = companion_state.finish_turn(session_id);
    if queued.is_empty() {
        return;
    }

    let app = app.clone();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        for message in queued {
            if let Err(error) = send_companion_message(
                &app,
                &session_id,
                &message.prompt,
                message.input_payload,
                None,
                None,
            )
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
