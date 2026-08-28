use rusqlite::Connection;

use crate::db::operations;

use super::db;
use super::types::TaskRunStatus;

pub fn session_turn_has_finished(conn: &Connection, session_id: &str) -> bool {
    let Ok(Some(events)) = operations::get_session_timeline(conn, session_id) else {
        return false;
    };
    for event in events.iter().rev() {
        let event_type = event
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if event_type == "turn_finished" || event_type == "error" {
            return true;
        }
        if event_type == "user_message" {
            return false;
        }
    }
    false
}

pub fn reconcile_running_runs(
    conn: &Connection,
    turn_active_session_ids: &[String],
) -> Vec<String> {
    let running = db::list_running_runs(conn).unwrap_or_default();
    let mut updated_task_ids = Vec::new();
    for run in running {
        if let Some(session_id) = &run.session_id {
            let still_active = turn_active_session_ids.iter().any(|id| id == session_id)
                && !session_turn_has_finished(conn, session_id);
            if still_active {
                continue;
            }
            if db::update_run_status(conn, &run.id, TaskRunStatus::Completed, None, None).is_ok() {
                updated_task_ids.push(run.task_id);
            }
        }
    }
    updated_task_ids
}

pub fn reconcile_runs_for_session(conn: &Connection, session_id: &str) -> Vec<String> {
    let running = db::list_running_runs(conn).unwrap_or_default();
    let mut updated_task_ids = Vec::new();
    for run in running {
        if run.session_id.as_deref() != Some(session_id) {
            continue;
        }
        if db::update_run_status(conn, &run.id, TaskRunStatus::Completed, None, None).is_ok() {
            updated_task_ids.push(run.task_id);
        }
    }
    updated_task_ids
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use chrono::{DateTime, Utc};
    use rusqlite::Connection;

    use super::super::schedule::{compute_next_run_at, local_timezone_label};
    use super::super::types::{
        ScheduleKind, ScheduledTaskUpsert, SkipReason, TaskRunPayload, TaskRunStatus, TaskRunner,
        TaskRunnerResult, MAX_CONCURRENT_SCHEDULED_RUNS,
    };
    use super::db;
    use crate::config::types::AgentKind;
    use crate::db::operations;
    use crate::db::schema;

    fn tick(conn: &Connection, now: DateTime<Utc>, runner: &mut dyn TaskRunner) {
        let now_str = now.to_rfc3339();
        let due_tasks = db::list_due_tasks(conn, &now_str).unwrap_or_default();

        for task in due_tasks {
            let scheduled_for = task.next_run_at.clone();
            let next_run_at = compute_next_run_at(
                task.schedule_kind,
                &task.schedule_time,
                task.weekly_weekday,
                task.weekly_weekdays.as_ref(),
                task.monthly_day,
                now,
            )
            .to_rfc3339();

            db::update_task_schedule_after_run(conn, &task.id, &scheduled_for, &next_run_at)
                .unwrap_or_default();

            if !task.enabled {
                continue;
            }

            if !db::project_exists(conn, &task.project_id).unwrap_or(false) {
                let _ = db::insert_run(
                    conn,
                    &task.id,
                    &scheduled_for,
                    TaskRunStatus::Skipped,
                    Some(SkipReason::ProjectMissing),
                    None,
                    None,
                );
                continue;
            }

            if db::task_has_active_run(conn, &task.id).unwrap_or(false) {
                let _ = db::insert_run(
                    conn,
                    &task.id,
                    &scheduled_for,
                    TaskRunStatus::Skipped,
                    Some(SkipReason::Overlap),
                    None,
                    None,
                );
                continue;
            }

            let active_count = db::count_active_runs(conn).unwrap_or(0);
            if active_count >= MAX_CONCURRENT_SCHEDULED_RUNS {
                let _ = db::insert_run(
                    conn,
                    &task.id,
                    &scheduled_for,
                    TaskRunStatus::Skipped,
                    Some(SkipReason::ConcurrencyLimit),
                    None,
                    None,
                );
                continue;
            }

            let run = match db::insert_run(
                conn,
                &task.id,
                &scheduled_for,
                TaskRunStatus::Running,
                None,
                None,
                None,
            ) {
                Ok(run) => run,
                Err(_) => continue,
            };

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

            match runner.run(payload) {
                TaskRunnerResult::Started { session_id } => {
                    db::update_run_status(
                        conn,
                        &run.id,
                        TaskRunStatus::Running,
                        Some(&session_id),
                        None,
                    )
                    .unwrap_or_default();
                }
                TaskRunnerResult::Failed { error } => {
                    db::update_run_status(conn, &run.id, TaskRunStatus::Failed, None, Some(&error))
                        .unwrap_or_default();
                }
            }
        }
    }

    struct MockRunner {
        pub calls: Vec<TaskRunPayload>,
        pub results: VecDeque<TaskRunnerResult>,
    }

    impl MockRunner {
        fn new(result: TaskRunnerResult) -> Self {
            let mut results = VecDeque::new();
            results.push_back(result);
            Self {
                calls: Vec::new(),
                results,
            }
        }
    }

    impl TaskRunner for MockRunner {
        fn run(&mut self, payload: TaskRunPayload) -> TaskRunnerResult {
            self.calls.push(payload);
            self.results
                .pop_front()
                .unwrap_or(TaskRunnerResult::Failed {
                    error: "no result".to_string(),
                })
        }
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::initialize_database(&conn).unwrap();
        conn
    }

    fn sample_upsert(project_id: &str) -> ScheduledTaskUpsert {
        ScheduledTaskUpsert {
            title: "Daily report".to_string(),
            instruction: "Summarize commits".to_string(),
            project_id: project_id.to_string(),
            agent_kind: AgentKind::ClaudeCode,
            provider_id: None,
            model: None,
            reasoning_effort: Some("high".to_string()),
            permission_config: r#"{"kind":"claude_code","permissionMode":"default"}"#.to_string(),
            plan_mode: "off".to_string(),
            schedule_kind: ScheduleKind::Daily,
            schedule_time: "09:00".to_string(),
            weekly_weekday: None,
            weekly_weekdays: None,
            monthly_day: None,
            timezone: local_timezone_label(),
            enabled: true,
        }
    }

    #[test]
    fn tick_fires_runner_with_saved_permission_snapshot() {
        let conn = test_conn();
        let project = operations::create_project(&conn, "demo", "/tmp/demo").unwrap();
        let upsert = sample_upsert(&project.id);
        let task = db::create_task(&conn, &upsert).unwrap();

        let mut runner = MockRunner::new(TaskRunnerResult::Started {
            session_id: "session-1".to_string(),
        });
        let now = DateTime::parse_from_rfc3339(&task.next_run_at)
            .unwrap()
            .with_timezone(&Utc);
        tick(&conn, now, &mut runner);

        assert_eq!(runner.calls.len(), 1);
        assert_eq!(runner.calls[0].permission_config, upsert.permission_config);
        assert_eq!(runner.calls[0].instruction, "Summarize commits");
    }

    #[test]
    fn tick_does_not_fire_before_next_run_at() {
        let conn = test_conn();
        let project = operations::create_project(&conn, "demo", "/tmp/demo").unwrap();
        let task = db::create_task(&conn, &sample_upsert(&project.id)).unwrap();
        let mut runner = MockRunner::new(TaskRunnerResult::Started {
            session_id: "session-1".to_string(),
        });
        let early = DateTime::parse_from_rfc3339(&task.next_run_at)
            .unwrap()
            .with_timezone(&Utc)
            - chrono::Duration::minutes(5);
        tick(&conn, early, &mut runner);
        assert!(runner.calls.is_empty());
    }

    #[test]
    fn overlap_skips_second_fire() {
        let conn = test_conn();
        let project = operations::create_project(&conn, "demo", "/tmp/demo").unwrap();
        let task = db::create_task(&conn, &sample_upsert(&project.id)).unwrap();
        let mut runner = MockRunner::new(TaskRunnerResult::Started {
            session_id: "session-1".to_string(),
        });
        let now = DateTime::parse_from_rfc3339(&task.next_run_at)
            .unwrap()
            .with_timezone(&Utc);
        tick(&conn, now, &mut runner);
        conn.execute(
            "UPDATE scheduled_tasks SET next_run_at = ?2 WHERE id = ?1",
            rusqlite::params![task.id, task.next_run_at],
        )
        .unwrap();
        tick(&conn, now, &mut runner);
        assert_eq!(runner.calls.len(), 1);
        let runs = db::list_runs(&conn, &task.id).unwrap();
        assert!(runs
            .iter()
            .any(|run| run.skip_reason == Some(SkipReason::Overlap)));
    }

    #[test]
    fn custom_permission_snapshot_is_passed_to_runner() {
        let conn = test_conn();
        let project = operations::create_project(&conn, "demo", "/tmp/demo").unwrap();
        let mut upsert = sample_upsert(&project.id);
        upsert.permission_config =
            r#"{"kind":"claude_code","permissionMode":"acceptEdits"}"#.to_string();
        let task = db::create_task(&conn, &upsert).unwrap();
        let mut runner = MockRunner::new(TaskRunnerResult::Started {
            session_id: "session-1".to_string(),
        });
        let now = DateTime::parse_from_rfc3339(&task.next_run_at)
            .unwrap()
            .with_timezone(&Utc);
        tick(&conn, now, &mut runner);
        assert_eq!(
            runner.calls[0].permission_config,
            r#"{"kind":"claude_code","permissionMode":"acceptEdits"}"#
        );
    }

    #[test]
    fn reconcile_completes_run_when_timeline_already_finished() {
        let mut conn = test_conn();
        let project = operations::create_project(&conn, "demo", "/tmp/demo").unwrap();
        let task = db::create_task(&conn, &sample_upsert(&project.id)).unwrap();
        let session = operations::create_scheduled_session_for_project(
            &conn,
            "demo run",
            crate::config::types::AgentKind::ClaudeCode,
            "agent",
            &project.id,
            None,
            None,
            None,
        )
        .unwrap();
        let run = db::insert_run(
            &conn,
            &task.id,
            &task.next_run_at,
            TaskRunStatus::Running,
            None,
            Some(&session.id),
            None,
        )
        .unwrap();
        operations::append_timeline_events(
            &mut conn,
            &session.id,
            &[
                serde_json::json!({
                    "type": "user_message",
                    "session_id": session.id,
                }),
                serde_json::json!({
                    "type": "turn_finished",
                    "session_id": session.id,
                }),
            ],
        )
        .unwrap();

        let updated = super::reconcile_running_runs(&conn, &[session.id.clone()]);
        assert_eq!(updated, vec![task.id.clone()]);
        let stored = db::get_run(&conn, &run.id).unwrap().unwrap();
        assert_eq!(stored.status, TaskRunStatus::Completed);
    }
}
