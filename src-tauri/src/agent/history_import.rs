use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::str::FromStr;
use tauri::State;

use crate::agent::claude_subagent_history::load_claude_session_subagent_history;
use crate::agent::codex_subagent_history::load_codex_session_subagent_history;
use crate::agent::commands::{
    convert_codex_history_values_to_events, home_dir, should_include_claude_history_event,
};
use crate::agent::history_events::normalize_history_events;
use crate::agent::opencode_history;
use crate::agent::opencode_subagent_history::load_opencode_session_subagent_history;
use crate::config::types::AgentKind;
use crate::db::operations;

const MAX_SOURCE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_EVENTS: usize = 100_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub key: String,
    pub agent_kind: AgentKind,
    pub agent_session_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub source_locator: String,
    pub source_fingerprint: String,
    pub event_count: usize,
    pub already_imported: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSessionsRequest {
    pub candidate_keys: Vec<String>,
    pub project_id: Option<String>,
    pub refresh_existing: bool,
    pub agent_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSessionsResult {
    pub sessions: Vec<operations::Session>,
    pub imported_count: usize,
    pub refreshed_count: usize,
    pub skipped_keys: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
struct DiscoveredSnapshot {
    candidate: ImportCandidate,
    source_modified_at: String,
    events: Vec<Value>,
}

#[tauri::command]
pub async fn discover_importable_sessions(
    state: State<'_, crate::AppState>,
    agent_kind: Option<String>,
) -> Result<Vec<ImportCandidate>, String> {
    let home = home_dir()?;
    let agent_kind = parse_agent_kind_filter(agent_kind)?;
    let discovered = tokio::task::spawn_blocking(move || discover_all(&home, agent_kind))
        .await
        .map_err(|error| format!("扫描外部会话失败: {}", error))??;
    let db = state.db.lock().unwrap();

    Ok(discovered
        .into_iter()
        .map(|snapshot| {
            let already_imported = operations::get_imported_source(
                &db,
                snapshot.candidate.agent_kind,
                &snapshot.candidate.agent_session_id,
            )
            .ok()
            .flatten()
            .is_some();
            ImportCandidate {
                already_imported,
                ..snapshot.candidate
            }
        })
        .collect())
}

#[tauri::command]
pub fn import_sessions(
    state: State<'_, crate::AppState>,
    request: ImportSessionsRequest,
) -> Result<ImportSessionsResult, String> {
    let home = home_dir()?;
    let agent_kind = parse_agent_kind_filter(request.agent_kind.clone())?;
    let discovered = discover_all(&home, agent_kind)?;
    let by_key: HashMap<String, DiscoveredSnapshot> = discovered
        .into_iter()
        .map(|snapshot| (snapshot.candidate.key.clone(), snapshot))
        .collect();

    let mut db = state.db.lock().unwrap();
    let mut result = ImportSessionsResult {
        sessions: Vec::new(),
        imported_count: 0,
        refreshed_count: 0,
        skipped_keys: Vec::new(),
        errors: Vec::new(),
    };

    for key in request.candidate_keys {
        let Some(snapshot) = by_key.get(&key) else {
            result.skipped_keys.push(key);
            continue;
        };

        let was_imported = operations::get_imported_source(
            &db,
            snapshot.candidate.agent_kind,
            &snapshot.candidate.agent_session_id,
        )
        .map_err(|error| error.to_string())?
        .is_some();
        let imported = operations::ImportedSessionSnapshot {
            agent_kind: snapshot.candidate.agent_kind,
            agent_session_id: snapshot.candidate.agent_session_id.clone(),
            title: snapshot.candidate.title.clone(),
            created_at: snapshot.candidate.created_at.clone(),
            updated_at: snapshot.candidate.updated_at.clone(),
            project_id: request.project_id.clone(),
            source_locator: snapshot.candidate.source_locator.clone(),
            source_fingerprint: snapshot.candidate.source_fingerprint.clone(),
            source_modified_at: Some(snapshot.source_modified_at.clone()),
            cwd: snapshot.candidate.cwd.clone(),
            events: snapshot.events.clone(),
        };

        match operations::import_session_snapshot(&mut db, &imported, request.refresh_existing) {
            Ok((session, changed)) => {
                if changed {
                    if was_imported {
                        result.refreshed_count += 1;
                    } else {
                        result.imported_count += 1;
                    }
                }
                result.sessions.push(session);
            }
            Err(error) => result.errors.push(format!("{}: {}", key, error)),
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn load_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<Value>, String> {
    let session = {
        let db = state.db.lock().unwrap();
        operations::get_session(&db, &app_session_id).map_err(|error| error.to_string())?
    };

    let agent_kind = session
        .as_ref()
        .map(|session| session.agent_kind)
        .unwrap_or(AgentKind::ClaudeCode);

    let timeline = {
        let db = state.db.lock().unwrap();
        operations::get_session_timeline(&db, &app_session_id).map_err(|error| error.to_string())?
    };

    if timeline.as_ref().is_some_and(|events| !events.is_empty()) {
        return Ok(timeline.unwrap_or_default());
    }

    let has_mapping = {
        let db = state.db.lock().unwrap();
        has_native_mapping(&db, &app_session_id, agent_kind)?
    };
    let should_hydrate = session
        .as_ref()
        .map(|session| should_hydrate_timeline_from_native(session, &timeline, has_mapping))
        .unwrap_or(false);

    if should_hydrate {
        let native_events =
            load_native_session_events(state.clone(), &app_session_id, agent_kind).await?;
        if !native_events.is_empty() {
            let mut db = state.db.lock().unwrap();
            operations::replace_session_timeline(&mut db, &app_session_id, &native_events)
                .map_err(|error| error.to_string())?;
            if let Err(error) = backfill_subagent_history(&mut db, &app_session_id, agent_kind) {
                log::warn!(
                    target: "agent",
                    "Failed to backfill subagent history for app_session_id={}: {}",
                    app_session_id,
                    error
                );
            }
            return Ok(native_events);
        }
    }

    Ok(timeline.unwrap_or_default())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResyncSessionFromNativeResult {
    pub event_count: usize,
}

#[tauri::command]
pub async fn resync_session_from_native(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<ResyncSessionFromNativeResult, String> {
    let session = {
        let db = state.db.lock().unwrap();
        operations::get_session(&db, &app_session_id).map_err(|error| error.to_string())?
    };
    let Some(session) = session else {
        return Err(format!("Session not found: {}", app_session_id));
    };

    let agent_kind = session.agent_kind;
    let has_mapping = {
        let db = state.db.lock().unwrap();
        has_native_mapping(&db, &app_session_id, agent_kind)?
    };

    if !can_resync_session_from_native(&session, has_mapping) {
        return Err("此会话无法从 CLI 同步历史：需要已关联的原生会话且不能为只读".to_string());
    }

    let native_events =
        load_native_session_events(state.clone(), &app_session_id, agent_kind).await?;
    if native_events.is_empty() {
        return Err("未在 CLI 历史文件中找到可同步的消息".to_string());
    }

    {
        let mut db = state.db.lock().unwrap();
        operations::replace_session_timeline(&mut db, &app_session_id, &native_events)
            .map_err(|error| error.to_string())?;
        if let Err(error) = backfill_subagent_history(&mut db, &app_session_id, agent_kind) {
            log::warn!(
                target: "agent",
                "Failed to backfill subagent history for app_session_id={}: {}",
                app_session_id,
                error
            );
        }
        let updated_at = Utc::now().to_rfc3339();
        db.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![updated_at, app_session_id],
        )
        .map_err(|error| error.to_string())?;
    }

    Ok(ResyncSessionFromNativeResult {
        event_count: native_events.len(),
    })
}

pub(crate) fn can_resync_session_from_native(
    session: &operations::Session,
    has_mapping: bool,
) -> bool {
    !session.is_read_only && has_mapping && !matches!(session.agent_kind, AgentKind::GeminiCli)
}

fn has_native_mapping(
    conn: &Connection,
    app_session_id: &str,
    agent_kind: AgentKind,
) -> Result<bool, String> {
    operations::get_agent_session_mapping(conn, app_session_id, agent_kind)
        .map_err(|error| error.to_string())
        .map(|mapping| mapping.is_some())
}

pub(crate) fn should_hydrate_timeline_from_native(
    session: &operations::Session,
    timeline: &Option<Vec<Value>>,
    has_mapping: bool,
) -> bool {
    timeline.as_ref().is_none_or(Vec::is_empty) && session.origin == "native" && has_mapping
}

async fn load_native_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: &str,
    agent_kind: AgentKind,
) -> Result<Vec<Value>, String> {
    match agent_kind {
        AgentKind::ClaudeCode => {
            crate::agent::commands::load_claude_session_events(state, app_session_id.to_string())
                .await
        }
        AgentKind::Codex => {
            crate::agent::commands::load_codex_session_events(state, app_session_id.to_string())
                .await
        }
        AgentKind::Opencode => {
            crate::agent::commands::load_opencode_session_events(state, app_session_id.to_string())
                .await
        }
        AgentKind::GeminiCli => Ok(Vec::new()),
    }
}

/// Backfill subagent descriptors and timelines from the Claude CLI's on-disk
/// `subagents/` transcripts after a native history (re)sync. Descriptors that
/// already exist (live sidecar captures) are left untouched. `conn` is the
/// app database connection, already locked by the caller.
fn backfill_claude_subagent_history(
    conn: &mut Connection,
    app_session_id: &str,
) -> Result<usize, String> {
    let claude_session_id =
        operations::get_agent_session_mapping(conn, app_session_id, AgentKind::ClaudeCode)
            .map_err(|error| error.to_string())?
            .map(|record| record.agent_session_id);
    let Some(claude_session_id) = claude_session_id else {
        return Ok(0);
    };
    let claude_dir = home_dir()?.join(".claude");
    let entries =
        load_claude_session_subagent_history(&claude_dir, &claude_session_id, app_session_id);
    if entries.is_empty() {
        return Ok(0);
    }

    let existing_ids: std::collections::HashSet<String> =
        operations::list_session_subagents(conn, app_session_id)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|record| record.subagent_id)
            .collect();

    let mut restored = 0usize;
    for entry in entries {
        if existing_ids.contains(&entry.subagent_id) {
            continue;
        }
        operations::upsert_session_subagent(conn, &entry.upsert).map_err(|e| e.to_string())?;
        for event in &entry.timeline {
            operations::append_session_subagent_event(conn, event).map_err(|e| e.to_string())?;
        }
        restored += 1;
    }
    if restored > 0 {
        log::info!(
            target: "agent",
            "Restored {} subagent tracks from Claude CLI history for app_session_id={}",
            restored,
            app_session_id
        );
    }
    Ok(restored)
}

/// Backfill subagent descriptors and timelines from the provider CLI's on-disk
/// storage after a native history (re)sync. Existing descriptors (live sidecar
/// captures) are always left untouched.
fn backfill_subagent_history(
    conn: &mut Connection,
    app_session_id: &str,
    agent_kind: AgentKind,
) -> Result<usize, String> {
    match agent_kind {
        AgentKind::ClaudeCode => backfill_claude_subagent_history(conn, app_session_id),
        AgentKind::Codex => backfill_codex_subagent_history(conn, app_session_id),
        AgentKind::Opencode => backfill_opencode_subagent_history(conn, app_session_id),
        AgentKind::GeminiCli => Ok(0),
    }
}

/// Backfill subagent descriptors and timelines from Codex's on-disk rollout
/// files. Each collab child thread has its own rollout; the parent rollout's
/// successful `spawn_agent` output (`{"agent_id", "nickname"}`) binds the
/// parent-side `call_id` — the canonical subagent id — to the child rollout.
fn backfill_codex_subagent_history(
    conn: &mut Connection,
    app_session_id: &str,
) -> Result<usize, String> {
    let codex_session_id =
        operations::get_agent_session_mapping(conn, app_session_id, AgentKind::Codex)
            .map_err(|error| error.to_string())?
            .map(|record| record.agent_session_id);
    let Some(codex_session_id) = codex_session_id else {
        return Ok(0);
    };
    let entries =
        load_codex_session_subagent_history(&home_dir()?, &codex_session_id, app_session_id);
    if entries.is_empty() {
        return Ok(0);
    }

    let existing_ids: std::collections::HashSet<String> =
        operations::list_session_subagents(conn, app_session_id)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|record| record.subagent_id)
            .collect();

    let mut restored = 0usize;
    for entry in entries {
        if existing_ids.contains(&entry.subagent_id) {
            continue;
        }
        operations::upsert_session_subagent(conn, &entry.upsert).map_err(|e| e.to_string())?;
        for event in &entry.timeline {
            operations::append_session_subagent_event(conn, event).map_err(|e| e.to_string())?;
        }
        restored += 1;
    }
    if restored > 0 {
        log::info!(
            target: "agent",
            "Restored {} subagent tracks from Codex rollout history for app_session_id={}",
            restored,
            app_session_id
        );
    }
    Ok(restored)
}

/// Backfill subagent descriptors and timelines from OpenCode's on-disk
/// SQLite storage. Child sessions (`session.parent_id`) become subagent
/// tracks; the parent Task tool part's `callID` is the canonical id.
fn backfill_opencode_subagent_history(
    conn: &mut Connection,
    app_session_id: &str,
) -> Result<usize, String> {
    let opencode_session_id =
        operations::get_agent_session_mapping(conn, app_session_id, AgentKind::Opencode)
            .map_err(|error| error.to_string())?
            .map(|record| record.agent_session_id);
    let Some(opencode_session_id) = opencode_session_id else {
        return Ok(0);
    };
    let Some(db_path) = opencode_history::find_opencode_database(&home_dir()?) else {
        return Ok(0);
    };
    let connection =
        rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Failed to open OpenCode database: {}", error))?;
    let entries =
        load_opencode_session_subagent_history(&connection, &opencode_session_id, app_session_id);
    drop(connection);
    if entries.is_empty() {
        return Ok(0);
    }

    let existing_ids: std::collections::HashSet<String> =
        operations::list_session_subagents(conn, app_session_id)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|record| record.subagent_id)
            .collect();

    let mut restored = 0usize;
    let mut repaired = 0usize;
    for entry in entries {
        if existing_ids.contains(&entry.subagent_id) {
            // Live captures normally win. Exception: a lossy capture (older
            // sidecar builds dropped the refreshed tool_started, so tool
            // arguments are missing) is repaired from the disk timeline,
            // which always carries final complete parts.
            let existing_events =
                operations::load_session_subagent_events(conn, app_session_id, &entry.subagent_id)
                    .map_err(|error| error.to_string())?;
            if !live_capture_missing_tool_args(&existing_events, &entry.timeline) {
                continue;
            }
            operations::replace_session_subagent_timeline(
                conn,
                app_session_id,
                &entry.subagent_id,
                &entry.timeline,
            )
            .map_err(|e| e.to_string())?;
            repaired += 1;
            continue;
        }
        operations::upsert_session_subagent(conn, &entry.upsert).map_err(|e| e.to_string())?;
        for event in &entry.timeline {
            operations::append_session_subagent_event(conn, event).map_err(|e| e.to_string())?;
        }
        restored += 1;
    }
    if restored > 0 {
        log::info!(
            target: "agent",
            "Restored {} subagent tracks from OpenCode history for app_session_id={}",
            restored,
            app_session_id
        );
    }
    if repaired > 0 {
        log::info!(
            target: "agent",
            "Repaired {} lossy subagent timelines from OpenCode history for app_session_id={}",
            repaired,
            app_session_id
        );
    }
    Ok(restored)
}

/// True when the disk timeline carries content that the persisted
/// (live-captured) timeline lacks — the signature of a lossy capture made by
/// an older sidecar (missing refreshed tool arguments, or assistant text parts
/// dropped by the per-message snapshot dedupe). Healthy captures keep winning.
fn live_capture_missing_tool_args(existing_events: &[Value], restored_timeline: &[Value]) -> bool {
    let has_complete_args = |event: &Value| {
        event.get("type").and_then(Value::as_str) == Some("tool_started")
            && event
                .get("input")
                .and_then(Value::as_object)
                .is_some_and(|input| !input.is_empty())
    };
    let disk_tool_starts = restored_timeline
        .iter()
        .filter_map(|envelope| envelope.get("event"))
        .filter(|event| has_complete_args(event));
    for disk_event in disk_tool_starts {
        let tool_use_id = disk_event.get("tool_use_id").and_then(Value::as_str);
        let captured = existing_events.iter().any(|event| {
            has_complete_args(event)
                && event.get("tool_use_id").and_then(Value::as_str) == tool_use_id
        });
        if !captured {
            return true;
        }
    }

    // Assistant text blocks: any disk text missing from the captured
    // assistant_message envelopes means text parts were dropped.
    let captured_texts: std::collections::HashSet<String> = existing_events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("assistant_message"))
        .flat_map(|event| {
            event
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| blocks.as_slice())
                .unwrap_or(&[])
                .to_vec()
        })
        .filter_map(|block| {
            block
                .get("text")
                .and_then(Value::as_str)
                .map(|text| text.trim().to_owned())
        })
        .filter(|text| !text.is_empty())
        .collect();
    let disk_texts = restored_timeline
        .iter()
        .filter_map(|envelope| envelope.get("event"))
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("assistant_message"))
        .flat_map(|event| {
            event
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| blocks.as_slice())
                .unwrap_or(&[])
                .to_vec()
        });
    for block in disk_texts {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = block.get("text").and_then(Value::as_str) else {
            continue;
        };
        let text = text.trim();
        if !text.is_empty() && !captured_texts.contains(text) {
            return true;
        }
    }
    false
}

#[tauri::command]
pub fn fetch_session_timeline(
    state: State<'_, crate::AppState>,
    session_id: String,
    direction: Option<String>,
    cursor: Option<i64>,
    limit: Option<usize>,
) -> Result<operations::SessionTimelinePage, String> {
    let db = state.db.lock().unwrap();
    let direction = operations::parse_timeline_direction(direction.as_deref());
    let limit = limit.unwrap_or(operations::DEFAULT_SESSION_TIMELINE_LIMIT);
    operations::fetch_session_timeline(&db, &session_id, direction, cursor, limit)
        .map_err(|error| error.to_string())
}

fn parse_agent_kind_filter(value: Option<String>) -> Result<Option<AgentKind>, String> {
    value
        .filter(|value| !value.is_empty() && value != "all")
        .map(|value| AgentKind::from_str(&value).map_err(|error| error.to_string()))
        .transpose()
}

fn discover_all(
    home: &Path,
    agent_kind: Option<AgentKind>,
) -> Result<Vec<DiscoveredSnapshot>, String> {
    let mut snapshots = Vec::new();
    if agent_kind.is_none() || agent_kind == Some(AgentKind::ClaudeCode) {
        snapshots.extend(discover_claude(home));
    }
    if agent_kind.is_none() || agent_kind == Some(AgentKind::Codex) {
        snapshots.extend(discover_codex(home));
    }
    if agent_kind.is_none() || agent_kind == Some(AgentKind::Opencode) {
        snapshots.extend(discover_opencode(home));
    }
    snapshots.sort_by(|left, right| right.candidate.updated_at.cmp(&left.candidate.updated_at));
    Ok(snapshots)
}

fn discover_claude(home: &Path) -> Vec<DiscoveredSnapshot> {
    let root = home.join(".claude").join("projects");
    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files);
    files
        .into_iter()
        .filter_map(|path| {
            let session_id = path.file_stem()?.to_string_lossy().to_string();
            let (raw, malformed) = read_jsonl_values(&path).ok()?;
            let raw: Vec<Value> = raw
                .into_iter()
                .filter(should_include_claude_history_event)
                .collect();
            let events = normalize_history_events(raw.clone(), &session_id);
            if events.is_empty() {
                return None;
            }
            Some(build_snapshot(
                AgentKind::ClaudeCode,
                session_id,
                path,
                events,
                malformed.then(|| "部分 JSONL 记录无法解析".to_string()),
            ))
        })
        .collect()
}

fn discover_codex(home: &Path) -> Vec<DiscoveredSnapshot> {
    let root = home.join(".codex").join("sessions");
    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files);
    files
        .into_iter()
        .filter_map(|path| {
            let (raw, malformed) = read_jsonl_values(&path).ok()?;
            let meta = raw
                .iter()
                .find(|value| value.get("type").and_then(Value::as_str) == Some("session_meta"))?;
            let session_id = meta
                .get("payload")
                .and_then(|payload| payload.get("id"))
                .and_then(Value::as_str)?
                .to_string();
            let cwd = meta
                .get("payload")
                .and_then(|payload| payload.get("cwd"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let mut events = convert_codex_history_values_to_events(&raw, &session_id);
            if let Some(cwd) = cwd {
                for event in &mut events {
                    if let Some(object) = event.as_object_mut() {
                        object.insert("cwd".to_string(), Value::String(cwd.clone()));
                    }
                }
            }
            if events.is_empty() {
                return None;
            }
            Some(build_snapshot(
                AgentKind::Codex,
                session_id,
                path,
                events,
                malformed.then(|| "部分 JSONL 记录无法解析".to_string()),
            ))
        })
        .collect()
}

fn discover_opencode(home: &Path) -> Vec<DiscoveredSnapshot> {
    let Some(path) = opencode_history::find_opencode_database(home) else {
        return Vec::new();
    };
    let Ok(connection) =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return Vec::new();
    };
    let Ok(mut statement) =
        connection.prepare("SELECT DISTINCT session_id FROM message ORDER BY session_id ASC")
    else {
        return Vec::new();
    };
    let Ok(session_ids) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };

    session_ids
        .filter_map(Result::ok)
        .filter_map(|session_id| {
            let raw = opencode_history::load_opencode_native_events(home, &session_id).ok()?;
            let events = normalize_history_events(raw, &session_id);
            if events.is_empty() {
                return None;
            }
            Some(build_snapshot(
                AgentKind::Opencode,
                session_id,
                path.clone(),
                events,
                None,
            ))
        })
        .collect()
}

fn build_snapshot(
    agent_kind: AgentKind,
    agent_session_id: String,
    path: PathBuf,
    events: Vec<Value>,
    warning: Option<String>,
) -> DiscoveredSnapshot {
    let metadata = fs::metadata(&path).ok();
    let modified = metadata
        .as_ref()
        .and_then(|value| value.modified().ok())
        .map(format_system_time)
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let fingerprint = format!(
        "{}:{}:{}",
        path.display(),
        metadata.as_ref().map(|value| value.len()).unwrap_or(0),
        modified
    );
    let timestamps: Vec<&str> = events
        .iter()
        .filter_map(|event| event.get("timestamp").and_then(Value::as_str))
        .collect();
    let created_at = timestamps.first().copied().unwrap_or(&modified).to_string();
    let updated_at = timestamps.last().copied().unwrap_or(&modified).to_string();
    let cwd = events
        .iter()
        .find_map(|event| event.get("cwd").and_then(Value::as_str))
        .map(ToOwned::to_owned);
    let title = first_user_text(&events)
        .map(|text| truncate_title(&text))
        .unwrap_or_else(|| {
            format!(
                "{} 会话 {}",
                agent_label(agent_kind),
                &agent_session_id[..agent_session_id.len().min(8)]
            )
        });
    let warnings = warning.into_iter().collect();

    DiscoveredSnapshot {
        candidate: ImportCandidate {
            key: format!("{}:{}", agent_kind.as_str(), agent_session_id),
            agent_kind,
            agent_session_id,
            title,
            cwd,
            created_at,
            updated_at,
            source_locator: path.display().to_string(),
            source_fingerprint: fingerprint,
            event_count: events.len(),
            already_imported: false,
            warnings,
        },
        source_modified_at: modified,
        events,
    }
}

fn collect_jsonl_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry
            .file_type()
            .map(|value| value.is_dir())
            .unwrap_or(false)
        {
            collect_jsonl_files(&path, output);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

fn read_jsonl_values(path: &Path) -> Result<(Vec<Value>, bool), String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "历史文件超过 {} MB",
            MAX_SOURCE_BYTES / 1024 / 1024
        ));
    }
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let reader = BufReader::new(file);
    let mut values = Vec::new();
    let mut malformed = false;
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => {
                malformed = true;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(value) => {
                values.push(value);
                if values.len() >= MAX_EVENTS {
                    malformed = true;
                    break;
                }
            }
            Err(_) => malformed = true,
        }
    }
    Ok((values, malformed))
}

fn first_user_text(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        let is_user = matches!(
            event.get("type").and_then(Value::as_str),
            Some("user") | Some("user_message")
        );
        if !is_user {
            return None;
        }
        let content = event
            .get("content")
            .or_else(|| event.get("message")?.get("content"))?;
        if let Some(text) = content.as_str() {
            return (!text.trim().is_empty()).then(|| text.trim().to_string());
        }
        content.as_array()?.iter().find_map(|block| {
            block
                .get("text")
                .and_then(Value::as_str)
                .map(|text| text.trim().to_string())
        })
    })
}

fn truncate_title(value: &str) -> String {
    let first_line = value.lines().next().unwrap_or(value).trim();
    let mut title = first_line.chars().take(80).collect::<String>();
    if first_line.chars().count() > 80 {
        title.push('…');
    }
    title
}

fn format_system_time(value: std::time::SystemTime) -> String {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| DateTime::<Utc>::from_timestamp(duration.as_secs() as i64, 0))
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

fn agent_label(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::ClaudeCode => "Claude Code",
        AgentKind::Codex => "Codex",
        AgentKind::Opencode => "OpenCode",
        AgentKind::GeminiCli => "Gemini CLI",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn detects_lossy_capture_missing_tool_arguments() {
        // Old sidecar capture: only the empty-input pending tool_started.
        let existing = vec![serde_json::json!({
            "type": "tool_started", "tool_use_id": "t1", "input": {}
        })];
        let disk_timeline = vec![serde_json::json!({
            "type": "subagent_timeline",
            "event": { "type": "tool_started", "tool_use_id": "t1", "input": { "filePath": "a.rs" } }
        })];
        assert!(live_capture_missing_tool_args(&existing, &disk_timeline));

        // Healthy capture: the refreshed tool_started carries full args.
        let healthy = vec![serde_json::json!({
            "type": "tool_started", "tool_use_id": "t1", "input": { "filePath": "a.rs" }
        })];
        assert!(!live_capture_missing_tool_args(&healthy, &disk_timeline));

        // Disk timeline without tools never triggers a repair.
        let text_only = vec![serde_json::json!({
            "type": "subagent_timeline",
            "event": { "type": "assistant_message", "content": [] }
        })];
        assert!(!live_capture_missing_tool_args(&existing, &text_only));
    }

    #[test]
    fn detects_lossy_capture_missing_assistant_text() {
        // Old sidecar capture: only the thinking envelope survived the
        // per-message snapshot dedupe; the summary text part was dropped.
        let existing = vec![serde_json::json!({
            "type": "assistant_message",
            "content": [{ "type": "thinking", "thinking": "let me summarize" }]
        })];
        let disk_timeline = vec![
            serde_json::json!({
                "type": "subagent_timeline",
                "event": { "type": "assistant_message", "content": [{ "type": "thinking", "thinking": "let me summarize" }] }
            }),
            serde_json::json!({
                "type": "subagent_timeline",
                "event": { "type": "assistant_message", "content": [{ "type": "text", "text": "Here is a concise summary" }] }
            }),
        ];
        assert!(live_capture_missing_tool_args(&existing, &disk_timeline));

        // Healthy capture: the text envelope is present with identical text.
        let healthy = vec![
            serde_json::json!({
                "type": "assistant_message",
                "content": [{ "type": "thinking", "thinking": "let me summarize" }]
            }),
            serde_json::json!({
                "type": "assistant_message",
                "content": [{ "type": "text", "text": "Here is a concise summary" }]
            }),
        ];
        assert!(!live_capture_missing_tool_args(&healthy, &disk_timeline));
    }

    fn test_home(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "codemux-history-import-{}-{}",
            name,
            Uuid::new_v4()
        ))
    }

    #[test]
    fn discovers_claude_jsonl_and_filters_meta_records() {
        let home = test_home("claude");
        let project_dir = home.join(".claude/projects/demo");
        fs::create_dir_all(&project_dir).unwrap();
        let path = project_dir.join("claude-session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"content\":\"internal\"}}\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"请检查项目\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"好的\"}]}}\n",
                "{\"type\":\"result\",\"subtype\":\"success\"}\n",
                "损坏的 JSON\n"
            ),
        )
        .unwrap();

        let snapshots = discover_claude(&home);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].candidate.agent_session_id, "claude-session");
        assert_eq!(snapshots[0].candidate.event_count, 3);
        assert!(snapshots[0]
            .candidate
            .warnings
            .iter()
            .any(|warning| warning.contains("JSONL")));
        assert!(snapshots[0]
            .events
            .iter()
            .all(|event| event.to_string().find("internal").is_none()));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn discovers_codex_session_meta_and_converts_events() {
        let home = test_home("codex");
        let session_dir = home.join(".codex/sessions/2026/07");
        fs::create_dir_all(&session_dir).unwrap();
        let path = session_dir.join("history.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-session\",\"cwd\":\"C:/workspace\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"列出文件\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"已完成\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n"
            ),
        )
        .unwrap();

        let snapshots = discover_codex(&home);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].candidate.agent_session_id, "codex-session");
        assert_eq!(snapshots[0].candidate.cwd.as_deref(), Some("C:/workspace"));
        assert!(snapshots[0]
            .events
            .iter()
            .any(|event| event.get("type").and_then(Value::as_str) == Some("turn_finished")));

        let _ = fs::remove_dir_all(home);
    }

    fn test_session(origin: &str) -> operations::Session {
        operations::Session {
            id: "session-1".to_string(),
            title: "Test".to_string(),
            agent_kind: AgentKind::Opencode,
            provider_id: None,
            model: None,
            reasoning_effort: None,
            mode: Some("agent".to_string()),
            permission_config: None,
            plan_mode: None,
            project_id: None,
            origin: origin.to_string(),
            is_read_only: false,
            is_archived: false,
            is_pinned: false,
            working_path: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            parent_session_id: None,
        }
    }

    #[test]
    fn resync_requires_mapping_and_writable_session() {
        let session = test_session("native");
        assert!(super::can_resync_session_from_native(&session, true));
        assert!(!super::can_resync_session_from_native(&session, false));
        assert!(!super::can_resync_session_from_native(
            &operations::Session {
                is_read_only: true,
                ..session.clone()
            },
            true,
        ));
        assert!(super::can_resync_session_from_native(
            &test_session("imported"),
            true,
        ));
        assert!(!super::can_resync_session_from_native(
            &operations::Session {
                agent_kind: AgentKind::GeminiCli,
                ..session
            },
            true,
        ));
    }

    #[test]
    fn hydrates_only_empty_native_timelines_with_mapping() {
        let session = test_session("native");
        let timeline = Some(vec![serde_json::json!({"type": "user_message"})]);

        assert!(!super::should_hydrate_timeline_from_native(
            &session, &timeline, true
        ));
        assert!(!super::should_hydrate_timeline_from_native(
            &session, &None, false
        ));
        assert!(!super::should_hydrate_timeline_from_native(
            &test_session("imported"),
            &None,
            true,
        ));
        assert!(super::should_hydrate_timeline_from_native(
            &session, &None, true
        ));
    }

    #[test]
    fn persisted_timeline_skips_native_hydration() {
        use crate::db::{operations, schema::initialize_database};
        use rusqlite::Connection;

        let mut conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, origin, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "session-1",
                "Test",
                "opencode",
                "agent",
                "native",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();
        operations::append_timeline_events(
            &mut conn,
            "session-1",
            &[serde_json::json!({
                "type": "user_message",
                "event_id": "e1",
                "content": "hello"
            })],
        )
        .unwrap();

        let timeline = operations::get_session_timeline(&conn, "session-1").unwrap();
        let session = test_session("native");
        assert!(!super::should_hydrate_timeline_from_native(
            &session, &timeline, true
        ));
        assert_eq!(timeline.as_ref().map(|events| events.len()), Some(1));
    }
}
