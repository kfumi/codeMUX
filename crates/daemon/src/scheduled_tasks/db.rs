use std::str::FromStr;

use chrono::Utc;
use rusqlite::{params, Connection, Result};
use uuid::Uuid;

use crate::config::types::AgentKind;

use super::schedule::compute_next_run_at;
use super::types::{
    RunDelivery, ScheduleKind, ScheduledTask, ScheduledTaskUpsert, SkipReason, TaskRun,
    TaskRunStatus,
};

const TASK_SELECT: &str = "id, title, instruction, project_id, agent_kind, provider_id, model, reasoning_effort, permission_config, plan_mode, schedule_kind, schedule_time, weekly_weekday, monthly_day, timezone, delivery, enabled, last_run_at, next_run_at, created_at, updated_at, weekly_weekdays";

const RUN_SELECT: &str =
    "id, task_id, session_id, scheduled_for, started_at, finished_at, status, skip_reason, error";

fn encode_weekly_weekdays(value: &Option<Vec<i32>>) -> Option<String> {
    value.as_ref().and_then(|days| {
        if days.is_empty() {
            None
        } else {
            serde_json::to_string(days).ok()
        }
    })
}

fn decode_weekly_weekdays(raw: Option<String>) -> Option<Vec<i32>> {
    raw.and_then(|value| serde_json::from_str::<Vec<i32>>(&value).ok())
        .filter(|days| !days.is_empty())
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduledTask> {
    let schedule_kind =
        ScheduleKind::from_str(row.get::<_, String>(10)?.as_str()).unwrap_or(ScheduleKind::Daily);
    let delivery = match row.get::<_, String>(15)?.as_str() {
        "new_session" => RunDelivery::NewSession,
        _ => RunDelivery::NewSession,
    };
    Ok(ScheduledTask {
        id: row.get(0)?,
        title: row.get(1)?,
        instruction: row.get(2)?,
        project_id: row.get(3)?,
        agent_kind: AgentKind::from_str(&row.get::<_, String>(4)?).unwrap_or(AgentKind::ClaudeCode),
        provider_id: row.get(5)?,
        model: row.get(6)?,
        reasoning_effort: row.get(7)?,
        permission_config: row.get(8)?,
        plan_mode: row.get(9)?,
        schedule_kind,
        schedule_time: row.get(11)?,
        weekly_weekday: row.get(12)?,
        monthly_day: row.get(13)?,
        timezone: row.get(14)?,
        delivery,
        enabled: row.get::<_, i64>(16)? != 0,
        last_run_at: row.get(17)?,
        next_run_at: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        weekly_weekdays: decode_weekly_weekdays(row.get(21)?),
        run_count: 0,
    })
}

fn enrich_tasks_run_counts(conn: &Connection, tasks: &mut [ScheduledTask]) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT task_id, COUNT(*) FROM scheduled_task_runs WHERE status != 'skipped' GROUP BY task_id",
    )?;
    let mut counts = std::collections::HashMap::new();
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
    })?;
    for row in rows {
        let (task_id, count) = row?;
        counts.insert(task_id, count);
    }
    for task in tasks {
        task.run_count = counts.get(&task.id).copied().unwrap_or(0);
    }
    Ok(())
}

fn enrich_task_run_count(conn: &Connection, task: &mut ScheduledTask) -> Result<()> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM scheduled_task_runs WHERE task_id = ?1 AND status != 'skipped'",
        params![task.id],
        |row| row.get(0),
    )?;
    task.run_count = count;
    Ok(())
}

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRun> {
    let status = TaskRunStatus::from_str(row.get::<_, String>(6)?.as_str())
        .unwrap_or(TaskRunStatus::Running);
    let skip_reason = row
        .get::<_, Option<String>>(7)?
        .and_then(|value| SkipReason::from_str(value.as_str()));
    Ok(TaskRun {
        id: row.get(0)?,
        task_id: row.get(1)?,
        session_id: row.get(2)?,
        scheduled_for: row.get(3)?,
        started_at: row.get(4)?,
        finished_at: row.get(5)?,
        status,
        skip_reason,
        error: row.get(8)?,
    })
}

pub fn list_tasks(conn: &Connection) -> Result<Vec<ScheduledTask>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_SELECT} FROM scheduled_tasks ORDER BY created_at DESC"
    ))?;
    let mut tasks = stmt
        .query_map([], row_to_task)?
        .collect::<Result<Vec<_>>>()?;
    enrich_tasks_run_counts(conn, &mut tasks)?;
    Ok(tasks)
}

pub fn get_task(conn: &Connection, task_id: &str) -> Result<Option<ScheduledTask>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_SELECT} FROM scheduled_tasks WHERE id = ?1"
    ))?;
    let mut rows = stmt.query_map(params![task_id], row_to_task)?;
    match rows.next() {
        Some(row) => {
            let mut task = row?;
            enrich_task_run_count(conn, &mut task)?;
            Ok(Some(task))
        }
        None => Ok(None),
    }
}

pub fn create_task(conn: &Connection, upsert: &ScheduledTaskUpsert) -> Result<ScheduledTask> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let next_run_at = compute_next_run_at(
        upsert.schedule_kind,
        &upsert.schedule_time,
        upsert.weekly_weekday,
        upsert.weekly_weekdays.as_ref(),
        upsert.monthly_day,
        now,
    );
    let now_str = now.to_rfc3339();
    let next_str = next_run_at.to_rfc3339();
    let weekly_weekdays_json = encode_weekly_weekdays(&upsert.weekly_weekdays);

    conn.execute(
        "INSERT INTO scheduled_tasks (
            id, title, instruction, project_id, agent_kind, provider_id, model, reasoning_effort,
            permission_config, plan_mode, schedule_kind, schedule_time, weekly_weekday, monthly_day,
            timezone, delivery, enabled, last_run_at, next_run_at, created_at, updated_at, weekly_weekdays
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'new_session', ?16, NULL, ?17, ?18, ?18, ?19)",
        params![
            id,
            upsert.title,
            upsert.instruction,
            upsert.project_id,
            upsert.agent_kind.as_str(),
            upsert.provider_id,
            upsert.model,
            upsert.reasoning_effort,
            upsert.permission_config,
            upsert.plan_mode,
            upsert.schedule_kind.as_str(),
            upsert.schedule_time,
            upsert.weekly_weekday,
            upsert.monthly_day,
            upsert.timezone,
            upsert.enabled,
            next_str,
            now_str,
            weekly_weekdays_json,
        ],
    )?;

    get_task(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn update_task(
    conn: &Connection,
    task_id: &str,
    upsert: &ScheduledTaskUpsert,
) -> Result<ScheduledTask> {
    let existing = get_task(conn, task_id)?;
    if existing.is_none() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    let now = Utc::now();
    let next_run_at = compute_next_run_at(
        upsert.schedule_kind,
        &upsert.schedule_time,
        upsert.weekly_weekday,
        upsert.weekly_weekdays.as_ref(),
        upsert.monthly_day,
        now,
    );
    let now_str = now.to_rfc3339();
    let next_str = next_run_at.to_rfc3339();
    let weekly_weekdays_json = encode_weekly_weekdays(&upsert.weekly_weekdays);

    conn.execute(
        "UPDATE scheduled_tasks SET
            title = ?2, instruction = ?3, project_id = ?4, agent_kind = ?5, provider_id = ?6,
            model = ?7, reasoning_effort = ?8, permission_config = ?9, plan_mode = ?10,
            schedule_kind = ?11, schedule_time = ?12, weekly_weekday = ?13, monthly_day = ?14,
            timezone = ?15, enabled = ?16, next_run_at = ?17, updated_at = ?18, weekly_weekdays = ?19
         WHERE id = ?1",
        params![
            task_id,
            upsert.title,
            upsert.instruction,
            upsert.project_id,
            upsert.agent_kind.as_str(),
            upsert.provider_id,
            upsert.model,
            upsert.reasoning_effort,
            upsert.permission_config,
            upsert.plan_mode,
            upsert.schedule_kind.as_str(),
            upsert.schedule_time,
            upsert.weekly_weekday,
            upsert.monthly_day,
            upsert.timezone,
            upsert.enabled,
            next_str,
            now_str,
            weekly_weekdays_json,
        ],
    )?;

    get_task(conn, task_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn delete_task(conn: &Connection, task_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM scheduled_tasks WHERE id = ?1",
        params![task_id],
    )?;
    Ok(())
}

pub fn set_task_enabled(conn: &Connection, task_id: &str, enabled: bool) -> Result<ScheduledTask> {
    let now_str = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE scheduled_tasks SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        params![task_id, enabled, now_str],
    )?;
    get_task(conn, task_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn list_runs(conn: &Connection, task_id: &str) -> Result<Vec<TaskRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_SELECT} FROM scheduled_task_runs WHERE task_id = ?1 ORDER BY scheduled_for DESC"
    ))?;
    let runs = stmt
        .query_map(params![task_id], row_to_run)?
        .collect::<Result<Vec<_>>>()?;
    Ok(runs)
}

pub fn project_exists(conn: &Connection, project_id: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM projects WHERE id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn count_active_runs(conn: &Connection) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM scheduled_task_runs WHERE status IN ('running', 'awaiting_input')",
        [],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

pub fn task_has_active_run(conn: &Connection, task_id: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM scheduled_task_runs WHERE task_id = ?1 AND status IN ('running', 'awaiting_input')",
        params![task_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn insert_run(
    conn: &Connection,
    task_id: &str,
    scheduled_for: &str,
    status: TaskRunStatus,
    skip_reason: Option<SkipReason>,
    session_id: Option<&str>,
    error: Option<&str>,
) -> Result<TaskRun> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let started_at = if status == TaskRunStatus::Skipped {
        None
    } else {
        Some(now.clone())
    };
    let finished_at = if status == TaskRunStatus::Skipped {
        Some(now.clone())
    } else {
        None
    };

    conn.execute(
        "INSERT INTO scheduled_task_runs (id, task_id, session_id, scheduled_for, started_at, finished_at, status, skip_reason, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            task_id,
            session_id,
            scheduled_for,
            started_at,
            finished_at,
            status.as_str(),
            skip_reason.map(|reason| reason.as_str()),
            error,
        ],
    )?;

    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_SELECT} FROM scheduled_task_runs WHERE id = ?1"
    ))?;
    let mut rows = stmt.query_map(params![id], row_to_run)?;
    match rows.next() {
        Some(Ok(row)) => Ok(row),
        Some(Err(error)) => Err(error),
        None => Err(rusqlite::Error::QueryReturnedNoRows),
    }
}

pub fn get_run(conn: &Connection, run_id: &str) -> Result<Option<TaskRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_SELECT} FROM scheduled_task_runs WHERE id = ?1"
    ))?;
    let mut rows = stmt.query_map(params![run_id], row_to_run)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn update_task_schedule_after_run(
    conn: &Connection,
    task_id: &str,
    last_run_at: &str,
    next_run_at: &str,
) -> Result<()> {
    let now_str = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE scheduled_tasks SET last_run_at = ?2, next_run_at = ?3, updated_at = ?4 WHERE id = ?1",
        params![task_id, last_run_at, next_run_at, now_str],
    )?;
    Ok(())
}

pub fn update_run_status(
    conn: &Connection,
    run_id: &str,
    status: TaskRunStatus,
    session_id: Option<&str>,
    error: Option<&str>,
) -> Result<()> {
    let finished_at = if matches!(
        status,
        TaskRunStatus::Completed | TaskRunStatus::Failed | TaskRunStatus::Skipped
    ) {
        Some(Utc::now().to_rfc3339())
    } else {
        None
    };
    conn.execute(
        "UPDATE scheduled_task_runs SET status = ?2, session_id = COALESCE(?3, session_id), error = ?4, finished_at = COALESCE(?5, finished_at) WHERE id = ?1",
        params![run_id, status.as_str(), session_id, error, finished_at],
    )?;
    Ok(())
}

pub fn list_due_tasks(conn: &Connection, now: &str) -> Result<Vec<ScheduledTask>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_SELECT} FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ?1 ORDER BY next_run_at ASC"
    ))?;
    let tasks = stmt
        .query_map(params![now], row_to_task)?
        .collect::<Result<Vec<_>>>()?;
    Ok(tasks)
}

pub fn list_running_runs(conn: &Connection) -> Result<Vec<TaskRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_SELECT} FROM scheduled_task_runs WHERE status = 'running' ORDER BY started_at ASC"
    ))?;
    let runs = stmt
        .query_map([], row_to_run)?
        .collect::<Result<Vec<_>>>()?;
    Ok(runs)
}

pub fn delete_run(conn: &Connection, run_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM scheduled_task_runs WHERE id = ?1",
        params![run_id],
    )?;
    Ok(())
}
