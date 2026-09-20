//! 工作任务执行生命周期（票 02）与 worktree 隔离/合并编排（票 03）。
//!
//! 分层：
//! - 纯 SQL/CAS 逻辑在 [`super::db`] 与本文件的可测函数（`claim_decision`、
//!   `handle_session_event_conn`），持 `&Connection`/`&mut Connection`；
//! - 需要 `DaemonState` 的编排（建会话、发指令、git、广播）只在函数边界
//!   拿锁，绝不跨 `await`/长操作持锁。

use std::path::PathBuf;

use chrono::Utc;
use log::{info, warn};
use rusqlite::Connection;
use serde_json::Value;

use crate::companion::actions::{interrupt_companion_session, send_companion_message};
use crate::companion::CompanionState;
use crate::daemon::DaemonState;
use crate::db::operations;
use crate::services::git::create_git_worktree_in_project;

use super::db::{self, StatusExtras};
use super::git_ops::{self, MergeError};
use super::service::set_status_cas;
use super::types::{CompletionKind, FailureReason, WorkTask, WorkTaskStatus};

/// 单项目同时执行（preparing/running/merging 占坑）的工作任务上限。
pub const MAX_CONCURRENT_WORK_TASKS_PER_PROJECT: i64 = 1;

fn now_str() -> String {
    Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// 领取（并发上限）
// ---------------------------------------------------------------------------

/// 项目占坑计数 < 上限且存在最老 queued 时返回该任务 id（纯判定，不落状态）。
/// 占坑 = status IN ('preparing','running','merging')。
pub fn claim_decision(conn: &Connection, project_id: &str, limit: i64) -> Option<String> {
    let busy = db::count_project_busy(conn, project_id).ok()?;
    if busy >= limit {
        return None;
    }
    conn.query_row(
        "SELECT id FROM work_tasks WHERE project_id = ?1 AND status = 'queued' \
         ORDER BY sort_order ASC, created_at ASC LIMIT 1",
        rusqlite::params![project_id],
        |row| row.get(0),
    )
    .ok()
}

/// 多候选 CAS：按顺序尝试 expected 列表，第一个匹配的生效。
fn cas_first(
    conn: &mut Connection,
    task_id: &str,
    candidates: &[WorkTaskStatus],
    next: WorkTaskStatus,
    event_kind: &str,
    event_detail: Option<&str>,
    extra: Option<StatusExtras>,
) -> Option<WorkTask> {
    for expected in candidates {
        if let Ok(Some(task)) = db::set_status_cas(
            conn,
            task_id,
            *expected,
            next,
            event_kind,
            event_detail,
            extra.clone(),
        ) {
            return Some(task);
        }
    }
    None
}

/// 锁内领取指定任务：queued 且项目容量允许时 CAS queued→preparing。
/// 容量计算与 CAS 在同一锁段完成（无 TOCTOU）；并发时只有一个调用方成功。
pub fn claim_specific_conn(conn: &mut Connection, task_id: &str, limit: i64) -> Option<WorkTask> {
    let task = db::get_task(conn, task_id).ok()??;
    if task.status != WorkTaskStatus::Queued {
        return None;
    }
    let busy = db::count_project_busy(conn, &task.project_id).ok()?;
    if busy >= limit {
        return None;
    }
    db::set_status_cas(
        conn,
        task_id,
        WorkTaskStatus::Queued,
        WorkTaskStatus::Preparing,
        "claim",
        None,
        None,
    )
    .ok()?
}

/// 领取项目最老 queued 任务并异步启动；返回领取到的任务（无容量/无队列返回 None）。
/// 容量计算与 CAS 占坑在同一锁段内完成，spawn 启动在锁外。
pub fn claim_and_launch(daemon: &DaemonState, project_id: &str) -> Option<WorkTask> {
    let (task_id, claimed) = {
        let mut conn = daemon.app.db.lock().ok()?;
        let task_id = claim_decision(&conn, project_id, MAX_CONCURRENT_WORK_TASKS_PER_PROJECT)?;
        let claimed = db::set_status_cas(
            &mut conn,
            &task_id,
            WorkTaskStatus::Queued,
            WorkTaskStatus::Preparing,
            "claim",
            None,
            None,
        )
        .ok()??;
        (task_id, claimed)
    };
    spawn_launch(daemon, task_id);
    Some(claimed)
}

/// 领取指定任务（start 路径）：对该任务本身做 queued→preparing 的容量判定 + CAS，
/// 随后异步启动；点开始即发，不依赖 30s tick。无容量/非 queued 返回 None。
pub fn claim_task_and_launch(daemon: &DaemonState, task_id: &str) -> Option<WorkTask> {
    let claimed = {
        let mut conn = daemon.app.db.lock().ok()?;
        claim_specific_conn(&mut conn, task_id, MAX_CONCURRENT_WORK_TASKS_PER_PROJECT)?
    };
    spawn_launch(daemon, claimed.id.clone());
    Some(claimed)
}

// ---------------------------------------------------------------------------
// 启动 / 重试：preparing → running（锁外异步）
// ---------------------------------------------------------------------------

/// 异步启动 preparing 状态的任务（建 worktree、建会话、发指令）。
pub fn spawn_launch(daemon: &DaemonState, task_id: String) {
    let daemon = clone_state(daemon);
    tokio::spawn(async move {
        if let Err(error) = launch(daemon, task_id).await {
            warn!(target: "work_tasks", "work task launch failed: {error}");
        }
    });
}

fn spawn_launch_retry(daemon: &DaemonState, task_id: String) {
    let daemon = clone_state(daemon);
    tokio::spawn(async move {
        if let Err(error) = launch_retry(daemon, task_id).await {
            warn!(target: "work_tasks", "work task retry failed: {error}");
        }
    });
}

/// DaemonState 各字段都是 Arc，手工克隆以便 spawn 'static 任务。
fn clone_state(daemon: &DaemonState) -> DaemonState {
    DaemonState {
        roots: daemon.roots.clone(),
        app: daemon.app.clone(),
        agent: daemon.agent.clone(),
        terminal: daemon.terminal.clone(),
        companion: daemon.companion.clone(),
        ui_events: daemon.ui_events.clone(),
    }
}

fn fail_preparing(conn: &mut Connection, task_id: &str, error: &str) {
    let extras = StatusExtras {
        failure_reason: Some(FailureReason::SetupError),
        last_error: Some(error.to_string()),
        ..Default::default()
    };
    if let Err(error) = db::set_status_cas(
        conn,
        task_id,
        WorkTaskStatus::Preparing,
        WorkTaskStatus::Failed,
        "fail",
        Some(error),
        Some(extras),
    ) {
        warn!(target: "work_tasks", "failed to mark task {task_id} failed: {error}");
    }
}

/// preparing → running：建 worktree（可选）、建会话、发指令。
async fn launch(daemon: DaemonState, task_id: String) -> Result<(), String> {
    let task = {
        let conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        db::get_task(&conn, &task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "任务不存在".to_string())?
    };
    if task.status != WorkTaskStatus::Preparing {
        return Ok(()); // 已被取消等，放弃启动
    }

    let worktree = match prepare_worktree(&daemon, &task).await {
        Ok(info) => info,
        Err(error) => {
            {
                let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
                fail_preparing(&mut conn, &task_id, &error);
            }
            super::emit_work_tasks_changed(&daemon, "fail");
            return Err(error);
        }
    };

    let session_id = match prepare_session(&daemon, &task, worktree.as_ref()) {
        Ok(session_id) => session_id,
        Err(error) => {
            {
                let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
                fail_preparing(&mut conn, &task_id, &error);
            }
            super::emit_work_tasks_changed(&daemon, "fail");
            return Err(error);
        }
    };
    // 会话出现在前端会话列表（照 scheduled runner 的 sessions-changed）
    daemon.ui_events.emit(
        "sessions-changed",
        serde_json::json!({
            "sessionId": session_id,
            "projectId": task.project_id,
            "taskId": task.id,
            "reason": "work_task",
        }),
    );

    send_and_settle(daemon, task_id, session_id, task.instruction).await
}

/// 重试：preparing → running/failed，沿用原 session_id 重发指令。
async fn launch_retry(daemon: DaemonState, task_id: String) -> Result<(), String> {
    let task = {
        let conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        db::get_task(&conn, &task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "任务不存在".to_string())?
    };
    if task.status != WorkTaskStatus::Preparing {
        return Ok(());
    }
    let session_id = task
        .session_id
        .clone()
        .ok_or_else(|| "任务缺少会话，无法重试".to_string())?;
    check_preparing(&daemon, &task_id)?;
    send_and_settle(daemon, task_id, session_id, task.instruction).await
}

/// 确认任务仍在 preparing（启动过程中被取消等则放弃）。
fn check_preparing(daemon: &DaemonState, task_id: &str) -> Result<(), String> {
    let conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
    let task = db::get_task(&conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;
    if task.status == WorkTaskStatus::Preparing {
        Ok(())
    } else {
        Err(format!("任务状态已变为 {}", task.status.as_str()))
    }
}

/// 发送指令并按结果落 running / failed(setup_error)。
async fn send_and_settle(
    daemon: DaemonState,
    task_id: String,
    session_id: String,
    instruction: String,
) -> Result<(), String> {
    let result = send_companion_message(&daemon, &session_id, &instruction, None, None, None).await;
    let changed = {
        let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        match result {
            Ok(()) => {
                let extras = StatusExtras {
                    session_id: Some(session_id.clone()),
                    started_at: Some(now_str()),
                    ..Default::default()
                };
                let changed = db::set_status_cas(
                    &mut conn,
                    &task_id,
                    WorkTaskStatus::Preparing,
                    WorkTaskStatus::Running,
                    "running",
                    None,
                    Some(extras),
                )
                .map_err(|e| e.to_string())?
                .is_some();
                if !changed {
                    // 状态已被外部改变（典型：启动期间被取消）——中断孤儿会话轮
                    abort_if_canceled(&daemon, &mut conn, &task_id, &session_id);
                }
                changed
            }
            Err(error) => {
                let extras = StatusExtras {
                    failure_reason: Some(FailureReason::SetupError),
                    last_error: Some(error.clone()),
                    ..Default::default()
                };
                let changed = db::set_status_cas(
                    &mut conn,
                    &task_id,
                    WorkTaskStatus::Preparing,
                    WorkTaskStatus::Failed,
                    "fail",
                    Some(&error),
                    Some(extras),
                )
                .map_err(|e| e.to_string())?
                .is_some();
                if changed {
                    super::emit_work_tasks_changed(&daemon, "fail");
                }
                changed
            }
        }
    };
    if changed {
        super::emit_work_tasks_changed(&daemon, "settle");
    }
    Ok(())
}

fn abort_if_canceled(daemon: &DaemonState, conn: &mut Connection, task_id: &str, session_id: &str) {
    let canceled = db::get_task(conn, task_id)
        .ok()
        .flatten()
        .is_some_and(|task| task.status == WorkTaskStatus::Canceled);
    if canceled {
        info!(target: "work_tasks", "task {task_id} canceled during launch; interrupting session {session_id}");
        let daemon = clone_state(daemon);
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            let _ = interrupt_companion_session(&daemon, &session_id).await;
        });
    }
}

// ---------------------------------------------------------------------------
// worktree 准备（票 03）
// ---------------------------------------------------------------------------

struct WorktreeInfo {
    path: String,
    branch: String,
}
async fn prepare_worktree(
    daemon: &DaemonState,
    task: &WorkTask,
) -> Result<Option<WorktreeInfo>, String> {
    if !task.use_worktree {
        return Ok(None);
    }
    // 已存在的 worktree（重试场景）直接复用
    if let (Some(path), Some(branch)) = (&task.worktree_path, &task.work_branch) {
        if std::path::Path::new(path).is_dir() {
            return Ok(Some(WorktreeInfo {
                path: path.clone(),
                branch: branch.clone(),
            }));
        }
    }
    let project_path = {
        let conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        db::get_project_path(&conn, &task.project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "项目不存在".to_string())?
    };
    let project_path = PathBuf::from(project_path);
    let task_id = task.id.clone();
    let task_base = task.base_branch.clone();
    let (path, work_branch, base) =
        tokio::task::spawn_blocking(move || -> Result<(String, String, String), String> {
            let base_branch = match task_base.as_deref().filter(|b| !b.trim().is_empty()) {
                Some(base) => base.to_string(),
                None => git_ops::current_branch(&project_path)?,
            };
            let short_id: String = task_id.chars().take(8).collect();
            let work_branch = format!("worktask/{short_id}");
            let worktree = create_git_worktree_in_project(
                &project_path,
                &work_branch,
                Some(&base_branch),
                None,
            )?;
            Ok((worktree.path, work_branch, base_branch))
        })
        .await
        .map_err(|error| format!("worktree 准备线程失败: {error}"))??;

    {
        let conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        db::set_worktree_fields(&conn, &task.id, &path, &work_branch, &base)
            .map_err(|e| e.to_string())?;
        db::insert_event(
            &conn,
            &task.id,
            "worktree_ready",
            Some(&format!("worktree {path} · 分支 {work_branch}")),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(Some(WorktreeInfo {
        path,
        branch: work_branch,
    }))
}

/// 建会话并写入 origin / working_path（worktree cwd）/ provider。
fn prepare_session(
    daemon: &DaemonState,
    task: &WorkTask,
    worktree: Option<&WorktreeInfo>,
) -> Result<String, String> {
    let conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
    let session = operations::create_scheduled_session_for_project(
        &conn,
        &task.title,
        task.agent_kind,
        "agent",
        &task.project_id,
        None,
        None,
        task.model.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE sessions SET origin = 'work_task', updated_at = ?2 WHERE id = ?1",
        rusqlite::params![session.id, now_str()],
    )
    .map_err(|e| e.to_string())?;

    if let Some(worktree) = worktree {
        operations::update_session_working_path(
            &conn,
            &session.id,
            &worktree.path,
            operations::GitBranchWrite::Capture(Some(worktree.branch.clone())),
        )
        .map_err(|e| e.to_string())?;
    }
    if let (Some(provider_id), Some(model)) = (&task.provider_id, &task.model) {
        let _ =
            operations::update_session_provider(&conn, &session.id, Some(provider_id), model, None);
    }
    Ok(session.id)
}

// ---------------------------------------------------------------------------
// 会话事件回写
// ---------------------------------------------------------------------------

/// `handle_session_event_conn` 的结果：状态是否实际变化 + 进入 review 后
/// 需要外层补算 diff 的任务信息。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EventOutcome {
    pub changed: bool,
    pub diff: Option<DiffRequest>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DiffRequest {
    pub task_id: String,
    pub project_path: String,
    pub base_branch: String,
    pub work_branch: String,
}

/// turn_finished 的真实字段形状见 agent/history_events.rs（normalize_result）与
/// sidecar turnEventNormalizer：`outcome`（completed/failed/interrupted/cancelled…）
/// + `reason`（结束文本）。取不到再回落旧字段名。
fn extract_summary(event: &Value) -> Option<String> {
    for key in ["reason", "summary", "text", "message", "result"] {
        if let Some(value) = event.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// turn_finished outcome 分类：None = 成功（进 review）；
/// Some(Interrupted) = 用户中断类；Some(AgentError) = 其余失败类。
/// 事件缺 outcome（旧格式/测试桩）按成功处理，保持既有回转语义。
fn classify_turn_outcome(event: &Value) -> Option<FailureReason> {
    match event
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or("completed")
    {
        "completed" | "success" | "ok" => None,
        "interrupted" | "cancelled" | "canceled" => Some(FailureReason::Interrupted),
        _ => Some(FailureReason::AgentError),
    }
}

/// 时间线尾部扫描条数上限（摘要兜底足够，避免整条时间线加载）。
const SUMMARY_TIMELINE_TAIL: usize = 40;
/// 摘要文本上限（result_summary 只是看板预览）。
const SUMMARY_MAX_CHARS: usize = 500;

/// turn_finished 无 reason 时，从持久化时间线尾部（倒序最近 N 条）找最后一条
/// assistant 文本作为摘要兜底。事件形状见 agent/history_events.rs：
/// `{"type":"assistant_message","content":[{"type":"text","text":…}]}`。
fn last_assistant_text_from_timeline(
    conn: &Connection,
    session_id: &str,
    tail: usize,
) -> Option<String> {
    let mut stmt = conn
        .prepare(
            "SELECT event_json FROM session_event_snapshots \
             WHERE session_id = ?1 ORDER BY sequence DESC LIMIT ?2",
        )
        .ok()?;
    let rows = stmt
        .query_map(rusqlite::params![session_id, tail as i64], |row| {
            row.get::<_, String>(0)
        })
        .ok()?;
    for raw in rows.filter_map(Result::ok) {
        let event: Value = serde_json::from_str(&raw).ok()?;
        if event.get("type").and_then(Value::as_str) != Some("assistant_message") {
            continue;
        }
        let text = timeline_text_blocks(&event).trim().to_string();
        if text.is_empty() {
            continue;
        }
        let truncated: String = text.chars().take(SUMMARY_MAX_CHARS).collect();
        return Some(truncated);
    }
    None
}

/// 拼接 assistant_message 事件的 text 块（content 可能是字符串或块数组）。
fn timeline_text_blocks(event: &Value) -> String {
    let content = event.get("content");
    let mut text = String::new();
    match content {
        Some(Value::String(value)) => text.push_str(value),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(value) = block.get("text").and_then(Value::as_str) {
                        text.push_str(value);
                    }
                }
            }
        }
        _ => {}
    }
    text
}

/// 从 error 事件提取错误消息。
fn extract_error(event: &Value) -> String {
    for key in ["error", "message", "detail"] {
        if let Some(value) = event.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "未知错误".to_string()
}

/// 会话事件 → 工作任务状态回写（纯 conn 逻辑，可测）。
///
/// generation 守卫：任务.session_id 必须等于事件 session_id（由查询保证），
/// 且任务必须处于活跃状态；否则事件被忽略。
pub fn handle_session_event_conn(
    conn: &mut Connection,
    session_id: &str,
    event: &Value,
) -> Result<EventOutcome, String> {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let Some(task) =
        super::db::find_live_task_by_session(conn, session_id).map_err(|e| e.to_string())?
    else {
        return Ok(EventOutcome::default());
    };

    match event_type {
        // 权限审批 / 用户输入请求：running|preparing → awaiting_input（幂等）
        "user_input_requested" | "permission_requested" => {
            if task.status == WorkTaskStatus::AwaitingInput {
                return Ok(EventOutcome::default());
            }
            let changed = db::set_status_cas(
                conn,
                &task.id,
                task.status,
                WorkTaskStatus::AwaitingInput,
                "awaiting_input",
                Some("智能体等待用户输入或权限审批"),
                None,
            )
            .map_err(|e| e.to_string())?
            .is_some();
            Ok(EventOutcome {
                changed,
                diff: None,
            })
        }
        // 用户在会话里回复：awaiting_input → running（状态机 ⇄，幂等）。
        "user_message" => {
            if task.status != WorkTaskStatus::AwaitingInput {
                return Ok(EventOutcome::default());
            }
            let changed = db::set_status_cas(
                conn,
                &task.id,
                WorkTaskStatus::AwaitingInput,
                WorkTaskStatus::Running,
                "resume",
                Some("用户已回复，任务继续执行"),
                None,
            )
            .map_err(|e| e.to_string())?
            .is_some();
            Ok(EventOutcome {
                changed,
                diff: None,
            })
        }
        "turn_finished" => {
            let summary = match extract_summary(event) {
                Some(summary) => Some(summary),
                // 事件无文本字段：从时间线尾部兜底取最后一条 assistant 文本
                None => last_assistant_text_from_timeline(conn, session_id, SUMMARY_TIMELINE_TAIL),
            };
            match classify_turn_outcome(event) {
                // 成功 → review（原路径）
                None => {
                    let extras = StatusExtras {
                        result_summary: summary,
                        settled_at: Some(now_str()),
                        ..Default::default()
                    };
                    let settled = cas_first(
                        conn,
                        &task.id,
                        &[
                            WorkTaskStatus::Preparing,
                            WorkTaskStatus::Running,
                            WorkTaskStatus::AwaitingInput,
                        ],
                        WorkTaskStatus::Review,
                        "turn_finished",
                        Some("回合结束，等待验收"),
                        Some(extras),
                    );
                    let Some(settled) = settled else {
                        return Ok(EventOutcome::default());
                    };
                    let project_path = db::get_project_path(conn, &settled.project_id)
                        .map_err(|e| e.to_string())?
                        .unwrap_or_default();
                    let diff = settled
                        .work_branch
                        .as_ref()
                        .zip(settled.base_branch.as_ref())
                        .map(|(work, base)| DiffRequest {
                            task_id: settled.id.clone(),
                            project_path: project_path.clone(),
                            base_branch: base.clone(),
                            work_branch: work.clone(),
                        });
                    Ok(EventOutcome {
                        changed: true,
                        diff,
                    })
                }
                // 失败类 outcome → failed（interrupted 单独标注失败原因）
                Some(failure_reason) => {
                    let detail = summary.clone();
                    let extras = StatusExtras {
                        failure_reason: Some(failure_reason),
                        last_error: detail.clone(),
                        result_summary: detail,
                        finished_at: Some(now_str()),
                        ..Default::default()
                    };
                    let changed = cas_first(
                        conn,
                        &task.id,
                        &[
                            WorkTaskStatus::Preparing,
                            WorkTaskStatus::Running,
                            WorkTaskStatus::AwaitingInput,
                        ],
                        WorkTaskStatus::Failed,
                        "turn_finished",
                        Some("回合以失败或中断结束"),
                        Some(extras),
                    )
                    .is_some();
                    Ok(EventOutcome {
                        changed,
                        diff: None,
                    })
                }
            }
        }
        "error" => {
            let message = extract_error(event);
            let extras = StatusExtras {
                failure_reason: Some(FailureReason::AgentError),
                last_error: Some(message.clone()),
                ..Default::default()
            };
            let changed = cas_first(
                conn,
                &task.id,
                &[
                    WorkTaskStatus::Preparing,
                    WorkTaskStatus::Running,
                    WorkTaskStatus::AwaitingInput,
                ],
                WorkTaskStatus::Failed,
                "fail",
                Some(&message),
                Some(extras),
            )
            .is_some();
            Ok(EventOutcome {
                changed,
                diff: None,
            })
        }
        _ => Ok(EventOutcome::default()),
    }
}

/// 事件包装层：拿锁调 conn 逻辑，状态实际变化才广播看板刷新；
/// 进入 review 的 worktree 任务由外层补算 diff 统计（CAS 事务后补写）。
pub fn handle_session_event(
    companion_state: &CompanionState,
    session_id: &str,
    event: &Value,
    app: &crate::AppState,
) {
    if session_id.is_empty() {
        return;
    }
    let outcome = {
        let Ok(mut conn) = app.db.lock() else {
            return;
        };
        match handle_session_event_conn(&mut conn, session_id, event) {
            Ok(outcome) => outcome,
            Err(error) => {
                warn!(target: "work_tasks", "work task event writeback failed: {error}");
                return;
            }
        }
    };
    if !outcome.changed {
        return;
    }

    if let Some(request) = &outcome.diff {
        // 记录 review 时基线分支 HEAD sha（合并前的 base 前进保护）
        let base_sha = git_ops::rev_parse(
            std::path::Path::new(&request.project_path),
            &request.base_branch,
        );
        let diff = tokio::task::block_in_place(|| {
            git_ops::diff_numstat(
                std::path::Path::new(&request.project_path),
                &request.base_branch,
                &request.work_branch,
            )
        });
        match diff {
            Ok((files, additions, deletions)) => {
                if let Ok(conn) = app.db.lock() {
                    let _ =
                        db::set_diff_stats(&conn, &request.task_id, files, additions, deletions);
                    if let Ok(base_sha) = &base_sha {
                        let _ = db::set_base_sha(&conn, &request.task_id, base_sha);
                    }
                }
            }
            Err(error) => {
                warn!(target: "work_tasks", "diff stats failed for task {}: {error}", request.task_id);
                if let (Ok(base_sha), Ok(conn)) = (&base_sha, app.db.lock()) {
                    let _ = db::set_base_sha(&conn, &request.task_id, base_sha);
                }
            }
        }
    }

    super::emit_work_tasks_changed_to_companion(companion_state, "session_event");
}

// ---------------------------------------------------------------------------
// 动作：start / cancel / retry / restart / merge / complete
// ---------------------------------------------------------------------------

/// start：todo → queued，随后尝试领取（有容量才 preparing+launch）。
pub async fn start_work_task(daemon: &DaemonState, task_id: &str) -> Result<WorkTask, String> {
    {
        let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        let task = db::get_task(&conn, task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != WorkTaskStatus::Todo {
            return Err(format!(
                "任务状态为 {}，仅 todo 可启动",
                task.status.as_str()
            ));
        }
        set_status_cas(
            &mut conn,
            task_id,
            WorkTaskStatus::Todo,
            WorkTaskStatus::Queued,
            "start",
            None,
            None,
        )?;
    }
    // 对该任务本身做 queued→preparing 的 claim+launch（点开始即发，不依赖 30s tick）
    Ok(match claim_task_and_launch(daemon, task_id) {
        Some(claimed) => claimed,
        None => current_task(daemon, task_id)?,
    })
}

fn current_task(daemon: &DaemonState, task_id: &str) -> Result<WorkTask, String> {
    let conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
    db::get_task(&conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())
}

/// cancel：queued/preparing/running/awaiting_input → canceled；活跃会话侧
/// 中断当前轮；释放坑位后自动领取项目最老 queued。
pub async fn cancel_work_task(daemon: &DaemonState, task_id: &str) -> Result<WorkTask, String> {
    let now = now_str();
    let task = {
        let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        let extras = StatusExtras {
            settled_at: Some(now.clone()),
            finished_at: Some(now.clone()),
            ..Default::default()
        };
        cas_first(
            &mut conn,
            task_id,
            &[
                WorkTaskStatus::Queued,
                WorkTaskStatus::Preparing,
                WorkTaskStatus::Running,
                WorkTaskStatus::AwaitingInput,
            ],
            WorkTaskStatus::Canceled,
            "cancel",
            Some("任务已取消"),
            Some(extras),
        )
        .ok_or_else(|| "任务不在可取消状态".to_string())?
    };

    if let Some(session_id) = &task.session_id {
        if daemon.companion.is_turn_active(session_id) {
            if let Err(error) = interrupt_companion_session(daemon, session_id).await {
                warn!(target: "work_tasks", "interrupt session {session_id} on cancel failed: {error}");
            }
        }
    }

    claim_and_launch(daemon, &task.project_id);
    Ok(task)
}

/// retry：failed → preparing（run_seq+1）。
/// - 有 session_id：沿用原会话重发指令；
/// - 无 session_id（setup_error 阶段失败）：走全新启动路径（worktree 复用/
///   新建 + 创建新会话），避免任务永久滞留 preparing 占坑锁死项目队列。
pub async fn retry_work_task(daemon: &DaemonState, task_id: &str) -> Result<WorkTask, String> {
    let has_session = {
        let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        let task = db::get_task(&conn, task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != WorkTaskStatus::Failed {
            return Err(format!(
                "任务状态为 {}，仅 failed 可重试",
                task.status.as_str()
            ));
        }
        let run_seq = task.run_seq + 1;
        let extras = StatusExtras {
            run_seq: Some(run_seq),
            ..Default::default()
        };
        set_status_cas(
            &mut conn,
            task_id,
            WorkTaskStatus::Failed,
            WorkTaskStatus::Preparing,
            "retry",
            Some(&format!("第 {run_seq} 次运行")),
            Some(extras),
        )?;
        task.session_id.is_some()
    };
    if has_session {
        spawn_launch_retry(daemon, task_id.to_string());
    } else {
        // fresh launch：launch() 会复用已存在的 worktree 或新建，并创建新会话
        spawn_launch(daemon, task_id.to_string());
    }
    current_task(daemon, task_id)
}

/// restart：canceled/failed → todo（worktree 先重置回 base），重新排队尾。
pub async fn restart_work_task(daemon: &DaemonState, task_id: &str) -> Result<WorkTask, String> {
    let task = current_task(daemon, task_id)?;
    if !matches!(
        task.status,
        WorkTaskStatus::Canceled | WorkTaskStatus::Failed
    ) {
        return Err(format!(
            "任务状态为 {}，仅 canceled/failed 可重新开始",
            task.status.as_str()
        ));
    }

    // worktree 重置（锁外、阻塞）
    let mut detail = String::from("重新开始");
    if task.use_worktree {
        if let Some(worktree_path) = &task.worktree_path {
            let base = task
                .base_branch
                .clone()
                .unwrap_or_else(|| "HEAD".to_string());
            let path = PathBuf::from(worktree_path);
            if path.is_dir() {
                let reset = tokio::task::spawn_blocking(move || {
                    git_ops::reset_worktree_to_base(&path, &base)
                })
                .await
                .map_err(|error| format!("worktree 重置线程失败: {error}"))?;
                match reset {
                    Ok(()) => detail = "worktree 已重置回基准分支".to_string(),
                    Err(error) => detail = format!("worktree 重置失败: {error}"),
                }
            } else {
                detail = "worktree 缺失，直接打回 todo".to_string();
            }
        }
    }

    {
        let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        let candidates = [task.status];
        let restarted = cas_first(
            &mut conn,
            task_id,
            &candidates,
            WorkTaskStatus::Todo,
            "restart",
            Some(&detail),
            None,
        )
        .ok_or_else(|| "任务状态已变化，重新开始失败".to_string())?;
        // 清空上一轮残留（结果摘要/diff 统计/合并信息/时间戳），避免跨代脏数据
        db::clear_run_artifacts(&conn, task_id).map_err(|e| e.to_string())?;
        db::set_sort_order_tail(&conn, task_id, &restarted.project_id)
            .map_err(|e| e.to_string())?;
        db::get_task(&conn, task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "任务不存在".to_string())
    }
}

/// merge：review → merging → done(merged) 或回 review(冲突)。
pub async fn merge_work_task(
    daemon: &DaemonState,
    task_id: &str,
    message: Option<String>,
) -> Result<WorkTask, String> {
    let (project_path, base, work, title) = {
        let conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        let task = db::get_task(&conn, task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != WorkTaskStatus::Review {
            return Err(format!(
                "任务状态为 {}，仅 review 可合并",
                task.status.as_str()
            ));
        }
        let work = task
            .work_branch
            .clone()
            .ok_or_else(|| "任务没有 work 分支，无法合并（可直接完成）".to_string())?;
        let base = task
            .base_branch
            .clone()
            .ok_or_else(|| "任务没有基准分支，无法合并".to_string())?;
        let project_path = db::get_project_path(&conn, &task.project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "项目不存在".to_string())?;
        (project_path, base, work, task.title.clone())
    };

    // 单锁窗口内：base 前进校验 + 项目级合并互斥 + CAS review → merging。
    // CAS 本身只互斥任务自身；同项目第二个 review 任务可能同时进 merging，
    // 必须在同一锁段先检查 merging 计数 == 0（merge_gate_conn）。
    {
        let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        let task = db::get_task(&conn, task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != WorkTaskStatus::Review {
            return Err(format!(
                "任务状态为 {}，仅 review 可合并",
                task.status.as_str()
            ));
        }
        // base 前进保护：基线分支当前 HEAD 必须仍等于 review 时记录的 base_sha
        let current_base = git_ops::rev_parse(std::path::Path::new(&project_path), &base).ok();
        verify_base_sha(task.base_sha.as_deref(), current_base.as_deref())?;
        merge_gate_conn(&mut conn, task_id)?;
    }

    let message = message
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("Merge work task: {title}"));

    let merge = tokio::task::spawn_blocking(move || {
        git_ops::merge_work_branch(std::path::Path::new(&project_path), &base, &work, &message)
    })
    .await
    .map_err(|error| format!("合并线程失败: {error}"));

    match merge {
        Ok(Ok(merge_commit)) => {
            let task = {
                let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
                let extras = StatusExtras {
                    merge_commit: Some(merge_commit.clone()),
                    completion_kind: Some(CompletionKind::Merged),
                    finished_at: Some(now_str()),
                    // base 引用已前进到 merge commit，记录新基线供后续校验
                    base_sha: Some(merge_commit.clone()),
                    ..Default::default()
                };
                set_status_cas(
                    &mut conn,
                    task_id,
                    WorkTaskStatus::Merging,
                    WorkTaskStatus::Done,
                    "merge_done",
                    Some(&format!("已合并 {merge_commit}")),
                    Some(extras),
                )?
            };
            // 清理 worktree 与 work 分支（失败不影响 done，仅记事件）
            cleanup_after_merge(daemon, task_id, &task.project_id);
            claim_and_launch(daemon, &task.project_id);
            Ok(task)
        }
        Ok(Err(MergeError::Conflict)) => {
            back_to_review(daemon, task_id, "合并冲突，需手动处理", "merge_conflict")?;
            Err("合并冲突，需手动处理".to_string())
        }
        Ok(Err(MergeError::Other(error))) => {
            let message = format!("合并失败: {error}");
            back_to_review(daemon, task_id, &message, "merge_failed")?;
            Err(message)
        }
        Err(error) => {
            let message = format!("合并失败: {error}");
            back_to_review(daemon, task_id, &message, "merge_failed")?;
            Err(message)
        }
    }
}

/// base 前进保护：review 时记录的 base_sha 必须仍等于基线分支当前 HEAD。
/// 旧数据无 base_sha（None）跳过校验；读取失败视为已前进，同样拒绝合并。
fn verify_base_sha(stored: Option<&str>, current: Option<&str>) -> Result<(), String> {
    let Some(stored) = stored.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    match current.map(str::trim) {
        Some(current) if current == stored => Ok(()),
        _ => Err("基线分支已前进，请重新开始或手动处理".to_string()),
    }
}

fn back_to_review(
    daemon: &DaemonState,
    task_id: &str,
    message: &str,
    event_kind: &str,
) -> Result<(), String> {
    let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
    let extras = StatusExtras {
        last_error: Some(message.to_string()),
        ..Default::default()
    };
    db::set_status_cas(
        &mut conn,
        task_id,
        WorkTaskStatus::Merging,
        WorkTaskStatus::Review,
        event_kind,
        Some(message),
        Some(extras),
    )
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "合并状态流转失败".to_string())?;
    Ok(())
}

/// 锁内合并入口（可测的纯 conn 层）：review 态、项目 merging 计数 == 0 时
/// CAS review → merging。base_sha 校验由调用方在同一锁窗口完成。
pub fn merge_gate_conn(conn: &mut Connection, task_id: &str) -> Result<WorkTask, String> {
    let task = db::get_task(conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;
    if task.status != WorkTaskStatus::Review {
        return Err(format!(
            "任务状态为 {}，仅 review 可合并",
            task.status.as_str()
        ));
    }
    let merging = db::count_project_merging(conn, &task.project_id).map_err(|e| e.to_string())?;
    if merging > 0 {
        return Err("项目已有任务在合并中，请稍后再试".to_string());
    }
    set_status_cas(
        conn,
        task_id,
        WorkTaskStatus::Review,
        WorkTaskStatus::Merging,
        "merge_start",
        Some("开始合并 work 分支"),
        None,
    )
}

fn cleanup_after_merge(daemon: &DaemonState, task_id: &str, project_id: &str) {
    let (project_path, worktree_path, work_branch) = {
        let Ok(conn) = daemon.app.db.lock() else {
            return;
        };
        let Some(task) = db::get_task(&conn, task_id).ok().flatten() else {
            return;
        };
        match (
            db::get_project_path(&conn, project_id).ok().flatten(),
            task.worktree_path,
            task.work_branch,
        ) {
            (Some(path), Some(worktree), Some(branch)) => (path, worktree, branch),
            _ => return,
        }
    };
    let result = tokio::task::block_in_place(|| {
        git_ops::cleanup_worktree_and_branch(
            std::path::Path::new(&project_path),
            &worktree_path,
            &work_branch,
        )
    });
    if let Err(error) = result {
        warn!(target: "work_tasks", "work task {task_id} cleanup failed: {error}");
        if let Ok(conn) = daemon.app.db.lock() {
            let _ = db::insert_event(&conn, task_id, "cleanup_failed", Some(&error));
        }
    }
}

/// complete：review → done（completion_kind=completed_without_merge）后自动领取。
pub async fn complete_work_task(daemon: &DaemonState, task_id: &str) -> Result<WorkTask, String> {
    let task = {
        let mut conn = daemon.app.db.lock().map_err(|e| e.to_string())?;
        let extras = StatusExtras {
            completion_kind: Some(CompletionKind::CompletedWithoutMerge),
            finished_at: Some(now_str()),
            ..Default::default()
        };
        set_status_cas(
            &mut conn,
            task_id,
            WorkTaskStatus::Review,
            WorkTaskStatus::Done,
            "complete",
            Some("未合并直接完成"),
            Some(extras),
        )?
    };
    claim_and_launch(daemon, &task.project_id);
    Ok(task)
}

// ---------------------------------------------------------------------------
// 中断对账 + tick 自动领取
// ---------------------------------------------------------------------------

/// daemon 重启后没有活跃轮：把 preparing/running/awaiting_input 的任务标
/// failed(interrupted)。返回受影响任务 id 列表。
pub fn reconcile_interrupted_tasks(conn: &mut Connection) -> Vec<String> {
    let live: Vec<String> = {
        let mut stmt = match conn.prepare(
            "SELECT id FROM work_tasks WHERE status IN ('preparing', 'running', 'awaiting_input')",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |row| row.get::<_, String>(0));
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => return Vec::new(),
        }
    };
    let mut updated = Vec::new();
    for task_id in live {
        let extras = StatusExtras {
            failure_reason: Some(FailureReason::Interrupted),
            last_error: Some("守护进程重启，执行中断".to_string()),
            ..Default::default()
        };
        if cas_first(
            conn,
            &task_id,
            &[
                WorkTaskStatus::Preparing,
                WorkTaskStatus::Running,
                WorkTaskStatus::AwaitingInput,
            ],
            WorkTaskStatus::Failed,
            "interrupted",
            Some("守护进程重启，执行中断"),
            Some(extras),
        )
        .is_some()
        {
            updated.push(task_id);
        }
    }
    updated
}

static INTERRUPTED_RECONCILED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// work_tasks 的 30s tick：daemon 启动后首 tick 做中断对账，之后每次扫描
/// 有 queued 任务的项目并自动领取（容量允许时）。
pub async fn tick(daemon: &DaemonState) {
    use std::sync::atomic::Ordering;
    let mut changed = false;

    if !INTERRUPTED_RECONCILED.swap(true, Ordering::SeqCst) {
        let interrupted = {
            let mut conn = match daemon.app.db.lock() {
                Ok(conn) => conn,
                Err(_) => return,
            };
            reconcile_interrupted_tasks(&mut conn)
        };
        if !interrupted.is_empty() {
            info!(target: "work_tasks", "reconciled interrupted work tasks: {:?}", interrupted);
            changed = true;
        }
    }

    let projects = {
        let conn = match daemon.app.db.lock() {
            Ok(conn) => conn,
            Err(_) => return,
        };
        db::list_queued_project_ids(&conn).unwrap_or_default()
    };
    for project_id in projects {
        if claim_and_launch(daemon, &project_id).is_some() {
            changed = true;
        }
    }

    if changed {
        super::emit_work_tasks_changed(daemon, "tick");
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::json;

    use super::super::db;
    use super::super::types::{FailureReason, WorkTaskInput};
    use super::*;
    use crate::config::types::AgentKind;
    use crate::db::schema;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::initialize_database(&conn).unwrap();
        conn
    }

    fn insert_project(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (?1, ?2, '/tmp/proj', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![id, id],
        )
        .unwrap();
    }

    fn input(project_id: &str) -> WorkTaskInput {
        WorkTaskInput {
            title: "实现登录页".to_string(),
            instruction: "按设计稿实现登录页".to_string(),
            project_id: project_id.to_string(),
            agent_kind: AgentKind::Codex,
            provider_id: None,
            model: Some("gpt-5".to_string()),
            use_worktree: false,
            base_branch: None,
        }
    }

    fn task_at_status(
        conn: &mut Connection,
        project_id: &str,
        session_id: Option<&str>,
        status: WorkTaskStatus,
    ) -> super::super::types::WorkTask {
        let created = super::super::service::create_work_task(conn, &input(project_id)).unwrap();
        super::super::service::set_status_cas(
            conn,
            &created.id,
            WorkTaskStatus::Todo,
            WorkTaskStatus::Queued,
            "start",
            None,
            None,
        )
        .unwrap();
        let extras = StatusExtras {
            session_id: session_id.map(str::to_string),
            ..Default::default()
        };
        super::super::service::set_status_cas(
            conn,
            &created.id,
            WorkTaskStatus::Queued,
            WorkTaskStatus::Preparing,
            "claim",
            None,
            Some(extras),
        )
        .unwrap();
        super::super::service::set_status_cas(
            conn,
            &created.id,
            WorkTaskStatus::Preparing,
            status,
            "test_setup",
            None,
            None,
        )
        .unwrap()
    }

    #[test]
    fn claim_decision_picks_oldest_queued_and_respects_limit() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");

        // 无 queued → None
        assert!(claim_decision(&conn, "p1", 1).is_none());

        let a = super::super::service::create_work_task(&conn, &input("p1")).unwrap();
        let b = super::super::service::create_work_task(&conn, &input("p1")).unwrap();
        for id in [&a.id, &b.id] {
            super::super::service::set_status_cas(
                &mut conn,
                id,
                WorkTaskStatus::Todo,
                WorkTaskStatus::Queued,
                "start",
                None,
                None,
            )
            .unwrap();
        }

        // 最老 sort_order 优先
        assert_eq!(
            claim_decision(&conn, "p1", 1).as_deref(),
            Some(a.id.as_str())
        );

        // 占坑满 → None
        super::super::service::set_status_cas(
            &mut conn,
            &a.id,
            WorkTaskStatus::Queued,
            WorkTaskStatus::Running,
            "claim",
            None,
            None,
        )
        .unwrap();
        assert!(claim_decision(&conn, "p1", 1).is_none());
        // 上限提高后 b 可领取
        assert_eq!(
            claim_decision(&conn, "p1", 2).as_deref(),
            Some(b.id.as_str())
        );
    }

    #[test]
    fn cas_chain_and_illegal_transitions_rejected() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = task_at_status(&mut conn, "p1", None, WorkTaskStatus::Queued);

        // 非法 CAS：期望态与实际不符（实际 queued，期望 preparing）被拒且不落事件
        let err = super::super::service::set_status_cas(
            &mut conn,
            &task.id,
            WorkTaskStatus::Preparing,
            WorkTaskStatus::Done,
            "illegal",
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("状态流转失败"), "{err}");
        assert_eq!(
            db::get_task(&conn, &task.id).unwrap().unwrap().status,
            WorkTaskStatus::Queued
        );

        // 全链：queued→preparing→running→awaiting_input→review→done
        for (from, to, kind) in [
            (WorkTaskStatus::Queued, WorkTaskStatus::Preparing, "claim"),
            (
                WorkTaskStatus::Preparing,
                WorkTaskStatus::Running,
                "running",
            ),
            (
                WorkTaskStatus::Running,
                WorkTaskStatus::AwaitingInput,
                "awaiting_input",
            ),
            (
                WorkTaskStatus::AwaitingInput,
                WorkTaskStatus::Review,
                "turn_finished",
            ),
            (WorkTaskStatus::Review, WorkTaskStatus::Done, "complete"),
        ] {
            let migrated = super::super::service::set_status_cas(
                &mut conn, &task.id, from, to, kind, None, None,
            )
            .unwrap();
            assert_eq!(migrated.status, to);
        }
        assert_eq!(
            db::get_task(&conn, &task.id).unwrap().unwrap().status,
            WorkTaskStatus::Done
        );
    }

    #[test]
    fn session_events_drive_lifecycle_writeback() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = task_at_status(&mut conn, "p1", Some("sess-1"), WorkTaskStatus::Running);

        // user_input_requested → awaiting_input
        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-1",
            &json!({"type": "user_input_requested"}),
        )
        .unwrap();
        assert!(outcome.changed);
        assert_eq!(
            db::get_task(&conn, &task.id).unwrap().unwrap().status,
            WorkTaskStatus::AwaitingInput
        );

        // 幂等：已 awaiting_input 再喂相同事件 → 无变化
        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-1",
            &json!({"type": "user_input_requested"}),
        )
        .unwrap();
        assert!(!outcome.changed);

        // turn_finished → review + settled_at + summary
        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-1",
            &json!({"type": "turn_finished", "summary": "完成了登录页"}),
        )
        .unwrap();
        assert!(outcome.changed);
        let settled = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(settled.status, WorkTaskStatus::Review);
        assert!(settled.settled_at.is_some());
        assert_eq!(settled.result_summary.as_deref(), Some("完成了登录页"));

        // review 态不再监听活跃事件
        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-1",
            &json!({"type": "error", "error": "boom"}),
        )
        .unwrap();
        assert!(!outcome.changed);
    }

    #[test]
    fn session_error_event_fails_running_task() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = task_at_status(&mut conn, "p1", Some("sess-2"), WorkTaskStatus::Running);

        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-2",
            &json!({"type": "error", "error": "API 401"}),
        )
        .unwrap();
        assert!(outcome.changed);
        let failed = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(failed.status, WorkTaskStatus::Failed);
        assert_eq!(failed.failure_reason, Some(FailureReason::AgentError));
        assert_eq!(failed.last_error.as_deref(), Some("API 401"));
    }

    #[test]
    fn session_event_generation_guard_ignores_other_sessions() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = task_at_status(&mut conn, "p1", Some("sess-a"), WorkTaskStatus::Running);

        // session_id 不匹配 → 状态不变、无事件
        let outcome =
            handle_session_event_conn(&mut conn, "sess-b", &json!({"type": "turn_finished"}))
                .unwrap();
        assert!(!outcome.changed);
        let events = db::list_events(&conn, &task.id).unwrap();
        assert!(events.iter().all(|event| event.kind != "turn_finished"));

        // 任务已取消（非活跃态）→ 事件被忽略
        super::super::service::set_status_cas(
            &mut conn,
            &task.id,
            WorkTaskStatus::Running,
            WorkTaskStatus::Canceled,
            "cancel",
            None,
            None,
        )
        .unwrap();
        let outcome =
            handle_session_event_conn(&mut conn, "sess-a", &json!({"type": "turn_finished"}))
                .unwrap();
        assert!(!outcome.changed);
    }

    #[test]
    fn reconcile_interrupted_marks_live_tasks_failed() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let preparing = task_at_status(&mut conn, "p1", Some("s1"), WorkTaskStatus::Preparing);
        let running = task_at_status(&mut conn, "p1", Some("s2"), WorkTaskStatus::Running);
        let awaiting = task_at_status(&mut conn, "p1", Some("s3"), WorkTaskStatus::AwaitingInput);

        let updated = reconcile_interrupted_tasks(&mut conn);
        assert_eq!(updated.len(), 3);
        for id in [&preparing.id, &running.id, &awaiting.id] {
            let task = db::get_task(&conn, id).unwrap().unwrap();
            assert_eq!(task.status, WorkTaskStatus::Failed);
            assert_eq!(task.failure_reason, Some(FailureReason::Interrupted));
        }
        // 幂等
        assert!(reconcile_interrupted_tasks(&mut conn).is_empty());
    }

    #[test]
    fn diff_request_only_when_work_branch_present() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        // use_worktree=false（无 work_branch）→ turn_finished 不带 diff 请求
        task_at_status(&mut conn, "p1", Some("s1"), WorkTaskStatus::Running);
        let outcome =
            handle_session_event_conn(&mut conn, "s1", &json!({"type": "turn_finished"})).unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.diff, None);
    }
    #[test]
    fn start_claims_task_immediately_and_respects_capacity() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let a = super::super::service::create_work_task(&conn, &input("p1")).unwrap();
        let b = super::super::service::create_work_task(&conn, &input("p1")).unwrap();
        for id in [&a.id, &b.id] {
            super::super::service::set_status_cas(
                &mut conn,
                id,
                WorkTaskStatus::Todo,
                WorkTaskStatus::Queued,
                "start",
                None,
                None,
            )
            .unwrap();
        }

        // start 路径：领取「该任务本身」queued→preparing（点开始即发）
        let claimed = claim_specific_conn(&mut conn, &a.id, 1).unwrap();
        assert_eq!(claimed.id, a.id);
        assert_eq!(claimed.status, WorkTaskStatus::Preparing);

        // 顺序模拟并发：a 已占满 1 坑（preparing 占坑），第二个任务的 claim 返回 None
        assert!(claim_specific_conn(&mut conn, &b.id, 1).is_none());
        let b_after = db::get_task(&conn, &b.id).unwrap().unwrap();
        assert_eq!(b_after.status, WorkTaskStatus::Queued);

        // 非 queued（todo）任务不可被 claim_specific 领取
        let c = super::super::service::create_work_task(&conn, &input("p1")).unwrap();
        assert!(claim_specific_conn(&mut conn, &c.id, 2).is_none());
    }

    #[test]
    fn claim_and_launch_single_lock_semaphore() {
        // 顺序模拟并发：先占满 1 坑，claim 第二个任务返回 None（TOCTOU 修复）
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let a = super::super::service::create_work_task(&conn, &input("p1")).unwrap();
        let b = super::super::service::create_work_task(&conn, &input("p1")).unwrap();
        super::super::service::set_status_cas(
            &mut conn,
            &a.id,
            WorkTaskStatus::Todo,
            WorkTaskStatus::Running,
            "start",
            None,
            None,
        )
        .unwrap();
        // b 仍 queued：容量已满 → claim_decision 返回 None（同锁段内不会 CAS 成功）
        assert!(claim_decision(&conn, "p1", 1).is_none());
        assert!(claim_specific_conn(&mut conn, &b.id, 1).is_none());
        assert_eq!(
            db::get_task(&conn, &b.id).unwrap().unwrap().status,
            WorkTaskStatus::Todo
        );
    }

    #[test]
    fn turn_finished_failed_outcome_fails_task() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = task_at_status(&mut conn, "p1", Some("sess-f"), WorkTaskStatus::Running);

        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-f",
            &json!({"type": "turn_finished", "outcome": "failed", "reason": "模型调用超时"}),
        )
        .unwrap();
        assert!(outcome.changed);
        assert!(outcome.diff.is_none());
        let failed = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(failed.status, WorkTaskStatus::Failed);
        assert_eq!(failed.failure_reason, Some(FailureReason::AgentError));
        assert_eq!(failed.last_error.as_deref(), Some("模型调用超时"));
        assert!(failed.finished_at.is_some());
    }

    #[test]
    fn turn_finished_interrupted_outcome_marks_interrupted() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = task_at_status(&mut conn, "p1", Some("sess-i"), WorkTaskStatus::Running);

        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-i",
            &json!({"type": "turn_finished", "outcome": "interrupted"}),
        )
        .unwrap();
        assert!(outcome.changed);
        let failed = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(failed.status, WorkTaskStatus::Failed);
        assert_eq!(failed.failure_reason, Some(FailureReason::Interrupted));
    }

    #[test]
    fn turn_finished_success_keeps_review_path() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = task_at_status(&mut conn, "p1", Some("sess-ok"), WorkTaskStatus::Running);

        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-ok",
            &json!({"type": "turn_finished", "outcome": "completed", "reason": "已实现登录页"}),
        )
        .unwrap();
        assert!(outcome.changed);
        let settled = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(settled.status, WorkTaskStatus::Review);
        assert_eq!(settled.result_summary.as_deref(), Some("已实现登录页"));
        assert!(settled.settled_at.is_some());
    }

    #[test]
    fn user_message_resumes_awaiting_input_task() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = task_at_status(
            &mut conn,
            "p1",
            Some("sess-u"),
            WorkTaskStatus::AwaitingInput,
        );

        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-u",
            &json!({"type": "user_message", "content": []}),
        )
        .unwrap();
        assert!(outcome.changed);
        let resumed = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(resumed.status, WorkTaskStatus::Running);

        // 幂等：已 running 的 user_message 不再变化
        let outcome = handle_session_event_conn(
            &mut conn,
            "sess-u",
            &json!({"type": "user_message", "content": []}),
        )
        .unwrap();
        assert!(!outcome.changed);
    }

    #[test]
    fn turn_finished_summary_falls_back_to_timeline_assistant_text() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        // 时间线行有 sessions 外键：先建真实会话，再让任务挂到该 session 上
        let session = crate::db::operations::create_scheduled_session_for_project(
            &conn,
            "登录页任务",
            crate::config::types::AgentKind::Codex,
            "agent",
            "p1",
            None,
            None,
            None,
        )
        .unwrap();
        let task = task_at_status(&mut conn, "p1", Some(&session.id), WorkTaskStatus::Running);

        // 持久化时间线：assistant 文本在 turn_finished 之前（sidecar 持久化先行）。
        // 直接落 session_event_snapshots（append_timeline_events 对未知 session
        // 有外键约束，这里只需要可读的事件行）。
        let timeline_events = [
            json!({"type": "user_message", "content": "开始"}),
            json!({"type": "assistant_message", "content": [
                {"type": "text", "text": "已按设计稿实现登录页"}
            ]}),
            json!({"type": "turn_finished", "outcome": "completed"}),
        ];
        for (sequence, event) in timeline_events.iter().enumerate() {
            conn.execute(
                "INSERT INTO session_event_snapshots \
                 (session_id, sequence, event_id, event_timestamp, event_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    &session.id,
                    sequence as i64,
                    format!("e{sequence}"),
                    Option::<String>::None,
                    serde_json::to_string(event).unwrap(),
                ],
            )
            .unwrap();
        }

        let outcome = handle_session_event_conn(
            &mut conn,
            &session.id,
            &json!({"type": "turn_finished", "outcome": "completed"}),
        )
        .unwrap();
        assert!(outcome.changed);
        let settled = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(
            settled.result_summary.as_deref(),
            Some("已按设计稿实现登录页")
        );
    }

    #[test]
    fn merge_gate_is_project_exclusive_and_verifies_base_sha() {
        // verify_base_sha：相等放行 / 不等拒绝 / 无记录跳过
        assert!(verify_base_sha(Some("abc"), Some("abc")).is_ok());
        let err = verify_base_sha(Some("abc"), Some("def")).unwrap_err();
        assert!(err.contains("基线分支已前进"), "{err}");
        assert!(verify_base_sha(Some("abc"), None).is_err());
        assert!(verify_base_sha(None, Some("abc")).is_ok());
        assert!(verify_base_sha(None, None).is_ok());

        // 项目级合并互斥：第一个任务进 merging 后，第二个 review 任务被拒
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let first = task_at_status(&mut conn, "p1", Some("s-merge1"), WorkTaskStatus::Review);
        let second = task_at_status(&mut conn, "p1", Some("s-merge2"), WorkTaskStatus::Review);

        let started = merge_gate_conn(&mut conn, &first.id).unwrap();
        assert_eq!(started.status, WorkTaskStatus::Merging);
        let err = merge_gate_conn(&mut conn, &second.id).unwrap_err();
        assert!(err.contains("合并中"), "{err}");
    }

    #[test]
    fn merge_gate_rejects_advanced_base() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = task_at_status(&mut conn, "p1", Some("s-merge2"), WorkTaskStatus::Review);
        db::set_base_sha(&conn, &task.id, "aaa111").unwrap();
        let stored = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(stored.base_sha.as_deref(), Some("aaa111"));

        // 当前基线 sha 与 review 时记录不一致 → 拒绝进入 merging
        let current = Some("bbb222".to_string());
        let err = verify_base_sha(stored.base_sha.as_deref(), current.as_deref()).unwrap_err();
        assert!(err.contains("基线分支已前进"), "{err}");
    }
}
