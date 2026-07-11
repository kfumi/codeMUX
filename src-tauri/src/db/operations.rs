use chrono::Utc;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::types::AgentKind;
use std::str::FromStr;

fn validate_agent_kind(value: &str) -> Result<AgentKind> {
    AgentKind::from_str(value).map_err(|message| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub agent_kind: AgentKind,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub mode: Option<String>,
    pub permission_config: Option<String>,
    pub plan_mode: Option<String>,
    pub project_id: Option<String>,
    pub is_archived: bool,
    pub is_pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentSessionMapping {
    pub app_session_id: String,
    pub agent_kind: AgentKind,
    pub agent_session_id: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn create_project(conn: &Connection, name: &str, path: &str) -> Result<Project> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, path, now, now],
    )?;

    Ok(Project {
        id,
        name: name.to_string(),
        path: path.to_string(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn get_all_projects(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, path, created_at, updated_at FROM projects ORDER BY updated_at DESC",
    )?;

    let projects = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(projects)
}

pub fn delete_project(conn: &Connection, project_id: &str) -> Result<()> {
    // 先删除该项目下的所有会话（含已归档），外键 CASCADE 会清理 agent_session_mappings
    conn.execute(
        "DELETE FROM sessions WHERE project_id = ?1",
        params![project_id],
    )?;
    // 再删除项目本身
    conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
    Ok(())
}

pub fn rename_project(conn: &Connection, project_id: &str, name: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now, project_id],
    )?;
    Ok(())
}

pub fn create_session_with_mode_and_permissions(
    conn: &Connection,
    title: &str,
    agent_kind: AgentKind,
    mode: &str,
    permission_config: Option<&str>,
    plan_mode: Option<&str>,
) -> Result<Session> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let permission_config = permission_config.unwrap_or("");
    let plan_mode = plan_mode.unwrap_or("off");

    conn.execute(
        "INSERT INTO sessions (id, title, agent_kind, mode, permission_config, plan_mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, title, agent_kind.as_str(), mode, permission_config, plan_mode, now, now],
    )?;

    Ok(Session {
        id,
        title: title.to_string(),
        agent_kind,
        provider_id: None,
        model: None,
        reasoning_effort: Some("medium".to_string()),
        mode: Some(mode.to_string()),
        permission_config: Some(permission_config.to_string()),
        plan_mode: Some(plan_mode.to_string()),
        project_id: None,
        is_archived: false,
        is_pinned: false,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn create_session_for_project_with_permissions(
    conn: &Connection,
    title: &str,
    agent_kind: AgentKind,
    mode: &str,
    project_id: &str,
    permission_config: Option<&str>,
    plan_mode: Option<&str>,
) -> Result<Session> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let permission_config = permission_config.unwrap_or("");
    let plan_mode = plan_mode.unwrap_or("off");

    conn.execute(
        "INSERT INTO sessions (id, title, agent_kind, mode, project_id, permission_config, plan_mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, title, agent_kind.as_str(), mode, project_id, permission_config, plan_mode, now, now],
    )?;

    Ok(Session {
        id,
        title: title.to_string(),
        agent_kind,
        provider_id: None,
        model: None,
        reasoning_effort: Some("medium".to_string()),
        mode: Some(mode.to_string()),
        permission_config: Some(permission_config.to_string()),
        plan_mode: Some(plan_mode.to_string()),
        project_id: Some(project_id.to_string()),
        is_archived: false,
        is_pinned: false,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn get_all_sessions(conn: &Connection) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare("SELECT id, title, agent_kind, provider_id, model, reasoning_effort, mode, permission_config, plan_mode, project_id, is_archived, is_pinned, created_at, updated_at FROM sessions WHERE is_archived = 0 ORDER BY updated_at DESC")?;

    let sessions = stmt
        .query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                title: row.get(1)?,
                agent_kind: validate_agent_kind(&row.get::<_, String>(2)?)?,
                provider_id: row.get(3)?,
                model: row.get(4)?,
                reasoning_effort: row.get(5)?,
                mode: row.get(6)?,
                permission_config: row.get(7)?,
                plan_mode: row.get(8)?,
                project_id: row.get(9)?,
                is_archived: row.get::<_, i32>(10)? != 0,
                is_pinned: row.get::<_, i32>(11)? != 0,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(sessions)
}

pub fn get_all_archived_sessions(conn: &Connection) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare("SELECT id, title, agent_kind, provider_id, model, reasoning_effort, mode, permission_config, plan_mode, project_id, is_archived, is_pinned, created_at, updated_at FROM sessions WHERE is_archived = 1 ORDER BY updated_at DESC")?;

    let sessions = stmt
        .query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                title: row.get(1)?,
                agent_kind: validate_agent_kind(&row.get::<_, String>(2)?)?,
                provider_id: row.get(3)?,
                model: row.get(4)?,
                reasoning_effort: row.get(5)?,
                mode: row.get(6)?,
                permission_config: row.get(7)?,
                plan_mode: row.get(8)?,
                project_id: row.get(9)?,
                is_archived: row.get::<_, i32>(10)? != 0,
                is_pinned: row.get::<_, i32>(11)? != 0,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(sessions)
}

pub fn archive_session(conn: &Connection, session_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET is_archived = 1, updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    )?;
    Ok(())
}

pub fn unarchive_session(conn: &Connection, session_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET is_archived = 0, updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    )?;
    Ok(())
}

pub fn set_session_pinned(conn: &Connection, session_id: &str, pinned: bool) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET is_pinned = ?1 WHERE id = ?2",
        params![if pinned { 1 } else { 0 }, session_id],
    )?;
    Ok(())
}

pub fn upsert_agent_session_mapping(
    conn: &Connection,
    app_session_id: &str,
    agent_kind: AgentKind,
    agent_session_id: &str,
) -> Result<AgentSessionMapping> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "
        INSERT INTO agent_session_mappings (app_session_id, agent_kind, agent_session_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?4)
        ON CONFLICT(app_session_id, agent_kind) DO UPDATE SET
            agent_session_id = excluded.agent_session_id,
            updated_at = excluded.updated_at
        ",
        params![app_session_id, agent_kind.as_str(), agent_session_id, now],
    )?;

    Ok(get_agent_session_mapping(conn, app_session_id, agent_kind)?
        .expect("mapping should exist after upsert"))
}

pub fn get_agent_session_mapping(
    conn: &Connection,
    app_session_id: &str,
    agent_kind: AgentKind,
) -> Result<Option<AgentSessionMapping>> {
    let mut stmt = conn.prepare(
        "
        SELECT app_session_id, agent_kind, agent_session_id, created_at, updated_at
        FROM agent_session_mappings
        WHERE app_session_id = ?1 AND agent_kind = ?2
        LIMIT 1
        ",
    )?;

    let mut rows = stmt.query(params![app_session_id, agent_kind.as_str()])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };

    Ok(Some(AgentSessionMapping {
        app_session_id: row.get(0)?,
        agent_kind: validate_agent_kind(&row.get::<_, String>(1)?)?,
        agent_session_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    }))
}

pub fn delete_agent_session_mapping(
    conn: &Connection,
    app_session_id: &str,
    agent_kind: AgentKind,
) -> Result<()> {
    conn.execute(
        "DELETE FROM agent_session_mappings WHERE app_session_id = ?1 AND agent_kind = ?2",
        params![app_session_id, agent_kind.as_str()],
    )?;
    Ok(())
}

pub fn delete_session(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
    Ok(())
}

pub fn update_session_title(conn: &Connection, session_id: &str, title: &str) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET title = ?1 WHERE id = ?2",
        params![title, session_id],
    )?;
    Ok(())
}

pub fn touch_session(conn: &Connection, session_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    )?;
    Ok(())
}

pub fn update_session_provider(
    conn: &Connection,
    session_id: &str,
    provider_id: &str,
    model: &str,
    reasoning_effort: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET provider_id = ?1, model = ?2, reasoning_effort = COALESCE(?3, reasoning_effort, 'medium'), updated_at = ?4 WHERE id = ?5",
        params![provider_id, model, reasoning_effort, now, session_id],
    )?;
    Ok(())
}

pub fn update_session_permissions(
    conn: &Connection,
    session_id: &str,
    permission_config: Option<&str>,
    plan_mode: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET permission_config = COALESCE(?1, permission_config, ''), plan_mode = COALESCE(?2, plan_mode, 'off'), updated_at = ?3 WHERE id = ?4",
        params![permission_config, plan_mode, now, session_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        archive_session, delete_agent_session_mapping, get_agent_session_mapping,
        get_all_archived_sessions, get_all_sessions, set_session_pinned, unarchive_session,
        update_session_provider, upsert_agent_session_mapping,
    };
    use crate::config::types::AgentKind;
    use crate::db::schema::initialize_database;
    use rusqlite::Connection;

    #[test]
    fn rejects_invalid_agent_kind_when_loading_sessions() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Broken", "invalid_agent", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        let error = get_all_sessions(&conn).unwrap_err();

        assert!(error.to_string().contains("Unsupported agent kind"));
    }

    #[test]
    fn upserts_and_reads_agent_session_mappings() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Test", "claude_code", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        let created =
            upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-a")
                .unwrap();
        assert_eq!(created.agent_session_id, "claude-a");

        let updated =
            upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-b")
                .unwrap();
        assert_eq!(updated.agent_session_id, "claude-b");

        let loaded = get_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode)
            .unwrap()
            .expect("mapping should exist");
        assert_eq!(loaded.agent_session_id, "claude-b");
    }

    #[test]
    fn upserts_and_reads_opencode_agent_session_mapping() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-opencode", "OpenCode", "opencode", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        let mapping = upsert_agent_session_mapping(
            &conn,
            "session-opencode",
            AgentKind::Opencode,
            "opencode-session-1",
        )
        .unwrap();

        assert_eq!(mapping.agent_kind, AgentKind::Opencode);
        assert_eq!(mapping.agent_session_id, "opencode-session-1");
        assert_eq!(
            get_agent_session_mapping(&conn, "session-opencode", AgentKind::Opencode)
                .unwrap()
                .unwrap()
                .agent_session_id,
            "opencode-session-1"
        );
    }

    #[test]
    fn deletes_agent_session_mappings_when_session_is_deleted() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Test", "claude_code", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-a")
            .unwrap();

        conn.execute("DELETE FROM sessions WHERE id = ?1", ["session-1"])
            .unwrap();

        let loaded = get_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode).unwrap();
        assert!(loaded.is_none());
    }

    #[test]
    fn deletes_one_agent_session_mapping_for_rewind() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Test", "claude_code", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-a")
            .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::Codex, "codex-a").unwrap();

        delete_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode).unwrap();

        assert!(
            get_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            get_agent_session_mapping(&conn, "session-1", AgentKind::Codex)
                .unwrap()
                .expect("codex mapping should remain")
                .agent_session_id,
            "codex-a"
        );
    }

    #[test]
    fn updates_session_reasoning_effort_with_provider() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Test", "codex", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        update_session_provider(&conn, "session-1", "provider-1", "gpt-5", Some("high")).unwrap();

        let sessions = get_all_sessions(&conn).unwrap();
        assert_eq!(sessions[0].model.as_deref(), Some("gpt-5"));
        assert_eq!(sessions[0].reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn creates_session_with_permission_snapshot_and_plan_mode() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();

        let permission_config = r#"{"kind":"codex","sandboxMode":"workspace-write","approvalPolicy":"on-request","networkAccessEnabled":false}"#;
        let created = super::create_session_with_mode_and_permissions(
            &conn,
            "Permissioned",
            AgentKind::Codex,
            "agent",
            Some(permission_config),
            Some("on"),
        )
        .unwrap();

        assert_eq!(
            created.permission_config.as_deref(),
            Some(permission_config)
        );
        assert_eq!(created.plan_mode.as_deref(), Some("on"));

        let sessions = get_all_sessions(&conn).unwrap();
        assert_eq!(
            sessions[0].permission_config.as_deref(),
            Some(permission_config)
        );
        assert_eq!(sessions[0].plan_mode.as_deref(), Some("on"));
    }

    #[test]
    fn active_session_listing_excludes_archived_sessions() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "session-active",
                "Active",
                "codex",
                "agent",
                "2026-06-19T00:00:00Z",
                "2026-06-19T00:00:00Z"
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "session-archived",
                "Archived",
                "codex",
                "agent",
                "2026-06-18T00:00:00Z",
                "2026-06-18T00:00:00Z"
            ],
        )
        .unwrap();

        archive_session(&conn, "session-archived").unwrap();

        let active = get_all_sessions(&conn).unwrap();
        let archived = get_all_archived_sessions(&conn).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "session-active");
        assert!(!active[0].is_archived);
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, "session-archived");
        assert!(archived[0].is_archived);
    }

    #[test]
    fn set_session_pinned_marks_session_and_active_listing_returns_it() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "session-pinned",
                "Pinned",
                "codex",
                "agent",
                "2026-06-20T00:00:00Z",
                "2026-06-20T00:00:00Z"
            ],
        )
        .unwrap();

        set_session_pinned(&conn, "session-pinned", true).unwrap();

        let sessions = get_all_sessions(&conn).unwrap();
        assert_eq!(sessions[0].id, "session-pinned");
        assert!(sessions[0].is_pinned);
    }

    #[test]
    fn unarchive_session_returns_it_to_active_listing() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at, is_archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "session-archived",
                "Archived",
                "codex",
                "agent",
                "2026-06-18T00:00:00Z",
                "2026-06-18T00:00:00Z",
                1
            ],
        )
        .unwrap();

        unarchive_session(&conn, "session-archived").unwrap();

        let active = get_all_sessions(&conn).unwrap();
        let archived = get_all_archived_sessions(&conn).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "session-archived");
        assert!(!active[0].is_archived);
        assert!(archived.is_empty());
    }
}
