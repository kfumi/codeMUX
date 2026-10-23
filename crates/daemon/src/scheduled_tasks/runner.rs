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

    let session: Result<operations::Session, String> = {
        let conn = app_state.db.lock();
        match conn {
            Ok(conn) => (|| -> Result<operations::Session, String> {
                // 目录集合与主根在任务创建时冻结；这里只按本次会话的实际 cwd 去掉重复项。
                // 旧任务没有冻结列，首次运行时补冻结并落库，避免继续跟随项目漂移。
                let mut frozen_roots = payload.directory_scope.clone();
                if frozen_roots.is_none() {
                    frozen_roots = operations::frozen_root_scope(&conn, &payload.project_id)
                        .map_err(|error| error.to_string())?;
                    if let Some(scope) = frozen_roots.as_deref() {
                        let _ = super::db::set_directory_scope(&conn, &payload.task_id, scope);
                    }
                }
                let mut working_path = payload.working_path.clone();
                if working_path.is_none() {
                    working_path = operations::get_primary_root(&conn, &payload.project_id)
                        .map_err(|error| error.to_string())?;
                    if let Some(path) = working_path.as_deref() {
                        let _ = super::db::set_working_path(&conn, &payload.task_id, path);
                    }
                }
                let Some(working_path) = working_path else {
                    return Err("定时任务没有可用的工作目录".to_string());
                };
                if !std::path::Path::new(&working_path).is_dir() {
                    return Err(format!("定时任务的工作目录不可用: {working_path}"));
                }
                let directory_scope = operations::directory_scope_excluding(
                    frozen_roots.as_deref(),
                    Some(working_path.as_str()),
                );
                operations::create_generated_session_for_project(
                    &conn,
                    &session_title,
                    payload.agent_kind,
                    "agent",
                    &payload.project_id,
                    Some(&payload.permission_config),
                    Some(&payload.plan_mode),
                    payload.model.as_deref(),
                    Some(&working_path),
                    directory_scope.as_deref(),
                )
                .map_err(|error| error.to_string())
            })(),
            Err(error) => Err(error.to_string()),
        }
    };
    let session = match session {
        Ok(session) => session,
        Err(error) => {
            return TaskRunnerResult::Failed { error };
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
