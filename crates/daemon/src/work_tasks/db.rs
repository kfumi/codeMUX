//! `work_tasks` / `work_task_events` 纯 SQL 访问层；不带业务守卫（见 service.rs）。

use std::str::FromStr;

use chrono::Utc;
use rusqlite::{params, Connection, Result};
use uuid::Uuid;

use crate::config::types::AgentKind;

use super::types::{
    CompletionKind, FailureReason, WorkTask, WorkTaskEvent, WorkTaskInput, WorkTaskPatch,
    WorkTaskStatus,
};

const TASK_SELECT: &str = "id, project_id, title, instruction, agent_kind, provider_id, model, \
     use_worktree, base_branch, worktree_path, work_branch, status, failure_reason, last_error, \
     run_seq, sort_order, session_id, result_summary, files_changed, additions, deletions, \
     merge_commit, completion_kind, archived_at, created_at, updated_at, started_at, settled_at, \
     finished_at, base_sha";

const EVENT_SELECT: &str = "id, task_id, kind, detail, created_at";

fn now_str() -> String {
    Utc::now().to_rfc3339()
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkTask> {
    let agent_kind =
        AgentKind::from_str(&row.get::<_, String>(4)?).unwrap_or(AgentKind::ClaudeCode);
    let status =
        WorkTaskStatus::from_str(&row.get::<_, String>(11)?).unwrap_or(WorkTaskStatus::Todo);
    let failure_reason = row
        .get::<_, Option<String>>(12)?
        .and_then(|value| FailureReason::from_str(&value));
    let completion_kind = row
        .get::<_, Option<String>>(22)?
        .and_then(|value| CompletionKind::from_str(&value));
    Ok(WorkTask {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        instruction: row.get(3)?,
        agent_kind,
        provider_id: row.get(5)?,
        model: row.get(6)?,
        use_worktree: row.get::<_, i64>(7)? != 0,
        base_branch: row.get(8)?,
        worktree_path: row.get(9)?,
        work_branch: row.get(10)?,
        status,
        failure_reason,
        last_error: row.get(13)?,
        run_seq: row.get(14)?,
        sort_order: row.get(15)?,
        session_id: row.get(16)?,
        result_summary: row.get(17)?,
        files_changed: row.get(18)?,
        additions: row.get(19)?,
        deletions: row.get(20)?,
        merge_commit: row.get(21)?,
        completion_kind,
        archived_at: row.get(23)?,
        created_at: row.get(24)?,
        updated_at: row.get(25)?,
        started_at: row.get(26)?,
        settled_at: row.get(27)?,
        finished_at: row.get(28)?,
        base_sha: row.get(29)?,
    })
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkTaskEvent> {
    Ok(WorkTaskEvent {
        id: row.get(0)?,
        task_id: row.get(1)?,
        kind: row.get(2)?,
        detail: row.get(3)?,
        created_at: row.get(4)?,
    })
}

pub fn project_exists(conn: &Connection, project_id: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM projects WHERE id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn insert_task(
    conn: &Connection,
    id: &str,
    input: &WorkTaskInput,
    sort_order: i64,
) -> Result<()> {
    let now = now_str();
    conn.execute(
        "INSERT INTO work_tasks (
            id, project_id, title, instruction, agent_kind, provider_id, model,
            use_worktree, base_branch, status, sort_order, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'todo', ?10, ?11, ?11)",
        params![
            id,
            input.project_id,
            input.title.trim(),
            input.instruction,
            input.agent_kind.as_str(),
            input.provider_id,
            input.model,
            input.use_worktree,
            input.base_branch,
            sort_order,
            now,
        ],
    )?;
    Ok(())
}

pub fn next_sort_order(conn: &Connection, project_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM work_tasks WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )
}

pub fn get_task(conn: &Connection, task_id: &str) -> Result<Option<WorkTask>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_SELECT} FROM work_tasks WHERE id = ?1"
    ))?;
    let mut rows = stmt.query_map(params![task_id], row_to_task)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn list_tasks(conn: &Connection) -> Result<Vec<WorkTask>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_SELECT} FROM work_tasks ORDER BY sort_order ASC, created_at ASC"
    ))?;
    let tasks = stmt
        .query_map([], row_to_task)?
        .collect::<Result<Vec<_>>>()?;
    Ok(tasks)
}

/// 仅更新编辑类列（动态 SET，只覆盖 patch 提供的字段）；
/// 调用方（service 层）负责状态守卫。返回受影响行数。
pub fn update_task_fields(
    conn: &Connection,
    task_id: &str,
    patch: &WorkTaskPatch,
) -> Result<usize> {
    use rusqlite::types::Value;

    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    let push = |column: &str, value: Value, sets: &mut Vec<String>, values: &mut Vec<Value>| {
        values.push(value);
        sets.push(format!("{column} = ?{}", values.len()));
    };

    if let Some(title) = &patch.title {
        push(
            "title",
            Value::Text(title.trim().to_string()),
            &mut sets,
            &mut values,
        );
    }
    if let Some(instruction) = &patch.instruction {
        push(
            "instruction",
            Value::Text(instruction.clone()),
            &mut sets,
            &mut values,
        );
    }
    if let Some(agent_kind) = &patch.agent_kind {
        push(
            "agent_kind",
            Value::Text(agent_kind.as_str().to_string()),
            &mut sets,
            &mut values,
        );
    }
    if let Some(provider_id) = &patch.provider_id {
        push(
            "provider_id",
            provider_id.clone().map(Value::Text).unwrap_or(Value::Null),
            &mut sets,
            &mut values,
        );
    }
    if let Some(model) = &patch.model {
        push(
            "model",
            model.clone().map(Value::Text).unwrap_or(Value::Null),
            &mut sets,
            &mut values,
        );
    }
    if let Some(use_worktree) = &patch.use_worktree {
        push(
            "use_worktree",
            Value::Integer(if *use_worktree { 1 } else { 0 }),
            &mut sets,
            &mut values,
        );
    }
    if let Some(base_branch) = &patch.base_branch {
        push(
            "base_branch",
            base_branch.clone().map(Value::Text).unwrap_or(Value::Null),
            &mut sets,
            &mut values,
        );
    }
    push("updated_at", Value::Text(now_str()), &mut sets, &mut values);

    values.push(Value::Text(task_id.to_string()));
    let id_marker = values.len();
    let sql = format!(
        "UPDATE work_tasks SET {} WHERE id = ?{id_marker}",
        sets.join(", ")
    );
    conn.execute(&sql, rusqlite::params_from_iter(values.iter()))
}

/// CAS 状态流转 + 同事务事件：`WHERE status = expected` 保证并发安全。
/// 返回 `Ok(Some(task))` 表示流转成功；`Ok(None)` 表示期望态不符（0 行更新）。
pub fn set_status_cas(
    conn: &mut Connection,
    task_id: &str,
    expected: WorkTaskStatus,
    next: WorkTaskStatus,
    event_kind: &str,
    event_detail: Option<&str>,
    extra: Option<StatusExtras>,
) -> Result<Option<WorkTask>> {
    let tx = conn.transaction()?;
    let now = now_str();
    let changed = if let Some(e) = &extra {
        let sql = "UPDATE work_tasks SET status = ?2, updated_at = ?3, \
             failure_reason = COALESCE(?4, failure_reason), last_error = COALESCE(?5, last_error), \
             session_id = COALESCE(?6, session_id), result_summary = COALESCE(?7, result_summary), \
             files_changed = COALESCE(?8, files_changed), additions = COALESCE(?9, additions), \
             deletions = COALESCE(?10, deletions), merge_commit = COALESCE(?11, merge_commit), \
             completion_kind = COALESCE(?12, completion_kind), \
             started_at = COALESCE(?13, started_at), settled_at = COALESCE(?14, settled_at), \
             finished_at = COALESCE(?15, finished_at), run_seq = COALESCE(?16, run_seq), \
             base_sha = COALESCE(?17, base_sha) \
             WHERE id = ?1 AND status = ?18";
        tx.execute(
            sql,
            params![
                task_id,
                next.as_str(),
                now,
                e.failure_reason.map(|r| r.as_str()),
                e.last_error,
                e.session_id,
                e.result_summary,
                e.files_changed,
                e.additions,
                e.deletions,
                e.merge_commit,
                e.completion_kind.map(|k| k.as_str()),
                e.started_at.as_deref(),
                e.settled_at.as_deref(),
                e.finished_at.as_deref(),
                e.run_seq,
                e.base_sha,
                expected.as_str(),
            ],
        )?
    } else {
        let sql = "UPDATE work_tasks SET status = ?2, updated_at = ?3, failure_reason = ?4, \
             last_error = ?5 WHERE id = ?1 AND status = ?6";
        tx.execute(
            sql,
            params![
                task_id,
                next.as_str(),
                now,
                Option::<String>::None,
                Option::<String>::None,
                expected.as_str(),
            ],
        )?
    };
    if changed == 0 {
        return Ok(None);
    }

    tx.execute(
        "INSERT INTO work_task_events (task_id, kind, detail, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![task_id, event_kind, event_detail, now],
    )?;
    tx.commit()?;

    get_task(conn, task_id)
}

#[derive(Debug, Default, Clone)]
pub struct StatusExtras {
    pub failure_reason: Option<FailureReason>,
    pub last_error: Option<String>,
    pub session_id: Option<String>,
    pub result_summary: Option<String>,
    pub files_changed: Option<i64>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub run_seq: Option<i64>,
    pub merge_commit: Option<String>,
    pub completion_kind: Option<CompletionKind>,
    pub started_at: Option<String>,
    pub settled_at: Option<String>,
    pub finished_at: Option<String>,
    pub base_sha: Option<String>,
}

/// 归档/取消归档：仅写 archived_at。
pub fn set_archived(conn: &Connection, task_id: &str, archived: bool) -> Result<usize> {
    let now = now_str();
    conn.execute(
        "UPDATE work_tasks SET archived_at = ?2, updated_at = ?3 WHERE id = ?1",
        params![
            task_id,
            if archived { Some(now.clone()) } else { None },
            now
        ],
    )
}

pub fn delete_task(conn: &Connection, task_id: &str) -> Result<()> {
    conn.execute("DELETE FROM work_tasks WHERE id = ?1", params![task_id])?;
    Ok(())
}

/// 事务内按 ids 顺序写 sort_order（0..n）；跳过不存在的 id。
pub fn reorder(conn: &Connection, project_id: &str, ids: &[String]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE work_tasks SET sort_order = ?3, updated_at = ?4 \
             WHERE id = ?1 AND project_id = ?2",
            params![id, project_id, index as i64, now_str()],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn insert_event(
    conn: &Connection,
    task_id: &str,
    kind: &str,
    detail: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO work_task_events (task_id, kind, detail, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![task_id, kind, detail, now_str()],
    )?;
    Ok(())
}

pub fn list_events(conn: &Connection, task_id: &str) -> Result<Vec<WorkTaskEvent>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {EVENT_SELECT} FROM work_task_events WHERE task_id = ?1 ORDER BY id ASC"
    ))?;
    let events = stmt
        .query_map(params![task_id], row_to_event)?
        .collect::<Result<Vec<_>>>()?;
    Ok(events)
}

/// 测试/调试辅助：生成任务 id（与 create 路径同源）。
pub fn new_task_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn get_project_path(conn: &Connection, project_id: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT path FROM projects WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![project_id], |row| row.get::<_, String>(0))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 按 session_id 找活跃任务（preparing/running/awaiting_input）。
/// session_id 相等即 generation 守卫：任务行只由启动方写入一次。
pub fn find_live_task_by_session(conn: &Connection, session_id: &str) -> Result<Option<WorkTask>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_SELECT} FROM work_tasks \
         WHERE session_id = ?1 AND status IN ('preparing', 'running', 'awaiting_input') \
         ORDER BY updated_at DESC LIMIT 1"
    ))?;
    let mut rows = stmt.query_map(params![session_id], row_to_task)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// worktree 创建成功后写回 worktree_path / work_branch / base_branch。
pub fn set_worktree_fields(
    conn: &Connection,
    task_id: &str,
    worktree_path: &str,
    work_branch: &str,
    base_branch: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE work_tasks SET worktree_path = ?2, work_branch = ?3, base_branch = ?4, \
         updated_at = ?5 WHERE id = ?1",
        params![task_id, worktree_path, work_branch, base_branch, now_str()],
    )?;
    Ok(())
}

/// 回写 diff 统计（turn_finished 后由外层补算）。
pub fn set_diff_stats(
    conn: &Connection,
    task_id: &str,
    files_changed: i64,
    additions: i64,
    deletions: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE work_tasks SET files_changed = ?2, additions = ?3, deletions = ?4, \
         updated_at = ?5 WHERE id = ?1",
        params![task_id, files_changed, additions, deletions, now_str()],
    )?;
    Ok(())
}

/// 记录 review 时的基线分支 HEAD（合并前的 base 前进保护）。
pub fn set_base_sha(conn: &Connection, task_id: &str, base_sha: &str) -> Result<()> {
    conn.execute(
        "UPDATE work_tasks SET base_sha = ?2, updated_at = ?3 WHERE id = ?1",
        params![task_id, base_sha, now_str()],
    )?;
    Ok(())
}

/// 项目内处于占坑状态（preparing/running/merging）的任务数。
pub fn count_project_busy(conn: &Connection, project_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM work_tasks \
         WHERE project_id = ?1 AND status IN ('preparing', 'running', 'merging')",
        params![project_id],
        |row| row.get(0),
    )
}

/// 项目内正在合并（merging）的任务数。
pub fn count_project_merging(conn: &Connection, project_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM work_tasks WHERE project_id = ?1 AND status = 'merging'",
        params![project_id],
        |row| row.get(0),
    )
}

/// 重启回 todo 时清空上一轮运行残留（结果摘要/diff 统计/合并信息/时间戳）。
pub fn clear_run_artifacts(conn: &Connection, task_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE work_tasks SET result_summary = NULL, files_changed = NULL, additions = NULL, \
         deletions = NULL, merge_commit = NULL, completion_kind = NULL, settled_at = NULL, \
         finished_at = NULL, updated_at = ?2 WHERE id = ?1",
        params![task_id, now_str()],
    )?;
    Ok(())
}

/// 重排到项目队列尾部（restart 后重新排队）。
pub fn set_sort_order_tail(conn: &Connection, task_id: &str, project_id: &str) -> Result<()> {
    let tail = next_sort_order(conn, project_id)?;
    conn.execute(
        "UPDATE work_tasks SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
        params![task_id, tail, now_str()],
    )?;
    Ok(())
}

/// 有 queued 任务的项目 id 列表（自动领取扫描用）。
pub fn list_queued_project_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT project_id FROM work_tasks WHERE status = 'queued'")?;
    let ids = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>>>()?;
    Ok(ids)
}
