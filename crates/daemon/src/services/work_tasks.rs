//! Work task services：持锁 `&AppState` 调用 `work_tasks` 模块。
//! 成功路径的领域事件广播由路由层 handler 负责。

use log::warn;

use crate::work_tasks::{
    archive_work_task, cleanup_worktree_and_branch, create_work_task, delete_work_task,
    get_project_path, get_task as db_get_task, list_events as db_list_events,
    list_tasks as db_list_tasks, reorder_work_tasks, update_work_task, WorkTask, WorkTaskEvent,
    WorkTaskInput, WorkTaskPatch,
};
use crate::AppState;

pub fn list_work_tasks_impl(state: &AppState) -> Result<Vec<WorkTask>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    db_list_tasks(&conn).map_err(|error| error.to_string())
}

pub fn get_work_task_impl(state: &AppState, task_id: String) -> Result<Option<WorkTask>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    db_get_task(&conn, &task_id).map_err(|error| error.to_string())
}

pub fn list_work_task_events_impl(
    state: &AppState,
    task_id: String,
) -> Result<Vec<WorkTaskEvent>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    db_list_events(&conn, &task_id).map_err(|error| error.to_string())
}

pub fn create_work_task_impl(state: &AppState, input: WorkTaskInput) -> Result<WorkTask, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    create_work_task(&conn, &input)
}

pub fn update_work_task_impl(
    state: &AppState,
    task_id: String,
    patch: WorkTaskPatch,
) -> Result<WorkTask, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    update_work_task(&conn, &task_id, &patch)
}

/// 删除待办或终态任务；带 worktree 的任务在删除前尽力清理 worktree + work 分支
/// （失败不阻断删除，仅记 warn）。清理必须发生在状态守卫通过之后，
/// 否则会误删活跃任务的 worktree。
pub fn delete_work_task_impl(state: &AppState, task_id: String) -> Result<(), String> {
    let (project_path, worktree_path, work_branch) = {
        let conn = state.db.lock().map_err(|error| error.to_string())?;
        let task = db_get_task(&conn, &task_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "任务不存在".to_string())?;
        if !matches!(
            task.status,
            crate::work_tasks::WorkTaskStatus::Todo
                | crate::work_tasks::WorkTaskStatus::Done
                | crate::work_tasks::WorkTaskStatus::Canceled
        ) {
            return Err(format!(
                "任务状态为 {}，仅 todo/done/canceled 可删除",
                task.status.as_str()
            ));
        }
        let project_path = match &task.worktree_path {
            Some(_) => {
                get_project_path(&conn, &task.project_id).map_err(|error| error.to_string())?
            }
            None => None,
        };
        (project_path, task.worktree_path, task.work_branch)
    };

    if let (Some(project_path), Some(worktree_path), Some(work_branch)) =
        (project_path, worktree_path, work_branch)
    {
        if std::path::Path::new(&worktree_path).is_dir() {
            if let Err(error) = cleanup_worktree_and_branch(
                std::path::Path::new(&project_path),
                &worktree_path,
                &work_branch,
            ) {
                warn!(
                    target: "work_tasks",
                    "work task {task_id} worktree cleanup before delete failed: {error}"
                );
            }
        }
    }

    let conn = state.db.lock().map_err(|error| error.to_string())?;
    delete_work_task(&conn, &task_id)
}

pub fn archive_work_task_impl(
    state: &AppState,
    task_id: String,
    archived: bool,
) -> Result<WorkTask, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    archive_work_task(&conn, &task_id, archived)
}

pub fn reorder_work_tasks_impl(
    state: &AppState,
    project_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    reorder_work_tasks(&conn, &project_id, &ids)
}
