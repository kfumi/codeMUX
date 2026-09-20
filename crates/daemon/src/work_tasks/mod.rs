mod db;
mod execution;
mod git_ops;
mod service;
mod types;

pub use db::{get_project_path, get_task, list_events, list_tasks, new_task_id, StatusExtras};
pub use service::{
    archive_work_task, create_work_task, delete_work_task, reorder_work_tasks, set_status_cas,
    update_work_task,
};
pub use types::{
    CompletionKind, FailureReason, WorkTask, WorkTaskEvent, WorkTaskInput, WorkTaskPatch,
    WorkTaskStatus,
};

pub use execution::{
    cancel_work_task, claim_decision, claim_task_and_launch, complete_work_task,
    handle_session_event, merge_work_task, restart_work_task, retry_work_task, start_work_task,
    tick, MAX_CONCURRENT_WORK_TASKS_PER_PROJECT,
};

/// 工作任务领域事件出口：前端经 WS 订阅 `work-tasks-changed` 后刷新列表。
pub fn emit_work_tasks_changed(daemon: &crate::daemon::DaemonState, reason: &str) {
    emit_work_tasks_changed_to_companion(&daemon.companion, reason);
}

/// sidecar 事件回写路径没有 `DaemonState`（事件循环只持有 companion 引用）：
/// 与 [`crate::daemon::UiEventSink`]（WsUiEventSink）完全同形的 `ui-event`
/// 信封、空 session_id，直接发 companion 广播通道。
pub fn emit_work_tasks_changed_to_companion(
    companion: &crate::companion::CompanionState,
    reason: &str,
) {
    let _ = companion
        .inner
        .event_tx
        .send(crate::companion::state::CompanionBroadcastEvent {
            session_id: String::new(),
            event: serde_json::json!({
                "type": "ui-event",
                "name": "work-tasks-changed",
                "payload": { "reason": reason },
            }),
        });
}

/// 终态任务删除前的 worktree/work 分支清理（services 层调用，尽力而为）。
pub(crate) fn cleanup_worktree_and_branch(
    project_path: &std::path::Path,
    worktree_path: &str,
    work_branch: &str,
) -> Result<(), String> {
    git_ops::cleanup_worktree_and_branch(project_path, worktree_path, work_branch)
}
