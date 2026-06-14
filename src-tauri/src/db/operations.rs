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
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, message)),
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
    pub mode: Option<String>,
    pub project_id: Option<String>,
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
    let mut stmt = conn.prepare("SELECT id, name, path, created_at, updated_at FROM projects ORDER BY updated_at DESC")?;

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

pub fn create_session_with_mode(conn: &Connection, title: &str, agent_kind: AgentKind, mode: &str) -> Result<Session> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, title, agent_kind.as_str(), mode, now, now],
    )?;

    Ok(Session {
        id,
        title: title.to_string(),
        agent_kind,
        provider_id: None,
        model: None,
        mode: Some(mode.to_string()),
        project_id: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn create_session_for_project(conn: &Connection, title: &str, agent_kind: AgentKind, mode: &str, project_id: &str) -> Result<Session> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO sessions (id, title, agent_kind, mode, project_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, title, agent_kind.as_str(), mode, project_id, now, now],
    )?;

    Ok(Session {
        id,
        title: title.to_string(),
        agent_kind,
        provider_id: None,
        model: None,
        mode: Some(mode.to_string()),
        project_id: Some(project_id.to_string()),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn get_all_sessions(conn: &Connection) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare("SELECT id, title, agent_kind, provider_id, model, mode, project_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC")?;

    let sessions = stmt
        .query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                title: row.get(1)?,
                agent_kind: validate_agent_kind(&row.get::<_, String>(2)?)?,
                provider_id: row.get(3)?,
                model: row.get(4)?,
                mode: row.get(5)?,
                project_id: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(sessions)
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

pub fn update_session_provider(conn: &Connection, session_id: &str, provider_id: &str, model: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET provider_id = ?1, model = ?2, updated_at = ?3 WHERE id = ?4",
        params![provider_id, model, now, session_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{get_agent_session_mapping, get_all_sessions, upsert_agent_session_mapping};
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

        let created = upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-a").unwrap();
        assert_eq!(created.agent_session_id, "claude-a");

        let updated = upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-b").unwrap();
        assert_eq!(updated.agent_session_id, "claude-b");

        let loaded = get_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode)
            .unwrap()
            .expect("mapping should exist");
        assert_eq!(loaded.agent_session_id, "claude-b");
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
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-a").unwrap();

        conn.execute("DELETE FROM sessions WHERE id = ?1", ["session-1"]).unwrap();

        let loaded = get_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode).unwrap();
        assert!(loaded.is_none());
    }
}
