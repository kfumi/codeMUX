//! 工作任务业务层：校验、状态守卫、CAS 流转。所有函数以 `&Connection` 为界，
//! 路由层负责持锁与事件广播。

use rusqlite::Connection;

use super::db;
use super::types::{WorkTask, WorkTaskInput, WorkTaskPatch, WorkTaskStatus};

/// 仅 todo/failed 可编辑。
fn assert_editable(task: &WorkTask) -> Result<(), String> {
    if matches!(task.status, WorkTaskStatus::Todo | WorkTaskStatus::Failed) {
        Ok(())
    } else {
        Err(format!(
            "任务状态为 {}，仅 todo/failed 可编辑",
            task.status.as_str()
        ))
    }
}

/// 仅 todo/done/canceled 可删除（todo 尚未开始，可直接删除）。
fn assert_deletable(task: &WorkTask) -> Result<(), String> {
    if matches!(
        task.status,
        WorkTaskStatus::Todo | WorkTaskStatus::Done | WorkTaskStatus::Canceled
    ) {
        Ok(())
    } else {
        Err(format!(
            "任务状态为 {}，仅 todo/done/canceled 可删除",
            task.status.as_str()
        ))
    }
}

pub fn create_work_task(conn: &Connection, input: &WorkTaskInput) -> Result<WorkTask, String> {
    if input.title.trim().is_empty() {
        return Err("任务标题不能为空".to_string());
    }
    if input.instruction.trim().is_empty() {
        return Err("任务指令不能为空".to_string());
    }
    if !db::project_exists(conn, &input.project_id).map_err(|e| e.to_string())? {
        return Err("项目不存在".to_string());
    }

    let sort_order = db::next_sort_order(conn, &input.project_id).map_err(|e| e.to_string())?;
    let id = db::new_task_id();
    db::insert_task(conn, &id, input, sort_order).map_err(|e| e.to_string())?;
    db::insert_event(conn, &id, "created", Some("任务已创建")).map_err(|e| e.to_string())?;

    db::get_task(conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务创建后读取失败".to_string())
}

pub fn update_work_task(
    conn: &Connection,
    task_id: &str,
    patch: &WorkTaskPatch,
) -> Result<WorkTask, String> {
    let existing = db::get_task(conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;
    assert_editable(&existing)?;

    if let Some(title) = &patch.title {
        if title.trim().is_empty() {
            return Err("任务标题不能为空".to_string());
        }
    }
    if let Some(instruction) = &patch.instruction {
        if instruction.trim().is_empty() {
            return Err("任务指令不能为空".to_string());
        }
    }

    let changed = db::update_task_fields(conn, task_id, patch).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("任务不存在".to_string());
    }
    db::insert_event(conn, task_id, "updated", None).map_err(|e| e.to_string())?;

    db::get_task(conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())
}

pub fn delete_work_task(conn: &Connection, task_id: &str) -> Result<(), String> {
    let existing = db::get_task(conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;
    assert_deletable(&existing)?;
    db::delete_task(conn, task_id).map_err(|e| e.to_string())
}

pub fn archive_work_task(
    conn: &Connection,
    task_id: &str,
    archived: bool,
) -> Result<WorkTask, String> {
    db::get_task(conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;
    db::set_archived(conn, task_id, archived).map_err(|e| e.to_string())?;
    db::insert_event(
        conn,
        task_id,
        if archived { "archived" } else { "unarchived" },
        None,
    )
    .map_err(|e| e.to_string())?;
    db::get_task(conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())
}

pub fn reorder_work_tasks(
    conn: &Connection,
    project_id: &str,
    ids: &[String],
) -> Result<(), String> {
    if !db::project_exists(conn, project_id).map_err(|e| e.to_string())? {
        return Err("项目不存在".to_string());
    }
    db::reorder(conn, project_id, ids).map_err(|e| e.to_string())
}

/// 通用 CAS 流转：期望态不符返回 Err（同时保证 0 行更新、无事件落库）。
pub fn set_status_cas(
    conn: &mut Connection,
    task_id: &str,
    expected: WorkTaskStatus,
    next: WorkTaskStatus,
    event_kind: &str,
    event_detail: Option<&str>,
    extra: Option<db::StatusExtras>,
) -> Result<WorkTask, String> {
    db::set_status_cas(
        conn,
        task_id,
        expected,
        next,
        event_kind,
        event_detail,
        extra,
    )
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("状态流转失败：期望 {}，实际状态不符", expected.as_str()))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::super::db;
    use super::super::types::{WorkTaskInput, WorkTaskPatch, WorkTaskStatus};
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
            use_worktree: true,
            base_branch: Some("main".to_string()),
        }
    }

    #[test]
    fn create_defaults_to_todo_and_increments_sort_order() {
        let conn = test_conn();
        insert_project(&conn, "p1");

        let t1 = create_work_task(&conn, &input("p1")).unwrap();
        let t2 = create_work_task(&conn, &input("p1")).unwrap();
        assert_eq!(t1.status, WorkTaskStatus::Todo);
        assert_eq!(t2.status, WorkTaskStatus::Todo);
        assert_eq!(t1.sort_order, 0);
        assert_eq!(t2.sort_order, 1);
        assert!(t1.use_worktree);
        assert_eq!(t1.base_branch.as_deref(), Some("main"));
        assert_eq!(t1.agent_kind, AgentKind::Codex);
        assert_eq!(t1.model.as_deref(), Some("gpt-5"));

        // 事件落库
        let events = db::list_events(&conn, &t1.id).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "created");

        // 校验失败路径
        assert!(create_work_task(&conn, &input("missing")).is_err());
        let mut bad = input("p1");
        bad.title = "  ".to_string();
        assert!(create_work_task(&conn, &bad).is_err());
        let mut bad2 = input("p1");
        bad2.instruction = String::new();
        assert!(create_work_task(&conn, &bad2).is_err());
    }

    #[test]
    fn update_edit_guard_and_patch_semantics() {
        let conn = test_conn();
        insert_project(&conn, "p1");
        let task = create_work_task(&conn, &input("p1")).unwrap();

        let patch = WorkTaskPatch {
            title: Some("新标题".to_string()),
            instruction: None,
            agent_kind: Some(AgentKind::Pi),
            provider_id: Some(Some("openrouter".to_string())),
            model: Some(None),
            use_worktree: Some(false),
            base_branch: Some(None),
        };
        let updated = update_work_task(&conn, &task.id, &patch).unwrap();
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.agent_kind, AgentKind::Pi);
        assert_eq!(updated.provider_id.as_deref(), Some("openrouter"));
        assert_eq!(updated.model, None);
        assert!(!updated.use_worktree);
        assert_eq!(updated.base_branch, None);
        assert_eq!(updated.instruction, task.instruction, "未提供的字段不变");

        let mut guarded = test_conn();
        insert_project(&guarded, "p2");
        let t2 = create_work_task(&guarded, &input("p2")).unwrap();
        set_status_cas(
            &mut guarded,
            &t2.id,
            WorkTaskStatus::Todo,
            WorkTaskStatus::Running,
            "start",
            None,
            None,
        )
        .unwrap();
        let err = update_work_task(&guarded, &t2.id, &patch).unwrap_err();
        assert!(err.contains("仅 todo/failed 可编辑"), "{err}");
    }

    #[test]
    fn delete_guard_todo_allowed_running_rejected_done_allowed() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let todo = create_work_task(&conn, &input("p1")).unwrap();
        let running = create_work_task(&conn, &input("p1")).unwrap();
        let done = create_work_task(&conn, &input("p1")).unwrap();

        // 待办尚未开始，可直接删除。
        delete_work_task(&conn, &todo.id).unwrap();
        assert!(db::get_task(&conn, &todo.id).unwrap().is_none());

        set_status_cas(
            &mut conn,
            &running.id,
            WorkTaskStatus::Todo,
            WorkTaskStatus::Running,
            "start",
            None,
            None,
        )
        .unwrap();
        assert!(delete_work_task(&conn, &running.id).is_err());

        set_status_cas(
            &mut conn,
            &done.id,
            WorkTaskStatus::Todo,
            WorkTaskStatus::Done,
            "complete",
            None,
            None,
        )
        .unwrap();
        delete_work_task(&conn, &done.id).unwrap();
        assert!(db::get_task(&conn, &done.id).unwrap().is_none());
        // 级联删除事件
        assert!(db::list_events(&conn, &done.id).unwrap().is_empty());
    }

    #[test]
    fn cas_mismatch_updates_zero_rows_and_errors() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = create_work_task(&conn, &input("p1")).unwrap();

        // 期望 queued，实际 todo → 报错且状态不变
        let err = set_status_cas(
            &mut conn,
            &task.id,
            WorkTaskStatus::Queued,
            WorkTaskStatus::Running,
            "start",
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("状态流转失败"), "{err}");
        let after = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(after.status, WorkTaskStatus::Todo);
        // 只有 created 一条事件，CAS 失败未落事件
        assert_eq!(db::list_events(&conn, &task.id).unwrap().len(), 1);

        // 合法流转成功且事件落库（同事务）
        let migrated = set_status_cas(
            &mut conn,
            &task.id,
            WorkTaskStatus::Todo,
            WorkTaskStatus::Running,
            "start",
            Some("第 1 次运行"),
            None,
        )
        .unwrap();
        assert_eq!(migrated.status, WorkTaskStatus::Running);
        let events = db::list_events(&conn, &task.id).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].kind, "start");
        assert_eq!(events[1].detail.as_deref(), Some("第 1 次运行"));
    }

    #[test]
    fn cas_with_extras_writes_lifecycle_columns() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = create_work_task(&conn, &input("p1")).unwrap();

        let extras = db::StatusExtras {
            session_id: Some("sess-1".to_string()),
            started_at: Some("2026-01-01T00:00:00Z".to_string()),
            ..Default::default()
        };
        let running = set_status_cas(
            &mut conn,
            &task.id,
            WorkTaskStatus::Todo,
            WorkTaskStatus::Running,
            "start",
            None,
            Some(extras),
        )
        .unwrap();
        assert_eq!(running.session_id.as_deref(), Some("sess-1"));
        assert_eq!(running.started_at.as_deref(), Some("2026-01-01T00:00:00Z"));

        let fail_extras = db::StatusExtras {
            failure_reason: Some(super::super::types::FailureReason::AgentError),
            last_error: Some("boom".to_string()),
            finished_at: Some("2026-01-01T01:00:00Z".to_string()),
            ..Default::default()
        };
        let failed = set_status_cas(
            &mut conn,
            &task.id,
            WorkTaskStatus::Running,
            WorkTaskStatus::Failed,
            "fail",
            Some("boom"),
            Some(fail_extras),
        )
        .unwrap();
        assert_eq!(failed.status, WorkTaskStatus::Failed);
        assert_eq!(
            failed.failure_reason,
            Some(super::super::types::FailureReason::AgentError)
        );
        assert_eq!(failed.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn reorder_applies_ids_order() {
        let conn = test_conn();
        insert_project(&conn, "p1");
        let a = create_work_task(&conn, &input("p1")).unwrap();
        let b = create_work_task(&conn, &input("p1")).unwrap();
        let c = create_work_task(&conn, &input("p1")).unwrap();

        reorder_work_tasks(&conn, "p1", &[c.id.clone(), a.id.clone(), b.id.clone()]).unwrap();
        let listed = db::list_tasks(&conn).unwrap();
        let ids: Vec<&str> = listed.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec![c.id.as_str(), a.id.as_str(), b.id.as_str()]);
        assert_eq!(listed[0].sort_order, 0);
        assert_eq!(listed[1].sort_order, 1);
        assert_eq!(listed[2].sort_order, 2);

        // 不存在的项目
        assert!(reorder_work_tasks(&conn, "missing", std::slice::from_ref(&a.id)).is_err());
    }

    #[test]
    fn archive_unarchive_roundtrip() {
        let conn = test_conn();
        insert_project(&conn, "p1");
        let task = create_work_task(&conn, &input("p1")).unwrap();
        assert_eq!(task.archived_at, None);

        let archived = archive_work_task(&conn, &task.id, true).unwrap();
        assert!(archived.archived_at.is_some());
        let unarchived = archive_work_task(&conn, &task.id, false).unwrap();
        assert_eq!(unarchived.archived_at, None);

        assert!(archive_work_task(&conn, "missing", true).is_err());
    }

    #[test]
    fn status_serde_covers_full_vocabulary() {
        let expected = [
            ("todo", WorkTaskStatus::Todo),
            ("queued", WorkTaskStatus::Queued),
            ("preparing", WorkTaskStatus::Preparing),
            ("running", WorkTaskStatus::Running),
            ("awaiting_input", WorkTaskStatus::AwaitingInput),
            ("review", WorkTaskStatus::Review),
            ("merging", WorkTaskStatus::Merging),
            ("done", WorkTaskStatus::Done),
            ("failed", WorkTaskStatus::Failed),
            ("canceled", WorkTaskStatus::Canceled),
        ];
        assert_eq!(WorkTaskStatus::all().len(), expected.len());
        for (word, status) in expected {
            assert_eq!(status.as_str(), word);
            assert_eq!(WorkTaskStatus::from_str(word), Some(status));
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(word));
            let back: WorkTaskStatus = serde_json::from_value(json).unwrap();
            assert_eq!(back, status);
        }
        assert_eq!(WorkTaskStatus::from_str("unknown"), None);
    }
    #[test]
    fn base_sha_roundtrip_and_restart_clears_run_artifacts() {
        let mut conn = test_conn();
        insert_project(&conn, "p1");
        let task = create_work_task(&conn, &input("p1")).unwrap();

        // 走一遍完整运行：写入 result_summary/diff/merge/settled/finished/base_sha
        let extras = db::StatusExtras {
            result_summary: Some("第一轮摘要".to_string()),
            merge_commit: Some("abc123".to_string()),
            completion_kind: Some(super::super::types::CompletionKind::Merged),
            settled_at: Some("2026-01-01T00:00:00Z".to_string()),
            finished_at: Some("2026-01-01T01:00:00Z".to_string()),
            base_sha: Some("aaa111".to_string()),
            ..Default::default()
        };
        set_status_cas(
            &mut conn,
            &task.id,
            WorkTaskStatus::Todo,
            WorkTaskStatus::Done,
            "merge_done",
            None,
            Some(extras),
        )
        .unwrap();
        db::set_diff_stats(&conn, &task.id, 3, 10, 2).unwrap();
        let done = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert!(done.result_summary.is_some());
        assert!(done.files_changed.is_some());
        assert!(done.merge_commit.is_some());
        assert!(done.completion_kind.is_some());
        assert!(done.settled_at.is_some());
        assert!(done.finished_at.is_some());

        // restart 场景：清空上一轮运行残留
        db::clear_run_artifacts(&conn, &task.id).unwrap();
        let clean = db::get_task(&conn, &task.id).unwrap().unwrap();
        assert_eq!(clean.result_summary, None);
        assert_eq!(clean.files_changed, None);
        assert_eq!(clean.additions, None);
        assert_eq!(clean.deletions, None);
        assert_eq!(clean.merge_commit, None);
        assert_eq!(clean.completion_kind, None);
        assert_eq!(clean.settled_at, None);
        assert_eq!(clean.finished_at, None);
        // base_sha 不清（重跑 review 时会重新记录）
        assert_eq!(clean.base_sha.as_deref(), Some("aaa111"));
    }

    #[test]
    fn patch_json_null_semantics_clear_and_missing_keeps() {
        use serde_json::json;

        let conn = test_conn();
        insert_project(&conn, "p1");
        let task = create_work_task(&conn, &input("p1")).unwrap();
        assert_eq!(task.base_branch.as_deref(), Some("main"));

        // JSON null = 清空（前端可清空基线分支）
        let clear: WorkTaskPatch =
            serde_json::from_value(json!({"baseBranch": null, "model": null})).unwrap();
        assert_eq!(clear.base_branch, Some(None));
        assert_eq!(clear.model, Some(None));
        let updated = update_work_task(&conn, &task.id, &clear).unwrap();
        assert_eq!(updated.base_branch, None);
        assert_eq!(updated.model, None);

        // 字段缺失 = 不修改；有值 = 覆盖
        let patch: WorkTaskPatch = serde_json::from_value(json!({
            "title": "只改标题",
            "baseBranch": "develop",
        }))
        .unwrap();
        assert_eq!(patch.base_branch, Some(Some("develop".to_string())));
        assert_eq!(patch.provider_id, None, "缺失字段保持 None（不修改）");
        let updated = update_work_task(&conn, &task.id, &patch).unwrap();
        assert_eq!(updated.title, "只改标题");
        assert_eq!(updated.base_branch.as_deref(), Some("develop"));
        assert_eq!(updated.model, None, "上一轮清空不会被缺省字段复活");
    }
}
