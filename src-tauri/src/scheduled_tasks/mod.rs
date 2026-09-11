mod db;
mod runner;
mod schedule;
mod service;
mod types;

pub use db::{
    create_task, delete_run, delete_task, get_task, list_runs, list_tasks, set_task_enabled,
    update_task,
};
pub use schedule::local_timezone_label;
pub use types::{ScheduleKind, ScheduledTask, ScheduledTaskUpsert, TaskRun};

pub fn reconcile_runs_for_session(conn: &rusqlite::Connection, session_id: &str) -> Vec<String> {
    service::reconcile_runs_for_session(conn, session_id)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTasksChangedPayload {
    task_ids: Vec<String>,
    reason: &'static str,
}

fn emit_scheduled_tasks_changed(
    daemon: &crate::daemon::DaemonState,
    mut task_ids: Vec<String>,
    reason: &'static str,
) {
    if task_ids.is_empty() {
        return;
    }
    task_ids.sort();
    task_ids.dedup();
    let payload = serde_json::to_value(ScheduledTasksChangedPayload { task_ids, reason })
        .unwrap_or(serde_json::json!({}));
    daemon.ui_events.emit("scheduled-tasks-changed", payload);
}

pub async fn tick_async(daemon: &crate::daemon::DaemonState, now: chrono::DateTime<chrono::Utc>) {
    let app_state = &daemon.app;
    let companion_state = &daemon.companion;
    let mut changed_task_ids = Vec::new();
    let turn_active = companion_state
        .inner
        .turn_active
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect::<Vec<_>>();

    let (payloads, stale_active_sessions) = {
        let conn = app_state.db.lock().unwrap();
        let stale_active_sessions = turn_active
            .iter()
            .filter(|session_id| service::session_turn_has_finished(&conn, session_id))
            .cloned()
            .collect::<Vec<_>>();
        changed_task_ids.extend(service::reconcile_running_runs(&conn, &turn_active));
        let now_str = now.to_rfc3339();
        let due_tasks = db::list_due_tasks(&conn, &now_str).unwrap_or_default();
        let mut planned = Vec::new();
        for task in due_tasks {
            let scheduled_for = task.next_run_at.clone();
            let next_run_at = schedule::compute_next_run_at(
                task.schedule_kind,
                &task.schedule_time,
                task.weekly_weekday,
                task.weekly_weekdays.as_ref(),
                task.monthly_day,
                now,
            )
            .to_rfc3339();
            db::update_task_schedule_after_run(&conn, &task.id, &scheduled_for, &next_run_at)
                .unwrap_or_default();
            changed_task_ids.push(task.id.clone());

            if !task.enabled {
                continue;
            }

            if !db::project_exists(&conn, &task.project_id).unwrap_or(false) {
                let _ = db::insert_run(
                    &conn,
                    &task.id,
                    &scheduled_for,
                    types::TaskRunStatus::Skipped,
                    Some(types::SkipReason::ProjectMissing),
                    None,
                    None,
                );
                continue;
            }

            if db::task_has_active_run(&conn, &task.id).unwrap_or(false) {
                let _ = db::insert_run(
                    &conn,
                    &task.id,
                    &scheduled_for,
                    types::TaskRunStatus::Skipped,
                    Some(types::SkipReason::Overlap),
                    None,
                    None,
                );
                continue;
            }

            let active_count = db::count_active_runs(&conn).unwrap_or(0);
            if active_count >= types::MAX_CONCURRENT_SCHEDULED_RUNS {
                let _ = db::insert_run(
                    &conn,
                    &task.id,
                    &scheduled_for,
                    types::TaskRunStatus::Skipped,
                    Some(types::SkipReason::ConcurrencyLimit),
                    None,
                    None,
                );
                continue;
            }

            let run = match db::insert_run(
                &conn,
                &task.id,
                &scheduled_for,
                types::TaskRunStatus::Running,
                None,
                None,
                None,
            ) {
                Ok(run) => run,
                Err(_) => continue,
            };

            planned.push((
                run.id,
                types::TaskRunPayload {
                    task_id: task.id.clone(),
                    task_title: task.title.clone(),
                    instruction: task.instruction.clone(),
                    project_id: task.project_id.clone(),
                    agent_kind: task.agent_kind,
                    provider_id: task.provider_id.clone(),
                    model: task.model.clone(),
                    reasoning_effort: task.reasoning_effort.clone(),
                    permission_config: task.permission_config.clone(),
                    plan_mode: task.plan_mode.clone(),
                },
            ));
        }
        (planned, stale_active_sessions)
    };

    for session_id in stale_active_sessions {
        companion_state.finish_turn(&session_id);
    }

    for (run_id, payload) in payloads {
        let task_id = payload.task_id.clone();
        let result = runner::fire_scheduled_task(daemon, payload).await;
        let conn = app_state.db.lock().unwrap();
        match result {
            types::TaskRunnerResult::Started { session_id } => {
                db::update_run_status(
                    &conn,
                    &run_id,
                    types::TaskRunStatus::Running,
                    Some(&session_id),
                    None,
                )
                .unwrap_or_default();
                changed_task_ids.push(task_id);
            }
            types::TaskRunnerResult::Failed { error } => {
                db::update_run_status(
                    &conn,
                    &run_id,
                    types::TaskRunStatus::Failed,
                    None,
                    Some(&error),
                )
                .unwrap_or_default();
                changed_task_ids.push(task_id);
            }
        }
    }

    emit_scheduled_tasks_changed(daemon, changed_task_ids, "tick");
}

pub async fn run_task_now(
    daemon: &crate::daemon::DaemonState,
    task_id: &str,
) -> Result<TaskRun, String> {
    use chrono::Utc;

    use types::{
        SkipReason, TaskRunPayload, TaskRunStatus, TaskRunnerResult, MAX_CONCURRENT_SCHEDULED_RUNS,
    };

    let app_state = &daemon.app;
    let now_str = Utc::now().to_rfc3339();

    let (run_id, payload) = {
        let conn = app_state.db.lock().map_err(|error| error.to_string())?;
        let task = db::get_task(&conn, task_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "任务不存在".to_string())?;

        if !db::project_exists(&conn, &task.project_id).map_err(|error| error.to_string())? {
            let run = db::insert_run(
                &conn,
                task_id,
                &now_str,
                TaskRunStatus::Skipped,
                Some(SkipReason::ProjectMissing),
                None,
                None,
            )
            .map_err(|error| error.to_string())?;
            return Ok(run);
        }

        if db::task_has_active_run(&conn, task_id).map_err(|error| error.to_string())? {
            return Err("该任务正在运行中".to_string());
        }

        if db::count_active_runs(&conn).map_err(|error| error.to_string())?
            >= MAX_CONCURRENT_SCHEDULED_RUNS
        {
            return Err("已达定时任务并发上限".to_string());
        }

        let run = db::insert_run(
            &conn,
            task_id,
            &now_str,
            TaskRunStatus::Running,
            None,
            None,
            None,
        )
        .map_err(|error| error.to_string())?;

        let payload = TaskRunPayload {
            task_id: task.id.clone(),
            task_title: task.title.clone(),
            instruction: task.instruction.clone(),
            project_id: task.project_id.clone(),
            agent_kind: task.agent_kind,
            provider_id: task.provider_id.clone(),
            model: task.model.clone(),
            reasoning_effort: task.reasoning_effort.clone(),
            permission_config: task.permission_config.clone(),
            plan_mode: task.plan_mode.clone(),
        };

        (run.id, payload)
    };

    let result = runner::fire_scheduled_task(daemon, payload).await;

    let conn = app_state.db.lock().map_err(|error| error.to_string())?;
    match result {
        TaskRunnerResult::Started { session_id } => {
            db::update_run_status(
                &conn,
                &run_id,
                TaskRunStatus::Running,
                Some(&session_id),
                None,
            )
            .map_err(|error| error.to_string())?;
        }
        TaskRunnerResult::Failed { error } => {
            db::update_run_status(&conn, &run_id, TaskRunStatus::Failed, None, Some(&error))
                .map_err(|error| error.to_string())?;
        }
    }

    db::get_run(&conn, &run_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "运行记录不存在".to_string())
}
