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

#[allow(clippy::too_many_arguments)]
pub fn create_scheduled_session_for_project(
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
        "INSERT INTO sessions (id, title, agent_kind, mode, project_id, model, permission_config, plan_mode, reasoning_effort, origin, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'high', 'scheduled', ?9, ?9)",
        params![id, title, agent_kind.as_str(), mode, project_id, model, permission_config, plan_mode, now],
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
        origin: "scheduled".to_string(),
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

pub fn get_session_timeline(conn: &Connection, session_id: &str) -> Result<Option<Vec<Value>>> {
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

pub fn clear_session_timeline(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM session_event_snapshots WHERE session_id = ?1",
        [session_id],
    )?;
    Ok(())
}

pub fn replace_session_timeline(
    conn: &mut Connection,
    session_id: &str,
    events: &[Value],
) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM session_event_snapshots WHERE session_id = ?1",
        [session_id],
    )?;
    insert_timeline_events(&tx, session_id, events)?;
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
        insert_timeline_events(&tx, &existing_source.app_session_id, &snapshot.events)?;
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
    insert_timeline_events(&tx, &app_session_id, &snapshot.events)?;
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

fn insert_timeline_events(
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

fn timeline_event_with_sequence(sequence: i64, raw: &str) -> Result<Value> {
    let mut event: Value = serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    if let Some(object) = event.as_object_mut() {
        object.insert("sequence".to_string(), serde_json::json!(sequence));
    }
    Ok(event)
}

pub fn get_session_events_after(
    conn: &Connection,
    session_id: &str,
    after_sequence: i64,
) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT sequence, event_json FROM session_event_snapshots WHERE session_id = ?1 AND sequence > ?2 ORDER BY sequence ASC",
    )?;
    let rows = stmt.query_map(params![session_id, after_sequence], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut events = Vec::new();
    for row in rows {
        let (sequence, raw) = row?;
        events.push(timeline_event_with_sequence(sequence, &raw)?);
    }
    Ok(events)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineDirection {
    Tail,
    After,
    Before,
}

pub const DEFAULT_SESSION_TIMELINE_LIMIT: usize = 200;
pub const MAX_SESSION_TIMELINE_LIMIT: usize = 500;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTimelinePage {
    pub events: Vec<Value>,
    pub seq_start: i64,
    pub seq_end: i64,
    pub has_older: bool,
    pub has_newer: bool,
    pub history_complete: bool,
}

pub fn parse_timeline_direction(value: Option<&str>) -> TimelineDirection {
    match value.unwrap_or("tail").trim().to_lowercase().as_str() {
        "after" => TimelineDirection::After,
        "before" => TimelineDirection::Before,
        _ => TimelineDirection::Tail,
    }
}

pub fn fetch_session_timeline(
    conn: &Connection,
    session_id: &str,
    direction: TimelineDirection,
    cursor: Option<i64>,
    limit: usize,
) -> Result<SessionTimelinePage> {
    let limit = limit.clamp(1, MAX_SESSION_TIMELINE_LIMIT);
    let fetch_limit = (limit + 1) as i64;
    let (min_sequence, max_sequence) = session_timeline_bounds(conn, session_id)?;

    let (rows, has_older, has_newer): (Vec<(i64, String)>, bool, bool) = match direction {
        TimelineDirection::Tail => {
            let mut stmt = conn.prepare(
                "SELECT sequence, event_json FROM session_event_snapshots WHERE session_id = ?1 ORDER BY sequence DESC LIMIT ?2",
            )?;
            let mut rows: Vec<(i64, String)> = stmt
                .query_map(params![session_id, limit as i64], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<Result<_>>()?;
            rows.reverse();
            let seq_start = rows.first().map(|row| row.0);
            let seq_end = rows.last().map(|row| row.0);
            let has_older = seq_start
                .zip(min_sequence)
                .map(|(start, min)| start > min)
                .unwrap_or(false);
            let has_newer = seq_end
                .zip(max_sequence)
                .map(|(end, max)| end < max)
                .unwrap_or(false);
            (rows, has_older, has_newer)
        }
        TimelineDirection::After => {
            let cursor = cursor.unwrap_or(-1);
            let mut stmt = conn.prepare(
                "SELECT sequence, event_json FROM session_event_snapshots WHERE session_id = ?1 AND sequence > ?2 ORDER BY sequence ASC LIMIT ?3",
            )?;
            let mut rows: Vec<(i64, String)> = stmt
                .query_map(params![session_id, cursor, fetch_limit], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<Result<Vec<_>>>()?;
            let has_newer = rows.len() > limit;
            if has_newer {
                rows.truncate(limit);
            }
            let has_older = rows
                .first()
                .map(|row| row.0)
                .zip(min_sequence)
                .map(|(start, min)| start > min)
                .unwrap_or(false);
            (rows, has_older, has_newer)
        }
        TimelineDirection::Before => {
            let cursor = cursor.unwrap_or(i64::MAX);
            let mut stmt = conn.prepare(
                "SELECT sequence, event_json FROM session_event_snapshots WHERE session_id = ?1 AND sequence < ?2 ORDER BY sequence DESC LIMIT ?3",
            )?;
            let mut rows: Vec<(i64, String)> = stmt
                .query_map(params![session_id, cursor, fetch_limit], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<Result<_>>()?;
            let has_older = rows.len() > limit;
            if has_older {
                rows.truncate(limit);
            }
            rows.reverse();
            let has_newer = rows
                .last()
                .map(|row| row.0)
                .zip(max_sequence)
                .map(|(end, max)| end < max)
                .unwrap_or(false);
            (rows, has_older, has_newer)
        }
    };

    if rows.is_empty() {
        return Ok(SessionTimelinePage {
            events: Vec::new(),
            seq_start: -1,
            seq_end: -1,
            has_older: false,
            has_newer: false,
            history_complete: true,
        });
    }

    let events = rows
        .iter()
        .map(|(sequence, raw)| timeline_event_with_sequence(*sequence, raw))
        .collect::<Result<Vec<_>>>()?;
    let seq_start = rows[0].0;
    let seq_end = rows[rows.len() - 1].0;

    Ok(SessionTimelinePage {
        events,
        seq_start,
        seq_end,
        has_older,
        has_newer,
        history_complete: !has_older,
    })
}

fn session_timeline_bounds(
    conn: &Connection,
    session_id: &str,
) -> Result<(Option<i64>, Option<i64>)> {
    let mut stmt = conn.prepare(
        "SELECT MIN(sequence), MAX(sequence) FROM session_event_snapshots WHERE session_id = ?1",
    )?;
    let mut rows = stmt.query([session_id])?;
    let Some(row) = rows.next()? else {
        return Ok((None, None));
    };
    Ok((row.get(0)?, row.get(1)?))
}

pub fn append_timeline_events(
    conn: &mut Connection,
    session_id: &str,
    events: &[Value],
) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let resolved_session_id = resolve_app_session_id_for_timeline(conn, session_id)?;
    let tx = conn.transaction()?;
    let next_sequence: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sequence), -1) + 1 FROM session_event_snapshots WHERE session_id = ?1",
        [&resolved_session_id],
        |row| row.get(0),
    )?;
    for (offset, event) in events.iter().enumerate() {
        let mut snapshot_event = event.clone();
        if let Some(object) = snapshot_event.as_object_mut() {
            object.insert(
                "session_id".to_string(),
                Value::String(resolved_session_id.clone()),
            );
            if !object.contains_key("timestamp") {
                object.insert(
                    "timestamp".to_string(),
                    Value::String(Utc::now().to_rfc3339()),
                );
            }
        }
        let sequence = next_sequence + offset as i64;
        if let Some(object) = snapshot_event.as_object_mut() {
            object.insert("sequence".to_string(), serde_json::json!(sequence));
        }
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
                resolved_session_id,
                sequence,
                event_id,
                timestamp,
                serde_json::to_string(&snapshot_event).unwrap_or_else(|_| "{}".to_string())
            ],
        )?;
    }
    tx.commit()
}

pub fn resolve_app_session_id_for_timeline(conn: &Connection, session_id: &str) -> Result<String> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
        [session_id],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(session_id.to_string());
    }

    let mapped: Option<String> = conn
        .query_row(
            "SELECT app_session_id FROM agent_session_mappings WHERE agent_session_id = ?1 LIMIT 1",
            [session_id],
            |row| row.get(0),
        )
        .ok();
    Ok(mapped.unwrap_or_else(|| session_id.to_string()))
}

// --- Subagent timeline (session_subagents / session_subagent_events) ---------
//
// These rows are a bypass store next to the parent timeline: they never appear
// in session_event_snapshots and are only read via load_session_subagents.

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSubagent {
    pub session_id: String,
    pub subagent_id: String,
    pub provider: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub tool_call_id: Option<String>,
    pub subtitle: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSubagentsPayload {
    pub subagents: Vec<SessionSubagent>,
    pub timelines: std::collections::HashMap<String, Vec<Value>>,
}

pub(crate) fn is_terminal_subagent_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "canceled")
}

/// Sticky upsert of a `subagent_upsert` descriptor event: omitted fields keep
/// their stored value, explicit `null` clears, and a terminal descriptor is
/// never moved back to `running`.
pub fn upsert_session_subagent(conn: &mut Connection, event: &Value) -> Result<()> {
    let session_id = event
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let subagent_id = event
        .get("subagent_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if session_id.is_empty() || subagent_id.is_empty() {
        return Ok(());
    }
    let resolved_session_id = resolve_app_session_id_for_timeline(conn, session_id)?;
    let now = Utc::now().to_rfc3339();
    let provider = event
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("claude");

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO session_subagents (session_id, subagent_id, provider, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'running', ?4, ?4)",
        params![resolved_session_id, subagent_id, provider, now],
    )?;
    let existing: (
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    ) = tx.query_row(
        "SELECT title, description, status, tool_call_id, subtitle
         FROM session_subagents WHERE session_id = ?1 AND subagent_id = ?2",
        params![resolved_session_id, subagent_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;

    let merge = |field: &str, current: Option<String>| -> Option<String> {
        match event.get(field) {
            Some(Value::String(text)) => Some(text.clone()),
            // Explicit null clears; a missing key keeps the stored value.
            Some(Value::Null) => None,
            None => current,
            Some(other) => Some(other.to_string()),
        }
    };
    let title = merge("title", existing.0);
    let description = merge("description", existing.1);
    let tool_call_id = merge("tool_call_id", existing.3);
    let subtitle = merge("subtitle", existing.4);
    let status = match event.get("status").and_then(Value::as_str) {
        Some(next_status)
            if next_status == "running" && is_terminal_subagent_status(&existing.2) =>
        {
            existing.2.clone()
        }
        Some(next_status) => next_status.to_string(),
        None => existing.2,
    };

    tx.execute(
        "UPDATE session_subagents
         SET provider = ?3, title = ?4, description = ?5, status = ?6, tool_call_id = ?7, subtitle = ?8, updated_at = ?9
         WHERE session_id = ?1 AND subagent_id = ?2",
        params![
            resolved_session_id,
            subagent_id,
            provider,
            title,
            description,
            status,
            tool_call_id,
            subtitle,
            now
        ],
    )?;
    tx.commit()
}

/// Append the inner CodeMUX event of a `subagent_timeline` envelope. Idempotent
/// on `event_id`; sequence falls back to per-subagent monotonic allocation.
pub fn append_session_subagent_event(conn: &mut Connection, event: &Value) -> Result<()> {
    let session_id = event
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let subagent_id = event
        .get("subagent_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if session_id.is_empty() || subagent_id.is_empty() {
        return Ok(());
    }
    let resolved_session_id = resolve_app_session_id_for_timeline(conn, session_id)?;
    let inner = event.get("event").cloned().unwrap_or(Value::Null);
    let now = Utc::now().to_rfc3339();

    let event_id = inner
        .get("event_id")
        .and_then(Value::as_str)
        .or_else(|| event.get("event_id").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let timestamp = inner
        .get("timestamp")
        .and_then(Value::as_str)
        .or_else(|| event.get("timestamp").and_then(Value::as_str));
    let sequence = inner
        .get("sequence")
        .and_then(Value::as_i64)
        .or_else(|| event.get("sequence").and_then(Value::as_i64));

    let tx = conn.transaction()?;
    // The descriptor is declared before its timeline in practice; stub it in
    // defensively so the FK never blocks a live timeline event.
    tx.execute(
        "INSERT OR IGNORE INTO session_subagents (session_id, subagent_id, provider, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'running', ?4, ?4)",
        params![
            resolved_session_id,
            subagent_id,
            event.get("provider").and_then(Value::as_str).unwrap_or("claude"),
            now
        ],
    )?;

    // Idempotency on event_id: a repeated delivery must not create a second
    // row even when it carries a fresh sequence.
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_subagent_events
         WHERE session_id = ?1 AND subagent_id = ?2 AND event_id = ?3)",
        params![resolved_session_id, subagent_id, event_id],
        |row| row.get(0),
    )?;
    if !exists {
        let sequence = sequence.unwrap_or_else(|| {
            tx.query_row(
                "SELECT COALESCE(MAX(sequence), -1) + 1 FROM session_subagent_events
                 WHERE session_id = ?1 AND subagent_id = ?2",
                params![resolved_session_id, subagent_id],
                |row| row.get(0),
            )
            .unwrap_or(0)
        });
        tx.execute(
            "INSERT OR IGNORE INTO session_subagent_events (session_id, subagent_id, sequence, event_id, event_timestamp, event_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                resolved_session_id,
                subagent_id,
                sequence,
                event_id,
                timestamp,
                serde_json::to_string(&inner).unwrap_or_else(|_| "{}".to_string())
            ],
        )?;
    }
    tx.commit()
}

/// Replace a subagent's persisted timeline with the provided envelopes.
/// Used only by the disk-history backfill to repair a lossy live capture
/// (e.g. tool arguments missing because an older sidecar dropped the
/// refreshed `tool_started`); deletes and re-appends in one transaction.
pub fn replace_session_subagent_timeline(
    conn: &mut Connection,
    session_id: &str,
    subagent_id: &str,
    events: &[Value],
) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM session_subagent_events WHERE session_id = ?1 AND subagent_id = ?2",
        params![session_id, subagent_id],
    )?;
    let now = Utc::now().to_rfc3339();
    // The descriptor must exist for the FK; stub it in defensively.
    tx.execute(
        "INSERT OR IGNORE INTO session_subagents (session_id, subagent_id, provider, status, created_at, updated_at)
         VALUES (?1, ?2, 'opencode', 'completed', ?3, ?3)",
        params![session_id, subagent_id, now],
    )?;
    for envelope in events {
        let inner = envelope.get("event").cloned().unwrap_or(Value::Null);
        let event_id = inner
            .get("event_id")
            .and_then(Value::as_str)
            .or_else(|| envelope.get("event_id").and_then(Value::as_str))
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let timestamp = inner
            .get("timestamp")
            .and_then(Value::as_str)
            .or_else(|| envelope.get("timestamp").and_then(Value::as_str));
        let sequence = inner
            .get("sequence")
            .and_then(Value::as_i64)
            .or_else(|| envelope.get("sequence").and_then(Value::as_i64))
            .unwrap_or(0);
        tx.execute(
            "INSERT OR IGNORE INTO session_subagent_events (session_id, subagent_id, sequence, event_id, event_timestamp, event_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session_id,
                subagent_id,
                sequence,
                event_id,
                timestamp,
                serde_json::to_string(&inner).unwrap_or_else(|_| "{}".to_string())
            ],
        )?;
    }
    tx.commit()
}

pub fn list_session_subagents(conn: &Connection, session_id: &str) -> Result<Vec<SessionSubagent>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, subagent_id, provider, title, description, status, tool_call_id, subtitle, created_at, updated_at
         FROM session_subagents WHERE session_id = ?1 ORDER BY created_at, subagent_id",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        Ok(SessionSubagent {
            session_id: row.get(0)?,
            subagent_id: row.get(1)?,
            provider: row.get(2)?,
            title: row.get(3)?,
            description: row.get(4)?,
            status: row.get(5)?,
            tool_call_id: row.get(6)?,
            subtitle: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn load_session_subagent_events(
    conn: &Connection,
    session_id: &str,
    subagent_id: &str,
) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT event_json FROM session_subagent_events
         WHERE session_id = ?1 AND subagent_id = ?2 ORDER BY sequence",
    )?;
    let rows = stmt.query_map(params![session_id, subagent_id], |row| {
        let json: String = row.get(0)?;
        Ok(serde_json::from_str::<Value>(&json).unwrap_or(Value::Null))
    })?;
    rows.collect()
}

/// Session open reconcile: descriptors still `running` from a previous process
/// are marked `failed` (the sidecar that owned them is gone).
pub fn reconcile_running_session_subagents(conn: &Connection, session_id: &str) -> Result<usize> {
    conn.execute(
        "UPDATE session_subagents SET status = 'failed', updated_at = ?2
         WHERE session_id = ?1 AND status = 'running'",
        params![session_id, Utc::now().to_rfc3339()],
    )
}

#[cfg(test)]
mod tests {
    use super::{
        append_timeline_events, archive_session, clear_session_timeline, create_forked_session,
        delete_agent_session_mapping, fetch_session_timeline, get_agent_distribution,
        get_agent_session_mapping, get_all_archived_sessions, get_all_sessions,
        get_model_distribution, get_session, get_session_events_after, get_session_timeline,
        get_usage_heatmap, get_usage_overview, import_session_snapshot,
        list_native_sessions_for_cleanup, resolve_app_session_id_for_timeline, set_session_pinned,
        set_session_read_only, unarchive_session, update_session_provider,
        update_session_reasoning_effort, update_session_settings, upsert_agent_session_mapping,
        ImportedSessionSnapshot,
    };
    use crate::config::types::AgentKind;
    use crate::db::schema::initialize_database;
    use rusqlite::Connection;
    use serde_json::Value;

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

        let child = create_forked_session(
            &mut conn,
            "parent",
            "claude-child",
            "assistant-event-1",
            Some("provider-message-1"),
            "Parent · 分支",
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

        let events = get_session_timeline(&conn, &created.id).unwrap().unwrap();
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
    fn append_timeline_events_increments_sequence() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        let first =
            serde_json::json!({ "type": "user_message", "event_id": "e1", "content": "hi" });
        append_timeline_events(&mut conn, "session-1", &[first]).unwrap();
        let second =
            serde_json::json!({ "type": "assistant_message", "event_id": "e2", "content": [] });
        append_timeline_events(&mut conn, "session-1", &[second]).unwrap();

        let events = get_session_events_after(&conn, "session-1", -1).unwrap();
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn append_timeline_events_resolves_provider_session_ids() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "app-session-1", "claude_code");
        upsert_agent_session_mapping(
            &conn,
            "app-session-1",
            AgentKind::ClaudeCode,
            "claude-session-1",
        )
        .unwrap();

        let event = serde_json::json!({
            "type": "text_delta",
            "event_id": "delta-1",
            "text": "hello"
        });
        append_timeline_events(&mut conn, "claude-session-1", &[event]).unwrap();

        let events = get_session_events_after(&conn, "app-session-1", -1).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].get("session_id").and_then(Value::as_str),
            Some("app-session-1")
        );
        assert_eq!(
            resolve_app_session_id_for_timeline(&conn, "claude-session-1").unwrap(),
            "app-session-1"
        );
    }

    #[test]
    fn clear_session_timeline_removes_snapshots() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");
        append_timeline_events(
            &mut conn,
            "session-1",
            &[serde_json::json!({ "type": "user_message", "event_id": "e1", "content": "hi" })],
        )
        .unwrap();

        clear_session_timeline(&conn, "session-1").unwrap();

        assert!(get_session_timeline(&conn, "session-1").unwrap().is_none());
    }

    #[test]
    fn fetch_session_timeline_supports_tail_after_and_before_pages() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        let events: Vec<Value> = (0..5)
            .map(|index| serde_json::json!({ "type": "user_message", "event_id": format!("e{index}") }))
            .collect();
        append_timeline_events(&mut conn, "session-1", &events).unwrap();

        let tail =
            fetch_session_timeline(&conn, "session-1", super::TimelineDirection::Tail, None, 2)
                .unwrap();
        assert_eq!(tail.events.len(), 2);
        assert_eq!(tail.seq_start, 3);
        assert_eq!(tail.seq_end, 4);
        assert!(tail.has_older);
        assert!(!tail.has_newer);

        let after = fetch_session_timeline(
            &conn,
            "session-1",
            super::TimelineDirection::After,
            Some(1),
            2,
        )
        .unwrap();
        assert_eq!(after.seq_start, 2);
        assert_eq!(after.seq_end, 3);
        assert!(after.has_newer);

        let before = fetch_session_timeline(
            &conn,
            "session-1",
            super::TimelineDirection::Before,
            Some(3),
            2,
        )
        .unwrap();
        assert_eq!(before.seq_start, 1);
        assert_eq!(before.seq_end, 2);
        assert!(before.has_older);
        assert!(before.has_newer);

        for (index, event) in tail.events.iter().enumerate() {
            assert_eq!(event.get("sequence").and_then(Value::as_i64), Some((3 + index) as i64));
        }
    }

    #[test]
    fn subagent_sticky_upsert_preserves_omitted_fields_and_blocks_resurrection() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "provider": "claude",
                "title": "Explore",
                "description": "find entry points",
                "status": "running",
                "tool_call_id": "toolu_1"
            }),
        )
        .unwrap();

        // Omitted fields keep their value; subtitle arrives later.
        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "subtitle": "tokens up 3.2k"
            }),
        )
        .unwrap();

        // Terminal status, then a stale running patch must not resurrect.
        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "status": "completed"
            }),
        )
        .unwrap();
        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "status": "running"
            }),
        )
        .unwrap();

        let subagents = super::list_session_subagents(&conn, "session-1").unwrap();
        assert_eq!(subagents.len(), 1);
        let descriptor = &subagents[0];
        assert_eq!(descriptor.title.as_deref(), Some("Explore"));
        assert_eq!(descriptor.description.as_deref(), Some("find entry points"));
        assert_eq!(descriptor.subtitle.as_deref(), Some("tokens up 3.2k"));
        assert_eq!(descriptor.status, "completed");
    }

    #[test]
    fn replace_session_subagent_timeline_swaps_rows_in_sequence_order() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "opencode");

        super::append_session_subagent_event(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_timeline",
                "session_id": "session-1",
                "subagent_id": "call_1",
                "provider": "opencode",
                "event": { "type": "tool_started", "event_id": "old-1", "sequence": 0, "tool_use_id": "t1", "name": "read", "input": {} },
                "event_id": "env-old-1"
            }),
        )
        .unwrap();

        let replacement = vec![
            serde_json::json!({
                "type": "subagent_timeline",
                "session_id": "session-1",
                "subagent_id": "call_1",
                "event": { "type": "tool_started", "event_id": "new-1", "sequence": 0, "tool_use_id": "t1", "name": "read", "input": { "filePath": "D:/demo/package.json" } },
                "event_id": "env-new-1"
            }),
            serde_json::json!({
                "type": "subagent_timeline",
                "session_id": "session-1",
                "subagent_id": "call_1",
                "event": { "type": "tool_finished", "event_id": "new-2", "sequence": 1, "tool_use_id": "t1", "content": "body", "is_error": false },
                "event_id": "env-new-2"
            }),
        ];
        super::replace_session_subagent_timeline(&mut conn, "session-1", "call_1", &replacement)
            .unwrap();

        let events = super::load_session_subagent_events(&conn, "session-1", "call_1").unwrap();
        let kinds: Vec<&str> = events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["tool_started", "tool_finished"]);
        assert_eq!(events[0]["input"]["filePath"], "D:/demo/package.json");
        assert_eq!(events[1]["sequence"], 1);
    }

    #[test]
    fn subagent_upsert_explicit_null_clears_field() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "subtitle": "working"
            }),
        )
        .unwrap();
        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "subtitle": serde_json::Value::Null
            }),
        )
        .unwrap();

        let subagents = super::list_session_subagents(&conn, "session-1").unwrap();
        assert_eq!(subagents[0].subtitle, None);
    }

    #[test]
    fn subagent_events_dedup_on_event_id_and_load_in_sequence_order() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "provider": "claude",
                "status": "running"
            }),
        )
        .unwrap();

        let timeline_event = |sequence: i64, event_id: &str| {
            serde_json::json!({
                "type": "subagent_timeline",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "event": {
                    "type": "tool_started",
                    "tool_use_id": "child-1",
                    "name": "Grep",
                    "input": {},
                    "event_id": event_id,
                    "sequence": sequence
                }
            })
        };

        super::append_session_subagent_event(&mut conn, &timeline_event(0, "evt-0")).unwrap();
        super::append_session_subagent_event(&mut conn, &timeline_event(1, "evt-1")).unwrap();
        // Same event_id delivered again (fresh sequence) must not double-write.
        super::append_session_subagent_event(&mut conn, &timeline_event(9, "evt-1")).unwrap();

        let events = super::load_session_subagent_events(&conn, "session-1", "toolu_1").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["event_id"], "evt-0");
        assert_eq!(events[1]["event_id"], "evt-1");

        // Timeline rows never leak into the parent timeline.
        let parent = super::fetch_session_timeline(
            &conn,
            "session-1",
            super::TimelineDirection::Tail,
            None,
            50,
        )
        .unwrap();
        assert!(parent.events.is_empty());
    }

    #[test]
    fn deleting_session_cascades_subagent_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "provider": "claude",
                "status": "running"
            }),
        )
        .unwrap();
        super::append_session_subagent_event(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_timeline",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "event": { "type": "tool_started", "tool_use_id": "c1", "name": "Grep", "input": {}, "event_id": "e1", "sequence": 0 }
            }),
        )
        .unwrap();

        conn.execute("DELETE FROM sessions WHERE id = ?1", ["session-1"])
            .unwrap();

        assert!(super::list_session_subagents(&conn, "session-1")
            .unwrap()
            .is_empty());
        assert!(
            super::load_session_subagent_events(&conn, "session-1", "toolu_1")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn session_open_reconciles_stale_running_descriptors_to_failed() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        insert_test_session(&conn, "session-1", "claude_code");

        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_1",
                "provider": "claude",
                "status": "running"
            }),
        )
        .unwrap();
        super::upsert_session_subagent(
            &mut conn,
            &serde_json::json!({
                "type": "subagent_upsert",
                "session_id": "session-1",
                "subagent_id": "toolu_2",
                "provider": "claude",
                "status": "completed"
            }),
        )
        .unwrap();

        super::reconcile_running_session_subagents(&conn, "session-1").unwrap();

        let statuses: Vec<(String, String)> = super::list_session_subagents(&conn, "session-1")
            .unwrap()
            .into_iter()
            .map(|item| (item.subagent_id, item.status))
            .collect();
        assert_eq!(
            statuses,
            vec![
                ("toolu_1".to_string(), "failed".to_string()),
                ("toolu_2".to_string(), "completed".to_string()),
            ]
        );
    }
}
