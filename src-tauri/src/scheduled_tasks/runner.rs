use chrono::Utc;
use log::info;

use crate::daemon::DaemonState;
use crate::db::operations;

use super::types::{TaskRunPayload, TaskRunnerResult};

pub async fn fire_scheduled_task(
    daemon: &DaemonState,
    payload: TaskRunPayload,
) -> TaskRunnerResult {
    info!(
        target: "scheduled_tasks",
        "Firing scheduled task {} ({})",
        payload.task_id,
        payload.task_title,
    );
    let app_state = &daemon.app;

    let session_title = format!(
        "{} · {}",
        payload.task_title,
        Utc::now().format("%Y-%m-%d %H:%M")
    );

    let session = match {
        let conn = app_state.db.lock();
        match conn {
            Ok(conn) => operations::create_scheduled_session_for_project(
                &conn,
                &session_title,
                payload.agent_kind,
                "agent",
                &payload.project_id,
                Some(&payload.permission_config),
                Some(&payload.plan_mode),
                payload.model.as_deref(),
            ),
            Err(error) => Err(rusqlite::Error::InvalidParameterName(error.to_string())),
        }
    } {
        Ok(session) => session,
        Err(error) => {
            return TaskRunnerResult::Failed {
                error: error.to_string(),
            };
        }
    };

    if let (Some(provider_id), Some(model)) = (&payload.provider_id, &payload.model) {
        let conn = app_state.db.lock();
        if let Ok(conn) = conn {
            let _ = operations::update_session_provider(
                &conn,
                &session.id,
                Some(provider_id),
                model,
                payload.reasoning_effort.as_deref(),
            );
        }
    }

    if let Some(effort) = &payload.reasoning_effort {
        let conn = app_state.db.lock();
        if let Ok(conn) = conn {
            let _ = operations::update_session_reasoning_effort(&conn, &session.id, effort);
        }
    }

    daemon.ui_events.emit(
        "sessions-changed",
        serde_json::json!({
            "sessionId": session.id,
            "projectId": payload.project_id,
            "taskId": payload.task_id,
            "reason": "scheduled_task",
        }),
    );

    let companion_state = &daemon.companion;
    if companion_state.is_turn_active(&session.id) {
        return TaskRunnerResult::Failed {
            error: "Session already has an active turn".to_string(),
        };
    }

    match crate::companion::actions::send_companion_message(
        daemon,
        &session.id,
        &payload.instruction,
        None,
        None,
        None,
    )
    .await
    {
        Ok(()) => TaskRunnerResult::Started {
            session_id: session.id,
        },
        Err(error) => TaskRunnerResult::Failed { error },
    }
}
