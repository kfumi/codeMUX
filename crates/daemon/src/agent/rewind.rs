//! Session rewind: locating the target user turn in native history and
//! rewinding through each provider's own native mechanism (opencode
//! `session.revert`, Claude SDK fork, Codex thread fork, pi tree fork).

use std::path::{Path, PathBuf};

use log::{info, warn};
use serde::{Deserialize, Serialize};

use crate::config::types::AgentKind;
use crate::db::operations;

use super::claude_history::{find_claude_session_jsonl, should_include_claude_history_event};
use super::codex_history::find_codex_session_jsonl;
use super::native_jsonl::split_jsonl_preserving_newlines;
use super::opencode_history;
use super::pi_history;
use super::session_lifecycle::{
    get_agent_session_id, home_dir, reject_read_only_session, AgentState,
};
use super::SidecarHandle;
use std::str::FromStr;
use tokio::sync::oneshot;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindSessionResult {
    pub files_changed: Option<usize>,
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

pub(crate) fn is_claude_visible_user_value(value: &serde_json::Value) -> bool {
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
pub(crate) fn is_claude_turn_boundary(value: &serde_json::Value) -> bool {
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
        // pi 会话树 rewind 走 sidecar 原生 fork（rewind_pi_conversation），
        // 不经过本函数所在的 JSONL 截断路径。
        AgentKind::Pi => false,
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

pub(crate) fn normalize_rewind_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn is_targetable_rewind_user_value(
    value: &serde_json::Value,
    agent_kind: AgentKind,
) -> bool {
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

pub(crate) fn resolve_rewind_provider_message_id(
    path: &Path,
    agent_kind: AgentKind,
    target: Option<&RewindTarget>,
) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let lines = split_jsonl_preserving_newlines(&content);
    let user_line_index = if let Some(target) = target {
        find_rewind_user_line_by_target(&lines, agent_kind, target).or_else(|| {
            // Live locators may carry a CodeMUX event_id that is not the Claude
            // JSONL uuid. Retry with turn ordinal + text fingerprint only.
            if target.turn_ordinal.is_none() && target.text_fingerprint.is_none() {
                return None;
            }
            let fingerprint_only = RewindTarget {
                provider_message_id: None,
                source_event_index: None,
                line_index: None,
                role: target.role.clone(),
                text_fingerprint: target.text_fingerprint.clone(),
                turn_ordinal: target.turn_ordinal,
            };
            find_rewind_user_line_by_target(&lines, agent_kind, &fingerprint_only)
        })
    } else {
        find_latest_targetable_rewind_user_line(&lines, agent_kind)
    }?;
    let value: serde_json::Value = serde_json::from_str(lines[user_line_index].trim()).ok()?;
    extract_provider_message_id(&value, agent_kind)
}

fn find_latest_targetable_rewind_user_line(
    lines: &[String],
    agent_kind: AgentKind,
) -> Option<usize> {
    let mut latest_index = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if is_targetable_rewind_user_value(&value, agent_kind) {
            latest_index = Some(index);
        }
    }
    latest_index
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RewindMode {
    Conversation,
    Files,
    Both,
}

impl RewindMode {
    fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "conversation" => Ok(Self::Conversation),
            "files" => Ok(Self::Files),
            "both" => Ok(Self::Both),
            other => Err(format!("Unknown rewind mode: {}", other)),
        }
    }

    fn includes_conversation(self) -> bool {
        matches!(self, Self::Conversation | Self::Both)
    }

    fn includes_files(self) -> bool {
        matches!(self, Self::Files | Self::Both)
    }
}

async fn rewind_agent_files_via_sidecar(
    agent_state: &AgentState,
    app_session_id: &str,
    provider_message_id: &str,
) -> Result<Vec<String>, String> {
    let sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars
            .get(app_session_id)
            .map(SidecarHandle::command_sender)
    };
    let Some(sender) = sender else {
        return Err("Agent runtime is not active; reopen the session and try again".to_string());
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (result_sender, result_receiver) = oneshot::channel();
    agent_state
        .session_rewind_files_waiters
        .lock()
        .await
        .insert(request_id.clone(), result_sender);
    let command = serde_json::json!({
        "type": "rewind_files",
        "sessionId": app_session_id,
        "requestId": request_id,
        "providerMessageId": provider_message_id,
    });
    if sender.send(command.to_string()).await.is_err() {
        agent_state
            .session_rewind_files_waiters
            .lock()
            .await
            .remove(&request_id);
        return Err("Failed to send the file rewind command to the sidecar".to_string());
    }

    match tokio::time::timeout(std::time::Duration::from_secs(60), result_receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Agent sidecar stopped before confirming the file rewind".to_string()),
        Err(_) => {
            agent_state
                .session_rewind_files_waiters
                .lock()
                .await
                .remove(&request_id);
            Err("Timed out waiting for the file rewind".to_string())
        }
    }
}

async fn rewind_pi_conversation_via_sidecar(
    agent_state: &AgentState,
    app_session_id: &str,
    entry_id: &str,
) -> Result<String, String> {
    rewind_conversation_via_sidecar(
        agent_state,
        app_session_id,
        serde_json::json!({ "entryId": entry_id }),
    )
    .await
}

/// 通用的 sidecar 原生会话回退：发 `rewind_conversation` 命令并等待
/// `session_rewind_conversation_result`。`extra` 携带按种类不同的定位参数
/// (pi=entryId / opencode+claude=providerMessageId / codex=
/// providerMessageTurnOrdinal)。返回（可能 fork 出的）原生会话 id。
async fn rewind_conversation_via_sidecar(
    agent_state: &AgentState,
    app_session_id: &str,
    extra: serde_json::Value,
) -> Result<String, String> {
    let sender = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars
            .get(app_session_id)
            .map(SidecarHandle::command_sender)
    };
    let Some(sender) = sender else {
        return Err("Agent runtime is not active; reopen the session and try again".to_string());
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (result_sender, result_receiver) = oneshot::channel();
    agent_state
        .session_rewind_conversation_waiters
        .lock()
        .await
        .insert(request_id.clone(), result_sender);
    let mut command = serde_json::json!({
        "type": "rewind_conversation",
        "sessionId": app_session_id,
        "requestId": request_id,
    });
    if let (Some(extra_object), Some(command_object)) = (extra.as_object(), command.as_object_mut())
    {
        for (key, value) in extra_object {
            command_object.insert(key.clone(), value.clone());
        }
    }
    if sender.send(command.to_string()).await.is_err() {
        agent_state
            .session_rewind_conversation_waiters
            .lock()
            .await
            .remove(&request_id);
        return Err("Failed to send the conversation rewind command to the sidecar".to_string());
    }

    match tokio::time::timeout(std::time::Duration::from_secs(60), result_receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            Err("Agent sidecar stopped before confirming the conversation rewind".to_string())
        }
        Err(_) => {
            agent_state
                .session_rewind_conversation_waiters
                .lock()
                .await
                .remove(&request_id);
            Err("Timed out waiting for the conversation rewind".to_string())
        }
    }
}

/// pi 会话树 rewind：pi 的原生历史是树形 JSONL 且进程持有 RPC 连接，不能像
/// Claude/Codex 那样直接截断文件。经 sidecar 调 pi 原生 `fork`——在原文件
/// 同目录新建 branched 会话文件（原文件与树历史不动）并在进程内 rebind——
/// 随后把 Native mapping 更新为新文件并重建时间线（branched 文件尚无消息
/// 条目时清空时间线）。mapping 保留（空 branched 文件仍是可恢复的原生会话），
/// 也不发 reset_session：pi 进程内已切换，无需重建。
async fn rewind_pi_conversation(
    state: std::sync::Arc<crate::AppState>,
    agent_state: std::sync::Arc<AgentState>,
    companion_state: std::sync::Arc<crate::companion::CompanionState>,
    app_session_id: &str,
    agent_kind: AgentKind,
    agent_session_id: &str,
    target: Option<&RewindTarget>,
) -> Result<RewindSessionResult, String> {
    let history_path = PathBuf::from(agent_session_id);
    if !history_path.is_file() {
        return Err(format!(
            "pi session file not found for session_id={} path={}",
            app_session_id,
            history_path.display()
        ));
    }
    let entry_id = {
        let path = history_path.clone();
        let provider_message_id = target.and_then(|entry| entry.provider_message_id.clone());
        let turn_ordinal = target.and_then(|entry| entry.turn_ordinal);
        let text_fingerprint = target.and_then(|entry| entry.text_fingerprint.clone());
        tokio::task::spawn_blocking(move || {
            pi_history::resolve_pi_rewind_entry_id(
                &path,
                provider_message_id.as_deref(),
                turn_ordinal,
                text_fingerprint.as_deref(),
            )
        })
        .await
        .map_err(|error| format!("Failed to join pi rewind resolver: {}", error))??
    };

    let new_agent_session_id =
        rewind_pi_conversation_via_sidecar(&agent_state, app_session_id, &entry_id).await?;

    {
        let db = state.db.lock().unwrap();
        operations::upsert_agent_session_mapping(
            &db,
            app_session_id,
            agent_kind,
            &new_agent_session_id,
        )
        .map_err(|err| format!("Failed to update rewound agent session mapping: {}", err))?;
    }
    super::history_import::reload_session_timeline_from_native(
        state.clone(),
        &companion_state,
        app_session_id,
        agent_kind,
    )
    .await
    .map_err(|err| format!("Failed to rebuild rewound session timeline: {}", err))?;

    info!(
        target: "agent",
        "Rewound pi session via native fork app_session_id={} entry_id={} new_session_file={}",
        app_session_id,
        entry_id,
        new_agent_session_id,
    );
    Ok(RewindSessionResult {
        files_changed: None,
    })
}

/// 空回退哨兵：回退目标在第一条用户消息之前，走清时间线/清 mapping/停
/// sidecar 的冷启动路径。
const REWIND_EMPTY_COMMAND: serde_json::Value = serde_json::Value::Null;

/// claude 回退边界：目标用户行之前最后一条带 `uuid` 的行。SDK
/// `forkSession(sessionId,{upToMessageId})` 的 upTo 为包含语义，要保留到
/// 目标用户消息之前，就得用它的前一条 uuid。返回 None 表示目标之前没有可
/// 保留的内容（空回退）。
fn resolve_claude_rewind_boundary(
    path: &Path,
    agent_kind: AgentKind,
    target: Option<&RewindTarget>,
) -> Result<Option<String>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|err| format!("Failed to read session history {}: {}", path.display(), err))?;
    let lines = split_jsonl_preserving_newlines(&content);
    let user_line_index = match target {
        Some(target) => match find_rewind_user_line_by_target(&lines, agent_kind, target) {
            Some(index) => index,
            None => {
                // 与旧截断路径同款兜底：历史里已无回退目标（重复回退/未 flush
                // 的中断）时按空回退处理，不阻塞下一次重试。
                if find_latest_rewind_user_line(&lines, agent_kind).is_none() {
                    return Ok(None);
                }
                return Err(format!(
                    "Target rewind user message not found in session history {}",
                    path.display()
                ));
            }
        },
        None => find_latest_rewind_user_line(&lines, agent_kind).ok_or_else(|| {
            format!(
                "No rewindable user message found in session history {}",
                path.display()
            )
        })?,
    };
    for line in lines[..user_line_index].iter().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if let Some(uuid) = value.get("uuid").and_then(|entry| entry.as_str()) {
            if !uuid.trim().is_empty() {
                return Ok(Some(uuid.trim().to_string()));
            }
        }
    }
    Ok(None)
}

/// codex 用户回合标记：rollout 里每次提交的用户 prompt 落一条
/// `response_item{type:"message",role:"user"}`；`event_msg/user_message` 是
/// 同一回合的重复投影，不参与计数（服务端 turns 与之一一对应）。
fn is_codex_user_turn_marker(value: &serde_json::Value) -> bool {
    if value.get("type").and_then(|entry| entry.as_str()) != Some("response_item") {
        return false;
    }
    let Some(payload) = value.get("payload") else {
        return false;
    };
    if payload.get("type").and_then(|entry| entry.as_str()) != Some("message")
        || payload.get("role").and_then(|entry| entry.as_str()) != Some("user")
    {
        return false;
    }
    let text = codex_response_item_text(value);
    let trimmed = text.trim_start();
    // 注入的环境上下文不是用户回合。
    !trimmed.starts_with("<environment_context>")
}

/// codex `response_item` 用户消息的正文（`payload.content` 块数组里的
/// input_text/text），环境上下文等注入内容的识别依赖它。
fn codex_response_item_text(value: &serde_json::Value) -> String {
    value
        .get("payload")
        .and_then(|payload| payload.get("content"))
        .and_then(serde_json::Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    let matches = block.get("type").and_then(|entry| entry.as_str())?;
                    if matches != "input_text" && matches != "text" {
                        return None;
                    }
                    block.get("text").and_then(|entry| entry.as_str())
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// codex 回退回合序号：目标用户行所属回合的用户回合序号（1-based）。codex
/// sidecar 用它在 `thread/turns/list` 里定位边界回合（保留到第 ordinal-1 个
/// 回合）。返回 None 表示空回退（目标是第一条用户回合）。
fn resolve_codex_rewind_turn_ordinal(
    path: &Path,
    target: Option<&RewindTarget>,
) -> Result<Option<usize>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|err| format!("Failed to read session history {}: {}", path.display(), err))?;
    let lines = split_jsonl_preserving_newlines(&content);
    let user_line_index = match target {
        Some(target) => match find_rewind_user_line_by_target(&lines, AgentKind::Codex, target) {
            Some(index) => index,
            None => {
                if find_latest_rewind_user_line(&lines, AgentKind::Codex).is_none() {
                    return Ok(None);
                }
                return Err(format!(
                    "Target rewind user message not found in session history {}",
                    path.display()
                ));
            }
        },
        None => find_latest_rewind_user_line(&lines, AgentKind::Codex).ok_or_else(|| {
            format!(
                "No rewindable user message found in session history {}",
                path.display()
            )
        })?,
    };
    // 目标行可能落在同一回合的后续条目（event_msg 投影/工具条目）上：向前找
    // 最近的用户回合标记，再数它之前（含自身）的回合标记数。
    let mut turn_start_index = None;
    for index in (0..=user_line_index).rev() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if is_codex_user_turn_marker(&value) {
            turn_start_index = Some(index);
            break;
        }
    }
    let Some(turn_start_index) = turn_start_index else {
        return Err(format!(
            "Codex rewind target turn not found in session history {}",
            path.display()
        ));
    };
    let ordinal = lines[..=turn_start_index]
        .iter()
        .filter(|line| {
            serde_json::from_str::<serde_json::Value>(line.trim())
                .map(|value| is_codex_user_turn_marker(&value))
                .unwrap_or(false)
        })
        .count();
    if ordinal == 0 {
        return Err(format!(
            "Codex rewind target turn not found in session history {}",
            path.display()
        ));
    }
    if ordinal == 1 {
        return Ok(None);
    }
    Ok(Some(ordinal))
}

#[allow(clippy::too_many_arguments)]
pub async fn rewind_agent_session_impl(
    state: std::sync::Arc<crate::AppState>,
    agent_state: std::sync::Arc<AgentState>,
    companion_state: std::sync::Arc<crate::companion::CompanionState>,
    app_session_id: String,
    agent_kind: String,
    target: Option<RewindTarget>,
    mode: Option<String>,
) -> Result<RewindSessionResult, String> {
    reject_read_only_session(&state, &app_session_id)?;
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    let mode = match mode.as_deref() {
        Some(value) if !value.trim().is_empty() => RewindMode::from_str(value.trim())?,
        _ => RewindMode::Conversation,
    };
    let mut files_changed: Option<usize> = None;
    let Some(agent_session_id) = get_agent_session_id(&state, &app_session_id, agent_kind)? else {
        return Err(format!(
            "No agent session mapping found for session_id={}",
            app_session_id
        ));
    };

    if mode.includes_files() {
        if agent_kind != AgentKind::ClaudeCode {
            return Err("This agent does not support rewinding files".to_string());
        }
        let resolved_from_jsonl = home_dir().ok().and_then(|home| {
            find_claude_session_jsonl(&home.join(".claude"), &agent_session_id).and_then(|path| {
                resolve_rewind_provider_message_id(&path, agent_kind, target.as_ref())
            })
        });
        let provider_message_id = resolved_from_jsonl.or_else(|| {
            target
                .as_ref()
                .and_then(|value| value.provider_message_id.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        match provider_message_id {
            Some(provider_message_id) => {
                match rewind_agent_files_via_sidecar(
                    &agent_state,
                    &app_session_id,
                    &provider_message_id,
                )
                .await
                {
                    Ok(changed_files) => {
                        if changed_files.is_empty() {
                            if mode == RewindMode::Files {
                                return Err("该消息没有可回退的文件变更".to_string());
                            }
                            warn!(
                                target: "agent",
                                "File rewind found no changed files during both-mode rewind for app_session_id={}",
                                app_session_id
                            );
                        }
                        files_changed = Some(changed_files.len());
                    }
                    Err(error) if mode == RewindMode::Both => {
                        warn!(
                            target: "agent",
                            "File rewind failed during both-mode rewind for app_session_id={}; continuing with conversation rewind: {}",
                            app_session_id,
                            error
                        );
                    }
                    Err(error) => return Err(error),
                }
            }
            None if mode == RewindMode::Files => {
                return Err(
                    "File rewind requires the provider message ID of the target".to_string()
                );
            }
            None => {}
        }
    }

    if !mode.includes_conversation() {
        return Ok(RewindSessionResult { files_changed });
    }

    // pi 会话树 rewind 走 sidecar 原生 fork，不做 JSONL 截断（此处 mode 必为
    // Conversation：files/both 已在上方对非 Claude 拒绝）。
    if agent_kind == AgentKind::Pi {
        return rewind_pi_conversation(
            state,
            agent_state,
            companion_state,
            &app_session_id,
            agent_kind,
            &agent_session_id,
            target.as_ref(),
        )
        .await;
    }

    // Claude/Codex/OpenCode 统一走 sidecar 原生 rewind:opencode 调原生
    // `session.revert`(server 打 revert 标记,会话 id 不变),claude 用 SDK
    // 非破坏 `forkSession(sessionId,{upToMessageId})`,codex 用 `thread/fork`
    // 到边界回合。三者都原地 rebind、不破坏原生存储、不清 sidecar 绑定 ——
    // 此前「截断原生 JSONL/直接 DELETE 运行中的 opencode SQLite + 发
    // reset_session」会让 rewind 后的 warm resend 必然失败(2026-09-20 事故),
    // 且与运行中 provider 的内存态存在竞态。原生会话数据原样留在盘上,可随时
    // 用原生工具恢复。
    let home = home_dir()?;
    let rewind_command: serde_json::Value = match agent_kind {
        AgentKind::Opencode => {
            let boundary_id = opencode_history::resolve_opencode_rewind_boundary_id(
                &home,
                &agent_session_id,
                target.as_ref(),
            )?;
            match boundary_id {
                Some(boundary) => serde_json::json!({ "providerMessageId": boundary }),
                None => REWIND_EMPTY_COMMAND,
            }
        }
        AgentKind::ClaudeCode => {
            let history_path = find_claude_session_jsonl(&home.join(".claude"), &agent_session_id)
                .ok_or_else(|| {
                    format!(
                        "Session history file not found for session_id={} agent_session_id={}",
                        app_session_id, agent_session_id
                    )
                })?;
            match resolve_claude_rewind_boundary(&history_path, agent_kind, target.as_ref())? {
                Some(boundary) => serde_json::json!({ "providerMessageId": boundary }),
                None => REWIND_EMPTY_COMMAND,
            }
        }
        AgentKind::Codex => {
            let history_path =
                find_codex_session_jsonl(&home.join(".codex").join("sessions"), &agent_session_id)
                    .ok_or_else(|| {
                        format!(
                            "Session history file not found for session_id={} agent_session_id={}",
                            app_session_id, agent_session_id
                        )
                    })?;
            match resolve_codex_rewind_turn_ordinal(&history_path, target.as_ref())? {
                Some(ordinal) => serde_json::json!({ "providerMessageTurnOrdinal": ordinal }),
                None => REWIND_EMPTY_COMMAND,
            }
        }
        AgentKind::GeminiCli | AgentKind::Pi => {
            return Err(format!(
                "{} does not support conversation rewind",
                agent_kind.as_str()
            ));
        }
    };

    if rewind_command == REWIND_EMPTY_COMMAND {
        // 回退目标在第一条用户消息之前:清时间线 + 清 mapping + 停 sidecar,
        // 下次发送冷启动全新原生会话。原生存储不动(可恢复);旧 mapping 指向
        // 的原生会话保留完整历史,属于「回退到空」的有意取舍。
        {
            let db = state.db.lock().unwrap();
            operations::clear_session_timeline(&db, &app_session_id)
                .map_err(|err| format!("Failed to clear rewound session timeline: {}", err))?;
            operations::delete_agent_session_mapping(&db, &app_session_id, agent_kind)
                .map_err(|err| format!("Failed to clear rewound agent session mapping: {}", err))?;
        }
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
        info!(
            target: "agent",
            "Rewound agent session to empty app_session_id={} agent_kind={}",
            app_session_id,
            agent_kind.as_str()
        );
        return Ok(RewindSessionResult { files_changed });
    }

    let new_agent_session_id =
        rewind_conversation_via_sidecar(&agent_state, &app_session_id, rewind_command).await?;
    {
        let db = state.db.lock().unwrap();
        operations::upsert_agent_session_mapping(
            &db,
            &app_session_id,
            agent_kind,
            &new_agent_session_id,
        )
        .map_err(|err| format!("Failed to update rewound agent session mapping: {}", err))?;
    }
    super::history_import::reload_session_timeline_from_native(
        state.clone(),
        &companion_state,
        &app_session_id,
        agent_kind,
    )
    .await
    .map_err(|err| format!("Failed to rebuild rewound session timeline: {}", err))?;

    info!(
        target: "agent",
        "Rewound agent session app_session_id={} agent_kind={} new_agent_session_id={}",
        app_session_id,
        agent_kind.as_str(),
        new_agent_session_id,
    );

    Ok(RewindSessionResult { files_changed })
}

pub async fn rewind_agent_session_for_companion(
    daemon: &crate::daemon::DaemonState,
    app_session_id: String,
    agent_kind: String,
    target: Option<RewindTarget>,
    mode: Option<String>,
) -> Result<RewindSessionResult, String> {
    // 回合进行中的原生会话正处于 runner 活跃/中断收敛窗口,此刻回退会踩进
    // provider 的内存态(2026-09-20 事故的中断时序之一)。先显式要求停止。
    if daemon.companion.is_turn_active(&app_session_id) {
        return Err("会话正在运行，请先停止当前回合再回退".to_string());
    }
    rewind_agent_session_impl(
        daemon.app.clone(),
        daemon.agent.clone(),
        daemon.companion.clone(),
        app_session_id,
        agent_kind,
        target,
        mode,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_claude_rewind_boundary, resolve_codex_rewind_turn_ordinal,
        resolve_rewind_provider_message_id, RewindTarget,
    };
    use crate::config::types::AgentKind;

    fn claude_fixture(content: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-rewind-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, content).unwrap();
        path
    }

    fn codex_fixture(content: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "codemux-codex-rewind-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn resolves_claude_uuid_from_fingerprint_without_provider_id() {
        let path = std::env::temp_dir().join(format!(
            "codemux-claude-resolve-uuid-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}]}}\n"
            ),
        )
        .unwrap();

        let resolved = resolve_rewind_provider_message_id(
            &path,
            AgentKind::ClaudeCode,
            Some(&RewindTarget {
                provider_message_id: None,
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("first".to_string()),
                turn_ordinal: Some(1),
            }),
        );
        assert_eq!(resolved.as_deref(), Some("u1"));

        let latest = resolve_rewind_provider_message_id(&path, AgentKind::ClaudeCode, None);
        assert_eq!(latest.as_deref(), Some("u2"));

        let stale_locator = resolve_rewind_provider_message_id(
            &path,
            AgentKind::ClaudeCode,
            Some(&RewindTarget {
                provider_message_id: Some("codemux-event-id".to_string()),
                source_event_index: None,
                line_index: None,
                role: Some("user".to_string()),
                text_fingerprint: Some("second".to_string()),
                turn_ordinal: Some(2),
            }),
        );
        assert_eq!(stale_locator.as_deref(), Some("u2"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolves_claude_rewind_boundary_to_previous_uuid() {
        // fork upToMessageId 为包含语义:回退目标 u2 时边界应是它之前最后一条
        // 带 uuid 的行(此处是 assistant a1 —— claude 只给 assistant 记 uuid)。
        let path = claude_fixture(concat!(
            "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
            "{\"type\":\"assistant\",\"uuid\":\"a1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n",
            "{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
            "{\"type\":\"assistant\",\"uuid\":\"a2\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}]}}\n"
        ));

        let boundary = resolve_claude_rewind_boundary(
            &path,
            AgentKind::ClaudeCode,
            Some(&RewindTarget {
                provider_message_id: Some("u2".to_string()),
                source_event_index: None,
                line_index: None,
                role: None,
                text_fingerprint: None,
                turn_ordinal: None,
            }),
        )
        .unwrap();
        assert_eq!(boundary.as_deref(), Some("a1"));

        // 回退最新一回合(u2)时,边界同样保留到它之前的 a1。
        let latest = resolve_claude_rewind_boundary(&path, AgentKind::ClaudeCode, None).unwrap();
        assert_eq!(latest.as_deref(), Some("a1"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolves_claude_rewind_boundary_to_empty_at_first_turn() {
        let path = claude_fixture(concat!(
            "{\"type\":\"summary\",\"summary\":\"seeded context\"}\n",
            "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
            "{\"type\":\"assistant\",\"uuid\":\"a1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}\n"
        ));

        let boundary = resolve_claude_rewind_boundary(
            &path,
            AgentKind::ClaudeCode,
            Some(&RewindTarget {
                provider_message_id: Some("u1".to_string()),
                source_event_index: None,
                line_index: None,
                role: None,
                text_fingerprint: None,
                turn_ordinal: None,
            }),
        )
        .unwrap();
        assert_eq!(boundary, None);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolves_codex_rewind_turn_ordinal_counts_response_items_only() {
        // event_msg/user_message 是同回合的重复投影,不计数;environment_context
        // 不是用户回合。目标 second(第 2 回合)→ ordinal 2。
        let path = codex_fixture(concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>ctx</environment_context>\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}],\"id\":\"m1\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"id\":\"u1\",\"message\":\"first\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"second\"}],\"id\":\"m2\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"id\":\"u2\",\"message\":\"second\"}}\n"
        ));

        let ordinal = resolve_codex_rewind_turn_ordinal(
            &path,
            Some(&RewindTarget {
                provider_message_id: Some("m2".to_string()),
                source_event_index: None,
                line_index: None,
                role: None,
                text_fingerprint: None,
                turn_ordinal: None,
            }),
        )
        .unwrap();
        assert_eq!(ordinal, Some(2));

        let latest = resolve_codex_rewind_turn_ordinal(&path, None).unwrap();
        assert_eq!(latest, Some(2));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolves_codex_rewind_turn_ordinal_to_empty_at_first_turn() {
        let path = codex_fixture(concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}],\"id\":\"m1\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first answer\"}]}}\n"
        ));

        let ordinal = resolve_codex_rewind_turn_ordinal(
            &path,
            Some(&RewindTarget {
                provider_message_id: Some("m1".to_string()),
                source_event_index: None,
                line_index: None,
                role: None,
                text_fingerprint: None,
                turn_ordinal: None,
            }),
        )
        .unwrap();
        assert_eq!(ordinal, None);

        let _ = std::fs::remove_file(&path);
    }
}
