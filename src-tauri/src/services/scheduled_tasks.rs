use std::str::FromStr;

use serde::Deserialize;

use crate::scheduled_tasks::{
    create_task, delete_task, get_task, list_runs, list_tasks, local_timezone_label,
    set_task_enabled, update_task, ScheduleKind, ScheduledTask, ScheduledTaskUpsert, TaskRun,
};
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskInput {
    pub title: String,
    pub instruction: String,
    pub project_id: String,
    pub agent_kind: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub permission_config: String,
    pub plan_mode: String,
    pub schedule_kind: String,
    pub schedule_time: String,
    pub weekly_weekday: Option<i32>,
    pub weekly_weekdays: Option<Vec<i32>>,
    pub monthly_day: Option<i32>,
    pub timezone: Option<String>,
    pub enabled: bool,
}

fn parse_input(input: ScheduledTaskInput) -> Result<ScheduledTaskUpsert, String> {
    let agent_kind = crate::config::types::AgentKind::from_str(&input.agent_kind)
        .map_err(|error| error.to_string())?;
    let schedule_kind = ScheduleKind::from_str(&input.schedule_kind)
        .ok_or_else(|| format!("Unsupported schedule kind: {}", input.schedule_kind))?;

    Ok(ScheduledTaskUpsert {
        title: input.title,
        instruction: input.instruction,
        project_id: input.project_id,
        agent_kind,
        provider_id: input.provider_id,
        model: input.model,
        reasoning_effort: input.reasoning_effort,
        permission_config: input.permission_config,
        plan_mode: input.plan_mode,
        schedule_kind,
        schedule_time: input.schedule_time,
        weekly_weekday: input.weekly_weekday,
        weekly_weekdays: input.weekly_weekdays,
        monthly_day: input.monthly_day,
        timezone: input.timezone.unwrap_or_else(local_timezone_label),
        enabled: input.enabled,
    })
}

pub fn list_scheduled_tasks_impl(state: &AppState) -> Result<Vec<ScheduledTask>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    list_tasks(&conn).map_err(|error| error.to_string())
}

pub fn get_scheduled_task_impl(
    state: &AppState,
    task_id: String,
) -> Result<Option<ScheduledTask>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    get_task(&conn, &task_id).map_err(|error| error.to_string())
}

pub fn create_scheduled_task_impl(
    state: &AppState,
    input: ScheduledTaskInput,
) -> Result<ScheduledTask, String> {
    let upsert = parse_input(input)?;
    if upsert.instruction.trim().is_empty() {
        return Err("任务指令不能为空".to_string());
    }
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    create_task(&conn, &upsert).map_err(|error| error.to_string())
}

pub fn update_scheduled_task_impl(
    state: &AppState,
    task_id: String,
    input: ScheduledTaskInput,
) -> Result<ScheduledTask, String> {
    let upsert = parse_input(input)?;
    if upsert.instruction.trim().is_empty() {
        return Err("任务指令不能为空".to_string());
    }
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    update_task(&conn, &task_id, &upsert).map_err(|error| error.to_string())
}

pub fn delete_scheduled_task_impl(state: &AppState, task_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    delete_task(&conn, &task_id).map_err(|error| error.to_string())
}

pub fn set_scheduled_task_enabled_impl(
    state: &AppState,
    task_id: String,
    enabled: bool,
) -> Result<ScheduledTask, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    set_task_enabled(&conn, &task_id, enabled).map_err(|error| error.to_string())
}

pub fn list_scheduled_task_runs_impl(
    state: &AppState,
    task_id: String,
) -> Result<Vec<TaskRun>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    list_runs(&conn, &task_id).map_err(|error| error.to_string())
}

pub fn get_scheduled_task_timezone() -> String {
    local_timezone_label()
}

pub fn delete_scheduled_task_run_impl(state: &AppState, run_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    crate::scheduled_tasks::delete_run(&conn, &run_id).map_err(|error| error.to_string())
}
