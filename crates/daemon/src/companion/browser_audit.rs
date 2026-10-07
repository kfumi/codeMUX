//! 电脑控制审计：每次自动化执行尝试与每次审批决策各记一笔。
//!
//! 表名沿用 02 票的 `browser_automation_audit`（已上线，改表名要数据迁移）；
//! 03/06 票在同一张表上补 `tool`/`actor`/`decision` 三列：谁、何时、哪个
//! 会话、什么动作、放行还是拦截。写审计永远吞错，不挡执行。

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::Serialize;

/// 一条审计记录。
#[derive(Debug, Clone, Serialize)]
pub struct AutomationAuditEntry {
    pub id: i64,
    pub created_at: String,
    pub op: String,
    pub tool: Option<String>,
    pub browser_id: Option<String>,
    pub session_id: Option<String>,
    pub actor: String,
    pub ok: bool,
    pub decision: Option<String>,
    pub error: Option<String>,
}

/// 待写入的一笔审计（字段多，用结构体而非长参数表）。
pub struct AuditRecord<'a> {
    pub op: &'a str,
    pub tool: Option<&'a str>,
    pub browser_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    /// 操作主体：本机为 `local`（回环 + Local Daemon Token 是唯一入口）。
    pub actor: &'a str,
    pub ok: bool,
    /// 审批决策：`allow-once`/`allow-session`/`reject`/`timeout`/`no-ui`。
    pub decision: Option<&'a str>,
    pub error: Option<&'a str>,
}

/// 记一笔；失败吞掉（审计永远不挡执行）。
pub fn record_audit(conn: &Connection, record: &AuditRecord<'_>) {
    let _ = conn.execute(
        "INSERT INTO browser_automation_audit (created_at, op, tool, browser_id, session_id, actor, ok, decision, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            Utc::now().to_rfc3339(),
            record.op,
            record.tool,
            record.browser_id,
            record.session_id,
            record.actor,
            if record.ok { 1 } else { 0 },
            record.decision,
            record.error,
        ],
    );
}

/// 最近 N 条（倒序）；limit 收敛到 1 到 200。
pub fn list_automation_audit(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<AutomationAuditEntry>, String> {
    let limit = limit.clamp(1, 200);
    let mut stmt = conn.prepare("SELECT id, created_at, op, tool, browser_id, session_id, actor, ok, decision, error FROM browser_automation_audit ORDER BY id DESC LIMIT ?1").map_err(|e| format!("审计查询失败: {}", e))?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(AutomationAuditEntry {
                id: row.get(0)?,
                created_at: row.get(1)?,
                op: row.get(2)?,
                tool: row.get(3)?,
                browser_id: row.get(4)?,
                session_id: row.get(5)?,
                actor: row.get(6)?,
                ok: row.get::<_, i32>(7)? != 0,
                decision: row.get(8)?,
                error: row.get(9)?,
            })
        })
        .map_err(|e| format!("审计查询失败: {}", e))?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| format!("审计行解析失败: {}", e))?);
    }
    Ok(entries)
}

/// 会话级的最近动作（工单 03：审批与执行都按会话可查）。
pub fn list_session_audit(
    conn: &Connection,
    session_id: &str,
    limit: i64,
) -> Result<Vec<AutomationAuditEntry>, String> {
    let limit = limit.clamp(1, 200);
    let mut stmt = conn.prepare("SELECT id, created_at, op, tool, browser_id, session_id, actor, ok, decision, error FROM browser_automation_audit WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2").map_err(|e| format!("审计查询失败: {}", e))?;
    let rows = stmt
        .query_map(params![session_id, limit], |row| {
            Ok(AutomationAuditEntry {
                id: row.get(0)?,
                created_at: row.get(1)?,
                op: row.get(2)?,
                tool: row.get(3)?,
                browser_id: row.get(4)?,
                session_id: row.get(5)?,
                actor: row.get(6)?,
                ok: row.get::<_, i32>(7)? != 0,
                decision: row.get(8)?,
                error: row.get(9)?,
            })
        })
        .map_err(|e| format!("审计查询失败: {}", e))?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| format!("审计行解析失败: {}", e))?);
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("内存库");
        crate::db::schema::initialize_database(&conn).expect("建表");
        conn
    }

    fn record<'a>(op: &'a str, ok: bool, decision: Option<&'a str>) -> AuditRecord<'a> {
        AuditRecord {
            op,
            tool: Some("browser_snapshot"),
            browser_id: Some("b-1"),
            session_id: Some("session-1"),
            actor: "local",
            ok,
            decision,
            error: None,
        }
    }

    #[test]
    fn audit_roundtrip_keeps_order_and_fields() {
        let conn = memory_db();
        record_audit(&conn, &record("snapshot", true, None));
        let mut failed = record("click", false, Some("reject"));
        failed.error = Some("用户拦截");
        record_audit(&conn, &failed);

        let entries = list_automation_audit(&conn, 10).expect("列表");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].op, "click");
        assert!(!entries[0].ok);
        assert_eq!(entries[0].decision.as_deref(), Some("reject"));
        assert_eq!(entries[0].error.as_deref(), Some("用户拦截"));
        assert_eq!(entries[0].actor, "local");
        assert_eq!(entries[1].op, "snapshot");
        assert_eq!(entries[1].tool.as_deref(), Some("browser_snapshot"));
        assert!(entries[1].ok);
        assert_eq!(list_automation_audit(&conn, 1).expect("限1").len(), 1);
    }

    #[test]
    fn session_audit_filters_by_session() {
        let conn = memory_db();
        record_audit(&conn, &record("snapshot", true, None));
        let mut other = record("click", true, Some("allow-once"));
        other.session_id = Some("session-2");
        record_audit(&conn, &other);

        let entries = list_session_audit(&conn, "session-1", 10).expect("列表");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].op, "snapshot");
        assert!(list_session_audit(&conn, "session-3", 10)
            .expect("列表")
            .is_empty());
    }
}
