mod db;
mod runner;
mod schedule;
mod service;
mod types;

pub use db::{
    create_task, delete_task, get_task, list_runs, list_tasks, set_task_enabled, update_task,
};
pub use schedule::local_timezone_label;
pub use types::{
    ScheduledTask, ScheduledTaskUpsert, ScheduleKind, TaskRun,
};

pub async fn tick_async(app: &tauri::AppHandle, now: chrono::DateTime<chrono::Utc>) {
    use tauri::Manager;

    use crate::companion::CompanionState;
    use crate::AppState;

    let app_state = app.state::<AppState>();
    let companion_state = app.state::<CompanionState>();
    let turn_active = companion_state
        .inner
        .turn_active
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect::<Vec<_>>();

    let payloads = {
        let conn = app_state.db.lock().unwrap();
        service::reconcile_running_runs(&conn, &turn_active);
        let now_str = now.to_rfc3339();
        let due_tasks = db::list_due_tasks(&conn, &now_str).unwrap_or_default();
        let mut planned = Vec::new();
        for task in due_tasks {
            let scheduled_for = task.next_run_at.clone();
            let next_run_at = schedule::compute_next_run_at(
                task.schedule_kind,
                &task.schedule_time,
                task.weekly_weekday,
                task.monthly_day,
                now,
            )
            .to_rfc3339();
            db::update_task_schedule_after_run(&conn, &task.id, &scheduled_for, &next_run_at)
                .unwrap_or_default();

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
        planned
    };

    for (run_id, payload) in payloads {
        let result = runner::fire_scheduled_task(app, payload).await;
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
            }
        }
    }
}
