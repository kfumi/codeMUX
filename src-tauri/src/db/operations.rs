use chrono::Utc;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

const SESSION_LIST_SELECT: &str = "id, title, agent_kind, provider_id, model, reasoning_effort, mode, permission_config, plan_mode, project_id, origin, is_read_only, is_archived, is_pinned, created_at, updated_at, working_path, (SELECT parent_session_id FROM session_lineage WHERE child_session_id = sessions.id)";

fn map_session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
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
        origin: row.get(10)?,
        is_read_only: row.get::<_, i32>(11)? != 0,
        is_archived: row.get::<_, i32>(12)? != 0,
        is_pinned: row.get::<_, i32>(13)? != 0,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        working_path: row.get(16)?,
        parent_session_id: row.get(17)?,
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
    pub origin: String,
    pub is_read_only: bool,
    pub is_archived: bool,
    pub is_pinned: bool,
    pub working_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeSessionRef {
    pub agent_kind: AgentKind,
    pub agent_session_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentSessionMapping {
    pub app_session_id: String,
    pub agent_kind: AgentKind,
    pub agent_session_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImportedSessionSource {
    pub app_session_id: String,
    pub agent_kind: AgentKind,
    pub agent_session_id: String,
    pub source_locator: String,
    pub source_fingerprint: String,
    pub source_modified_at: Option<String>,
    pub cwd: Option<String>,
    pub snapshot_version: i32,
    pub imported_at: String,
}

pub struct ImportedSessionSnapshot {
    pub agent_kind: AgentKind,
    pub agent_session_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub project_id: Option<String>,
    pub source_locator: String,
    pub source_fingerprint: String,
    pub source_modified_at: Option<String>,
    pub cwd: Option<String>,
    pub events: Vec<Value>,
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
    model: Option<&str>,
) -> Result<Session> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let permission_config = permission_config.unwrap_or("");
    let plan_mode = plan_mode.unwrap_or("off");

    conn.execute(
        "INSERT INTO sessions (id, title, agent_kind, mode, model, permission_config, plan_mode, reasoning_effort, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'high', ?8, ?9)",
        params![id, title, agent_kind.as_str(), mode, model, permission_config, plan_mode, now, now],
    )?;

    Ok(Session {
        id,
        title: title.to_string(),
        agent_kind,
        provider_id: None,
        model: model.map(str::to_string),
        reasoning_effort: Some("high".to_string()),
        mode: Some(mode.to_string()),
        permission_config: Some(permission_config.to_string()),
        plan_mode: Some(plan_mode.to_string()),
        project_id: None,
        origin: "native".to_string(),
        is_read_only: false,
        is_archived: false,
        is_pinned: false,
        working_path: None,
        created_at: now.clone(),
        updated_at: now,
        parent_session_id: None,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn create_session_for_project_with_permissions(
    conn: &Connection,
    title: &str,
    agent_kind: AgentKind,
    mode: &str,
    project_id: &str,
    permission_config: Option<&str>,
    plan_mode: Option<&str>,
    model: Option<&str>,
) -> Result<Session> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let permission_config = permission_config.unwrap_or("");
    let plan_mode = plan_mode.unwrap_or("off");

    conn.execute(
        "INSERT INTO sessions (id, title, agent_kind, mode, project_id, model, permission_config, plan_mode, reasoning_effort, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'high', ?9, ?10)",
        params![id, title, agent_kind.as_str(), mode, project_id, model, permission_config, plan_mode, now, now],
    )?;

    Ok(Session {
        id,
        title: title.to_string(),
        agent_kind,
        provider_id: None,
        model: model.map(str::to_string),
        reasoning_effort: Some("high".to_string()),
        mode: Some(mode.to_string()),
        permission_config: Some(permission_config.to_string()),
        plan_mode: Some(plan_mode.to_string()),
        project_id: Some(project_id.to_string()),
        origin: "native".to_string(),
        is_read_only: false,
        is_archived: false,
        is_pinned: false,
        working_path: None,
        created_at: now.clone(),
        updated_at: now,
        parent_session_id: None,
    })
}

pub fn get_session(conn: &Connection, session_id: &str) -> Result<Option<Session>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_LIST_SELECT} FROM sessions WHERE id = ?1 LIMIT 1"
    ))?;
    let mut rows = stmt.query([session_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(map_session_row(row)?))
}

pub fn create_forked_session(
    conn: &mut Connection,
    source_session_id: &str,
    child_agent_session_id: &str,
    fork_event_id: &str,
    fork_provider_message_id: Option<&str>,
    title: &str,
    fork_user_message_count: Option<i64>,
) -> Result<Session> {
    let source = get_session(conn, source_session_id)?
        .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
    let child_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO sessions (
            id, title, agent_kind, provider_id, model, reasoning_effort, mode,
            permission_config, plan_mode, project_id, origin, is_read_only,
            is_archived, is_pinned, working_path, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'native', 0, 0, 0, ?11, ?12, ?12)",
        params![
            child_id,
            title,
            source.agent_kind.as_str(),
            source.provider_id.as_deref(),
            source.model.as_deref(),
            source.reasoning_effort.as_deref(),
            source.mode.as_deref(),
            source.permission_config.as_deref().unwrap_or(""),
            source.plan_mode.as_deref().unwrap_or("off"),
            source.project_id.as_deref(),
            source.working_path.as_deref(),
            &now,
        ],
    )?;
    tx.execute(
        "INSERT INTO session_lineage (
            child_session_id, parent_session_id, fork_event_id,
            fork_provider_message_id, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            child_id,
            source_session_id,
            fork_event_id,
            fork_provider_message_id,
            &now,
        ],
    )?;
    tx.execute(
        "INSERT INTO agent_session_mappings (
            app_session_id, agent_kind, agent_session_id, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![
            child_id,
            source.agent_kind.as_str(),
            child_agent_session_id,
            &now
        ],
    )?;
    if let Some(message_count) = fork_user_message_count {
        tx.execute(
            "INSERT INTO session_message_attachments (
                session_id, user_index, attachments_json
             )
             SELECT ?1, user_index, attachments_json
             FROM session_message_attachments
             WHERE session_id = ?2 AND user_index >= 0 AND user_index < ?3",
            params![child_id, source_session_id, message_count.max(0)],
        )?;
    }
    tx.commit()?;

    Ok(Session {
        id: child_id,
        title: title.to_string(),
        agent_kind: source.agent_kind,
        provider_id: source.provider_id,
        model: source.model,
        reasoning_effort: source.reasoning_effort,
        mode: source.mode,
        permission_config: source.permission_config,
        plan_mode: source.plan_mode,
        project_id: source.project_id,
        origin: "native".to_string(),
        is_read_only: false,
        is_archived: false,
        is_pinned: false,
        working_path: source.working_path,
        created_at: now.clone(),
        updated_at: now,
        parent_session_id: Some(source_session_id.to_string()),
    })
}

pub fn update_session_working_path(
    conn: &Connection,
    session_id: &str,
    working_path: &str,
) -> Result<()> {
    let trimmed = working_path.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET working_path = ?1, updated_at = ?2 WHERE id = ?3",
        params![trimmed, now, session_id],
    )?;
    Ok(())
}

pub fn get_imported_source(
    conn: &Connection,
    agent_kind: AgentKind,
    agent_session_id: &str,
) -> Result<Option<ImportedSessionSource>> {
    let mut stmt = conn.prepare(
        "SELECT app_session_id, agent_kind, agent_session_id, source_locator, source_fingerprint, source_modified_at, cwd, snapshot_version, imported_at FROM session_sources WHERE agent_kind = ?1 AND agent_session_id = ?2 LIMIT 1",
    )?;
    let mut rows = stmt.query(params![agent_kind.as_str(), agent_session_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(ImportedSessionSource {
        app_session_id: row.get(0)?,
        agent_kind: validate_agent_kind(&row.get::<_, String>(1)?)?,
        agent_session_id: row.get(2)?,
        source_locator: row.get(3)?,
        source_fingerprint: row.get(4)?,
        source_modified_at: row.get(5)?,
        cwd: row.get(6)?,
        snapshot_version: row.get(7)?,
        imported_at: row.get(8)?,
    }))
}

pub fn get_session_snapshot(conn: &Connection, session_id: &str) -> Result<Option<Vec<Value>>> {
    let mut stmt = conn.prepare(
        "SELECT event_json FROM session_event_snapshots WHERE session_id = ?1 ORDER BY sequence ASC",
    )?;
    let rows = stmt.query_map([session_id], |row| row.get::<_, String>(0))?;
    let mut events = Vec::new();
    for raw in rows {
        let raw = raw?;
        events.push(serde_json::from_str(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?);
    }
    if events.is_empty() {
        return Ok(None);
    }
    Ok(Some(events))
}

pub fn replace_session_snapshot(
    conn: &mut Connection,
    session_id: &str,
    events: &[Value],
) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM session_event_snapshots WHERE session_id = ?1",
        [session_id],
    )?;
    insert_snapshot_events(&tx, session_id, events)?;
    tx.commit()
}

pub fn import_session_snapshot(
    conn: &mut Connection,
    snapshot: &ImportedSessionSnapshot,
    refresh_existing: bool,
) -> Result<(Session, bool)> {
    if let Some(existing_source) =
        get_imported_source(conn, snapshot.agent_kind, &snapshot.agent_session_id)?
    {
        let session = get_session(conn, &existing_source.app_session_id)?
            .expect("imported source must reference an existing session");
        let mapping_missing =
            get_agent_session_mapping(conn, &existing_source.app_session_id, snapshot.agent_kind)?
                .is_none();
        if !refresh_existing {
            if mapping_missing {
                let imported_at = Utc::now().to_rfc3339();
                let tx = conn.transaction()?;
                insert_imported_mapping(
                    &tx,
                    &existing_source.app_session_id,
                    snapshot.agent_kind,
                    &snapshot.agent_session_id,
                    &imported_at,
                )?;
                tx.execute(
                    "UPDATE sessions SET is_read_only = 0 WHERE id = ?1",
                    [&existing_source.app_session_id],
                )?;
                tx.commit()?;
                return Ok((
                    get_session(conn, &existing_source.app_session_id)?.unwrap(),
                    true,
                ));
            }
            return Ok((session, false));
        }

        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM session_event_snapshots WHERE session_id = ?1",
            [&existing_source.app_session_id],
        )?;
        insert_snapshot_events(&tx, &existing_source.app_session_id, &snapshot.events)?;
        tx.execute(
            "UPDATE sessions SET title = ?1, updated_at = ?2, project_id = COALESCE(?3, project_id), is_read_only = 0 WHERE id = ?4",
            params![snapshot.title, snapshot.updated_at, snapshot.project_id, existing_source.app_session_id],
        )?;
        if mapping_missing {
            let imported_at = Utc::now().to_rfc3339();
            insert_imported_mapping(
                &tx,
                &existing_source.app_session_id,
                snapshot.agent_kind,
                &snapshot.agent_session_id,
                &imported_at,
            )?;
        }
        tx.execute(
            "UPDATE session_sources SET source_locator = ?1, source_fingerprint = ?2, source_modified_at = ?3, cwd = ?4, snapshot_version = 1, imported_at = ?5 WHERE app_session_id = ?6",
            params![snapshot.source_locator, snapshot.source_fingerprint, snapshot.source_modified_at, snapshot.cwd, Utc::now().to_rfc3339(), existing_source.app_session_id],
        )?;
        tx.commit()?;
        return Ok((
            get_session(conn, &existing_source.app_session_id)?.unwrap(),
            true,
        ));
    }

    let native_conflict: Option<String> = conn
        .query_row(
            "SELECT app_session_id FROM agent_session_mappings WHERE agent_kind = ?1 AND agent_session_id = ?2 LIMIT 1",
            params![snapshot.agent_kind.as_str(), snapshot.agent_session_id],
            |row| row.get(0),
        )
        .ok();
    if native_conflict.is_some() {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "原生会话冲突：{} / {} 已被 CodeMUX 运行中会话占用",
            snapshot.agent_kind.as_str(),
            snapshot.agent_session_id
        )));
    }

    let app_session_id = Uuid::new_v4().to_string();
    let imported_at = Utc::now().to_rfc3339();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO sessions (id, title, agent_kind, mode, project_id, origin, is_read_only, created_at, updated_at) VALUES (?1, ?2, ?3, 'chat', ?4, 'imported', 0, ?5, ?6)",
        params![app_session_id, snapshot.title, snapshot.agent_kind.as_str(), snapshot.project_id, snapshot.created_at, snapshot.updated_at],
    )?;
    insert_imported_mapping(
        &tx,
        &app_session_id,
        snapshot.agent_kind,
        &snapshot.agent_session_id,
        &imported_at,
    )?;
    tx.execute(
        "INSERT INTO session_sources (app_session_id, agent_kind, agent_session_id, source_locator, source_fingerprint, source_modified_at, cwd, snapshot_version, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)",
        params![app_session_id, snapshot.agent_kind.as_str(), snapshot.agent_session_id, snapshot.source_locator, snapshot.source_fingerprint, snapshot.source_modified_at, snapshot.cwd, imported_at],
    )?;
    insert_snapshot_events(&tx, &app_session_id, &snapshot.events)?;
    tx.commit()?;

    Ok((get_session(conn, &app_session_id)?.unwrap(), true))
}

fn insert_imported_mapping(
    conn: &rusqlite::Transaction<'_>,
    app_session_id: &str,
    agent_kind: AgentKind,
    agent_session_id: &str,
    timestamp: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO agent_session_mappings (app_session_id, agent_kind, agent_session_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![app_session_id, agent_kind.as_str(), agent_session_id, timestamp],
    )?;
    Ok(())
}

fn insert_snapshot_events(
    conn: &rusqlite::Transaction<'_>,
    session_id: &str,
    events: &[Value],
) -> Result<()> {
    for (sequence, event) in events.iter().enumerate() {
        let mut snapshot_event = event.clone();
        if let Some(object) = snapshot_event.as_object_mut() {
            object.insert(
                "session_id".to_string(),
                Value::String(session_id.to_string()),
            );
        }
        let event_id = snapshot_event
            .get("event_id")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                snapshot_event
                    .get("uuid")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            });
        let timestamp = snapshot_event.get("timestamp").and_then(Value::as_str);
        conn.execute(
            "INSERT INTO session_event_snapshots (session_id, sequence, event_id, event_timestamp, event_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, sequence as i64, event_id, timestamp, serde_json::to_string(&snapshot_event).unwrap_or_else(|_| "{}".to_string())],
        )?;
    }
    Ok(())
}

pub fn save_session_message_attachments(
    conn: &Connection,
    session_id: &str,
    user_index: i64,
    attachments: &[serde_json::Value],
) -> Result<()> {
    conn.execute(
        "INSERT INTO session_message_attachments (session_id, user_index, attachments_json)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(session_id, user_index) DO UPDATE SET attachments_json = excluded.attachments_json",
        rusqlite::params![
            session_id,
            user_index,
            serde_json::to_string(attachments).unwrap_or_else(|_| "[]".to_string())
        ],
    )?;
    Ok(())
}

pub fn delete_session_message_attachments_from_index(
    conn: &Connection,
    session_id: &str,
    user_index: i64,
) -> Result<()> {
    conn.execute(
        "DELETE FROM session_message_attachments
         WHERE session_id = ?1 AND user_index >= ?2",
        params![session_id, user_index.max(0)],
    )?;
    Ok(())
}

pub fn get_session_message_attachments(
    conn: &Connection,
    session_id: &str,
) -> Result<std::collections::HashMap<i64, Vec<serde_json::Value>>> {
    let mut stmt = conn.prepare(
        "SELECT user_index, attachments_json FROM session_message_attachments WHERE session_id = ?1 ORDER BY user_index ASC",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        let user_index: i64 = row.get(0)?;
        let attachments_json: String = row.get(1)?;
        let attachments: Vec<serde_json::Value> =
            serde_json::from_str(&attachments_json).unwrap_or_default();
        Ok((user_index, attachments))
    })?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (user_index, attachments) = row?;
        map.insert(user_index, attachments);
    }
    Ok(map)
}

pub fn get_all_sessions(conn: &Connection) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_LIST_SELECT} FROM sessions WHERE is_archived = 0 ORDER BY updated_at DESC"
    ))?;

    let sessions = stmt
        .query_map([], map_session_row)?
        .collect::<Result<Vec<_>>>()?;

    Ok(sessions)
}

pub fn get_all_archived_sessions(conn: &Connection) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_LIST_SELECT} FROM sessions WHERE is_archived = 1 ORDER BY updated_at DESC"
    ))?;

    let sessions = stmt
        .query_map([], map_session_row)?
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

pub fn set_session_read_only(conn: &Connection, session_id: &str, read_only: bool) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET is_read_only = ?1, updated_at = ?2 WHERE id = ?3",
        params![
            if read_only { 1 } else { 0 },
            Utc::now().to_rfc3339(),
            session_id
        ],
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
    record_session_native_session(conn, app_session_id, agent_kind, agent_session_id)?;

    Ok(get_agent_session_mapping(conn, app_session_id, agent_kind)?
        .expect("mapping should exist after upsert"))
}

fn record_session_native_session(
    conn: &Connection,
    session_id: &str,
    agent_kind: AgentKind,
    agent_session_id: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "
        INSERT OR IGNORE INTO session_native_sessions (
            session_id, agent_kind, agent_session_id, created_at
        ) VALUES (?1, ?2, ?3, ?4)
        ",
        params![session_id, agent_kind.as_str(), agent_session_id, now],
    )?;
    Ok(())
}

pub fn current_native_sessions_for_kinds(
    conn: &Connection,
    session_id: &str,
    kinds: &[AgentKind],
) -> Result<Vec<NativeSessionRef>> {
    let mut sessions = Vec::new();
    for kind in kinds {
        if let Some(mapping) = get_agent_session_mapping(conn, session_id, *kind)? {
            sessions.push(NativeSessionRef {
                agent_kind: mapping.agent_kind,
                agent_session_id: mapping.agent_session_id,
            });
        }
    }
    Ok(sessions)
}

pub fn list_native_sessions_for_cleanup(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<NativeSessionRef>> {
    let mut stmt = conn.prepare(
        "
        SELECT agent_kind, agent_session_id FROM session_native_sessions WHERE session_id = ?1
        UNION
        SELECT agent_kind, agent_session_id FROM agent_session_mappings WHERE app_session_id = ?1
        ",
    )?;
    let rows = stmt.query_map(params![session_id], |row| {
        Ok(NativeSessionRef {
            agent_kind: validate_agent_kind(&row.get::<_, String>(0)?)?,
            agent_session_id: row.get(1)?,
        })
    })?;

    let mut sessions = Vec::new();
    for row in rows {
        let session = row?;
        if !sessions.iter().any(|existing: &NativeSessionRef| {
            existing.agent_kind == session.agent_kind
                && existing.agent_session_id == session.agent_session_id
        }) {
            sessions.push(session);
        }
    }
    Ok(sessions)
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
    provider_id: Option<&str>,
    model: &str,
    reasoning_effort: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET provider_id = ?1, model = ?2, reasoning_effort = COALESCE(?3, reasoning_effort, 'high') WHERE id = ?4",
        params![provider_id, model, reasoning_effort, session_id],
    )?;
    Ok(())
}

pub fn update_session_reasoning_effort(
    conn: &Connection,
    session_id: &str,
    reasoning_effort: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET reasoning_effort = ?1, updated_at = ?2 WHERE id = ?3",
        params![reasoning_effort, now, session_id],
    )?;
    Ok(())
}

pub fn update_session_permissions(
    conn: &Connection,
    session_id: &str,
    permission_config: Option<&str>,
    plan_mode: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET permission_config = COALESCE(?1, permission_config, ''), plan_mode = COALESCE(?2, plan_mode, 'off') WHERE id = ?3",
        params![permission_config, plan_mode, session_id],
    )?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SessionKindModelSelection {
    pub session_id: String,
    pub agent_kind: AgentKind,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

pub fn upsert_session_kind_model_selection(
    conn: &Connection,
    selection: &SessionKindModelSelection,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_kind_model_selections (
            session_id, agent_kind, provider_id, model, reasoning_effort, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(session_id, agent_kind) DO UPDATE SET
            provider_id = excluded.provider_id,
            model = excluded.model,
            reasoning_effort = excluded.reasoning_effort,
            updated_at = excluded.updated_at",
        params![
            selection.session_id,
            selection.agent_kind.as_str(),
            selection.provider_id.as_deref(),
            selection.model.as_deref(),
            selection.reasoning_effort.as_deref(),
            now,
        ],
    )?;
    Ok(())
}

pub fn get_session_kind_model_selection(
    conn: &Connection,
    session_id: &str,
    agent_kind: AgentKind,
) -> Result<Option<SessionKindModelSelection>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, agent_kind, provider_id, model, reasoning_effort
         FROM session_kind_model_selections
         WHERE session_id = ?1 AND agent_kind = ?2
         LIMIT 1",
    )?;
    let mut rows = stmt.query(params![session_id, agent_kind.as_str()])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(SessionKindModelSelection {
        session_id: row.get(0)?,
        agent_kind: validate_agent_kind(&row.get::<_, String>(1)?)?,
        provider_id: row.get(2)?,
        model: row.get(3)?,
        reasoning_effort: row.get(4)?,
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn update_session_agent_kind(
    conn: &Connection,
    session_id: &str,
    agent_kind: AgentKind,
    permission_config: &str,
    plan_mode: &str,
    provider_id: Option<&str>,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET
            agent_kind = ?1,
            permission_config = ?2,
            plan_mode = ?3,
            provider_id = ?4,
            model = ?5,
            reasoning_effort = COALESCE(?6, reasoning_effort, 'high'),
            updated_at = ?7
         WHERE id = ?8",
        params![
            agent_kind.as_str(),
            permission_config,
            plan_mode,
            provider_id,
            model,
            reasoning_effort,
            now,
            session_id,
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn update_session_settings(
    conn: &mut Connection,
    session_id: &str,
    agent_kind: AgentKind,
    permission_config: &str,
    plan_mode: &str,
    provider_id: Option<&str>,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<()> {
    let transaction = conn.transaction()?;
    let now = Utc::now().to_rfc3339();
    let changed = transaction.execute(
        "UPDATE sessions SET
            agent_kind = ?1,
            permission_config = ?2,
            plan_mode = ?3,
            provider_id = ?4,
            model = ?5,
            reasoning_effort = COALESCE(?6, reasoning_effort, 'high'),
            updated_at = ?7
         WHERE id = ?8",
        params![
            agent_kind.as_str(),
            permission_config,
            plan_mode,
            provider_id,
            model,
            reasoning_effort,
            now,
            session_id,
        ],
    )?;
    if changed == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    transaction.commit()
}

pub fn insert_session_runtime_switch(
    conn: &Connection,
    session_id: &str,
    from_kind: AgentKind,
    to_kind: AgentKind,
    at_sequence: i64,
    new_agent_session_id: Option<&str>,
    briefing_text: Option<&str>,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_runtime_switches (
            id, session_id, from_kind, to_kind, at_sequence, new_agent_session_id, briefing_text, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            session_id,
            from_kind.as_str(),
            to_kind.as_str(),
            at_sequence,
            new_agent_session_id,
            briefing_text,
            now,
        ],
    )?;
    Ok(id)
}

pub fn session_has_runtime_switch(conn: &Connection, session_id: &str) -> Result<bool> {
    let mut stmt =
        conn.prepare("SELECT 1 FROM session_runtime_switches WHERE session_id = ?1 LIMIT 1")?;
    stmt.exists([session_id])
}

pub fn set_pending_switch_briefing(
    conn: &Connection,
    session_id: &str,
    briefing: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET pending_switch_briefing = ?1, updated_at = ?2 WHERE id = ?3",
        params![briefing, Utc::now().to_rfc3339(), session_id],
    )?;
    Ok(())
}

pub fn take_pending_switch_briefing(conn: &Connection, session_id: &str) -> Result<Option<String>> {
    let briefing: Option<String> = conn.query_row(
        "SELECT pending_switch_briefing FROM sessions WHERE id = ?1 LIMIT 1",
        [session_id],
        |row| row.get(0),
    )?;
    if briefing.as_ref().is_some_and(|value| !value.is_empty()) {
        set_pending_switch_briefing(conn, session_id, None)?;
    }
    Ok(briefing.filter(|value| !value.is_empty()))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageHeatmapDay {
    pub date: String,
    pub count: i64,
}

pub fn get_usage_heatmap(conn: &Connection) -> Result<Vec<UsageHeatmapDay>> {
    let mut stmt = conn.prepare(
        "SELECT DATE(created_at) as date, COUNT(*) as count \
         FROM sessions \
         WHERE created_at >= date('now', '-365 days') \
         GROUP BY DATE(created_at) \
         ORDER BY date",
    )?;

    let rows = stmt
        .query_map([], |row| {
            Ok(UsageHeatmapDay {
                date: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(rows)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageOverview {
    pub total_sessions: i64,
    pub active_days: i64,
}

pub fn get_usage_overview(
    conn: &Connection,
    agent_kind: Option<&str>,
    days: u32,
) -> Result<UsageOverview> {
    let days_modifier = format!("-{} days", days);

    let (total_sessions, active_days) = if let Some(kind) = agent_kind {
        conn.query_row(
            "SELECT COUNT(*), COUNT(DISTINCT DATE(created_at)) \
             FROM sessions \
             WHERE created_at >= date('now', ?1) AND agent_kind = ?2",
            params![days_modifier, kind],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*), COUNT(DISTINCT DATE(created_at)) \
             FROM sessions \
             WHERE created_at >= date('now', ?1)",
            params![days_modifier],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
    };

    Ok(UsageOverview {
        total_sessions,
        active_days,
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDistribution {
    pub agent_kind: String,
    pub count: i64,
}

pub fn get_agent_distribution(conn: &Connection, days: u32) -> Result<Vec<AgentDistribution>> {
    let days_modifier = format!("-{} days", days);
    let mut stmt = conn.prepare(
        "SELECT agent_kind, COUNT(*) as count \
         FROM sessions \
         WHERE created_at >= date('now', ?1) \
         GROUP BY agent_kind \
         ORDER BY count DESC",
    )?;

    let rows = stmt
        .query_map(params![days_modifier], |row| {
            Ok(AgentDistribution {
                agent_kind: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(rows)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelDistribution {
    pub model: String,
    pub session_count: i64,
}

pub fn get_model_distribution(
    conn: &Connection,
    agent_kind: Option<&str>,
    days: u32,
) -> Result<Vec<ModelDistribution>> {
    let days_modifier = format!("-{} days", days);

    let result = if let Some(kind) = agent_kind {
        let mut stmt = conn.prepare(
            "SELECT COALESCE(NULLIF(model, ''), '未知模型') as model, COUNT(*) as session_count \
             FROM sessions \
             WHERE created_at >= date('now', ?1) AND agent_kind = ?2 \
             GROUP BY COALESCE(NULLIF(model, ''), '未知模型') \
             ORDER BY session_count DESC",
        )?;
        let rows = stmt.query_map(params![days_modifier, kind], |row| {
            Ok(ModelDistribution {
                model: row.get(0)?,
                session_count: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT COALESCE(NULLIF(model, ''), '未知模型') as model, COUNT(*) as session_count \
             FROM sessions \
             WHERE created_at >= date('now', ?1) \
             GROUP BY COALESCE(NULLIF(model, ''), '未知模型') \
             ORDER BY session_count DESC",
        )?;
        let rows = stmt.query_map(params![days_modifier], |row| {
            Ok(ModelDistribution {
                model: row.get(0)?,
                session_count: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>>>()?
    };

    Ok(result)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
}

pub fn hash_pairing_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

pub fn list_paired_devices(conn: &Connection) -> Result<Vec<PairedDevice>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, paired_at, last_seen_at FROM companion_paired_devices ORDER BY paired_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PairedDevice {
            id: row.get(0)?,
            name: row.get(1)?,
            paired_at: row.get(2)?,
            last_seen_at: row.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn insert_paired_device(
    conn: &Connection,
    id: &str,
    name: &str,
    token_hash: &str,
    paired_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO companion_paired_devices (id, name, token_hash, paired_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, token_hash, paired_at],
    )?;
    Ok(())
}

pub fn verify_pairing_token(conn: &Connection, token: &str) -> Result<Option<PairedDevice>> {
    let token_hash = hash_pairing_token(token);
    let mut stmt = conn.prepare(
        "SELECT id, name, paired_at, last_seen_at FROM companion_paired_devices WHERE token_hash = ?1",
    )?;
    let mut rows = stmt.query([token_hash])?;
    if let Some(row) = rows.next()? {
        let device = PairedDevice {
            id: row.get(0)?,
            name: row.get(1)?,
            paired_at: row.get(2)?,
            last_seen_at: row.get(3)?,
        };
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE companion_paired_devices SET last_seen_at = ?1 WHERE id = ?2",
            params![now, device.id],
        )?;
        return Ok(Some(device));
    }
    Ok(None)
}

pub fn get_session_events_after(
    conn: &Connection,
    session_id: &str,
    after_sequence: i64,
) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT event_json FROM session_event_snapshots WHERE session_id = ?1 AND sequence > ?2 ORDER BY sequence ASC",
    )?;
    let rows = stmt.query_map(params![session_id, after_sequence], |row| {
        row.get::<_, String>(0)
    })?;
    let mut events = Vec::new();
    for raw in rows {
        let raw = raw?;
        events.push(serde_json::from_str(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?);
    }
    Ok(events)
}

pub fn append_snapshot_events(
    conn: &mut Connection,
    session_id: &str,
    events: &[Value],
) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let next_sequence: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sequence), -1) + 1 FROM session_event_snapshots WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )?;
    for (offset, event) in events.iter().enumerate() {
        let mut snapshot_event = event.clone();
        if let Some(object) = snapshot_event.as_object_mut() {
            object.insert(
                "session_id".to_string(),
                Value::String(session_id.to_string()),
            );
            if !object.contains_key("timestamp") {
                object.insert(
                    "timestamp".to_string(),
                    Value::String(Utc::now().to_rfc3339()),
                );
            }
        }
        let sequence = next_sequence + offset as i64;
        let event_id = snapshot_event
            .get("event_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let timestamp = snapshot_event.get("timestamp").and_then(Value::as_str);
        tx.execute(
            "INSERT OR IGNORE INTO session_event_snapshots (session_id, sequence, event_id, event_timestamp, event_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                session_id,
                sequence,
                event_id,
                timestamp,
                serde_json::to_string(&snapshot_event).unwrap_or_else(|_| "{}".to_string())
            ],
        )?;
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::{
        append_snapshot_events, archive_session, create_forked_session,
        current_native_sessions_for_kinds, delete_agent_session_mapping,
        delete_session_message_attachments_from_index, get_agent_distribution,
        get_agent_session_mapping, get_all_archived_sessions, get_all_sessions,
        get_model_distribution, get_session, get_session_events_after,
        get_session_kind_model_selection, get_session_snapshot, get_usage_heatmap,
        get_usage_overview, import_session_snapshot, insert_session_runtime_switch,
        list_native_sessions_for_cleanup, session_has_runtime_switch, set_session_pinned,
        set_session_read_only, unarchive_session, update_session_agent_kind,
        update_session_provider, update_session_reasoning_effort, update_session_settings,
        upsert_agent_session_mapping, upsert_session_kind_model_selection, ImportedSessionSnapshot,
        SessionKindModelSelection,
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
    fn records_every_native_session_id_even_after_mapping_overwrite() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Test", "claude_code", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-a")
            .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-b")
            .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::Codex, "codex-a").unwrap();

        let mut ids: Vec<(String, String)> = list_native_sessions_for_cleanup(&conn, "session-1")
            .unwrap()
            .into_iter()
            .map(|entry| {
                (
                    entry.agent_kind.as_str().to_string(),
                    entry.agent_session_id,
                )
            })
            .collect();
        ids.sort();

        assert_eq!(
            ids,
            vec![
                ("claude_code".to_string(), "claude-a".to_string()),
                ("claude_code".to_string(), "claude-b".to_string()),
                ("codex".to_string(), "codex-a".to_string()),
            ]
        );
        assert_eq!(
            get_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode)
                .unwrap()
                .unwrap()
                .agent_session_id,
            "claude-b"
        );
    }

    #[test]
    fn current_native_sessions_for_kinds_return_live_mappings_only() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Test", "claude_code", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-a")
            .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-b")
            .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::Codex, "codex-a").unwrap();

        let abandoned = current_native_sessions_for_kinds(
            &conn,
            "session-1",
            &[AgentKind::ClaudeCode, AgentKind::Opencode],
        )
        .unwrap();

        assert_eq!(abandoned.len(), 1);
        assert_eq!(abandoned[0].agent_kind, AgentKind::ClaudeCode);
        assert_eq!(abandoned[0].agent_session_id, "claude-b");
    }

    #[test]
    fn deleting_session_cascades_native_session_history() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Test", "claude_code", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-a")
            .unwrap();
        upsert_agent_session_mapping(&conn, "session-1", AgentKind::ClaudeCode, "claude-b")
            .unwrap();

        conn.execute("DELETE FROM sessions WHERE id = ?1", ["session-1"])
            .unwrap();

        assert!(list_native_sessions_for_cleanup(&conn, "session-1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn creates_forked_session_with_independent_mapping_and_lineage() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, model, permission_config, plan_mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            rusqlite::params![
                "parent",
                "Parent",
                "claude_code",
                "agent",
                "claude-sonnet",
                "{}",
                "off",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();
        upsert_agent_session_mapping(&conn, "parent", AgentKind::ClaudeCode, "claude-parent")
            .unwrap();
        conn.execute(
            "INSERT INTO session_message_attachments (session_id, user_index, attachments_json)
             VALUES (?1, ?2, ?3)",
            rusqlite::params!["parent", 0_i64, "[]"],
        )
        .unwrap();

        let child = create_forked_session(
            &mut conn,
            "parent",
            "claude-child",
            "assistant-event-1",
            Some("provider-message-1"),
            "Parent · 分支",
            Some(1),
        )
        .unwrap();

        assert_eq!(child.parent_session_id.as_deref(), Some("parent"));
        assert_eq!(child.model.as_deref(), Some("claude-sonnet"));
        assert_eq!(
            get_agent_session_mapping(&conn, &child.id, AgentKind::ClaudeCode)
                .unwrap()
                .unwrap()
                .agent_session_id,
            "claude-child"
        );
        let lineage = conn
            .query_row(
                "SELECT parent_session_id, fork_event_id, fork_provider_message_id
                 FROM session_lineage WHERE child_session_id = ?1",
                [&child.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(lineage.0, "parent");
        assert_eq!(lineage.1, "assistant-event-1");
        assert_eq!(lineage.2, "provider-message-1");
        let copied_attachment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_message_attachments WHERE session_id = ?1",
                [&child.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(copied_attachment_count, 1);
    }

    #[test]
    fn deletes_rewound_message_attachments_without_touching_previous_turns() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at)
             VALUES ('session-1', 'Test', 'claude_code', 'agent', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_message_attachments (session_id, user_index, attachments_json)
             VALUES ('session-1', 0, '[]'), ('session-1', 1, '[]'), ('session-1', 2, '[]')",
            [],
        )
        .unwrap();

        delete_session_message_attachments_from_index(&conn, "session-1", 1).unwrap();

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_message_attachments
                 WHERE session_id = 'session-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 1);
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
    fn deletes_opencode_mapping_for_reset() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-opencode", "OpenCode", "opencode", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        upsert_agent_session_mapping(
            &conn,
            "session-opencode",
            AgentKind::Opencode,
            "opencode-session-1",
        )
        .unwrap();

        delete_agent_session_mapping(&conn, "session-opencode", AgentKind::Opencode).unwrap();

        assert!(
            get_agent_session_mapping(&conn, "session-opencode", AgentKind::Opencode)
                .unwrap()
                .is_none()
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

        update_session_provider(
            &conn,
            "session-1",
            Some("provider-1"),
            "gpt-5",
            Some("high"),
        )
        .unwrap();

        let sessions = get_all_sessions(&conn).unwrap();
        assert_eq!(sessions[0].model.as_deref(), Some("gpt-5"));
        assert_eq!(sessions[0].reasoning_effort.as_deref(), Some("high"));
        assert_eq!(sessions[0].updated_at, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn updates_session_reasoning_effort_without_provider() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Test", "codex", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        update_session_reasoning_effort(&conn, "session-1", "high").unwrap();

        let sessions = get_all_sessions(&conn).unwrap();
        assert_eq!(sessions[0].reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn updates_all_session_settings_in_one_transaction() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-1", "Test", "claude_code", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        update_session_settings(
            &mut conn,
            "session-1",
            AgentKind::Codex,
            r#"{"kind":"codex","sandboxMode":"workspace-write"}"#,
            "on",
            Some("provider-1"),
            Some("gpt-5"),
            Some("medium"),
        )
        .unwrap();

        let session = get_session(&conn, "session-1").unwrap().unwrap();
        assert_eq!(session.agent_kind, AgentKind::Codex);
        assert_eq!(session.provider_id.as_deref(), Some("provider-1"));
        assert_eq!(session.model.as_deref(), Some("gpt-5"));
        assert_eq!(session.reasoning_effort.as_deref(), Some("medium"));
        assert_eq!(
            session.permission_config.as_deref(),
            Some(r#"{"kind":"codex","sandboxMode":"workspace-write"}"#)
        );
        assert_eq!(session.plan_mode.as_deref(), Some("on"));
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
            None,
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

    fn insert_session_at(conn: &Connection, id: &str, agent_kind: &str, created_at: &str) {
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, "Test", agent_kind, "agent", created_at, created_at],
        )
        .unwrap();
    }

    #[test]
    fn aggregates_usage_heatmap_by_day() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();

        let now = chrono::Utc::now();
        let today = now.format("%Y-%m-%dT00:00:00Z").to_string();
        let yesterday = (now - chrono::Duration::days(1))
            .format("%Y-%m-%dT00:00:00Z")
            .to_string();

        insert_session_at(&conn, "session-1", "claude_code", &today);
        insert_session_at(&conn, "session-2", "codex", &today);
        insert_session_at(&conn, "session-3", "claude_code", &yesterday);

        let heatmap = get_usage_heatmap(&conn).unwrap();

        let today_date = now.format("%Y-%m-%d").to_string();
        let yesterday_date = (now - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();

        let today_entry = heatmap
            .iter()
            .find(|day| day.date == today_date)
            .expect("today should be in heatmap");
        assert_eq!(today_entry.count, 2);

        let yesterday_entry = heatmap
            .iter()
            .find(|day| day.date == yesterday_date)
            .expect("yesterday should be in heatmap");
        assert_eq!(yesterday_entry.count, 1);
    }

    #[test]
    fn gets_usage_overview_with_and_without_agent_kind_filter() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();

        let now = chrono::Utc::now();
        let today = now.format("%Y-%m-%dT00:00:00Z").to_string();
        let yesterday = (now - chrono::Duration::days(1))
            .format("%Y-%m-%dT00:00:00Z")
            .to_string();

        insert_session_at(&conn, "session-1", "claude_code", &today);
        insert_session_at(&conn, "session-2", "codex", &today);
        insert_session_at(&conn, "session-3", "claude_code", &yesterday);

        let all_overview = get_usage_overview(&conn, None, 30).unwrap();
        assert_eq!(all_overview.total_sessions, 3);
        assert_eq!(all_overview.active_days, 2);

        let claude_overview = get_usage_overview(&conn, Some("claude_code"), 30).unwrap();
        assert_eq!(claude_overview.total_sessions, 2);
        assert_eq!(claude_overview.active_days, 2);

        let codex_overview = get_usage_overview(&conn, Some("codex"), 30).unwrap();
        assert_eq!(codex_overview.total_sessions, 1);
        assert_eq!(codex_overview.active_days, 1);
    }

    #[test]
    fn gets_agent_distribution_within_days_window() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();

        let now = chrono::Utc::now();
        let today = now.format("%Y-%m-%dT00:00:00Z").to_string();
        let old = (now - chrono::Duration::days(60))
            .format("%Y-%m-%dT00:00:00Z")
            .to_string();

        insert_session_at(&conn, "session-1", "claude_code", &today);
        insert_session_at(&conn, "session-2", "claude_code", &today);
        insert_session_at(&conn, "session-3", "codex", &today);
        insert_session_at(&conn, "session-old", "codex", &old);

        let dist = get_agent_distribution(&conn, 30).unwrap();
        assert_eq!(dist.len(), 2);

        let claude = dist
            .iter()
            .find(|d| d.agent_kind == "claude_code")
            .expect("claude_code should be present");
        assert_eq!(claude.count, 2);

        let codex = dist
            .iter()
            .find(|d| d.agent_kind == "codex")
            .expect("codex should be present");
        assert_eq!(codex.count, 1);
    }

    #[test]
    fn gets_model_distribution_with_unknown_group_and_agent_filter() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();

        let now = chrono::Utc::now();
        let today = now.format("%Y-%m-%dT00:00:00Z").to_string();

        // session with model
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, model, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            rusqlite::params![
                "session-1",
                "A",
                "claude_code",
                "agent",
                "claude-sonnet-4",
                &today
            ],
        )
        .unwrap();
        // session without model (NULL)
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-2", "B", "claude_code", "agent", &today, &today],
        )
        .unwrap();
        // session with empty model string
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, model, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            rusqlite::params!["session-3", "C", "codex", "agent", "", &today],
        )
        .unwrap();

        let all = get_model_distribution(&conn, None, 30).unwrap();
        let unknown = all
            .iter()
            .find(|d| d.model == "未知模型")
            .expect("unknown model group should exist");
        assert_eq!(unknown.session_count, 2);

        let claude_only = get_model_distribution(&conn, Some("claude_code"), 30).unwrap();
        let claude_unknown = claude_only
            .iter()
            .find(|d| d.model == "未知模型")
            .expect("unknown model group should exist for claude_code");
        assert_eq!(claude_unknown.session_count, 1);
    }

    #[test]
    fn imports_snapshot_idempotently_and_rewrites_session_id() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        let snapshot = ImportedSessionSnapshot {
            agent_kind: AgentKind::Codex,
            agent_session_id: "codex-import-1".to_string(),
            title: "Imported Codex".to_string(),
            created_at: "2026-07-30T10:00:00Z".to_string(),
            updated_at: "2026-07-30T10:05:00Z".to_string(),
            project_id: None,
            source_locator: "C:/Users/test/.codex/sessions/one.jsonl".to_string(),
            source_fingerprint: "one:1".to_string(),
            source_modified_at: Some("2026-07-30T10:05:00Z".to_string()),
            cwd: Some("C:/workspace".to_string()),
            events: vec![serde_json::json!({
                "type": "user_message",
                "session_id": "codex-import-1",
                "event_id": "event-1",
                "content": [{"type": "text", "text": "hello"}]
            })],
        };

        let (created, changed) = import_session_snapshot(&mut conn, &snapshot, false).unwrap();
        assert!(changed);
        assert_eq!(created.origin, "imported");
        assert!(!created.is_read_only);
        assert_eq!(
            get_agent_session_mapping(&conn, &created.id, AgentKind::Codex)
                .unwrap()
                .unwrap()
                .agent_session_id,
            "codex-import-1"
        );

        let events = get_session_snapshot(&conn, &created.id).unwrap().unwrap();
        assert_eq!(events[0]["session_id"], created.id);
        assert_eq!(events[0]["event_id"], "event-1");

        let (same, changed_again) = import_session_snapshot(&mut conn, &snapshot, false).unwrap();
        assert_eq!(same.id, created.id);
        assert!(!changed_again);
        assert_eq!(get_all_sessions(&conn).unwrap().len(), 1);
    }

    #[test]
    fn refresh_import_restores_a_failed_session_and_keeps_mapping() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        let snapshot = ImportedSessionSnapshot {
            agent_kind: AgentKind::ClaudeCode,
            agent_session_id: "claude-import-1".to_string(),
            title: "Imported Claude".to_string(),
            created_at: "2026-01-01T10:00:00Z".to_string(),
            updated_at: "2026-01-01T10:05:00Z".to_string(),
            project_id: None,
            source_locator: "C:/Users/test/.claude/session.jsonl".to_string(),
            source_fingerprint: "claude:1".to_string(),
            source_modified_at: Some("2026-01-01T10:05:00Z".to_string()),
            cwd: Some("C:/workspace".to_string()),
            events: vec![serde_json::json!({
                "type": "user_message",
                "session_id": "claude-import-1",
                "event_id": "event-1",
                "content": [{"type": "text", "text": "hello"}]
            })],
        };

        let (created, _) = import_session_snapshot(&mut conn, &snapshot, false).unwrap();
        set_session_read_only(&conn, &created.id, true).unwrap();
        let (refreshed, changed) = import_session_snapshot(&mut conn, &snapshot, true).unwrap();

        assert!(changed);
        assert!(!refreshed.is_read_only);
        assert_eq!(
            get_agent_session_mapping(&conn, &created.id, AgentKind::ClaudeCode)
                .unwrap()
                .unwrap()
                .agent_session_id,
            "claude-import-1"
        );
    }

    fn insert_test_session(conn: &Connection, session_id: &str, agent_kind: &str) {
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![session_id, "Test", agent_kind, "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
    }

    #[test]
    fn never_switched_session_has_no_runtime_switch_record() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        assert!(!session_has_runtime_switch(&conn, "session-1").unwrap());
    }

    #[test]
    fn updates_agent_kind_and_resets_permission_snapshot() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");
        conn.execute(
            "UPDATE sessions SET permission_config = ?1, plan_mode = 'on', provider_id = 'anthropic', model = 'opus' WHERE id = 'session-1'",
            rusqlite::params![r#"{"kind":"claude_code","permissionMode":"plan"}"#],
        )
        .unwrap();

        update_session_agent_kind(
            &conn,
            "session-1",
            AgentKind::Codex,
            r#"{"kind":"codex","sandboxMode":"danger-full-access","approvalPolicy":"never","networkAccessEnabled":true}"#,
            "off",
            Some("openai"),
            Some("gpt-5"),
            Some("medium"),
        )
        .unwrap();

        let session = get_session(&conn, "session-1").unwrap().unwrap();
        assert_eq!(session.agent_kind, AgentKind::Codex);
        assert_eq!(session.plan_mode.as_deref(), Some("off"));
        assert_eq!(session.provider_id.as_deref(), Some("openai"));
        assert_eq!(session.model.as_deref(), Some("gpt-5"));
        assert_eq!(session.reasoning_effort.as_deref(), Some("medium"));
        assert!(session
            .permission_config
            .as_deref()
            .unwrap_or("")
            .contains("\"kind\":\"codex\""));
    }

    #[test]
    fn remembers_kind_model_selection_per_agent_kind() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        upsert_session_kind_model_selection(
            &conn,
            &SessionKindModelSelection {
                session_id: "session-1".to_string(),
                agent_kind: AgentKind::ClaudeCode,
                provider_id: Some("anthropic".to_string()),
                model: Some("opus".to_string()),
                reasoning_effort: Some("high".to_string()),
            },
        )
        .unwrap();
        upsert_session_kind_model_selection(
            &conn,
            &SessionKindModelSelection {
                session_id: "session-1".to_string(),
                agent_kind: AgentKind::Codex,
                provider_id: Some("openai".to_string()),
                model: Some("gpt-5".to_string()),
                reasoning_effort: Some("medium".to_string()),
            },
        )
        .unwrap();
        upsert_session_kind_model_selection(
            &conn,
            &SessionKindModelSelection {
                session_id: "session-1".to_string(),
                agent_kind: AgentKind::ClaudeCode,
                provider_id: Some("anthropic".to_string()),
                model: Some("sonnet".to_string()),
                reasoning_effort: Some("low".to_string()),
            },
        )
        .unwrap();

        let claude = get_session_kind_model_selection(&conn, "session-1", AgentKind::ClaudeCode)
            .unwrap()
            .unwrap();
        let codex = get_session_kind_model_selection(&conn, "session-1", AgentKind::Codex)
            .unwrap()
            .unwrap();
        assert_eq!(claude.model.as_deref(), Some("sonnet"));
        assert_eq!(claude.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(codex.model.as_deref(), Some("gpt-5"));
        assert!(
            get_session_kind_model_selection(&conn, "session-1", AgentKind::Opencode)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn append_snapshot_events_increments_sequence() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        let first =
            serde_json::json!({ "type": "user_message", "event_id": "e1", "content": "hi" });
        append_snapshot_events(&mut conn, "session-1", &[first]).unwrap();
        let second =
            serde_json::json!({ "type": "assistant_message", "event_id": "e2", "content": [] });
        append_snapshot_events(&mut conn, "session-1", &[second]).unwrap();

        let events = get_session_events_after(&conn, "session-1", -1).unwrap();
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn records_runtime_switch_and_marks_session_as_switched() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        insert_session_runtime_switch(
            &conn,
            "session-1",
            AgentKind::ClaudeCode,
            AgentKind::Codex,
            12,
            Some("thr_new"),
            Some("briefing"),
        )
        .unwrap();

        assert!(session_has_runtime_switch(&conn, "session-1").unwrap());
        assert!(!session_has_runtime_switch(&conn, "missing").unwrap());
    }
}
