use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use crate::commands::provider::CLAUDE_DEFAULT_SUPPLIER_ID;
use crate::config::types::AgentKind;
use crate::db::operations;
use crate::provider_profiles::types::NativeProfileConfig;
use log::{debug, info, warn};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use super::context_usage::{
    latest_claude_usage_from_values, latest_codex_usage_from_values, ThreadTokenUsageSnapshot,
};
use super::history_events::normalize_history_events;
use super::opencode_history;
use super::{spawn_sidecar, SidecarHandle};
use crate::agent_runtime::opencode::OpenCodeRuntime;

pub(crate) fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| "Cannot determine home directory".to_string())
}

pub(crate) fn get_agent_session_id(
    state: &crate::AppState,
    app_session_id: &str,
    agent_kind: AgentKind,
) -> Result<Option<String>, String> {
    let db = state.db.lock().unwrap();
    operations::get_agent_session_mapping(&db, app_session_id, agent_kind)
        .map(|mapping| mapping.map(|record| record.agent_session_id))
        .map_err(|err| err.to_string())
}

fn resolve_session_agent_kind(state: &crate::AppState, session_id: &str) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    crate::agent_runtime::factory::session_runtime_kind_name(&db, session_id)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedRuntimeConfig {
    profile_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    codex_needs_proxy: Option<bool>,
    provider: Option<String>,
    credential_source: Option<String>,
}

fn resolve_active_runtime_config(
    state: &crate::AppState,
    session_id: &str,
) -> Result<ResolvedRuntimeConfig, String> {
    let agent_kind = resolve_session_agent_kind(state, session_id)?
        .parse::<AgentKind>()
        .map_err(|error| format!("无法解析会话智能体类型: {}", error))?;
    let config = state.config.lock().unwrap();
    let (persisted_profile_id, persisted_model): (Option<String>, Option<String>) = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT provider_id, model FROM sessions WHERE id = ?1 LIMIT 1",
            [session_id],
            |row| {
                let pid: Option<String> = row.get(0)?;
                let model: Option<String> = row.get(1)?;
                Ok((pid, model))
            },
        )
        .map_err(|error| format!("无法读取会话档案快照: {}", error))?
    };
    let session_model = persisted_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty());
    let profile_id = persisted_profile_id.as_deref().or_else(|| {
        if session_model.is_some() && agent_kind == AgentKind::ClaudeCode {
            return Some(CLAUDE_DEFAULT_SUPPLIER_ID);
        }
        config
            .agent_profile_registry
            .active_profile_ids
            .get(&agent_kind)
            .map(String::as_str)
    });
    if profile_id.is_none() && agent_kind == AgentKind::ClaudeCode && session_model.is_none() {
        let resolved = resolve_default_claude_runtime_config();
        drop(config);
        let db = state.db.lock().unwrap();
        operations::update_session_provider(&db, session_id, Some(&resolved.profile_id), "", None)
            .map_err(|error| format!("无法保存会话默认供应商快照: {}", error))?;
        return Ok(resolved);
    }
    if profile_id.is_none() && agent_kind == AgentKind::Opencode {
        drop(config);
        return Ok(ResolvedRuntimeConfig {
            profile_id: String::new(),
            api_key: None,
            base_url: None,
            model: session_model.map(|model| model.to_string()),
            codex_needs_proxy: None,
            provider: None,
            credential_source: None,
        });
    }
    let profile_id =
        profile_id.ok_or_else(|| format!("{} 尚未启用供应商档案", agent_kind.as_str()))?;
    if agent_kind == AgentKind::ClaudeCode && profile_id == CLAUDE_DEFAULT_SUPPLIER_ID {
        drop(config);
        return Ok(ResolvedRuntimeConfig {
            profile_id: CLAUDE_DEFAULT_SUPPLIER_ID.to_string(),
            api_key: None,
            base_url: None,
            model: session_model.map(|model| model.to_string()),
            codex_needs_proxy: None,
            provider: None,
            credential_source: None,
        });
    }
    let profile = config
        .agent_profile_registry
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.agent_kind == agent_kind)
        .ok_or_else(|| "已启用供应商档案不存在或智能体不匹配".to_string())?;

    let model = session_model
        .map(str::to_string)
        .or_else(|| {
            let default_model = profile.default_model.trim();
            (!default_model.is_empty()).then(|| default_model.to_string())
        })
        .or_else(|| {
            profile
                .models
                .iter()
                .map(|model| model.id.trim())
                .find(|model| !model.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| "已启用供应商档案没有可用模型".to_string())?;

    let (api_key, base_url, codex_needs_proxy, provider, credential_source) =
        match &profile.native_config {
            NativeProfileConfig::ClaudeCode { .. } => (
                profile
                    .native_config
                    .claude_env_value("ANTHROPIC_AUTH_TOKEN")
                    .filter(|value| !value.trim().is_empty())
                    .map(ToOwned::to_owned),
                profile
                    .native_config
                    .claude_env_value("ANTHROPIC_BASE_URL")
                    .filter(|value| !value.trim().is_empty())
                    .map(ToOwned::to_owned),
                None,
                None,
                None,
            ),
            NativeProfileConfig::Codex {
                api_key,
                openai_base_url,
                codex_needs_proxy,
                ..
            } => (
                (!api_key.trim().is_empty()).then(|| api_key.clone()),
                (!openai_base_url.trim().is_empty()).then(|| openai_base_url.clone()),
                *codex_needs_proxy,
                None,
                None,
            ),
            NativeProfileConfig::OpenCode {
                api_key,
                openai_base_url,
                provider_key,
                ..
            } => {
                let pk = provider_key.as_deref().unwrap_or("codemux-openai");
                (
                    (!api_key.trim().is_empty()).then(|| api_key.clone()),
                    (!openai_base_url.trim().is_empty()).then(|| openai_base_url.clone()),
                    None,
                    Some(pk.to_string()),
                    Some("codemux".to_string()),
                )
            }
        };

    let resolved = ResolvedRuntimeConfig {
        profile_id: profile.id.clone(),
        api_key,
        base_url,
        model: Some(model),
        codex_needs_proxy,
        provider,
        credential_source,
    };
    drop(config);

    if persisted_profile_id.is_none() && session_model.is_none() {
        let db = state.db.lock().unwrap();
        operations::update_session_provider(
            &db,
            session_id,
            Some(&resolved.profile_id),
            resolved.model.as_deref().unwrap_or_default(),
            None,
        )
        .map_err(|error| format!("无法保存会话供应商档案快照: {}", error))?;
    }

    Ok(resolved)
}

fn resolve_default_claude_runtime_config() -> ResolvedRuntimeConfig {
    ResolvedRuntimeConfig {
        profile_id: CLAUDE_DEFAULT_SUPPLIER_ID.to_string(),
        api_key: None,
        base_url: None,
        model: None,
        codex_needs_proxy: None,
        provider: None,
        credential_source: None,
    }
}

pub(crate) fn find_claude_session_jsonl(
    claude_dir: &Path,
    claude_session_id: &str,
) -> Option<PathBuf> {
    use std::fs;

    let projects_dir = claude_dir.join("projects");
    if !projects_dir.exists() {
        return None;
    }
    for entry in fs::read_dir(&projects_dir).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let jsonl = entry.path().join(format!("{}.jsonl", claude_session_id));
        if jsonl.exists() {
            return Some(jsonl);
        }
    }
    None
}

fn should_include_claude_history_event(val: &serde_json::Value) -> bool {
    if val
        .get("isSidechain")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false)
    {
        return false;
    }

    if val
        .get("isMeta")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false)
    {
        return false;
    }

    let msg_type = val
        .get("type")
        .and_then(|entry| entry.as_str())
        .unwrap_or("");
    if msg_type == "user" || msg_type == "assistant" || msg_type == "result" {
        return true;
    }

    msg_type == "system"
        && val.get("subtype").and_then(|entry| entry.as_str()) == Some("compact_boundary")
}

fn first_non_empty_line(path: &Path) -> Option<String> {
    use std::fs::File;
    use std::io::{BufRead, BufReader};

    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let line = line.ok()?;
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn read_codex_session_meta_id(path: &Path) -> Option<String> {
    let line = first_non_empty_line(path)?;
    let value = serde_json::from_str::<serde_json::Value>(&line).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("session_meta") {
        return None;
    }

    value
        .get("payload")
        .and_then(|payload| payload.get("id"))
        .and_then(|entry| entry.as_str())
        .map(|id| id.to_string())
}

fn sanitize_file_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn split_jsonl_preserving_newlines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }

    content
        .split_inclusive('\n')
        .map(|line| line.to_string())
        .collect()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindTarget {
    pub provider_message_id: Option<String>,
    pub source_event_index: Option<usize>,
    pub line_index: Option<usize>,
    pub role: Option<String>,
    pub text_fingerprint: Option<String>,
    pub turn_ordinal: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RewindOutcome {
    truncated_to_empty: bool,
}

fn is_claude_visible_user_value(value: &serde_json::Value) -> bool {
    if !should_include_claude_history_event(value) {
        return false;
    }
    value.get("type").and_then(|entry| entry.as_str()) == Some("user")
}

// A turn boundary marks the end of a previous turn when scanning backwards.
// We stop scanning at `result` events and at assistant messages that carry a
// `text` content block (the final reply to the user). Thinking-only and
// tool_use-only assistant messages are mid-turn and must NOT stop the scan —
// Claude Code emits thinking, tool_use, and text as separate assistant lines,
// so only the text line reliably signals "turn finished replying".
fn is_claude_turn_boundary(value: &serde_json::Value) -> bool {
    let msg_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if msg_type == "result" {
        return true;
    }
    if msg_type == "assistant" {
        return value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            })
            .unwrap_or(false);
    }
    false
}

fn is_codex_visible_user_value(value: &serde_json::Value) -> bool {
    let Some(payload) = value.get("payload") else {
        return false;
    };

    if value.get("type").and_then(|entry| entry.as_str()) == Some("response_item") {
        return payload.get("type").and_then(|entry| entry.as_str()) == Some("message")
            && payload.get("role").and_then(|entry| entry.as_str()) == Some("user");
    }

    value.get("type").and_then(|entry| entry.as_str()) == Some("event_msg")
        && payload.get("type").and_then(|entry| entry.as_str()) == Some("user_message")
}

fn is_rewind_user_value(value: &serde_json::Value, agent_kind: AgentKind) -> bool {
    match agent_kind {
        AgentKind::Codex => is_codex_visible_user_value(value),
        AgentKind::ClaudeCode | AgentKind::GeminiCli | AgentKind::Opencode => {
            is_claude_visible_user_value(value)
        }
    }
}

fn extract_provider_message_id(value: &serde_json::Value, agent_kind: AgentKind) -> Option<String> {
    let direct = ["uuid", "id", "message_id", "messageId"]
        .iter()
        .find_map(|key| value.get(key).and_then(|entry| entry.as_str()));
    if direct.is_some() {
        return direct.map(ToString::to_string);
    }

    if matches!(agent_kind, AgentKind::Codex) {
        return value.get("payload").and_then(|payload| {
            ["id", "uuid", "message_id", "messageId"]
                .iter()
                .find_map(|key| payload.get(key).and_then(|entry| entry.as_str()))
                .map(ToString::to_string)
        });
    }

    None
}

fn extract_user_text_for_rewind(value: &serde_json::Value) -> String {
    let Some(message) = value.get("message") else {
        return value
            .get("payload")
            .and_then(|payload| {
                payload
                    .get("message")
                    .or_else(|| payload.get("text"))
                    .and_then(|entry| entry.as_str())
            })
            .unwrap_or("")
            .to_string();
    };

    let Some(content) = message.get("content") else {
        return String::new();
    };

    if let Some(text) = content.as_str() {
        return text.to_string();
    }

    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(|entry| entry.as_str()) == Some("text") {
                        block.get("text").and_then(|entry| entry.as_str())
                    } else if block.get("type").and_then(|entry| entry.as_str())
                        == Some("input_text")
                    {
                        block.get("text").and_then(|entry| entry.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn normalize_rewind_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_targetable_rewind_user_value(value: &serde_json::Value, agent_kind: AgentKind) -> bool {
    if !is_rewind_user_value(value, agent_kind) {
        return false;
    }

    if value
        .get("isMeta")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false)
    {
        return false;
    }

    let content = value
        .get("message")
        .and_then(|message| message.get("content"));
    if content
        .and_then(|entry| entry.as_array())
        .map(|blocks| {
            blocks.iter().any(|block| {
                block.get("type").and_then(|entry| entry.as_str()) == Some("tool_result")
            })
        })
        .unwrap_or(false)
    {
        return false;
    }

    let text = extract_user_text_for_rewind(value);
    let trimmed = text.trim_start();
    if trimmed.starts_with("Base directory for this skill: ")
        || (trimmed.starts_with("# AGENTS.md instructions for ")
            && trimmed.contains("<INSTRUCTIONS>"))
    {
        return false;
    }

    true
}

fn rewind_target_matches(
    value: &serde_json::Value,
    line_index: usize,
    targetable_ordinal: usize,
    agent_kind: AgentKind,
    target: &RewindTarget,
) -> bool {
    if let Some(role) = target
        .role
        .as_deref()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if role != "user" {
            return false;
        }
    }

    if let Some(provider_message_id) = target
        .provider_message_id
        .as_deref()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if extract_provider_message_id(value, agent_kind).as_deref() == Some(provider_message_id) {
            return true;
        }
    }

    if target.line_index == Some(line_index) {
        return true;
    }

    if let Some(source_event_index) = target.source_event_index {
        if source_event_index == line_index {
            return true;
        }
    }

    if let Some(turn_ordinal) = target.turn_ordinal {
        if turn_ordinal == targetable_ordinal {
            if let Some(text_fingerprint) = target
                .text_fingerprint
                .as_deref()
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
            {
                return normalize_rewind_text(&extract_user_text_for_rewind(value))
                    == normalize_rewind_text(text_fingerprint);
            }
            return true;
        }
    }

    false
}

fn find_rewind_user_line_by_target(
    lines: &[String],
    agent_kind: AgentKind,
    target: &RewindTarget,
) -> Option<usize> {
    let mut targetable_ordinal = 0usize;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if !is_targetable_rewind_user_value(&value, agent_kind) {
            continue;
        }
        targetable_ordinal += 1;
        if rewind_target_matches(&value, index, targetable_ordinal, agent_kind, target) {
            return Some(index);
        }
    }

    None
}

fn find_latest_rewind_user_line(lines: &[String], agent_kind: AgentKind) -> Option<usize> {
    // Step 1: find the latest user line (any type: "user" — plain text, meta,
    // command XML echo, or tool_result). All of these belong to the current turn.
    let mut latest_user_index: Option<usize> = None;
    for (index, line) in lines.iter().enumerate().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if is_rewind_user_value(&value, agent_kind) {
            latest_user_index = Some(index);
            break;
        }
    }
    let latest_user_index = latest_user_index?;

    // For Codex there is no explicit result/text-only assistant boundary marker
    // in the JSONL, so we treat the latest user line as the turn start.
    if !matches!(
        agent_kind,
        AgentKind::ClaudeCode | AgentKind::GeminiCli | AgentKind::Opencode
    ) {
        return Some(latest_user_index);
    }

    // Step 2: scan backwards to find the earliest user line in this turn.
    // We stop at turn boundaries (result events, text-only assistant replies).
    // Assistant messages with tool_use blocks are within-turn (mid-turn tool
    // calls), so we keep scanning past them. All user lines encountered
    // (including meta, XML echo, tool_result) belong to this turn.
    let mut earliest_user_index = latest_user_index;
    for index in (0..latest_user_index).rev() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if is_claude_turn_boundary(&value) {
            break;
        }
        if is_rewind_user_value(&value, agent_kind) {
            earliest_user_index = index;
        }
    }

    Some(earliest_user_index)
}

#[cfg(test)]
fn rewind_jsonl_before_latest_turn(
    path: &Path,
    agent_kind: AgentKind,
) -> Result<RewindOutcome, String> {
    rewind_jsonl_before_target_turn(path, agent_kind, None)
}

fn rewind_jsonl_before_target_turn(
    path: &Path,
    agent_kind: AgentKind,
    target: Option<RewindTarget>,
) -> Result<RewindOutcome, String> {
    use std::fs;

    let content = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read session history {}: {}", path.display(), err))?;
    let lines = split_jsonl_preserving_newlines(&content);
    let user_line_index = if let Some(target) = target.as_ref() {
        find_rewind_user_line_by_target(&lines, agent_kind, target).ok_or_else(|| {
            format!(
                "Target rewind user message not found in session history {}",
                path.display()
            )
        })?
    } else {
        find_latest_rewind_user_line(&lines, agent_kind).ok_or_else(|| {
            format!(
                "No rewindable user message found in session history {}",
                path.display()
            )
        })?
    };

    let next_content = lines[..user_line_index].concat();
    // Atomic write: write to a temp file first, then rename over the original.
    // This prevents corruption if the process crashes mid-write or the sidecar
    // is concurrently appending to the same file.
    let tmp_path = path.with_extension(format!("jsonl.tmp.{}", uuid::Uuid::new_v4()));
    fs::write(&tmp_path, &next_content).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        format!(
            "Failed to write temp session history {}: {}",
            tmp_path.display(),
            err
        )
    })?;
    fs::rename(&tmp_path, path).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        format!(
            "Failed to rename temp session history to {}: {}",
            path.display(),
            err
        )
    })?;

    Ok(RewindOutcome {
        truncated_to_empty: !lines[..user_line_index].iter().any(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return false;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                return false;
            };
            is_targetable_rewind_user_value(&value, agent_kind)
        }),
    })
}

fn collect_codex_jsonl_files(root: &Path, output: &mut Vec<PathBuf>) {
    use std::fs;

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|ty| ty.is_dir()).unwrap_or(false) {
            collect_codex_jsonl_files(&path, output);
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

pub(crate) fn find_codex_session_jsonl(
    sessions_dir: &Path,
    codex_session_id: &str,
) -> Option<PathBuf> {
    use std::fs;

    let mut candidates = Vec::new();
    collect_codex_jsonl_files(sessions_dir, &mut candidates);

    candidates
        .into_iter()
        .filter(|path| read_codex_session_meta_id(path).as_deref() == Some(codex_session_id))
        .max_by_key(|path| {
            fs::metadata(path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0)
        })
}

fn codex_interactive_events_dir(home: &Path) -> PathBuf {
    home.join(".codemux").join("codex-interactive-events")
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    pub agent_session_id: Option<String>,
    pub message_path: Option<String>,
}

fn resolve_agent_session_info(
    home: &Path,
    agent_kind: AgentKind,
    agent_session_id: Option<String>,
) -> Result<AgentSessionInfo, String> {
    let Some(agent_session_id) = agent_session_id else {
        return Ok(AgentSessionInfo {
            agent_session_id: None,
            message_path: None,
        });
    };

    let message_path = match agent_kind {
        AgentKind::ClaudeCode => {
            find_claude_session_jsonl(&home.join(".claude"), &agent_session_id)
        }
        AgentKind::Codex => {
            find_codex_session_jsonl(&home.join(".codex").join("sessions"), &agent_session_id)
        }
        AgentKind::GeminiCli | AgentKind::Opencode => None,
    }
    .map(|path| path.to_string_lossy().to_string());

    Ok(AgentSessionInfo {
        agent_session_id: Some(agent_session_id),
        message_path,
    })
}

fn load_latest_token_usage_for_agent_session(
    home: &Path,
    agent_kind: AgentKind,
    agent_session_id: &str,
    freshness: &str,
) -> Result<Option<ThreadTokenUsageSnapshot>, String> {
    if agent_kind == AgentKind::Opencode {
        return super::opencode_history::load_latest_opencode_token_usage(
            home,
            agent_session_id,
            freshness,
        );
    }

    let history_path = match agent_kind {
        AgentKind::ClaudeCode => find_claude_session_jsonl(&home.join(".claude"), agent_session_id),
        AgentKind::Codex => {
            find_codex_session_jsonl(&home.join(".codex").join("sessions"), agent_session_id)
        }
        AgentKind::GeminiCli | AgentKind::Opencode => None,
    };
    let Some(history_path) = history_path else {
        return Ok(None);
    };

    let values = read_json_stream_values(&history_path)?;
    let snapshot = match agent_kind {
        AgentKind::ClaudeCode => latest_claude_usage_from_values(&values, freshness),
        AgentKind::Codex => latest_codex_usage_from_values(&values, freshness),
        AgentKind::GeminiCli | AgentKind::Opencode => None,
    };

    Ok(snapshot)
}

#[tauri::command]
pub async fn get_agent_session_info(
    state: State<'_, crate::AppState>,
    app_session_id: String,
    agent_kind: String,
) -> Result<AgentSessionInfo, String> {
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    let agent_session_id = get_agent_session_id(state.inner(), &app_session_id, agent_kind)?;
    resolve_agent_session_info(&home_dir()?, agent_kind, agent_session_id)
}

#[tauri::command]
pub async fn load_agent_latest_token_usage(
    state: State<'_, crate::AppState>,
    app_session_id: String,
    agent_kind: String,
    freshness: Option<String>,
) -> Result<Option<ThreadTokenUsageSnapshot>, String> {
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    let Some(agent_session_id) = get_agent_session_id(state.inner(), &app_session_id, agent_kind)?
    else {
        return Ok(None);
    };
    let home = home_dir()?;
    let freshness = freshness.unwrap_or_else(|| "restored".to_string());

    tokio::task::spawn_blocking(move || {
        load_latest_token_usage_for_agent_session(&home, agent_kind, &agent_session_id, &freshness)
    })
    .await
    .map_err(|err| format!("Failed to join token usage loader: {}", err))?
}

#[tauri::command]
pub async fn load_claude_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    use std::fs;
    use std::io::{BufRead, BufReader};

    debug!(target: "agent", "Loading Claude session events for app_session_id={}", app_session_id);

    let mut messages = Vec::new();

    let Some(claude_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::ClaudeCode)?
    else {
        info!(target: "agent", "No Claude mapping found for app_session_id={}", app_session_id);
        return Ok(messages);
    };

    let claude_dir = home_dir()?.join(".claude");
    let Some(jsonl_path) = find_claude_session_jsonl(&claude_dir, &claude_session_id) else {
        info!(
            target: "agent",
            "Claude JSONL not found for app_session_id={} claude_session_id={}",
            app_session_id,
            claude_session_id
        );
        return Ok(messages);
    };

    debug!(target: "agent", "Reading JSONL from {}", jsonl_path.display());

    let file = fs::File::open(&jsonl_path).map_err(|e| format!("Failed to open JSONL: {}", e))?;
    let reader = BufReader::new(file);

    for (line_index, line_result) in reader.lines().enumerate() {
        let line = match line_result {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut val: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if should_include_claude_history_event(&val) {
            if let Some(obj) = val.as_object_mut() {
                obj.insert("__lineIndex".to_string(), serde_json::json!(line_index));
            }
            messages.push(val);
        }
    }

    let normalized = normalize_history_events(messages, &app_session_id);
    info!(target: "agent", "Loaded {} CodeMUX events from Claude JSONL for app_session_id={}", normalized.len(), app_session_id);
    Ok(normalized)
}

/// Convert a codex JSONL response_item to a Claude-compatible message format.
/// Codex uses: {type: "response_item", payload: {type, role, content, ...}}
/// Claude uses: {type: "assistant"|"user", message: {role, content: [...]}, ...}
fn convert_codex_item_to_claude_format(val: &serde_json::Value) -> Option<serde_json::Value> {
    let item_type = val.get("type")?.as_str()?;
    let payload = val.get("payload")?;
    let timestamp = val.get("timestamp").cloned();
    let line_index = val.get("__lineIndex").cloned();

    if item_type == "response_item" {
        let payload_type = payload.get("type")?.as_str()?;
        let role = payload.get("role").and_then(|r| r.as_str());

        if payload_type == "reasoning" {
            let thinking = extract_codex_reasoning_summary(payload)?;
            return Some(serde_json::json!({
                "type": "assistant",
                "timestamp": timestamp,
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "thinking",
                            "thinking": thinking
                        }
                    ]
                }
            }));
        }

        // Assistant text message
        if role == Some("assistant") {
            let content_blocks = payload.get("content")?;
            // Convert codex content format to claude format
            let mut claude_content = Vec::new();
            if let Some(arr) = content_blocks.as_array() {
                for block in arr {
                    let block_type = block.get("type")?.as_str()?;
                    if block_type == "output_text" {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            claude_content.push(serde_json::json!({"type": "text", "text": text}));
                        }
                    } else if block_type == "reasoning" {
                        if let Some(thinking) = extract_codex_reasoning_summary(block) {
                            claude_content.push(
                                serde_json::json!({"type": "thinking", "thinking": thinking}),
                            );
                        }
                    }
                }
            }
            if claude_content.is_empty() {
                return None;
            }
            return Some(serde_json::json!({
                "type": "assistant",
                "timestamp": timestamp,
                "message": {
                    "role": "assistant",
                    "content": claude_content
                }
            }));
        }

        // User message
        if role == Some("user") {
            let content_blocks = payload.get("content")?;
            let mut text_parts = Vec::new();
            let mut claude_content = Vec::new();
            if let Some(arr) = content_blocks.as_array() {
                for block in arr {
                    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if block_type == "input_text" {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            if is_codex_image_text_marker(text) {
                                continue;
                            }
                            text_parts.push(text.to_string());
                            claude_content.push(serde_json::json!({"type": "text", "text": text}));
                        }
                    } else if block_type == "input_image" {
                        if let Some(image_url) = block.get("image_url").and_then(|t| t.as_str()) {
                            if let Some((media_type, data)) = parse_image_data_url(image_url) {
                                claude_content.push(serde_json::json!({
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": media_type,
                                        "data": data
                                    }
                                }));
                            }
                        }
                    }
                }
            }
            if claude_content.is_empty() {
                return None;
            }
            let content = text_parts.join("\n");
            // Skip Codex environment context injections (not real user messages)
            if content.starts_with("<environment_context>") {
                return None;
            }
            let provider_message_id = ["id", "uuid", "message_id", "messageId"]
                .iter()
                .find_map(|key| payload.get(key).and_then(|entry| entry.as_str()));
            let mut converted = serde_json::json!({
                "type": "user",
                "timestamp": timestamp,
                "message": {
                    "role": "user",
                    "content": claude_content
                }
            });
            if let Some(provider_message_id) = provider_message_id {
                converted["uuid"] = serde_json::json!(provider_message_id);
            }
            if let Some(line_index) = line_index {
                converted["__lineIndex"] = line_index;
            }
            return Some(converted);
        }

        // Function call → tool_use
        if payload_type == "function_call" {
            let name = payload.get("name")?.as_str()?;
            let call_id = payload.get("call_id")?.as_str()?;
            let arguments = payload.get("arguments");
            let input: serde_json::Value =
                if let Some(args_str) = arguments.and_then(|a| a.as_str()) {
                    serde_json::from_str(args_str)
                        .unwrap_or_else(|_| serde_json::json!({"raw": args_str}))
                } else {
                    arguments.cloned().unwrap_or(serde_json::json!({}))
                };
            return Some(serde_json::json!({
                "type": "assistant",
                "timestamp": timestamp,
                "message": {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": call_id,
                        "name": name,
                        "input": input
                    }]
                }
            }));
        }

        // Function call output → user tool_result
        if payload_type == "function_call_output" {
            let call_id = payload.get("call_id")?.as_str()?;
            let output = payload.get("output").and_then(|o| o.as_str()).unwrap_or("");
            return Some(serde_json::json!({
                "type": "user",
                "timestamp": timestamp,
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": call_id,
                        "content": output
                    }]
                }
            }));
        }

        // Custom tool call -> tool_use. Codex records tools such as apply_patch
        // this way in JSONL, so history loading needs to preserve them.
        if payload_type == "custom_tool_call" {
            let name = payload.get("name")?.as_str()?;
            let call_id = payload.get("call_id")?.as_str()?;
            let input_value = payload
                .get("input")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let input = if input_value.is_object() {
                input_value
            } else if input_value.is_null() {
                serde_json::json!({})
            } else {
                serde_json::json!({ "input": input_value })
            };
            return Some(serde_json::json!({
                "type": "assistant",
                "timestamp": timestamp,
                "message": {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": call_id,
                        "name": name,
                        "input": input
                    }]
                }
            }));
        }

        // Custom tool call output -> user tool_result.
        if payload_type == "custom_tool_call_output" {
            let call_id = payload.get("call_id")?.as_str()?;
            let output = payload
                .get("output")
                .and_then(|o| o.as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| {
                    payload
                        .get("output")
                        .map(|o| o.to_string())
                        .unwrap_or_default()
                });
            return Some(serde_json::json!({
                "type": "user",
                "timestamp": timestamp,
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": call_id,
                        "content": output
                    }]
                }
            }));
        }
    }

    None
}

/// 将持久化的 Codex 工具记录转换为实时 sidecar 使用的 CodeMUX Event。
/// 插入回合结束事件后再分配 sequence 和 event_id，以最终历史顺序为准。
fn convert_codex_tool_to_codemux(
    val: &serde_json::Value,
    app_session_id: &str,
) -> Option<(&'static str, String, serde_json::Value)> {
    if val.get("type").and_then(|entry| entry.as_str()) != Some("response_item") {
        return None;
    }

    let payload = val.get("payload")?;
    let payload_type = payload.get("type")?.as_str()?;
    let timestamp = val.get("timestamp").cloned();

    match payload_type {
        "function_call" => {
            let tool_use_id = payload.get("call_id")?.as_str()?.to_string();
            let name = payload.get("name")?.as_str()?;
            let input = parse_codex_tool_input(payload.get("arguments"));
            Some((
                "tool_started",
                tool_use_id.clone(),
                serde_json::json!({
                    "type": "tool_started",
                    "session_id": app_session_id,
                    "tool_use_id": tool_use_id,
                    "name": name,
                    "input": input,
                    "timestamp": timestamp,
                    "event_id": "",
                    "sequence": 0
                }),
            ))
        }
        "custom_tool_call" => {
            let tool_use_id = payload.get("call_id")?.as_str()?.to_string();
            let name = payload.get("name")?.as_str()?;
            let input_value = payload
                .get("input")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let input = if input_value.is_object() {
                input_value
            } else if input_value.is_null() {
                serde_json::json!({})
            } else {
                serde_json::json!({ "input": input_value })
            };
            Some((
                "tool_started",
                tool_use_id.clone(),
                serde_json::json!({
                    "type": "tool_started",
                    "session_id": app_session_id,
                    "tool_use_id": tool_use_id,
                    "name": name,
                    "input": input,
                    "timestamp": timestamp,
                    "event_id": "",
                    "sequence": 0
                }),
            ))
        }
        "function_call_output" | "custom_tool_call_output" => {
            let tool_use_id = payload.get("call_id")?.as_str()?.to_string();
            let content = stringify_codex_tool_output(payload.get("output"));
            let is_error = payload.get("is_error").and_then(|entry| entry.as_bool()) == Some(true)
                || payload.get("error").and_then(|entry| entry.as_bool()) == Some(true);
            Some((
                "tool_finished",
                tool_use_id.clone(),
                serde_json::json!({
                    "type": "tool_finished",
                    "session_id": app_session_id,
                    "tool_use_id": tool_use_id,
                    "content": content,
                    "is_error": is_error,
                    "timestamp": timestamp,
                    "event_id": "",
                    "sequence": 0
                }),
            ))
        }
        _ => None,
    }
}

fn parse_codex_tool_input(value: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(value) = value else {
        return serde_json::json!({});
    };
    if let Some(raw) = value.as_str() {
        return serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!({ "raw": raw }));
    }
    if value.is_null() {
        serde_json::json!({})
    } else if value.is_object() {
        value.clone()
    } else {
        serde_json::json!({ "input": value })
    }
}

fn stringify_codex_tool_output(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn assign_codex_history_event_sequence(messages: &mut [serde_json::Value], app_session_id: &str) {
    let mut sequence = 0u64;
    for event in messages {
        let event_type = event.get("type").and_then(|entry| entry.as_str());
        if event_type != Some("tool_started")
            && event_type != Some("tool_finished")
            && event_type != Some("error")
            && event_type != Some("turn_finished")
        {
            continue;
        }
        event["event_id"] =
            serde_json::json!(format!("codemux-history-{}-{}", app_session_id, sequence));
        event["sequence"] = serde_json::json!(sequence);
        sequence += 1;
    }
}

fn is_codex_assistant_response_message(val: &serde_json::Value) -> bool {
    val.get("type").and_then(|t| t.as_str()) == Some("response_item")
        && val
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(|t| t.as_str())
            == Some("message")
        && val
            .get("payload")
            .and_then(|payload| payload.get("role"))
            .and_then(|role| role.as_str())
            == Some("assistant")
}

fn is_codex_user_response_message(val: &serde_json::Value) -> bool {
    val.get("type").and_then(|t| t.as_str()) == Some("response_item")
        && val
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(|t| t.as_str())
            == Some("message")
        && val
            .get("payload")
            .and_then(|payload| payload.get("role"))
            .and_then(|role| role.as_str())
            == Some("user")
}

fn convert_codex_agent_message_to_claude_format(
    val: &serde_json::Value,
) -> Option<serde_json::Value> {
    if val.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
        return None;
    }

    let payload = val.get("payload")?;
    if payload.get("type").and_then(|t| t.as_str()) != Some("agent_message") {
        return None;
    }

    let text = payload.get("message")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }

    Some(serde_json::json!({
        "type": "assistant",
        "timestamp": val.get("timestamp").cloned(),
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": text }]
        }
    }))
}

fn convert_codex_user_event_to_claude_format(val: &serde_json::Value) -> Option<serde_json::Value> {
    if val.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
        return None;
    }

    let payload = val.get("payload")?;
    if payload.get("type").and_then(|t| t.as_str()) != Some("user_message") {
        return None;
    }

    let text = payload
        .get("message")
        .or_else(|| payload.get("text"))
        .and_then(|entry| entry.as_str())?
        .trim();
    if text.is_empty() {
        return None;
    }

    let mut converted = serde_json::json!({
        "type": "user",
        "timestamp": val.get("timestamp").cloned(),
        "message": {
            "role": "user",
            "content": text
        }
    });

    if let Some(provider_message_id) = ["id", "uuid", "message_id", "messageId"]
        .iter()
        .find_map(|key| payload.get(key).and_then(|entry| entry.as_str()))
    {
        converted["uuid"] = serde_json::json!(provider_message_id);
    }

    if let Some(line_index) = val.get("__lineIndex").cloned() {
        converted["__lineIndex"] = line_index;
    }

    Some(converted)
}

fn convert_codex_compacted_to_compact_boundary(
    val: &serde_json::Value,
) -> Option<serde_json::Value> {
    if val.get("type").and_then(|t| t.as_str()) != Some("compacted") {
        return None;
    }

    let payload = val.get("payload");
    let trigger = payload
        .and_then(|p| p.get("trigger"))
        .and_then(|v| v.as_str())
        .filter(|value| *value == "auto" || *value == "manual")
        .unwrap_or("auto");
    let pre_tokens = payload
        .and_then(|p| p.get("pre_tokens").or_else(|| p.get("preTokens")))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let post_tokens = payload
        .and_then(|p| p.get("post_tokens").or_else(|| p.get("postTokens")))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    Some(serde_json::json!({
        "type": "system",
        "subtype": "compact_boundary",
        "content": "Conversation compacted",
        "timestamp": val.get("timestamp").cloned(),
        "compact_metadata": {
            "trigger": trigger,
            "pre_tokens": pre_tokens,
            "post_tokens": post_tokens
        }
    }))
}

fn convert_codex_history_values_to_events(
    raw_events: &[serde_json::Value],
    app_session_id: &str,
) -> Vec<serde_json::Value> {
    #[derive(Default)]
    struct TurnInfo {
        last_token_usage: Option<serde_json::Value>,
        model_context_window: Option<u64>,
        duration_ms: Option<u64>,
        last_assistant_msg_idx: Option<usize>,
        last_event_idx: Option<usize>,
        compaction_only: bool,
        terminal_outcome: Option<&'static str>,
        terminal_reason: Option<String>,
    }

    let has_agent_messages = raw_events
        .iter()
        .any(|val| convert_codex_agent_message_to_claude_format(val).is_some());
    let has_user_events = raw_events
        .iter()
        .any(|val| convert_codex_user_event_to_claude_format(val).is_some());
    let mut messages = Vec::new();
    let mut turns: Vec<TurnInfo> = Vec::new();
    let mut msg_idx: usize = 0;
    let mut emitted_tool_started = HashSet::new();
    let mut emitted_tool_finished = HashSet::new();

    for val in raw_events {
        let item_type = val.get("type").and_then(|t| t.as_str());

        if item_type == Some("turn_context") {
            turns.push(TurnInfo::default());
        }

        let current_turn = if turns.is_empty() {
            turns.push(TurnInfo::default());
            turns.last_mut().unwrap()
        } else {
            turns.last_mut().unwrap()
        };

        if let Some(converted) = convert_codex_compacted_to_compact_boundary(val) {
            current_turn.last_assistant_msg_idx = None;
            current_turn.compaction_only = true;
            current_turn.last_event_idx = Some(msg_idx);
            messages.push(converted);
            msg_idx += 1;
            continue;
        }

        if let Some((event_type, tool_use_id, converted)) =
            convert_codex_tool_to_codemux(val, app_session_id)
        {
            let is_new = if event_type == "tool_started" {
                emitted_tool_started.insert(tool_use_id)
            } else {
                emitted_tool_finished.insert(tool_use_id)
            };
            if is_new {
                current_turn.last_event_idx = Some(msg_idx);
                messages.push(converted);
                msg_idx += 1;
            }
            continue;
        }

        if item_type == Some("event_msg") {
            if let Some(payload) = val.get("payload") {
                let payload_type = payload.get("type").and_then(|t| t.as_str());
                match payload_type {
                    Some("user_message") => {
                        if has_matching_codex_image_response_user(raw_events, val) {
                            continue;
                        }
                        if let Some(converted) = convert_codex_user_event_to_claude_format(val) {
                            current_turn.compaction_only = false;
                            current_turn.last_event_idx = Some(msg_idx);
                            messages.push(converted);
                            msg_idx += 1;
                        }
                    }
                    Some("agent_message") => {
                        if let Some(converted) = convert_codex_agent_message_to_claude_format(val) {
                            current_turn.last_assistant_msg_idx = Some(msg_idx);
                            current_turn.compaction_only = false;
                            current_turn.last_event_idx = Some(msg_idx);
                            messages.push(converted);
                            msg_idx += 1;
                        }
                    }
                    Some("token_count") => {
                        if let Some(info) = payload.get("info") {
                            if let Some(usage) = info.get("last_token_usage") {
                                current_turn.last_token_usage = Some(usage.clone());
                            }
                            if let Some(ctx) =
                                info.get("model_context_window").and_then(|v| v.as_u64())
                            {
                                current_turn.model_context_window = Some(ctx);
                            }
                        }
                    }
                    Some("task_complete") => {
                        if let Some(dm) = payload.get("duration_ms").and_then(|d| d.as_u64()) {
                            current_turn.duration_ms = Some(dm);
                        }
                        current_turn.terminal_outcome = Some("completed");
                        current_turn.terminal_reason = payload
                            .get("reason")
                            .or_else(|| payload.get("message"))
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .map(ToOwned::to_owned);
                    }
                    Some("turn_aborted") | Some("task_aborted") | Some("turn_cancelled") => {
                        current_turn.terminal_outcome = Some("interrupted");
                        current_turn.terminal_reason = payload
                            .get("reason")
                            .or_else(|| payload.get("message"))
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .map(ToOwned::to_owned);
                    }
                    Some("turn_failed") | Some("task_failed") | Some("api_error") => {
                        current_turn.terminal_outcome = Some("failed");
                        current_turn.terminal_reason = payload
                            .get("error")
                            .or_else(|| payload.get("reason"))
                            .or_else(|| payload.get("message"))
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .map(ToOwned::to_owned);
                    }
                    _ => {}
                }
            }
            continue;
        }

        if has_agent_messages && is_codex_assistant_response_message(val) {
            continue;
        }
        if has_user_events
            && is_codex_user_response_message(val)
            && !codex_response_user_has_image(val)
        {
            continue;
        }

        if let Some(converted) = convert_codex_item_to_claude_format(val) {
            if converted.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                current_turn.last_assistant_msg_idx = Some(msg_idx);
                current_turn.compaction_only = false;
            }
            current_turn.last_event_idx = Some(msg_idx);
            messages.push(converted);
            msg_idx += 1;
        }
    }

    struct TurnResult {
        insert_at: usize,
        result: serde_json::Value,
    }
    let mut turn_results: Vec<TurnResult> = Vec::new();

    for turn in &turns {
        if turn.compaction_only {
            continue;
        }

        let Some(insert_at) = turn.last_event_idx.or(turn.last_assistant_msg_idx) else {
            continue;
        };
        let Some(outcome) = turn.terminal_outcome else {
            continue;
        };
        let usage = turn.last_token_usage.as_ref();
        let mut result = serde_json::json!({
            "type": "turn_finished",
            "session_id": app_session_id,
            "outcome": outcome,
            "duration_ms": turn.duration_ms,
            "event_id": "",
            "sequence": 0
        });
        if let Some(reason) = &turn.terminal_reason {
            result["reason"] = serde_json::json!(reason);
        }
        if let Some(usage) = usage {
            result["usage"] = serde_json::json!({
                "input_tokens": usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                "cached_input_tokens": usage.get("cached_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                "output_tokens": usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                "reasoning_output_tokens": usage.get("reasoning_output_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
            });
        }
        if let Some(ctx) = turn.model_context_window {
            result["model_context_window"] = serde_json::json!(ctx);
        }
        turn_results.push(TurnResult { insert_at, result });
    }

    for turn_result in turn_results.into_iter().rev() {
        let pos = (turn_result.insert_at + 1).min(messages.len());
        messages.insert(pos, turn_result.result);
    }

    assign_codex_history_event_sequence(&mut messages, app_session_id);

    messages
}

fn has_matching_codex_image_response_user(
    raw_events: &[serde_json::Value],
    event_msg: &serde_json::Value,
) -> bool {
    let Some(event_payload) = event_msg.get("payload") else {
        return false;
    };
    let event_id = ["id", "uuid", "message_id", "messageId"]
        .iter()
        .find_map(|key| event_payload.get(key).and_then(|entry| entry.as_str()));
    let event_text = event_payload
        .get("message")
        .or_else(|| event_payload.get("text"))
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .unwrap_or("");

    raw_events.iter().any(|candidate| {
        if !codex_response_user_has_image(candidate) {
            return false;
        }
        let Some(payload) = candidate.get("payload") else {
            return false;
        };
        let response_id = ["id", "uuid", "message_id", "messageId"]
            .iter()
            .find_map(|key| payload.get(key).and_then(|entry| entry.as_str()));
        if event_id.is_some() && event_id == response_id {
            return true;
        }
        extract_codex_response_user_text(payload) == event_text
    })
}

fn codex_response_user_has_image(value: &serde_json::Value) -> bool {
    if !is_codex_user_response_message(value) {
        return false;
    }
    let Some(content) = value
        .get("payload")
        .and_then(|payload| payload.get("content"))
        .and_then(|content| content.as_array())
    else {
        return false;
    };

    content.iter().any(|block| {
        block.get("type").and_then(|entry| entry.as_str()) == Some("input_image")
            && block
                .get("image_url")
                .and_then(|entry| entry.as_str())
                .and_then(parse_image_data_url)
                .is_some()
    })
}

fn extract_codex_response_user_text(payload: &serde_json::Value) -> String {
    payload
        .get("content")
        .and_then(|content| content.as_array())
        .map(|content| {
            content
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(|entry| entry.as_str()) != Some("input_text") {
                        return None;
                    }
                    let text = block.get("text").and_then(|entry| entry.as_str())?;
                    if is_codex_image_text_marker(text) {
                        return None;
                    }
                    Some(text)
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn is_codex_image_text_marker(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("<image ") || trimmed == "<image>" || trimmed == "</image>"
}

fn parse_image_data_url(data_url: &str) -> Option<(String, String)> {
    let rest = data_url.strip_prefix("data:")?;
    let (media_type, data) = rest.split_once(";base64,")?;
    if !media_type.starts_with("image/") || data.is_empty() {
        return None;
    }
    Some((media_type.to_string(), data.to_string()))
}

fn read_json_stream_values(path: &Path) -> Result<Vec<serde_json::Value>, String> {
    use std::fs;

    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read JSONL: {}", e))?;
    let stream = serde_json::Deserializer::from_str(&content).into_iter::<serde_json::Value>();
    let mut values = Vec::new();

    for item in stream {
        match item {
            Ok(mut value) => {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("__lineIndex".to_string(), serde_json::json!(values.len()));
                }
                values.push(value);
            }
            Err(error) => {
                warn!(
                    target: "agent",
                    "Stopped parsing JSON stream from {} after {} values: {}",
                    path.display(),
                    values.len(),
                    error
                );
                break;
            }
        }
    }

    Ok(values)
}

fn read_codex_interactive_events_from_dir(
    dir: &Path,
    app_session_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let path = dir.join(format!("{}.jsonl", sanitize_file_segment(app_session_id)));
    if !path.exists() {
        return Ok(Vec::new());
    }

    read_json_stream_values(&path)
}

fn event_timestamp_millis(value: &serde_json::Value) -> Option<i64> {
    let timestamp = value.get("timestamp").and_then(|entry| entry.as_str())?;
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|entry| entry.timestamp_millis())
}

fn sort_events_by_timestamp_stable(events: &mut Vec<serde_json::Value>) {
    let mut indexed: Vec<(usize, serde_json::Value)> = events.drain(..).enumerate().collect();
    indexed
        .sort_by_key(|(index, value)| (event_timestamp_millis(value).unwrap_or(i64::MAX), *index));
    events.extend(indexed.into_iter().map(|(_, value)| value));
}

#[tauri::command]
pub async fn load_opencode_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    debug!(target: "agent", "Loading OpenCode SQLite session events for app_session_id={}", app_session_id);
    let Some(opencode_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::Opencode)?
    else {
        info!(target: "agent", "No OpenCode mapping found for app_session_id={}", app_session_id);
        return Ok(Vec::new());
    };
    let home = home_dir()?;
    let events = tokio::task::spawn_blocking(move || {
        super::opencode_history::load_opencode_session_events(&home, &opencode_session_id)
    })
    .await
    .map_err(|error| format!("Failed to join OpenCode history loader: {}", error))??;
    Ok(normalize_history_events(events, &app_session_id))
}

#[tauri::command]
pub async fn delete_opencode_session(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<(), String> {
    debug!(target: "agent", "Deleting OpenCode SQLite session for app_session_id={}", app_session_id);
    let Some(opencode_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::Opencode)?
    else {
        return Ok(());
    };
    let home = home_dir()?;
    tokio::task::spawn_blocking(move || {
        super::opencode_history::delete_opencode_session(&home, &opencode_session_id).map(|_| ())
    })
    .await
    .map_err(|error| format!("Failed to join OpenCode history deletion: {}", error))?
}

#[tauri::command]
pub async fn load_codex_session_events(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    debug!(target: "agent", "Loading Codex session events for app_session_id={}", app_session_id);

    let mut messages = Vec::new();
    let Some(codex_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::Codex)?
    else {
        info!(target: "agent", "No Codex mapping found for app_session_id={}", app_session_id);
        return Ok(messages);
    };

    let sessions_dir = home_dir()?.join(".codex").join("sessions");
    let Some(jsonl_path) = find_codex_session_jsonl(&sessions_dir, &codex_session_id) else {
        info!(
            target: "agent",
            "No Codex JSONL found for app_session_id={} codex_session_id={} dir={}",
            app_session_id,
            codex_session_id,
            sessions_dir.display()
        );
        return Ok(messages);
    };

    debug!(target: "agent", "Reading Codex JSONL from {}", jsonl_path.display());
    // Collect all raw events for two-pass processing
    let mut raw_events = read_json_stream_values(&jsonl_path)?;
    let mut interactive_events = read_codex_interactive_events_from_dir(
        &codex_interactive_events_dir(&home_dir()?),
        &app_session_id,
    )?;
    if !interactive_events.is_empty() {
        raw_events.append(&mut interactive_events);
        sort_events_by_timestamp_stable(&mut raw_events);
    }

    messages = convert_codex_history_values_to_events(&raw_events, &app_session_id);
    messages = normalize_history_events(messages, &app_session_id);

    info!(target: "agent", "Loaded {} CodeMUX events from Codex JSONL for app_session_id={}", messages.len(), app_session_id);
    Ok(messages)
}

type SessionLifecycleLock = Arc<Mutex<()>>;
type SessionLifecycleLocks = Arc<Mutex<HashMap<String, SessionLifecycleLock>>>;
type SessionGenerations = Arc<Mutex<HashMap<String, u64>>>;

pub struct AgentState {
    pub sidecars: Arc<Mutex<HashMap<String, SidecarHandle>>>,
    pub session_startup_locks: SessionLifecycleLocks,
    pub session_generations: SessionGenerations,
    /// Port of the running codex compat proxy, if any.
    pub proxy_port: Arc<Mutex<Option<u16>>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            sidecars: Arc::new(Mutex::new(HashMap::new())),
            session_startup_locks: Arc::new(Mutex::new(HashMap::new())),
            session_generations: Arc::new(Mutex::new(HashMap::new())),
            proxy_port: Arc::new(Mutex::new(None)),
        }
    }
}

async fn session_lifecycle_lock(
    agent_state: &AgentState,
    session_id: &str,
) -> SessionLifecycleLock {
    let mut locks = agent_state.session_startup_locks.lock().await;
    locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

async fn begin_session_generation(agent_state: &AgentState, session_id: &str) -> u64 {
    let mut generations = agent_state.session_generations.lock().await;
    let generation = generations.entry(session_id.to_string()).or_insert(0);
    *generation = generation
        .checked_add(1)
        .expect("session runtime generation exhausted");
    *generation
}

async fn invalidate_session_generation(agent_state: &AgentState, session_id: &str) {
    let _ = begin_session_generation(agent_state, session_id).await;
}

async fn mapping_generation_is_current(
    session_generations: &SessionGenerations,
    session_id: &str,
    generation: u64,
) -> bool {
    session_generations.lock().await.get(session_id).copied() == Some(generation)
}

async fn ensure_sidecar_for_session(
    app: AppHandle,
    agent_state: &State<'_, AgentState>,
    session_id: &str,
    channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let channel_handle = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(session_id).map(SidecarHandle::channel_handle)
    };
    if let Some(channel_handle) = channel_handle {
        let mut current_channel = channel_handle.lock().await;
        *current_channel = channel;
        info!(target: "agent", "Reusing existing sidecar for session_id={}", session_id);
        return Ok(());
    }

    let (handle, mut rx) = spawn_sidecar(&app, channel).await?;
    let shared_channel = handle.channel.clone();
    let session_startup_locks = agent_state.session_startup_locks.clone();
    let session_generations = agent_state.session_generations.clone();
    let session_id_clone = session_id.to_string();
    let app_handle = app.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let app_state = app_handle.state::<crate::AppState>();
            match handle_agent_session_mapping_event(
                app_state.inner(),
                &session_startup_locks,
                &session_generations,
                &event,
            )
            .await
            {
                Ok(true) => continue,
                Ok(false) => {
                    let ch = shared_channel.lock().await;
                    let _ = ch.send(event);
                }
                Err(error) => {
                    let error_event = serde_json::json!({
                        "type": "sidecar_error",
                        "error": error,
                    })
                    .to_string();
                    let ch = shared_channel.lock().await;
                    let _ = ch.send(error_event);
                }
            }
        }
        info!(target: "agent", "Sidecar stream closed for session_id={}", session_id_clone);
    });

    let mut sidecars = agent_state.sidecars.lock().await;
    sidecars.insert(session_id.to_string(), handle);

    Ok(())
}

struct AgentSessionMappingEvent {
    app_session_id: String,
    agent_kind: AgentKind,
    agent_session_id: String,
    runtime_generation: Option<u64>,
}

fn parse_agent_session_mapping_event(
    event: &str,
) -> Result<Option<AgentSessionMappingEvent>, String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(event) else {
        if event.contains("\"type\"") && event.contains("agent_session_mapping") {
            return Err("Invalid agent session mapping event: malformed JSON".to_string());
        }
        return Ok(None);
    };

    if value.get("type").and_then(|entry| entry.as_str()) != Some("agent_session_mapping") {
        return Ok(None);
    }

    let app_session_id = value
        .get("app_session_id")
        .and_then(|entry| entry.as_str())
        .ok_or_else(|| "Invalid agent session mapping event: missing app_session_id".to_string())?;
    let agent_kind_str = value
        .get("agent_kind")
        .and_then(|entry| entry.as_str())
        .ok_or_else(|| "Invalid agent session mapping event: missing agent_kind".to_string())?;
    let agent_session_id = value
        .get("agent_session_id")
        .and_then(|entry| entry.as_str())
        .ok_or_else(|| {
            "Invalid agent session mapping event: missing agent_session_id".to_string()
        })?;
    let agent_kind = AgentKind::from_str(agent_kind_str).map_err(|_| {
        format!(
            "Invalid agent session mapping event: unknown agent_kind={}",
            agent_kind_str
        )
    })?;

    let runtime_generation = if agent_kind == AgentKind::Opencode {
        Some(
            value
                .get("runtime_generation")
                .and_then(|entry| entry.as_u64())
                .ok_or_else(|| {
                    "Invalid agent session mapping event: missing runtime_generation".to_string()
                })?,
        )
    } else {
        None
    };

    Ok(Some(AgentSessionMappingEvent {
        app_session_id: app_session_id.to_string(),
        agent_kind,
        agent_session_id: agent_session_id.to_string(),
        runtime_generation,
    }))
}

fn persist_agent_session_mapping_event(
    db: &rusqlite::Connection,
    event: &str,
) -> Result<bool, String> {
    let Some(mapping) = parse_agent_session_mapping_event(event)? else {
        return Ok(false);
    };

    operations::upsert_agent_session_mapping(
        db,
        &mapping.app_session_id,
        mapping.agent_kind,
        &mapping.agent_session_id,
    )
    .map_err(|error| {
        format!(
            "Failed to persist agent session mapping app_session_id={} agent_kind={} agent_session_id={}: {}",
            mapping.app_session_id,
            mapping.agent_kind.as_str(),
            mapping.agent_session_id,
            error
        )
    })?;

    Ok(true)
}

async fn handle_agent_session_mapping_event(
    state: &crate::AppState,
    session_startup_locks: &SessionLifecycleLocks,
    session_generations: &SessionGenerations,
    event: &str,
) -> Result<bool, String> {
    let Some(mapping) = parse_agent_session_mapping_event(event)? else {
        return Ok(false);
    };

    let session_lock = {
        let mut locks = session_startup_locks.lock().await;
        locks
            .entry(mapping.app_session_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _lifecycle_guard = session_lock.lock().await;

    let session_exists = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            [&mapping.app_session_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| {
            format!(
                "Failed to verify app session for agent session mapping app_session_id={}: {}",
                mapping.app_session_id, error
            )
        })?
    };
    if !session_exists {
        return Err(format!(
            "Session not found for agent session mapping app_session_id={}",
            mapping.app_session_id
        ));
    }

    if mapping.agent_kind == AgentKind::Opencode
        && !mapping_generation_is_current(
            session_generations,
            &mapping.app_session_id,
            mapping
                .runtime_generation
                .expect("OpenCode mapping generation missing"),
        )
        .await
    {
        debug!(
            target: "agent",
            "Dropping stale OpenCode session mapping after reset app_session_id={}",
            mapping.app_session_id
        );
        return Ok(true);
    }

    let db = state.db.lock().unwrap();
    let persisted = persist_agent_session_mapping_event(&db, event)?;
    if persisted {
        info!(
            target: "agent",
            "Persisted agent session mapping app_session_id={} agent_kind={}",
            mapping.app_session_id,
            mapping.agent_kind.as_str()
        );
    }

    Ok(persisted)
}

#[allow(clippy::too_many_arguments)]
fn build_ensure_session_command(
    state: &crate::AppState,
    session_id: &str,
    agent_kind: &str,
    cwd: String,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    codex_needs_proxy: Option<bool>,
    provider: Option<String>,
    credential_source: Option<String>,
    runtime_generation: Option<u64>,
) -> Result<serde_json::Value, String> {
    let mut cmd = serde_json::json!({
        "type": "ensure_session",
        "agentKind": agent_kind,
        "cwd": cwd,
        "sessionId": session_id,
    });
    if agent_kind == "opencode" {
        if let Some(generation) = runtime_generation {
            cmd["runtimeGeneration"] = serde_json::json!(generation);
        }
        if let Some(provider) = provider {
            cmd["provider"] = serde_json::Value::String(provider);
        }
        if let Some(credential_source) = credential_source {
            cmd["credentialSource"] = serde_json::Value::String(credential_source);
        }
    }

    if let Some(key) = api_key {
        cmd["apiKey"] = serde_json::Value::String(key);
    }
    if let Some(url) = base_url {
        cmd["baseUrl"] = serde_json::Value::String(url);
    }
    if let Some(m) = model {
        cmd["model"] = serde_json::Value::String(m);
    }
    if let Some(effort) = reasoning_effort {
        cmd["reasoningEffort"] = serde_json::Value::String(effort);
    }
    if let Some(needs_proxy) = codex_needs_proxy {
        cmd["codexNeedsProxy"] = serde_json::Value::Bool(needs_proxy);
    }
    let permission_snapshot = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT permission_config, plan_mode FROM sessions WHERE id = ?1 LIMIT 1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .map_err(|error| {
            format!(
                "Failed to load session permissions for session_id={}: {}",
                session_id, error
            )
        })?
    };
    let (permission_config, plan_mode) = permission_snapshot;
    apply_permission_snapshot_to_command(&mut cmd, session_id, permission_config, plan_mode);
    if let Ok(parsed_agent_kind) = AgentKind::from_str(agent_kind) {
        match get_agent_session_id(state, session_id, parsed_agent_kind) {
            Ok(Some(agent_session_id)) => {
                cmd["agentSessionId"] = serde_json::Value::String(agent_session_id);
            }
            Ok(None) => {}
            Err(error) => {
                return Err(format!(
                    "Failed to load agent session mapping for session_id={} agent_kind={}: {}",
                    session_id, agent_kind, error
                ))
            }
        }
    }

    let app = match agent_kind {
        "claude_code" => "claude",
        "codex" => "codex",
        "gemini_cli" => "gemini",
        "opencode" => "opencode",
        _ => "claude",
    };
    let enabled_skills = {
        let db = state.db.lock().unwrap();
        crate::skills::db::get_enabled_skill_names_for_app(&db, app).map_err(|error| {
            format!(
                "Failed to load enabled skills for session_id={} agent_kind={}: {}",
                session_id, agent_kind, error
            )
        })?
    };
    if !enabled_skills.is_empty() {
        cmd["skills"] = serde_json::json!(enabled_skills);
    }

    Ok(cmd)
}

fn apply_permission_snapshot_to_command(
    cmd: &mut serde_json::Value,
    session_id: &str,
    permission_config: Option<String>,
    plan_mode: Option<String>,
) {
    if let Some(permission_config) = permission_config.filter(|value| !value.trim().is_empty()) {
        match serde_json::from_str::<serde_json::Value>(&permission_config) {
            Ok(value) => {
                cmd["permissionConfig"] = value;
            }
            Err(error) => warn!(
                target: "agent",
                "Ignoring invalid permission_config for session_id={} error={}",
                session_id,
                error
            ),
        }
    }
    if let Some(plan_mode) = plan_mode.filter(|value| value == "on" || value == "off") {
        cmd["planMode"] = serde_json::Value::String(plan_mode);
    }
}

fn build_update_permissions_command_from_snapshot(
    session_id: &str,
    agent_kind: &str,
    permission_config: Option<String>,
    plan_mode: Option<String>,
) -> serde_json::Value {
    let mut cmd = serde_json::json!({
        "type": "update_permissions",
        "sessionId": session_id,
        "agentKind": agent_kind,
    });
    apply_permission_snapshot_to_command(&mut cmd, session_id, permission_config, plan_mode);
    cmd
}

fn build_update_permissions_command(
    state: &crate::AppState,
    session_id: &str,
) -> Result<serde_json::Value, String> {
    let (agent_kind, permission_config, plan_mode) = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT agent_kind, permission_config, plan_mode FROM sessions WHERE id = ?1 LIMIT 1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?
    };

    Ok(build_update_permissions_command_from_snapshot(
        session_id,
        &agent_kind,
        permission_config,
        plan_mode,
    ))
}

async fn send_command_to_session(
    agent_state: &State<'_, AgentState>,
    session_id: &str,
    cmd: serde_json::Value,
) -> Result<(), String> {
    let command_sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(session_id).map(SidecarHandle::command_sender)
    };
    let command_sender =
        command_sender.ok_or_else(|| format!("No sidecar found for session_id={}", session_id))?;
    command_sender
        .send(cmd.to_string())
        .await
        .map_err(|_| "Failed to send command to sidecar".to_string())
}

pub async fn send_permission_update_to_session(
    state: &crate::AppState,
    agent_state: &State<'_, AgentState>,
    session_id: &str,
) -> Result<bool, String> {
    let cmd = build_update_permissions_command(state, session_id)?;
    let command_sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(session_id).map(SidecarHandle::command_sender)
    };
    if let Some(command_sender) = command_sender {
        command_sender
            .send(cmd.to_string())
            .await
            .map_err(|_| "Failed to send command to sidecar".to_string())?;
        info!(target: "agent", "Runtime permission update sent for session_id={}", session_id);
        Ok(true)
    } else {
        debug!(target: "agent", "Runtime permission update skipped; no active sidecar for session_id={}", session_id);
        Ok(false)
    }
}

#[tauri::command]
pub async fn ensure_agent_session(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    cwd: String,
    channel: tauri::ipc::Channel<String>,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    info!(target: "agent", "Ensuring agent session session_id={} cwd={}", session_id, cwd);

    let lifecycle_lock = session_lifecycle_lock(agent_state.inner(), &session_id).await;
    let _lifecycle_guard = lifecycle_lock.lock().await;
    let agent_kind = resolve_session_agent_kind(&state, &session_id)?;
    let runtime_config = resolve_active_runtime_config(&state, &session_id)?;
    let runtime_generation = if agent_kind == "opencode" {
        Some(begin_session_generation(agent_state.inner(), &session_id).await)
    } else {
        None
    };

    ensure_sidecar_for_session(app, &agent_state, &session_id, channel).await?;

    let stderr_lines = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(|h| h.stderr_lines.clone())
    };

    let cmd = build_ensure_session_command(
        &state,
        &session_id,
        &agent_kind,
        cwd,
        runtime_config.api_key,
        runtime_config.base_url,
        runtime_config.model,
        reasoning_effort,
        runtime_config.codex_needs_proxy,
        runtime_config.provider,
        runtime_config.credential_source,
        runtime_generation,
    )?;

    send_command_to_session(&agent_state, &session_id, cmd).await?;
    info!(target: "agent", "Agent ensure command sent for session_id={} agent_kind={}", session_id, agent_kind);

    if agent_kind == "codex" && agent_state.proxy_port.lock().await.is_none() {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Some(lines) = stderr_lines {
            let captured = lines.lock().await;
            if let Some(port) = parse_proxy_port_from_stderr(&captured) {
                *agent_state.proxy_port.lock().await = Some(port);
                info!(target: "agent", "Auto-detected codex proxy on port {}", port);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn send_agent_input(
    agent_state: State<'_, AgentState>,
    session_id: String,
    prompt: String,
    input_payload: Option<serde_json::Value>,
    display_content: Option<String>,
) -> Result<(), String> {
    let mut cmd =
        OpenCodeRuntime::send_input_command(&session_id, prompt, display_content.as_deref());
    if let Some(payload) = input_payload {
        cmd["inputPayload"] = payload;
    }
    send_command_to_session(&agent_state, &session_id, cmd).await?;
    info!(target: "agent", "Agent input command sent for session_id={}", session_id);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_agent_session(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    prompt: String,
    cwd: String,
    channel: tauri::ipc::Channel<String>,
    reasoning_effort: Option<String>,
    input_payload: Option<serde_json::Value>,
    display_content: Option<String>,
) -> Result<(), String> {
    let ctx = crate::log_ctx::LogCtx::with_session(&session_id);
    crate::log_ctx::with_ctx(ctx, || async {
        crate::log_ctx!(info, target: "agent", "Starting agent session wrapper");

        let lifecycle_lock = session_lifecycle_lock(agent_state.inner(), &session_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let agent_kind = resolve_session_agent_kind(&state, &session_id)?;
        let runtime_config = resolve_active_runtime_config(&state, &session_id)?;
        let runtime_generation = if agent_kind == "opencode" {
            Some(begin_session_generation(agent_state.inner(), &session_id).await)
        } else {
            None
        };

        ensure_sidecar_for_session(app, &agent_state, &session_id, channel).await?;
        let ensure_cmd = build_ensure_session_command(
            &state,
            &session_id,
            &agent_kind,
            cwd,
            runtime_config.api_key,
            runtime_config.base_url,
            runtime_config.model,
            reasoning_effort,
            runtime_config.codex_needs_proxy,
            runtime_config.provider,
            runtime_config.credential_source,
            runtime_generation,
        )?;

        send_command_to_session(&agent_state, &session_id, ensure_cmd).await?;

        let mut input_cmd =
            OpenCodeRuntime::send_input_command(&session_id, prompt, display_content.as_deref());
        if let Some(payload) = input_payload {
            input_cmd["inputPayload"] = payload;
        }
        send_command_to_session(&agent_state, &session_id, input_cmd).await
    })
    .await
}

#[tauri::command]
pub async fn interrupt_agent_session(
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let ctx = crate::log_ctx::LogCtx::with_session(&session_id);
    crate::log_ctx::with_ctx(ctx, || async {
        crate::log_ctx!(info, target: "agent", "Interrupt requested");
        let lifecycle_lock = session_lifecycle_lock(agent_state.inner(), &session_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        invalidate_session_generation(agent_state.inner(), &session_id).await;
        let sidecar = {
            let mut sidecars = agent_state.sidecars.lock().await;
            sidecars.remove(&session_id)
        };
        if let Some(handle) = sidecar {
            let _ = handle
                .send_command(&OpenCodeRuntime::interrupt_command().to_string())
                .await;
            agent_state
                .sidecars
                .lock()
                .await
                .insert(session_id.clone(), handle);
            crate::log_ctx!(info, target: "agent", "Interrupt command sent, sidecar kept alive");
        } else {
            crate::log_ctx!(info, target: "agent", "Interrupt skipped; no active sidecar");
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn shutdown_agent(
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let ctx = crate::log_ctx::LogCtx::with_session(&session_id);
    crate::log_ctx::with_ctx(ctx, || async {
        crate::log_ctx!(info, target: "agent", "Shutdown requested");
        let lifecycle_lock = session_lifecycle_lock(agent_state.inner(), &session_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        invalidate_session_generation(agent_state.inner(), &session_id).await;
        let sidecar = {
            let mut sidecars = agent_state.sidecars.lock().await;
            sidecars.remove(&session_id)
        };
        if let Some(mut handle) = sidecar {
            handle.shutdown().await;
        } else {
            crate::log_ctx!(info, target: "agent", "Shutdown skipped; no active sidecar");
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn send_tool_response(
    agent_state: State<'_, AgentState>,
    session_id: String,
    tool_use_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    let ctx = crate::log_ctx::LogCtx::with_session(&session_id);
    crate::log_ctx::with_ctx(ctx, || async {
        crate::log_ctx!(info, target: "agent", "Sending tool response tool_use_id={}", tool_use_id);
        let cmd = serde_json::json!({
            "type": "tool_response",
            "toolUseId": tool_use_id,
            "response": response,
        });
        let command_sender = {
            let sidecars = agent_state.sidecars.lock().await;
            sidecars.get(&session_id).map(SidecarHandle::command_sender)
        };
        if let Some(command_sender) = command_sender {
            command_sender
                .send(cmd.to_string())
                .await
                .map_err(|_| "Failed to send command to sidecar".to_string())?;
        } else {
            crate::log_ctx!(warn, target: "agent", "Tool response skipped because no sidecar was found tool_use_id={}", tool_use_id);
        }
        Ok(())
    }).await
}

#[tauri::command]
pub async fn respond_to_agent_permission(
    agent_state: State<'_, AgentState>,
    session_id: String,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    let ctx = crate::log_ctx::LogCtx::with_session(&session_id);
    crate::log_ctx::with_ctx(ctx, || async {
        crate::log_ctx!(info, target: "agent", "Respond to permission request_id={}", request_id);
        let cmd =
            OpenCodeRuntime::respond_to_permission_command(&request_id, &session_id, response);
        send_command_to_session(&agent_state, &session_id, cmd).await
    })
    .await
}

#[tauri::command]
pub async fn reset_agent_session(
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let ctx = crate::log_ctx::LogCtx::with_session(&session_id);
    crate::log_ctx::with_ctx(ctx, || async {
        crate::log_ctx!(info, target: "agent", "Reset requested");
        let lifecycle_lock = session_lifecycle_lock(agent_state.inner(), &session_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let agent_kind = resolve_session_agent_kind(&state, &session_id)?;
        invalidate_session_generation(agent_state.inner(), &session_id).await;
        let cmd = OpenCodeRuntime::reset_session_command(&session_id);

        let command_sender = {
            let sidecars = agent_state.sidecars.lock().await;
            sidecars.get(&session_id).map(SidecarHandle::command_sender)
        };
        if let Some(command_sender) = command_sender {
            command_sender
                .send(cmd.to_string())
                .await
                .map_err(|_| "Failed to send command to sidecar".to_string())?;
        } else {
            crate::log_ctx!(info, target: "agent", "Reset skipped; no active sidecar");
        }

        if agent_kind == "opencode" {
            let db = state.db.lock().unwrap();
            operations::delete_agent_session_mapping(&db, &session_id, AgentKind::Opencode)
                .map_err(|error| {
                    format!(
                        "Failed to clear OpenCode session mapping for session_id={}: {}",
                        session_id, error
                    )
                })?;
        }

        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn rewind_agent_session(
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    app_session_id: String,
    agent_kind: String,
    target: Option<RewindTarget>,
) -> Result<(), String> {
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    let Some(agent_session_id) = get_agent_session_id(state.inner(), &app_session_id, agent_kind)?
    else {
        return Err(format!(
            "No agent session mapping found for session_id={}",
            app_session_id
        ));
    };

    let home = home_dir()?;
    let (rewind_outcome, history_display): (RewindOutcome, String) = if agent_kind
        == AgentKind::Opencode
    {
        let truncated_to_empty =
            opencode_history::rewind_opencode_session_to_latest_turn(&home, &agent_session_id)?;
        (
            RewindOutcome { truncated_to_empty },
            agent_session_id.clone(),
        )
    } else {
        let history_path = match agent_kind {
            AgentKind::ClaudeCode => {
                find_claude_session_jsonl(&home.join(".claude"), &agent_session_id)
            }
            AgentKind::Codex => {
                find_codex_session_jsonl(&home.join(".codex").join("sessions"), &agent_session_id)
            }
            AgentKind::GeminiCli => None,
            AgentKind::Opencode => unreachable!(),
        }
        .ok_or_else(|| {
            format!(
                "Session history file not found for session_id={} agent_session_id={}",
                app_session_id, agent_session_id
            )
        })?;

        let outcome = rewind_jsonl_before_target_turn(&history_path, agent_kind, target.clone())?;

        if agent_kind == AgentKind::Codex {
            let interactive_path = codex_interactive_events_dir(&home)
                .join(format!("{}.jsonl", sanitize_file_segment(&app_session_id)));
            if interactive_path.exists() {
                let _ =
                    rewind_jsonl_before_target_turn(&interactive_path, agent_kind, target.clone());
            }
        }

        (outcome, history_path.display().to_string())
    };

    if rewind_outcome.truncated_to_empty {
        {
            let db = state.db.lock().unwrap();
            operations::delete_agent_session_mapping(&db, &app_session_id, agent_kind)
                .map_err(|err| format!("Failed to clear rewound agent session mapping: {}", err))?;
        }
        info!(
            target: "agent",
            "Cleared agent session mapping after rewinding first message app_session_id={} agent_kind={}",
            app_session_id,
            agent_kind.as_str()
        );

        let sidecar = {
            let mut sidecars = agent_state.sidecars.lock().await;
            sidecars.remove(&app_session_id)
        };
        if let Some(mut handle) = sidecar {
            info!(
                target: "agent",
                "Shutting down sidecar after rewinding first message app_session_id={} agent_kind={}",
                app_session_id,
                agent_kind.as_str()
            );
            handle.shutdown().await;
        }
    } else {
        let cmd = serde_json::json!({
            "type": "reset_session",
            "sessionId": app_session_id,
        });
        let command_sender = {
            let sidecars = agent_state.sidecars.lock().await;
            sidecars
                .get(&app_session_id)
                .map(SidecarHandle::command_sender)
        };
        if let Some(command_sender) = command_sender {
            command_sender
                .send(cmd.to_string())
                .await
                .map_err(|_| "Failed to send command to sidecar".to_string())?;
        }
    }

    info!(
        target: "agent",
        "Rewound agent session app_session_id={} agent_kind={} history_path={}",
        app_session_id,
        agent_kind.as_str(),
        history_display,
    );

    Ok(())
}

#[tauri::command]
pub async fn delete_claude_session_files(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<String>, String> {
    use std::fs;
    let claude_dir = home_dir()?.join(".claude");

    let Some(claude_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::ClaudeCode)?
    else {
        debug!(target: "agent", "No Claude session mapping found for session_id={}", app_session_id);
        return Ok(vec![]);
    };

    info!(
        target: "agent",
        "Deleting Claude session files for app_session_id={} claude_session_id={}",
        app_session_id,
        claude_session_id
    );

    let mut deleted = Vec::new();
    let projects_dir = claude_dir.join("projects");

    if projects_dir.exists() {
        if let Ok(entries) = fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let jsonl = entry.path().join(format!("{}.jsonl", claude_session_id));
                if jsonl.exists() {
                    let _ = fs::remove_file(&jsonl);
                    deleted.push(jsonl.to_string_lossy().to_string());
                }
                // 删除会话子目录（含 subagents 等子智能体记录）
                let session_subdir = entry.path().join(&claude_session_id);
                if session_subdir.exists() {
                    let _ = fs::remove_dir_all(&session_subdir);
                    deleted.push(session_subdir.to_string_lossy().to_string());
                }
            }
        }
    }

    let session_env = claude_dir.join("session-env").join(&claude_session_id);
    if session_env.exists() {
        let _ = fs::remove_dir_all(&session_env);
        deleted.push(session_env.to_string_lossy().to_string());
    }

    let file_history = claude_dir.join("file-history").join(&claude_session_id);
    if file_history.exists() {
        let _ = fs::remove_dir_all(&file_history);
        deleted.push(file_history.to_string_lossy().to_string());
    }

    let todos_dir = claude_dir.join("todos");
    if todos_dir.exists() {
        if let Ok(entries) = fs::read_dir(&todos_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&claude_session_id) {
                    let _ = fs::remove_file(entry.path());
                    deleted.push(entry.path().to_string_lossy().to_string());
                }
            }
        }
    }

    let debug_file = claude_dir
        .join("debug")
        .join(format!("{}.txt", claude_session_id));
    if debug_file.exists() {
        let _ = fs::remove_file(&debug_file);
        deleted.push(debug_file.to_string_lossy().to_string());
    }

    let history_file = claude_dir.join("history.jsonl");
    if history_file.exists() {
        if let Ok(content) = fs::read_to_string(&history_file) {
            let filtered: String = content
                .lines()
                .filter(|line| !line.contains(&format!("\"sessionId\":\"{}\"", claude_session_id)))
                .collect::<Vec<_>>()
                .join("\n");
            if filtered.len() != content.len() {
                let _ = fs::write(&history_file, filtered);
                deleted.push(history_file.to_string_lossy().to_string());
            }
        }
    }

    info!(
        target: "agent",
        "Deleted {} Claude session file entries for app_session_id={}",
        deleted.len(),
        app_session_id
    );

    Ok(deleted)
}

#[tauri::command]
pub async fn delete_codex_session_files(
    state: State<'_, crate::AppState>,
    app_session_id: String,
) -> Result<Vec<String>, String> {
    use std::fs;

    let Some(codex_session_id) =
        get_agent_session_id(state.inner(), &app_session_id, AgentKind::Codex)?
    else {
        debug!(target: "agent", "No Codex session mapping found for session_id={}", app_session_id);
        return Ok(vec![]);
    };

    info!(
        target: "agent",
        "Deleting Codex session files for app_session_id={} codex_session_id={}",
        app_session_id,
        codex_session_id
    );

    let mut deleted = Vec::new();
    let sessions_dir = home_dir()?.join(".codex").join("sessions");

    if sessions_dir.exists() {
        let mut candidates = Vec::new();
        collect_codex_jsonl_files(&sessions_dir, &mut candidates);

        for path in candidates {
            if read_codex_session_meta_id(&path).as_deref() == Some(&codex_session_id) {
                let _ = fs::remove_file(&path);
                deleted.push(path.to_string_lossy().to_string());
            }
        }
    }

    let interactive_events_path = codex_interactive_events_dir(&home_dir()?)
        .join(format!("{}.jsonl", sanitize_file_segment(&app_session_id)));
    if interactive_events_path.exists() {
        let _ = fs::remove_file(&interactive_events_path);
        deleted.push(interactive_events_path.to_string_lossy().to_string());
    }

    info!(
        target: "agent",
        "Deleted {} Codex session file entries for app_session_id={}",
        deleted.len(),
        app_session_id
    );

    Ok(deleted)
}

/// Find any active sidecar to send a global command (e.g. proxy management).
/// Skips the dedicated proxy sidecar — it has no Codex session initialized.
fn find_any_active_sidecar(sidecars: &HashMap<String, SidecarHandle>) -> Option<String> {
    sidecars
        .keys()
        .find(|id| id.as_str() != PROXY_SESSION_ID)
        .cloned()
}

/// Parse the proxy port from captured sidecar stderr lines.
fn parse_proxy_port_from_stderr(lines: &[String]) -> Option<u16> {
    for line in lines.iter().rev() {
        if let Some(rest) = line.strip_prefix("[proxy-manager] Proxy started on port ") {
            if let Some(port_str) = rest.split(',').next() {
                if let Ok(port) = port_str.trim().parse::<u16>() {
                    return Some(port);
                }
            }
        }

        if let Some(rest) = line.strip_prefix("[proxy-manager] Reusing existing proxy on port ") {
            if let Ok(port) = rest.trim().parse::<u16>() {
                return Some(port);
            }
        }
    }

    None
}

#[allow(dead_code)]
async fn probe_local_proxy_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/__codemux_proxy_health", port);
    match reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[allow(dead_code)]
async fn get_live_proxy_port(agent_state: &State<'_, AgentState>) -> Option<u16> {
    let current = *agent_state.proxy_port.lock().await;
    let port = current?;

    if port == 0 {
        *agent_state.proxy_port.lock().await = None;
        return None;
    }

    if probe_local_proxy_health(port).await {
        return Some(port);
    }

    warn!(target: "agent", "Cached codex proxy port {} failed health check; clearing stale proxy state", port);
    *agent_state.proxy_port.lock().await = None;
    None
}

#[cfg(test)]
mod tests {
    use super::{
        begin_session_generation, build_ensure_session_command,
        build_update_permissions_command_from_snapshot, convert_codex_history_values_to_events,
        convert_codex_item_to_claude_format, find_codex_session_jsonl,
        handle_agent_session_mapping_event, invalidate_session_generation,
        load_latest_token_usage_for_agent_session, mapping_generation_is_current,
        parse_agent_session_mapping_event, parse_proxy_port_from_stderr,
        persist_agent_session_mapping_event, read_codex_interactive_events_from_dir,
        read_json_stream_values, resolve_active_runtime_config, resolve_agent_session_info,
        rewind_jsonl_before_latest_turn, rewind_jsonl_before_target_turn, session_lifecycle_lock,
        should_include_claude_history_event, sort_events_by_timestamp_stable, AgentState,
        RewindTarget,
    };
    use crate::config::types::AgentKind;

    #[test]
    fn find_codex_session_jsonl_matches_only_session_meta_payload_id() {
        use std::fs;

        let base =
            std::env::temp_dir().join(format!("codemux-codex-test-{}", uuid::Uuid::new_v4()));
        let sessions_dir = base.join("2026").join("06").join("11");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(
            sessions_dir.join("wrong-id.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"wrong-session\",\"timestamp\":\"2026-06-11T10:00:00Z\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"wrong\"}]}}\n"
            ),
        )
        .unwrap();
        fs::write(
            sessions_dir.join("target.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"target-session\",\"timestamp\":\"2026-06-11T11:00:00Z\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}}\n"
            ),
        )
        .unwrap();

        let matched =
            find_codex_session_jsonl(&base, "target-session").expect("matching file should exist");
        assert_eq!(matched, sessions_dir.join("target.jsonl"));

        let missing = find_codex_session_jsonl(&base, "missing-session");
        assert!(missing.is_none());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_agent_session_info_returns_codex_id_and_message_path() {
        let temp =
            std::env::temp_dir().join(format!("codemux-agent-info-test-{}", uuid::Uuid::new_v4()));
        let sessions_dir = temp.join(".codex").join("sessions").join("2026").join("06");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let jsonl = sessions_dir.join("rollout.jsonl");
        std::fs::write(
            &jsonl,
            r#"{"type":"session_meta","payload":{"id":"codex-session-1"}}"#,
        )
        .unwrap();

        let info = resolve_agent_session_info(
            &temp,
            AgentKind::Codex,
            Some("codex-session-1".to_string()),
        )
        .unwrap();

        assert_eq!(info.agent_session_id.as_deref(), Some("codex-session-1"));
        assert_eq!(
            info.message_path.as_deref(),
            Some(jsonl.to_string_lossy().as_ref())
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn loads_latest_claude_token_usage_from_agent_session_file() {
        let temp = std::env::temp_dir().join(format!(
            "codemux-claude-usage-test-{}",
            uuid::Uuid::new_v4()
        ));
        let project_dir = temp.join(".claude").join("projects").join("d--project");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(
            project_dir.join("claude-session-1.jsonl"),
            concat!(
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":20,\"output_tokens\":3}}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input_tokens\":30,\"cache_read_input_tokens\":40,\"output_tokens\":5}}}\n"
            ),
        )
        .unwrap();

        let usage = load_latest_token_usage_for_agent_session(
            &temp,
            AgentKind::ClaudeCode,
            "claude-session-1",
            "restored",
        )
        .expect("load should not fail")
        .expect("usage should exist");

        assert_eq!(usage.last.total_tokens, 70);
        assert_eq!(usage.last.input_tokens, 30);
        assert_eq!(usage.last.cached_input_tokens, 40);
        assert_eq!(usage.last.output_tokens, 5);

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn loads_latest_codex_token_usage_from_agent_session_file() {
        let temp =
            std::env::temp_dir().join(format!("codemux-codex-usage-test-{}", uuid::Uuid::new_v4()));
        let sessions_dir = temp
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("07")
            .join("11");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        std::fs::write(
            sessions_dir.join("rollout.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-session-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":20,\"cached_input_tokens\":7,\"output_tokens\":5},\"model_context_window\":200000}}}\n"
            ),
        )
        .unwrap();

        let usage = load_latest_token_usage_for_agent_session(
            &temp,
            AgentKind::Codex,
            "codex-session-1",
            "live_synced",
        )
        .expect("load should not fail")
        .expect("usage should exist");

        assert_eq!(usage.last.total_tokens, 25);
        assert_eq!(usage.last.cached_input_tokens, 7);
        assert_eq!(usage.model_context_window, Some(200_000));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn loads_latest_opencode_token_usage_from_sqlite_message_history() {
        let temp = std::env::temp_dir().join(format!(
            "codemux-opencode-usage-test-{}",
            uuid::Uuid::new_v4()
        ));
        let db_dir = temp.join("AppData").join("Local").join("opencode");
        std::fs::create_dir_all(&db_dir).unwrap();
        let db_path = db_dir.join("opencode.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "assistant-1",
                    "opencode-session-1",
                    1000_i64,
                    r#"{"role":"assistant","tokens":{"input":9,"output":3,"reasoning":1,"cache":{"read":2,"write":1}}}"#,
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![
                    "assistant-2",
                    "opencode-session-1",
                    2000_i64,
                    r#"{"role":"assistant","tokens":{"input":12,"output":5,"reasoning":2,"cache":{"read":7,"write":3}}}"#,
                ],
            )
            .unwrap();
        drop(connection);

        let usage = load_latest_token_usage_for_agent_session(
            &temp,
            AgentKind::Opencode,
            "opencode-session-1",
            "restored",
        )
        .expect("load should not fail")
        .expect("usage should exist");

        assert_eq!(usage.last.total_tokens, 17);
        assert_eq!(usage.last.input_tokens, 12);
        assert_eq!(usage.last.cached_input_tokens, 7);
        assert_eq!(usage.last.output_tokens, 5);
        assert_eq!(usage.last.reasoning_output_tokens, 2);
        assert_eq!(usage.total, usage.last);
        assert_eq!(usage.context_usage_source, "history_database");
        assert_eq!(usage.context_usage_freshness, "restored");

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn rewinds_claude_jsonl_before_latest_visible_user_turn() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}]}}\n",
                "{\"type\":\"result\",\"subtype\":\"success\"}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_codex_jsonl_before_latest_user_message_but_keeps_session_meta() {
        let path = std::env::temp_dir().join(format!(
            "codemux-codex-rewind-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-session-1\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"second\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"second answer\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::Codex).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-session-1\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_command_turn_removes_meta_and_xml_echo_together() {
        // When a command turn contains multiple user lines (the plain-text
        // command, the isMeta expansion, and the <command-message> XML echo),
        // all of them belong to the same turn and must be removed together.
        // The previous turn's content must be preserved.
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-cmd-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"/init\"}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"expanded init prompt\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-message>init</command-message><command-name>/init</command-name><command-args></command-args>\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"init answer\"}]}}\n",
                "{\"type\":\"result\",\"subtype\":\"success\"}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_keeps_tool_result_within_previous_turn() {
        // A tool_result line has type "user" but belongs to the previous turn.
        // When the latest user line is a plain-text message from a later turn,
        // the earlier tool_result (and its surrounding assistant tool_use and
        // text-only reply) must all be preserved as part of that earlier turn.
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-tool-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"bash\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        // The whole first turn (user, tool_use, tool_result, assistant reply)
        // is kept; only the second turn is removed.
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"bash\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_drops_whole_turn_when_tool_result_is_latest_user() {
        // When the latest user line is a tool_result (e.g. the turn is still
        // mid-flight), scanning backwards must walk past the assistant tool_use
        // and reach the turn's first user line, removing the whole turn.
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-toolresult-latest-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"bash\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        // The whole second turn (user, tool_use, tool_result) is removed;
        // only the first turn survives.
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_command_turn_walks_past_thinking_assistant() {
        // Real Claude Code JSONL emits thinking, tool_use, and text as separate
        // assistant lines. A command turn looks like:
        //   user (XML echo) → user (isMeta) → assistant (thinking) →
        //   assistant (tool_use) → user (tool_result) → user (isMeta) →
        //   assistant (thinking) → assistant (text = final reply)
        // The thinking-only assistant must NOT be treated as a turn boundary,
        // otherwise the scan stops too early and the command's XML echo / isMeta
        // lines survive in the JSONL — which re-surface as a phantom command
        // message on the next history load.
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-thinking-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-message>find-skills</command-message><command-name>/find-skills</command-name><command-args>触发技能</command-args>\"}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"expanded prompt\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"planning\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Skill\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"Base directory for this skill\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"reflecting\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"skill answer\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_latest_turn(&path, AgentKind::ClaudeCode).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        // The entire command turn (XML echo + isMeta + thinking + tool_use +
        // tool_result + isMeta + thinking + text) is removed; only the first
        // plain-text turn survives.
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_claude_jsonl_by_target_uuid_ignores_later_skill_user_lines() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-target-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"role\":\"user\",\"content\":\"use skill\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Skill\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"Base directory for this skill\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"skill answer\"}]}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_target_turn(
            &path,
            AgentKind::ClaudeCode,
            Some(RewindTarget {
                provider_message_id: Some("u2".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("use skill".to_string()),
                turn_ordinal: Some(2),
            }),
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewind_target_missing_does_not_truncate_latest_turn() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-target-missing-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let original = concat!(
            "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
        );
        std::fs::write(&path, original).unwrap();

        let error = rewind_jsonl_before_target_turn(
            &path,
            AgentKind::ClaudeCode,
            Some(RewindTarget {
                provider_message_id: Some("missing".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: None,
                turn_ordinal: None,
            }),
        )
        .expect_err("missing target should not fall back to latest");

        assert!(error.contains("Target rewind user message not found"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewind_single_claude_user_reports_empty_history() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-empty-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
        )
        .unwrap();

        let outcome = rewind_jsonl_before_target_turn(
            &path,
            AgentKind::ClaudeCode,
            Some(RewindTarget {
                provider_message_id: Some("u1".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("first".to_string()),
                turn_ordinal: None,
            }),
        )
        .unwrap();

        assert!(outcome.truncated_to_empty);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewind_first_claude_tool_turn_after_system_line_reports_empty_user_history() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-first-tool-turn-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\"}\n",
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"use skill\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Skill\",\"input\":{}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"done\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"answer\"}]}}\n"
            ),
        )
        .unwrap();

        let outcome = rewind_jsonl_before_target_turn(
            &path,
            AgentKind::ClaudeCode,
            Some(RewindTarget {
                provider_message_id: Some("u1".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("use skill".to_string()),
                turn_ordinal: None,
            }),
        )
        .unwrap();

        assert!(outcome.truncated_to_empty);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\"}\n"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_codex_jsonl_by_target_payload_id_ignores_tool_outputs() {
        let path = std::env::temp_dir().join(format!(
            "codemux-codex-rewind-target-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"id\":\"u1\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"id\":\"u2\",\"content\":[{\"type\":\"input_text\",\"text\":\"use skill\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call_skill\",\"name\":\"Skill\",\"arguments\":\"{}\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_skill\",\"output\":\"done\"}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_target_turn(
            &path,
            AgentKind::Codex,
            Some(RewindTarget {
                provider_message_id: Some("u2".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("use skill".to_string()),
                turn_ordinal: Some(2),
            }),
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"id\":\"u1\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rewinds_codex_event_msg_user_by_target_payload_id() {
        let path = std::env::temp_dir().join(format!(
            "codemux-codex-rewind-event-msg-target-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"id\":\"u1\",\"message\":\"first\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"first answer\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"id\":\"u2\",\"message\":\"use skill\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call_skill\",\"name\":\"tool_search\",\"arguments\":\"{}\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_skill\",\"output\":\"done\"}}\n"
            ),
        )
        .unwrap();

        rewind_jsonl_before_target_turn(
            &path,
            AgentKind::Codex,
            Some(RewindTarget {
                provider_message_id: Some("u2".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("use skill".to_string()),
                turn_ordinal: None,
            }),
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"id\":\"u1\",\"message\":\"first\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"first answer\"}}\n"
            )
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parse_proxy_port_from_reuse_log() {
        let lines = vec![
            "[codex-compat-proxy] port 15722 busy, retrying (1/5)...".to_string(),
            "[proxy-manager] Reusing existing proxy on port 15722".to_string(),
        ];

        assert_eq!(parse_proxy_port_from_stderr(&lines), Some(15722));
    }

    #[test]
    fn convert_codex_user_message_preserves_provider_message_id() {
        let converted = convert_codex_item_to_claude_format(&serde_json::json!({
            "type": "response_item",
            "__lineIndex": 4,
            "payload": {
                "type": "message",
                "role": "user",
                "id": "codex-user-1",
                "content": [{ "type": "input_text", "text": "hello" }]
            }
        }))
        .expect("codex user message should convert");

        assert_eq!(converted["type"], "user");
        assert_eq!(converted["uuid"], "codex-user-1");
        assert_eq!(converted["__lineIndex"], 4);
    }

    #[test]
    fn resolves_codex_runtime_config_from_the_active_profile() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-codex", "Codex", "codex", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let mut config = crate::config::types::AppConfig::default();
        let profile = crate::provider_profiles::types::AgentProviderProfile {
            id: "codex-profile".to_string(),
            agent_kind: AgentKind::Codex,
            name: "Codex 测试档案".to_string(),
            note: String::new(),
            models: vec![
                crate::provider_profiles::types::ProfileModel {
                    id: "gpt-first".to_string(),
                    name: None,
                    context_window: None,
                },
                crate::provider_profiles::types::ProfileModel {
                    id: "gpt-test".to_string(),
                    name: None,
                    context_window: None,
                },
            ],
            default_model: "gpt-test".to_string(),
            native_config: crate::provider_profiles::types::NativeProfileConfig::Codex {
                api_key: "internal-secret".to_string(),
                openai_base_url: "https://provider.example/v1".to_string(),
                codex_needs_proxy: Some(true),
                advanced_config: None,
                auth_json: None,
                config_toml: None,
                model_catalog: None,
                requires_review: false,
            },
        };
        config.agent_profile_registry.profiles.push(profile);
        config
            .agent_profile_registry
            .active_profile_ids
            .insert(AgentKind::Codex, "codex-profile".to_string());
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(config),
            provider_profile_operation_lock: std::sync::Mutex::new(()),
            app_data_dir: std::path::PathBuf::new(),
        };

        let resolved = resolve_active_runtime_config(&state, "session-codex").unwrap();

        assert_eq!(resolved.profile_id, "codex-profile");
        assert_eq!(resolved.api_key.as_deref(), Some("internal-secret"));
        assert_eq!(
            resolved.base_url.as_deref(),
            Some("https://provider.example/v1")
        );
        assert_eq!(resolved.model.as_deref(), Some("gpt-test"));
        assert_eq!(resolved.codex_needs_proxy, Some(true));
        let snapshot: String = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT provider_id FROM sessions WHERE id = 'session-codex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(snapshot, "codex-profile");
    }

    #[test]
    fn claude_code_keeps_builtin_model_when_session_model_is_set() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        // 模拟"从自定义切到内置"后的 DB 状态：provider_id=NULL, model=sonnet
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, provider_id, model, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                "session-claude-builtin",
                "Claude",
                "claude_code",
                None::<String>,
                "sonnet",
                "agent",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();
        // 全局仍有一个激活的自定义 claude_code profile（bug 场景：会被错误回退）
        let mut config = crate::config::types::AppConfig::default();
        let profile = crate::provider_profiles::types::AgentProviderProfile {
            id: "claude-custom".to_string(),
            agent_kind: AgentKind::ClaudeCode,
            name: "自定义 Claude".to_string(),
            note: String::new(),
            models: vec![crate::provider_profiles::types::ProfileModel {
                id: "custom-model".to_string(),
                name: None,
                context_window: None,
            }],
            default_model: "custom-model".to_string(),
            native_config: crate::provider_profiles::types::NativeProfileConfig::ClaudeCode {
                settings: serde_json::json!({}),
                requires_review: false,
            },
        };
        config.agent_profile_registry.profiles.push(profile);
        config
            .agent_profile_registry
            .active_profile_ids
            .insert(AgentKind::ClaudeCode, "claude-custom".to_string());
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(config),
            provider_profile_operation_lock: std::sync::Mutex::new(()),
            app_data_dir: std::path::PathBuf::new(),
        };

        let resolved = resolve_active_runtime_config(&state, "session-claude-builtin").unwrap();

        // 应使用内置 sonnet，而不是回退到激活的自定义 profile
        assert_eq!(resolved.profile_id, "__claude_default__");
        assert_eq!(resolved.model.as_deref(), Some("sonnet"));
        assert_eq!(resolved.api_key, None);
        assert_eq!(resolved.base_url, None);
        // session.model 不应被覆写
        let snapshot_model: Option<String> = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT model FROM sessions WHERE id = 'session-claude-builtin'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(snapshot_model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn respects_persisted_session_model_within_profile() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        // session 已绑定 profile，且保存了用户选择的具体模型（非 models[0]）
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, provider_id, model, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                "session-codex-switched",
                "Codex",
                "codex",
                "codex-profile",
                "gpt-test",
                "agent",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();
        let mut config = crate::config::types::AppConfig::default();
        let profile = crate::provider_profiles::types::AgentProviderProfile {
            id: "codex-profile".to_string(),
            agent_kind: AgentKind::Codex,
            name: "Codex 测试档案".to_string(),
            note: String::new(),
            models: vec![
                crate::provider_profiles::types::ProfileModel {
                    id: "gpt-first".to_string(),
                    name: None,
                    context_window: None,
                },
                crate::provider_profiles::types::ProfileModel {
                    id: "gpt-test".to_string(),
                    name: None,
                    context_window: None,
                },
            ],
            default_model: String::new(),
            native_config: crate::provider_profiles::types::NativeProfileConfig::Codex {
                api_key: "internal-secret".to_string(),
                openai_base_url: "https://provider.example/v1".to_string(),
                codex_needs_proxy: Some(true),
                advanced_config: None,
                auth_json: None,
                config_toml: None,
                model_catalog: None,
                requires_review: false,
            },
        };
        config.agent_profile_registry.profiles.push(profile);
        config
            .agent_profile_registry
            .active_profile_ids
            .insert(AgentKind::Codex, "codex-profile".to_string());
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(config),
            provider_profile_operation_lock: std::sync::Mutex::new(()),
            app_data_dir: std::path::PathBuf::new(),
        };

        let resolved = resolve_active_runtime_config(&state, "session-codex-switched").unwrap();

        // 应使用 session 保存的 gpt-test，而不是 models[0]（gpt-first）
        assert_eq!(resolved.profile_id, "codex-profile");
        assert_eq!(resolved.model.as_deref(), Some("gpt-test"));
        // provider_id 已存在，不应触发覆写
        let snapshot_model: Option<String> = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT model FROM sessions WHERE id = 'session-codex-switched'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(snapshot_model.as_deref(), Some("gpt-test"));
    }

    #[test]
    fn builds_opencode_command_with_provider_credentials() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-opencode", "OpenCode", "opencode", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let app_state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            provider_profile_operation_lock: std::sync::Mutex::new(()),
            app_data_dir: std::path::PathBuf::new(),
        };

        let command = build_ensure_session_command(
            &app_state,
            "session-opencode",
            "opencode",
            "D:/workspace/demo".to_string(),
            Some("secret-key".to_string()),
            Some("https://provider.example/v1".to_string()),
            Some("glm-4.7-flash".to_string()),
            None,
            None,
            Some("codemux-openai".to_string()),
            Some("codemux".to_string()),
            Some(1),
        )
        .unwrap();

        assert_eq!(command["provider"], "codemux-openai");
        assert_eq!(command["credentialSource"], "codemux");
        assert_eq!(command["apiKey"], "secret-key");
        assert_eq!(command["baseUrl"], "https://provider.example/v1");
        assert_eq!(command["runtimeGeneration"], 1);

        let claude_command = build_ensure_session_command(
            &app_state,
            "session-opencode",
            "claude_code",
            "D:/workspace/demo".to_string(),
            Some("secret-key".to_string()),
            Some("https://provider.example/v1".to_string()),
            None,
            None,
            None,
            Some("codemux-openai".to_string()),
            Some("codemux".to_string()),
            None,
        )
        .unwrap();
        assert!(claude_command.get("provider").is_none());
        assert!(claude_command.get("credentialSource").is_none());
    }
    #[test]
    fn builds_runtime_permission_update_command_from_session_snapshot() {
        let cmd = build_update_permissions_command_from_snapshot(
            "session-1",
            "codex",
            Some(r#"{"kind":"codex","sandboxMode":"read-only","approvalPolicy":"on-request","networkAccessEnabled":false}"#.to_string()),
            Some("on".to_string()),
        );

        assert_eq!(
            cmd,
            serde_json::json!({
                "type": "update_permissions",
                "sessionId": "session-1",
                "agentKind": "codex",
                "permissionConfig": {
                    "kind": "codex",
                    "sandboxMode": "read-only",
                    "approvalPolicy": "on-request",
                    "networkAccessEnabled": false
                },
                "planMode": "on"
            })
        );

        let opencode_cmd = build_update_permissions_command_from_snapshot(
            "session-opencode",
            "opencode",
            Some(r#"{"kind":"opencode","allow":"ask"}"#.to_string()),
            Some("off".to_string()),
        );
        assert_eq!(opencode_cmd["agentKind"], "opencode");
        assert_eq!(opencode_cmd["permissionConfig"]["kind"], "opencode");
    }

    #[test]
    fn parses_opencode_session_mapping_event_for_database_persistence() {
        let mapping = parse_agent_session_mapping_event(
            r#"{"type":"agent_session_mapping","app_session_id":"app-session","agent_kind":"opencode","agent_session_id":"opencode-session","runtime_generation":7}"#,
        )
        .expect("mapping event should parse")
        .expect("valid mapping event should return a mapping");

        assert_eq!(mapping.app_session_id, "app-session");
        assert_eq!(mapping.agent_kind, AgentKind::Opencode);
        assert_eq!(mapping.agent_session_id, "opencode-session");
        assert_eq!(mapping.runtime_generation, Some(7));
    }

    #[test]
    fn rejects_malformed_agent_session_mapping_event_without_db_write() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["app-session", "OpenCode", "opencode", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        let event = r#"{"type":"agent_session_mapping","app_session_id":"app-session","agent_kind":"opencode"}"#;
        let error = persist_agent_session_mapping_event(&conn, event).unwrap_err();

        assert!(error.contains("Invalid agent session mapping event"));
        assert!(crate::db::operations::get_agent_session_mapping(
            &conn,
            "app-session",
            AgentKind::Opencode,
        )
        .unwrap()
        .is_none());

        let malformed_json = r#"{"type":"agent_session_mapping","app_session_id":"app-session""#;
        let error = persist_agent_session_mapping_event(&conn, malformed_json).unwrap_err();
        assert!(error.contains("Invalid agent session mapping event"));
    }

    #[test]
    fn returns_database_write_failure_for_mapping_event() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();

        let error = persist_agent_session_mapping_event(
            &conn,
            r#"{"type":"agent_session_mapping","app_session_id":"missing-session","agent_kind":"opencode","agent_session_id":"opencode-session","runtime_generation":1}"#,
        )
        .unwrap_err();

        assert!(error.contains("Failed to persist agent session mapping"));
    }

    #[tokio::test]
    async fn reset_and_start_share_a_deterministic_session_lifecycle_lock() {
        let state = AgentState::default();
        let lock = session_lifecycle_lock(&state, "session-opencode").await;
        let guard = lock.lock().await;
        let started = tokio::sync::oneshot::channel();
        let (started_tx, mut started_rx) = started;
        let reset = tokio::spawn(async move {
            let lock = session_lifecycle_lock(&state, "session-opencode").await;
            let _guard = lock.lock().await;
            let _ = started_tx.send(());
        });

        tokio::task::yield_now().await;
        assert!(started_rx.try_recv().is_err());
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), reset)
            .await
            .expect("reset should acquire lifecycle lock")
            .unwrap();
    }

    #[tokio::test]
    async fn shutdown_and_start_share_a_deterministic_session_lifecycle_lock() {
        let state = AgentState::default();
        let lock = session_lifecycle_lock(&state, "session-opencode").await;
        let guard = lock.lock().await;
        let (started_tx, mut started_rx) = tokio::sync::oneshot::channel();
        let shutdown = tokio::spawn(async move {
            let lock = session_lifecycle_lock(&state, "session-opencode").await;
            let _guard = lock.lock().await;
            let _ = started_tx.send(());
        });

        tokio::task::yield_now().await;
        assert!(started_rx.try_recv().is_err());
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), shutdown)
            .await
            .expect("shutdown should acquire lifecycle lock")
            .unwrap();
    }

    #[tokio::test]
    async fn late_old_opencode_mapping_event_is_dropped_after_reset_and_start() {
        let state = AgentState::default();
        let lifecycle_lock = session_lifecycle_lock(&state, "session-opencode").await;
        let lifecycle_guard = lifecycle_lock.lock().await;
        let old_generation = begin_session_generation(&state, "session-opencode").await;
        let old_event_generation = old_generation;
        let session_generations = state.session_generations.clone();
        let event_lock = lifecycle_lock.clone();
        let (event_checked_tx, mut event_checked_rx) = tokio::sync::oneshot::channel();
        let event_waiter = tokio::spawn(async move {
            let _event_guard = event_lock.lock().await;
            let accepted = mapping_generation_is_current(
                &session_generations,
                "session-opencode",
                old_event_generation,
            )
            .await;
            let _ = event_checked_tx.send(accepted);
        });
        tokio::task::yield_now().await;
        assert!(event_checked_rx.try_recv().is_err());
        invalidate_session_generation(&state, "session-opencode").await;
        let new_generation = begin_session_generation(&state, "session-opencode").await;
        drop(lifecycle_guard);
        event_waiter.await.unwrap();
        assert!(!event_checked_rx.await.unwrap());

        assert_ne!(old_event_generation, new_generation);

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-opencode", "OpenCode", "opencode", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();

        let event = format!(
            r#"{{"type":"agent_session_mapping","app_session_id":"session-opencode","agent_kind":"opencode","agent_session_id":"late-session","runtime_generation":{old_event_generation}}}"#
        );
        if mapping_generation_is_current(
            &state.session_generations,
            "session-opencode",
            old_event_generation,
        )
        .await
        {
            persist_agent_session_mapping_event(&conn, &event).unwrap();
        }
        assert!(crate::db::operations::get_agent_session_mapping(
            &conn,
            "session-opencode",
            AgentKind::Opencode,
        )
        .unwrap()
        .is_none());
    }

    #[tokio::test]
    async fn unknown_session_mapping_returns_session_not_found_error() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        let app_state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            provider_profile_operation_lock: std::sync::Mutex::new(()),
            app_data_dir: std::path::PathBuf::new(),
        };
        let state = AgentState::default();
        let event = r#"{"type":"agent_session_mapping","app_session_id":"missing-session","agent_kind":"opencode","agent_session_id":"opencode-session","runtime_generation":1}"#;

        let error = handle_agent_session_mapping_event(
            &app_state,
            &state.session_startup_locks,
            &state.session_generations,
            event,
        )
        .await
        .unwrap_err();

        assert!(error.contains("Session not found"));
    }

    #[tokio::test]
    async fn known_session_with_stale_generation_is_dropped_by_real_handler() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-opencode", "OpenCode", "opencode", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let app_state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            provider_profile_operation_lock: std::sync::Mutex::new(()),
            app_data_dir: std::path::PathBuf::new(),
        };
        let state = AgentState::default();
        begin_session_generation(&state, "session-opencode").await;
        let current_generation = begin_session_generation(&state, "session-opencode").await;
        let stale_generation = current_generation - 1;
        let event = format!(
            r#"{{"type":"agent_session_mapping","app_session_id":"session-opencode","agent_kind":"opencode","agent_session_id":"stale-session","runtime_generation":{stale_generation}}}"#
        );

        let handled = handle_agent_session_mapping_event(
            &app_state,
            &state.session_startup_locks,
            &state.session_generations,
            &event,
        )
        .await
        .unwrap();

        assert!(handled);
        let db = app_state.db.lock().unwrap();
        assert!(crate::db::operations::get_agent_session_mapping(
            &db,
            "session-opencode",
            AgentKind::Opencode,
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn claude_history_includes_compact_boundary_events() {
        let compact = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary",
            "content": "Conversation compacted",
            "compactMetadata": {
                "trigger": "manual",
                "preTokens": 40956,
                "postTokens": 2876
            }
        });

        assert!(should_include_claude_history_event(&compact));
    }

    #[test]
    fn claude_history_excludes_non_visible_system_and_sidechain_events() {
        let status = serde_json::json!({
            "type": "system",
            "subtype": "status",
            "status": "compacting"
        });
        let sidechain_user = serde_json::json!({
            "type": "user",
            "isSidechain": true,
            "message": { "role": "user", "content": "subagent" }
        });

        assert!(!should_include_claude_history_event(&status));
        assert!(!should_include_claude_history_event(&sidechain_user));
    }

    #[test]
    fn claude_history_excludes_meta_user_events() {
        let meta_user = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": { "role": "user", "content": "Continue from where you left off." }
        });

        assert!(!should_include_claude_history_event(&meta_user));
    }

    #[test]
    fn convert_codex_reasoning_summary_to_assistant_thinking_block() {
        let value = serde_json::json!({
            "timestamp": "2026-06-19T12:38:49.366Z",
            "type": "response_item",
            "payload": {
                "type": "reasoning",
                "summary": [
                    {
                        "type": "summary_text",
                        "text": "**Crafting a concise response**\n\nI can answer directly."
                    }
                ]
            }
        });

        let converted =
            convert_codex_item_to_claude_format(&value).expect("reasoning should be visible");

        assert_eq!(
            converted,
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-06-19T12:38:49.366Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "thinking",
                            "thinking": "**Crafting a concise response**\n\nI can answer directly."
                        }
                    ]
                }
            })
        );
    }

    #[test]
    fn codex_history_prefers_event_msg_agent_message_over_response_item_message() {
        let raw_events = vec![
            serde_json::json!({
                "timestamp": "2026-07-03T17:31:58.239Z",
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "message": "使用 agent_message 展示",
                    "phase": "commentary"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T17:31:58.240Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "不应该展示 response_item" }],
                    "phase": "commentary"
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(
            converted[0],
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-07-03T17:31:58.239Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "使用 agent_message 展示" }]
                }
            })
        );
    }

    #[test]
    fn codex_history_converts_event_msg_user_message_with_locator_fields() {
        let raw_events = vec![serde_json::json!({
            "__lineIndex": 8,
            "timestamp": "2026-07-03T17:31:58.238Z",
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "id": "event-user-1",
                "message": "use skill"
            }
        })];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(
            converted[0],
            serde_json::json!({
                "type": "user",
                "uuid": "event-user-1",
                "__lineIndex": 8,
                "timestamp": "2026-07-03T17:31:58.238Z",
                "message": {
                    "role": "user",
                    "content": "use skill"
                }
            })
        );
    }

    #[test]
    fn codex_history_prefers_event_msg_user_message_over_response_item_user() {
        let raw_events = vec![
            serde_json::json!({
                "__lineIndex": 8,
                "timestamp": "2026-07-03T17:31:58.238Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "id": "event-user-1",
                    "message": "use skill"
                }
            }),
            serde_json::json!({
                "__lineIndex": 9,
                "timestamp": "2026-07-03T17:31:58.239Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "id": "response-user-1",
                    "content": [{ "type": "input_text", "text": "use skill" }]
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0]["uuid"], "event-user-1");
        assert_eq!(converted[0]["__lineIndex"], 8);
    }

    #[test]
    fn codex_history_keeps_response_item_user_when_it_contains_an_image() {
        let raw_events = vec![
            serde_json::json!({
                "__lineIndex": 8,
                "timestamp": "2026-07-08T15:59:12.248Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "id": "event-user-1",
                    "message": "Describe this image."
                }
            }),
            serde_json::json!({
                "__lineIndex": 9,
                "timestamp": "2026-07-08T15:59:12.249Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "id": "response-user-1",
                    "content": [
                        { "type": "input_text", "text": "<image name=[Image #1] path=\"C:\\Users\\94910\\AppData\\Local\\Temp\\image.png\">" },
                        { "type": "input_image", "image_url": "data:image/png;base64,abc123", "detail": "high" },
                        { "type": "input_text", "text": "</image>" },
                        { "type": "input_text", "text": "Describe this image." }
                    ]
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0]["uuid"], "response-user-1");
        assert_eq!(converted[0]["__lineIndex"], 9);
        assert_eq!(
            converted[0]["message"]["content"],
            serde_json::json!([
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "abc123"
                    }
                },
                { "type": "text", "text": "Describe this image." }
            ])
        );
    }

    #[test]
    fn codex_history_falls_back_to_response_item_message_without_agent_message() {
        let raw_events = vec![serde_json::json!({
            "timestamp": "2026-07-03T17:31:58.240Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "旧历史消息" }],
                "phase": "commentary"
            }
        })];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(
            converted[0],
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-07-03T17:31:58.240Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "旧历史消息" }]
                }
            })
        );
    }

    #[test]
    fn codex_history_converts_compacted_record_to_compact_boundary() {
        let raw_events = vec![serde_json::json!({
            "timestamp": "2026-07-03T18:00:00.000Z",
            "type": "compacted",
            "payload": {
                "trigger": "auto",
                "pre_tokens": 40956,
                "post_tokens": 2876
            }
        })];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 1);
        assert_eq!(
            converted[0],
            serde_json::json!({
                "type": "system",
                "subtype": "compact_boundary",
                "content": "Conversation compacted",
                "timestamp": "2026-07-03T18:00:00.000Z",
                "compact_metadata": {
                    "trigger": "auto",
                    "pre_tokens": 40956,
                    "post_tokens": 2876
                }
            })
        );
    }

    #[test]
    fn codex_history_does_not_attach_compaction_usage_to_previous_assistant() {
        let raw_events = vec![
            serde_json::json!({
                "timestamp": "2026-07-03T17:59:00.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "message": "压缩前的助手消息"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:00.000Z",
                "type": "compacted",
                "payload": {
                    "message": "Another language model started to solve this problem and produced a summary.",
                    "pre_tokens": 40956,
                    "post_tokens": 2876
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:01.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 237119,
                            "cached_input_tokens": 1209,
                            "output_tokens": 0,
                            "reasoning_output_tokens": 0
                        },
                        "model_context_window": 200000
                    }
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:02.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "task_complete",
                    "duration_ms": 1
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 2);
        assert_eq!(
            converted[0].get("type").and_then(|v| v.as_str()),
            Some("assistant")
        );
        assert_eq!(
            converted[1].get("subtype").and_then(|v| v.as_str()),
            Some("compact_boundary")
        );
        assert!(!converted
            .iter()
            .any(|event| event.get("type").and_then(|v| v.as_str()) == Some("result")));
    }

    #[test]
    fn codex_history_keeps_normal_assistant_usage_result() {
        let raw_events = vec![
            serde_json::json!({
                "timestamp": "2026-07-03T17:59:00.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "message": "普通助手消息"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:01.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 10,
                            "cached_input_tokens": 2,
                            "output_tokens": 4,
                            "reasoning_output_tokens": 0
                        }
                    }
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:02.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "task_complete",
                    "duration_ms": 123
                }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 2);
        assert_eq!(
            converted[0].get("type").and_then(|v| v.as_str()),
            Some("assistant")
        );
        assert_eq!(
            converted[1].get("type").and_then(|v| v.as_str()),
            Some("turn_finished")
        );
        assert_eq!(converted[1]["outcome"], "completed");
        assert_eq!(converted[1]["sequence"], 0);
    }

    #[test]
    fn codex_history_keeps_explicit_completion_without_usage() {
        let raw_events = vec![
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "agent_message", "message": "完成" }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "task_complete", "duration_ms": 12 }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");

        assert_eq!(converted.len(), 2);
        assert_eq!(converted[1]["type"], "turn_finished");
        assert_eq!(converted[1]["outcome"], "completed");
        assert_eq!(converted[1]["duration_ms"], 12);
        assert!(converted[1].get("usage").is_none());
    }

    #[test]
    fn codex_history_emits_deduplicated_codemux_tool_lifecycle_and_turn_outcome() {
        let raw_events = vec![
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:00.000Z",
                "type": "event_msg",
                "payload": { "type": "agent_message", "message": "先执行工具" }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:01.000Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "call_id": "call-read",
                    "name": "read_file",
                    "arguments": "{\"path\":\"README.md\"}"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:02.000Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "call_id": "call-read",
                    "name": "read_file",
                    "arguments": "{\"path\":\"README.md\"}"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:03.000Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-read",
                    "output": "内容"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:04.000Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-read",
                    "output": "内容"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:05.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 10,
                            "cached_input_tokens": 2,
                            "output_tokens": 4,
                            "reasoning_output_tokens": 1
                        }
                    }
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-03T18:00:06.000Z",
                "type": "event_msg",
                "payload": { "type": "task_complete", "duration_ms": 123 }
            }),
        ];

        let converted = convert_codex_history_values_to_events(&raw_events, "app-session-1");
        let codemux_events: Vec<&serde_json::Value> = converted
            .iter()
            .filter(|event| {
                matches!(
                    event.get("type").and_then(|value| value.as_str()),
                    Some("tool_started") | Some("tool_finished") | Some("turn_finished")
                )
            })
            .collect();

        assert_eq!(codemux_events.len(), 3);
        assert_eq!(codemux_events[0]["type"], "tool_started");
        assert_eq!(codemux_events[1]["type"], "tool_finished");
        assert_eq!(codemux_events[2]["type"], "turn_finished");
        assert_eq!(
            codemux_events
                .iter()
                .map(|event| event["sequence"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(codemux_events[2]["usage"]["reasoning_output_tokens"], 1);
    }

    #[test]
    fn convert_codex_custom_tool_call_to_tool_use() {
        let value = serde_json::json!({
            "timestamp": "2026-06-29T10:00:00.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "call_id": "call_apply_patch_1",
                "name": "apply_patch",
                "input": "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch"
            }
        });

        let converted = convert_codex_item_to_claude_format(&value)
            .expect("custom tool call should be visible");

        assert_eq!(
            converted,
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-06-29T10:00:00.000Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "call_apply_patch_1",
                            "name": "apply_patch",
                            "input": {
                                "input": "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch"
                            }
                        }
                    ]
                }
            })
        );
    }

    #[test]
    fn convert_codex_custom_tool_call_output_to_tool_result() {
        let value = serde_json::json!({
            "timestamp": "2026-06-29T10:00:01.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_apply_patch_1",
                "output": "Success. Updated the following files:\nM src/app.ts"
            }
        });

        let converted = convert_codex_item_to_claude_format(&value)
            .expect("custom tool output should be visible");

        assert_eq!(
            converted,
            serde_json::json!({
                "type": "user",
                "timestamp": "2026-06-29T10:00:01.000Z",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_apply_patch_1",
                            "content": "Success. Updated the following files:\nM src/app.ts"
                        }
                    ]
                }
            })
        );
    }

    #[test]
    fn reads_codex_interactive_events_from_codemux_jsonl() {
        use std::fs;

        let base = std::env::temp_dir().join(format!(
            "codemux-interactive-events-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&base).unwrap();
        fs::write(
            base.join("app-session-1.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-07-02T10:00:00.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call_question\",\"name\":\"AskUserQuestion\",\"arguments\":\"{\\\"questions\\\":[{\\\"question\\\":\\\"继续吗？\\\",\\\"options\\\":[{\\\"label\\\":\\\"继续\\\"}]}]}\"}}\n",
                "{\"timestamp\":\"2026-07-02T10:00:00.001Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_question\",\"output\":\"[\\\"继续\\\"]\"}}\n"
            ),
        )
        .unwrap();

        let values = read_codex_interactive_events_from_dir(&base, "app-session-1")
            .expect("interactive events should be readable");

        let mut raw_events = vec![serde_json::json!({
            "timestamp": "2026-07-02T09:59:59.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "先确认一个问题。" }]
            }
        })];
        raw_events.extend(values);
        sort_events_by_timestamp_stable(&mut raw_events);

        let converted: Vec<serde_json::Value> = raw_events
            .iter()
            .filter_map(convert_codex_item_to_claude_format)
            .collect();

        assert_eq!(converted.len(), 3);
        assert_eq!(
            converted[1],
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-07-02T10:00:00.000Z",
                "message": {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "call_question",
                        "name": "AskUserQuestion",
                        "input": {
                            "questions": [{
                                "question": "继续吗？",
                                "options": [{ "label": "继续" }]
                            }]
                        }
                    }]
                }
            })
        );
        assert_eq!(
            converted[2],
            serde_json::json!({
                "type": "user",
                "timestamp": "2026-07-02T10:00:00.001Z",
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "call_question",
                        "content": "[\"继续\"]"
                    }]
                }
            })
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn convert_codex_user_input_image_to_claude_image_block() {
        let value = serde_json::json!({
            "timestamp": "2026-06-28T13:04:49.643Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "<image name=[Image #1] path=\"C:\\Users\\94910\\AppData\\Local\\Temp\\screen.jpg\">"
                    },
                    {
                        "type": "input_image",
                        "image_url": "data:image/jpeg;base64,abc123",
                        "detail": "high"
                    },
                    {
                        "type": "input_text",
                        "text": "</image>"
                    },
                    {
                        "type": "input_text",
                        "text": "这是谁"
                    }
                ]
            }
        });

        let converted =
            convert_codex_item_to_claude_format(&value).expect("user image should be visible");

        assert_eq!(
            converted,
            serde_json::json!({
                "type": "user",
                "timestamp": "2026-06-28T13:04:49.643Z",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": "abc123"
                            }
                        },
                        {
                            "type": "text",
                            "text": "这是谁"
                        }
                    ]
                }
            })
        );
    }

    #[test]
    fn read_json_stream_values_accepts_pretty_and_concatenated_values() {
        use std::fs;

        let path = std::env::temp_dir().join(format!(
            "codemux-json-stream-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session-1\"}}\n",
                "{\n",
                "  \"type\": \"response_item\",\n",
                "  \"payload\": {\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,abc\"}]}\n",
                "}{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\"}}\n"
            ),
        )
        .unwrap();

        let values = read_json_stream_values(&path).expect("stream should parse");

        assert_eq!(values.len(), 3);
        assert_eq!(
            values[1].get("type").and_then(|value| value.as_str()),
            Some("response_item")
        );

        let _ = fs::remove_file(path);
    }
}

fn extract_codex_reasoning_summary(value: &serde_json::Value) -> Option<String> {
    let summary = value.get("summary")?.as_array()?;
    let parts: Vec<String> = summary
        .iter()
        .filter_map(|entry| {
            let entry_type = entry.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if entry_type != "summary_text" {
                return None;
            }
            entry
                .get("text")
                .and_then(|text| text.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .collect();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

const PROXY_SESSION_ID: &str = "__codex_proxy__";

#[tauri::command]
pub async fn start_codex_proxy(
    app: AppHandle,
    agent_state: State<'_, AgentState>,
    api_key: String,
    base_url: String,
    provider_name: String,
    codex_needs_proxy: Option<bool>,
) -> Result<u16, String> {
    info!(target: "agent", "Starting codex proxy upstream={} provider={}", base_url, provider_name);

    // Find an existing sidecar, or spawn a dedicated one for the proxy
    let session_id = {
        let sidecars = agent_state.sidecars.lock().await;
        find_any_active_sidecar(&sidecars)
    };

    let session_id = match session_id {
        Some(id) => id,
        None => {
            info!(target: "agent", "No active sidecar, spawning dedicated proxy sidecar");
            let (handle, mut rx) =
                spawn_sidecar(&app, tauri::ipc::Channel::new(|_| Ok(()))).await?;

            // Drain the event stream in the background
            let session_id_clone = PROXY_SESSION_ID.to_string();
            tokio::spawn(async move {
                while rx.recv().await.is_some() {}
                info!(target: "agent", "Proxy sidecar stream closed for {}", session_id_clone);
            });

            agent_state
                .sidecars
                .lock()
                .await
                .insert(PROXY_SESSION_ID.to_string(), handle);
            PROXY_SESSION_ID.to_string()
        }
    };

    // Get the stderr lines Arc before sending the command
    let stderr_lines = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(|h| h.stderr_lines.clone())
    };

    let mut cmd = serde_json::json!({
        "type": "start_proxy",
        "apiKey": api_key,
        "baseUrl": base_url,
        "providerName": provider_name,
    });
    if let Some(needs_proxy) = codex_needs_proxy {
        cmd["codexNeedsProxy"] = serde_json::Value::Bool(needs_proxy);
    }
    send_command_to_session(&agent_state, &session_id, cmd).await?;

    // Wait until stderr confirms either a fresh start or successful reuse.
    let timeout = std::time::Duration::from_secs(5);
    let poll_interval = std::time::Duration::from_millis(100);
    let deadline = tokio::time::Instant::now() + timeout;

    while tokio::time::Instant::now() < deadline {
        if let Some(lines) = &stderr_lines {
            let captured = lines.lock().await;
            if let Some(port) = parse_proxy_port_from_stderr(&captured) {
                drop(captured);
                *agent_state.proxy_port.lock().await = Some(port);
                info!(target: "agent", "Codex proxy started on port {}", port);
                return Ok(port);
            }
        }

        tokio::time::sleep(poll_interval).await;
    }

    warn!(
        target: "agent",
        "Codex proxy did not confirm startup within {}ms; leaving proxy_port unset",
        timeout.as_millis()
    );
    Err("Codex proxy did not confirm startup. Check sidecar logs for details.".to_string())
}

#[tauri::command]
pub async fn stop_codex_proxy(agent_state: State<'_, AgentState>) -> Result<(), String> {
    info!(target: "agent", "Stopping codex proxy");

    let session_id = {
        let sidecars = agent_state.sidecars.lock().await;
        // Prefer the dedicated proxy sidecar if it exists
        if sidecars.contains_key(PROXY_SESSION_ID) {
            Some(PROXY_SESSION_ID.to_string())
        } else {
            find_any_active_sidecar(&sidecars)
        }
    };
    let session_id = session_id.ok_or("No active sidecar to stop proxy")?;

    let cmd = serde_json::json!({ "type": "stop_proxy" });
    send_command_to_session(&agent_state, &session_id, cmd).await?;

    // Wait for the proxy to fully release the port
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Clean up the dedicated proxy sidecar
    if session_id == PROXY_SESSION_ID {
        let sidecar = {
            let mut sidecars = agent_state.sidecars.lock().await;
            sidecars.remove(PROXY_SESSION_ID)
        };
        if let Some(mut handle) = sidecar {
            handle.shutdown().await;
            info!(target: "agent", "Dedicated proxy sidecar shut down");
        }
    }

    *agent_state.proxy_port.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn get_codex_proxy_port(
    agent_state: State<'_, AgentState>,
) -> Result<Option<u16>, String> {
    Ok(*agent_state.proxy_port.lock().await)
}
