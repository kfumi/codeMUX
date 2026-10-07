//! 浏览器自动化审计：每次 execute 尝试记一笔。

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::Serialize;
/// 一条审计记录。
#[derive(Debug, Clone, Serialize)]
pub struct AutomationAuditEntry {
    pub id: i64,
    pub created_at: String,
    pub op: String,
    pub browser_id: Option<String>,
    pub session_id: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

/// 记一笔；失败吞掉（审计永远不挡执行）。
pub fn record_automation_audit(
    conn: &Connection,
    op: &str,
    browser_id: Option<&str>,
    session_id: Option<&str>,
    ok: bool,
    error: Option<&str>,
) {
    let _ = conn.execute(
        "INSERT INTO browser_automation_audit (created_at, op, browser_id, session_id, ok, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![Utc::now().to_rfc3339(), op, browser_id, session_id, if ok { 1 } else { 0 }, error],
    );
}

/// 最近 N 条（倒序）；limit 收敛到 1 到 200。
pub fn list_automation_audit(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<AutomationAuditEntry>, String> {
    let limit = limit.clamp(1, 200);
    let mut stmt = conn.prepare("SELECT id, created_at, op, browser_id, session_id, ok, error FROM browser_automation_audit ORDER BY id DESC LIMIT ?1").map_err(|e| format!("审计查询失败: {}", e))?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(AutomationAuditEntry {
                id: row.get(0)?,
                created_at: row.get(1)?,
                op: row.get(2)?,
                browser_id: row.get(3)?,
                session_id: row.get(4)?,
                ok: row.get::<_, i32>(5)? != 0,
                error: row.get(6)?,
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

    #[test]
    fn audit_roundtrip_keeps_order_and_fields() {
        let conn = memory_db();
        record_automation_audit(&conn, "snapshot", Some("b-1"), None, true, None);
        record_automation_audit(
            &conn,
            "click",
            Some("b-1"),
            None,
            false,
            Some("unknown elementId"),
        );
        let entries = list_automation_audit(&conn, 10).expect("列表");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].op, "click");
        assert!(!entries[0].ok);
        assert_eq!(entries[0].error.as_deref(), Some("unknown elementId"));
        assert_eq!(entries[1].op, "snapshot");
        assert!(entries[1].ok);
        assert_eq!(list_automation_audit(&conn, 1).expect("限1").len(), 1);
    }
}
