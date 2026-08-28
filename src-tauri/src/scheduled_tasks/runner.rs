use chrono::Utc;
use log::info;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::companion::CompanionState;
use crate::db::operations;
use crate::AppState;

use super::types::{TaskRunPayload, TaskRunnerResult};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsChangedPayload {
    session_id: String,
    project_id: String,
    task_id: String,
    reason: &'static str,
}

pub async fn fire_scheduled_task(app: &AppHandle, payload: TaskRunPayload) -> TaskRunnerResult {
    info!(
        target: "scheduled_tasks",
        "Firing scheduled task {} ({})",
        payload.task_id,
        payload.task_title,
    );
    let app_state = app.state::<AppState>();

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

    let _ = app.emit(
        "sessions-changed",
        SessionsChangedPayload {
            session_id: session.id.clone(),
            project_id: payload.project_id.clone(),
            task_id: payload.task_id.clone(),
            reason: "scheduled_task",
        },
    );

    let companion_state = app.state::<CompanionState>();
    if companion_state.is_turn_active(&session.id) {
        return TaskRunnerResult::Failed {
            error: "Session already has an active turn".to_string(),
        };
    }

    match crate::companion::actions::send_companion_message(
        app,
        &session.id,
        &payload.instruction,
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
