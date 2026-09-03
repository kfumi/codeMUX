//! Session runtime lifecycle: sidecar management, runtime configuration
//! resolution, session mapping persistence, and the core agent commands.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use crate::config::types::AgentKind;
use crate::db::operations;
use crate::model_providers::{
    effective_api_key, is_provider_usable, required_protocol, select_agent_endpoint,
    strip_context_1m_suffix, with_context_1m_suffix, Protocol, ProviderModel,
};
use crate::provider_profiles::types::AgentTimeouts;
use log::{debug, info, warn};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex};

use super::claude_history::find_claude_session_jsonl;
use super::codex_history::find_codex_session_jsonl;
use super::codex_proxy::parse_proxy_port_from_stderr;
use super::context_usage::{
    latest_claude_usage_from_values, latest_codex_usage_from_values, ThreadTokenUsageSnapshot,
};
use super::native_jsonl::read_json_stream_values;
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

pub(crate) fn is_imported_session(
    state: &crate::AppState,
    session_id: &str,
) -> Result<bool, String> {
    let db = state.db.lock().unwrap();
    db.query_row(
        "SELECT origin FROM sessions WHERE id = ?1 LIMIT 1",
        [session_id],
        |row| row.get::<_, String>(0),
    )
    .map(|origin| origin == "imported")
    .map_err(|error| error.to_string())
}

pub(crate) fn reject_read_only_session(
    state: &crate::AppState,
    session_id: &str,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let is_read_only: i32 = db
        .query_row(
            "SELECT is_read_only FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if is_read_only != 0 {
        return Err("会话为只读，原生会话无法恢复".to_string());
    }
    Ok(())
}

fn resolve_session_agent_kind(state: &crate::AppState, session_id: &str) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    crate::agent_runtime::factory::session_runtime_kind_name(&db, session_id)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedRuntimeConfig {
    /// Model Provider id (sessions.provider_id).
    pub(crate) profile_id: String,
    pub(crate) api_key: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) codex_needs_proxy: Option<bool>,
    pub(crate) provider: Option<String>,
    pub(crate) credential_source: Option<String>,
    pub(crate) timeouts: Option<AgentTimeouts>,
    /// Optional per-model limits forwarded to sidecar (Codex / OpenCode).
    pub(crate) model_limits: Option<serde_json::Value>,
}

fn agent_timeouts(
    config: &crate::config::types::AppConfig,
    agent_kind: AgentKind,
) -> Option<AgentTimeouts> {
    match agent_kind {
        AgentKind::ClaudeCode => config.agent_configs.claude_code.timeouts.clone(),
        AgentKind::Codex => config.agent_configs.codex.timeouts.clone(),
        AgentKind::Opencode => config.agent_configs.opencode.timeouts.clone(),
        AgentKind::Pi => config.agent_configs.pi.timeouts.clone(),
        AgentKind::GeminiCli => None,
    }
}

fn resolve_model_input_modalities(provider_model: &ProviderModel) -> Vec<String> {
    let mut modalities = vec!["text".to_string()];
    let mut has_image = false;

    if let Some(configured) = provider_model.input_modalities.as_ref() {
        for modality in configured {
            let normalized = modality.trim().to_ascii_lowercase();
            if normalized.is_empty() || normalized == "text" {
                continue;
            }
            if normalized == "image" {
                has_image = true;
            }
            if !modalities.iter().any(|entry| entry == &normalized) {
                modalities.push(normalized);
            }
        }
    } else if provider_model.supports_vision == Some(true) {
        has_image = true;
        modalities.push("image".to_string());
    }

    if has_image && !modalities.iter().any(|entry| entry == "image") {
        modalities.push("image".to_string());
    }
    modalities
}

fn resolve_active_runtime_config(
    state: &crate::AppState,
    session_id: &str,
) -> Result<ResolvedRuntimeConfig, String> {
    let agent_kind = resolve_session_agent_kind(state, session_id)?
        .parse::<AgentKind>()
        .map_err(|error| format!("无法解析会话智能体类型: {}", error))?;

    if required_protocol(agent_kind).is_none() {
        return Err(format!(
            "智能体 {} 暂不支持 Model Provider 运行时注入",
            agent_kind.as_str()
        ));
    }

    let config = state.config.lock().unwrap();
    let (persisted_provider_id, persisted_model): (Option<String>, Option<String>) = {
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
        .map_err(|error| format!("无法读取会话供应商快照: {}", error))?
    };
    let session_model = persisted_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty());

    let provider_id = persisted_provider_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .or(config.active_provider_id.as_deref())
        .ok_or_else(|| "尚未配置可用的模型供应商".to_string())?;

    let provider = config
        .model_providers
        .iter()
        .find(|item| item.id == provider_id)
        .ok_or_else(|| format!("会话绑定的供应商不存在，请重新选择供应商（id={provider_id}）"))?;

    if !is_provider_usable(provider, agent_kind) {
        let hint = match agent_kind {
            AgentKind::ClaudeCode => "缺少可用的 Anthropic 端点或 API Key / 默认模型",
            AgentKind::Opencode => "缺少可用的 OpenAI 兼容端点或 API Key / 默认模型",
            AgentKind::Codex => {
                "缺少可用的 OpenAI Responses 或 OpenAI 兼容端点 / API Key / 默认模型"
            }
            AgentKind::Pi => "缺少可用的 Anthropic 或 OpenAI 兼容端点 / API Key / 默认模型",
            AgentKind::GeminiCli => "暂不支持 Model Provider 运行时注入",
        };
        return Err(format!(
            "供应商「{}」对 {} 不可用：{}（或已禁用）",
            provider.name,
            agent_kind.as_str(),
            hint
        ));
    }

    let endpoint = select_agent_endpoint(provider, agent_kind).ok_or_else(|| {
        format!(
            "供应商「{}」缺少 {} 可用端点",
            provider.name,
            agent_kind.as_str()
        )
    })?;

    let api_key = effective_api_key(provider, endpoint);
    if api_key.is_empty() {
        return Err(format!("供应商「{}」未配置 API Key", provider.name));
    }

    let model = session_model
        .map(str::to_string)
        .or_else(|| {
            let default_model = provider.default_model.trim();
            (!default_model.is_empty()).then(|| default_model.to_string())
        })
        .ok_or_else(|| format!("供应商「{}」没有可用模型", provider.name))?;

    let model_base = strip_context_1m_suffix(&model);
    let provider_model = provider
        .models
        .iter()
        .find(|entry| strip_context_1m_suffix(entry.id.trim()) == model_base)
        .ok_or_else(|| format!("模型 `{model}` 不在供应商「{}」的模型列表中", provider.name))?;

    let model = match agent_kind {
        AgentKind::ClaudeCode => {
            if provider_model.context_1m.unwrap_or(false) {
                with_context_1m_suffix(&model_base)
            } else {
                model_base
            }
        }
        // Codex / OpenCode should never receive Claude's `[1m]` request marker.
        _ => model_base,
    };

    let model_limits = match agent_kind {
        AgentKind::Codex | AgentKind::Opencode => {
            let mut limits = serde_json::Map::new();
            if let Some(context_window) = provider_model.context_window.filter(|value| *value > 0) {
                limits.insert(
                    "contextWindow".to_string(),
                    serde_json::Value::Number(context_window.into()),
                );
            }
            if matches!(agent_kind, AgentKind::Codex | AgentKind::Opencode) {
                let modalities = resolve_model_input_modalities(provider_model);
                limits.insert(
                    "inputModalities".to_string(),
                    serde_json::Value::Array(
                        modalities
                            .into_iter()
                            .map(serde_json::Value::String)
                            .collect(),
                    ),
                );
            }
            if agent_kind == AgentKind::Opencode {
                if let Some(max_input) = provider_model.max_input_tokens.filter(|value| *value > 0)
                {
                    limits.insert(
                        "maxInputTokens".to_string(),
                        serde_json::Value::Number(max_input.into()),
                    );
                }
                if let Some(max_output) =
                    provider_model.max_output_tokens.filter(|value| *value > 0)
                {
                    limits.insert(
                        "maxOutputTokens".to_string(),
                        serde_json::Value::Number(max_output.into()),
                    );
                }
            }
            (!limits.is_empty()).then_some(serde_json::Value::Object(limits))
        }
        // pi models.json 的模型条目：contextWindow / maxTokens（输出上限）。
        AgentKind::Pi => {
            let mut limits = serde_json::Map::new();
            if let Some(context_window) = provider_model.context_window.filter(|value| *value > 0) {
                limits.insert(
                    "contextWindow".to_string(),
                    serde_json::Value::Number(context_window.into()),
                );
            }
            if let Some(max_output) = provider_model.max_output_tokens.filter(|value| *value > 0) {
                limits.insert(
                    "maxTokens".to_string(),
                    serde_json::Value::Number(max_output.into()),
                );
            }
            (!limits.is_empty()).then_some(serde_json::Value::Object(limits))
        }
        _ => None,
    };

    let (opencode_provider, credential_source) = match agent_kind {
        AgentKind::Opencode => (
            Some(
                provider
                    .opencode_provider_key
                    .clone()
                    .unwrap_or_else(|| "codemux-openai".to_string()),
            ),
            Some("codemux".to_string()),
        ),
        // pi 的供应商命名空间跟随所选端点协议：Anthropic 端点 → `anthropic`
        // （ANTHROPIC_* 环境变量），OpenAI 兼容端点 → `openai`（OPENAI_*）。
        AgentKind::Pi => {
            let provider_key = match endpoint.protocol {
                Protocol::Anthropic => "anthropic",
                _ => "openai",
            };
            (Some(provider_key.to_string()), Some("codemux".to_string()))
        }
        _ => (None, None),
    };

    // Native Responses endpoints are dialed directly by Codex; never route
    // them through the chat-completions compat proxy.
    let codex_needs_proxy = match endpoint.protocol {
        Protocol::OpenaiResponses => Some(false),
        _ => endpoint.codex_needs_proxy,
    };

    let resolved = ResolvedRuntimeConfig {
        profile_id: provider.id.clone(),
        api_key: Some(api_key),
        base_url: Some(endpoint.base_url.clone()),
        model: Some(model),
        codex_needs_proxy,
        provider: opencode_provider,
        credential_source,
        timeouts: agent_timeouts(&config, agent_kind),
        model_limits,
    };
    drop(config);

    if persisted_provider_id.is_none() {
        let db = state.db.lock().unwrap();
        operations::update_session_provider(
            &db,
            session_id,
            Some(&resolved.profile_id),
            resolved.model.as_deref().unwrap_or_default(),
            None,
        )
        .map_err(|error| format!("无法保存会话供应商快照: {}", error))?;
    }

    Ok(resolved)
}

pub(crate) type SessionLifecycleLock = Arc<Mutex<()>>;
pub(crate) type SessionLifecycleLocks = Arc<Mutex<HashMap<String, SessionLifecycleLock>>>;
pub(crate) type SessionGenerations = Arc<Mutex<HashMap<String, u64>>>;
pub(crate) type SessionDeleteWaiters =
    Arc<Mutex<HashMap<String, oneshot::Sender<Result<(), String>>>>>;
pub(crate) type SessionForkWaiters =
    Arc<Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>>;
pub(crate) type SessionRewindFilesWaiters =
    Arc<Mutex<HashMap<String, oneshot::Sender<Result<Vec<String>, String>>>>>;

pub struct AgentState {
    pub sidecars: Arc<Mutex<HashMap<String, SidecarHandle>>>,
    pub session_startup_locks: SessionLifecycleLocks,
    pub session_generations: SessionGenerations,
    pub session_delete_waiters: SessionDeleteWaiters,
    pub session_fork_waiters: SessionForkWaiters,
    pub session_rewind_files_waiters: SessionRewindFilesWaiters,
    /// Port of the running codex compat proxy, if any.
    pub proxy_port: Arc<Mutex<Option<u16>>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            sidecars: Arc::new(Mutex::new(HashMap::new())),
            session_startup_locks: Arc::new(Mutex::new(HashMap::new())),
            session_generations: Arc::new(Mutex::new(HashMap::new())),
            session_delete_waiters: Arc::new(Mutex::new(HashMap::new())),
            session_fork_waiters: Arc::new(Mutex::new(HashMap::new())),
            session_rewind_files_waiters: Arc::new(Mutex::new(HashMap::new())),
            proxy_port: Arc::new(Mutex::new(None)),
        }
    }
}

pub(crate) async fn session_lifecycle_lock(
    agent_state: &AgentState,
    session_id: &str,
) -> SessionLifecycleLock {
    let mut locks = agent_state.session_startup_locks.lock().await;
    locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

pub(crate) async fn begin_session_generation(agent_state: &AgentState, session_id: &str) -> u64 {
    let mut generations = agent_state.session_generations.lock().await;
    let generation = generations.entry(session_id.to_string()).or_insert(0);
    *generation = generation
        .checked_add(1)
        .expect("session runtime generation exhausted");
    *generation
}

async fn opencode_runtime_generation(agent_state: &AgentState, session_id: &str) -> u64 {
    if agent_state.sidecars.lock().await.contains_key(session_id) {
        let generations = agent_state.session_generations.lock().await;
        if let Some(&generation) = generations.get(session_id) {
            return generation;
        }
    }
    begin_session_generation(agent_state, session_id).await
}

pub(crate) async fn invalidate_session_generation(agent_state: &AgentState, session_id: &str) {
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
    agent_state: &AgentState,
    session_id: &str,
    channel: tauri::ipc::Channel<String>,
    replace_event_channel: bool,
) -> Result<(), String> {
    let channel_handle = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(session_id).map(SidecarHandle::channel_handle)
    };
    if let Some(channel_handle) = channel_handle {
        if replace_event_channel {
            let mut current_channel = channel_handle.lock().await;
            *current_channel = channel;
        }
        info!(target: "agent", "Reusing existing sidecar for session_id={}", session_id);
        return Ok(());
    }

    let (handle, mut rx) = spawn_sidecar(&app, channel).await?;
    let shared_channel = handle.channel.clone();
    let session_startup_locks = agent_state.session_startup_locks.clone();
    let session_generations = agent_state.session_generations.clone();
    let session_delete_waiters = agent_state.session_delete_waiters.clone();
    let session_fork_waiters = agent_state.session_fork_waiters.clone();
    let session_rewind_files_waiters = agent_state.session_rewind_files_waiters.clone();
    let session_id_clone = session_id.to_string();
    let app_handle = app.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let Some(result) = parse_session_delete_result_event(&event) {
                if let Some(waiter) = session_delete_waiters
                    .lock()
                    .await
                    .remove(&result.request_id)
                {
                    let _ = waiter.send(result.result);
                }
                continue;
            }
            if let Some(result) = parse_session_fork_result_event(&event) {
                if let Some(waiter) = session_fork_waiters.lock().await.remove(&result.request_id) {
                    let _ = waiter.send(result.result);
                }
                continue;
            }
            if let Some(result) = parse_session_rewind_files_result_event(&event) {
                if let Some(waiter) = session_rewind_files_waiters
                    .lock()
                    .await
                    .remove(&result.request_id)
                {
                    let _ = waiter.send(result.result);
                }
                continue;
            }
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
                    crate::agent::timeline_persist::handle_sidecar_timeline_event(
                        app_state.inner(),
                        &event,
                    );
                    crate::agent::subagent_persist::handle_sidecar_subagent_event(
                        app_state.inner(),
                        &event,
                    );
                    let app_for_companion = app_handle.clone();
                    let event_for_companion = event.clone();
                    crate::companion::handle_sidecar_event_for_companion(
                        &app_for_companion,
                        &event_for_companion,
                    );
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&event) {
                        let session_id = value
                            .get("session_id")
                            .and_then(|item| item.as_str())
                            .unwrap_or(session_id_clone.as_str());
                        let _ = app_handle.emit(
                            "agent-session-stream-event",
                            serde_json::json!({
                                "sessionId": session_id,
                                "payload": event,
                            }),
                        );
                    }
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

pub(crate) struct SessionDeleteResultEvent {
    pub request_id: String,
    pub result: Result<(), String>,
}

pub(crate) struct SessionForkResultEvent {
    pub request_id: String,
    pub result: Result<String, String>,
}

pub(crate) fn parse_session_delete_result_event(event: &str) -> Option<SessionDeleteResultEvent> {
    let value = serde_json::from_str::<serde_json::Value>(event).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("session_delete_result") {
        return None;
    }
    let request_id = value.get("request_id")?.as_str()?.to_string();
    let ok = value
        .get("ok")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false);
    let result = if ok {
        Ok(())
    } else {
        Err(value
            .get("error")
            .and_then(|entry| entry.as_str())
            .unwrap_or("OpenCode session deletion failed")
            .to_string())
    };
    Some(SessionDeleteResultEvent { request_id, result })
}

pub(crate) fn parse_session_fork_result_event(event: &str) -> Option<SessionForkResultEvent> {
    let value = serde_json::from_str::<serde_json::Value>(event).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("session_fork_result") {
        return None;
    }
    let request_id = value.get("request_id")?.as_str()?.to_string();
    let result = if value
        .get("ok")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false)
    {
        value
            .get("agent_session_id")
            .and_then(|entry| entry.as_str())
            .filter(|entry| !entry.is_empty())
            .map(ToOwned::to_owned)
            .ok_or_else(|| "Provider fork result did not include an agent session ID".to_string())
    } else {
        Err(value
            .get("error")
            .and_then(|entry| entry.as_str())
            .unwrap_or("Provider session fork failed")
            .to_string())
    };
    Some(SessionForkResultEvent { request_id, result })
}

pub(crate) struct SessionRewindFilesResultEvent {
    pub request_id: String,
    pub result: Result<Vec<String>, String>,
}

pub(crate) fn parse_session_rewind_files_result_event(
    event: &str,
) -> Option<SessionRewindFilesResultEvent> {
    let value = serde_json::from_str::<serde_json::Value>(event).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("session_rewind_files_result") {
        return None;
    }
    let request_id = value.get("request_id")?.as_str()?.to_string();
    let result = if value
        .get("ok")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false)
    {
        let files_changed = value
            .get("files_changed")
            .and_then(|entry| entry.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(files_changed)
    } else {
        Err(value
            .get("error")
            .and_then(|entry| entry.as_str())
            .unwrap_or("Provider file rewind failed")
            .to_string())
    };
    Some(SessionRewindFilesResultEvent { request_id, result })
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

fn resolve_session_cwd(
    state: &crate::AppState,
    session_id: &str,
    cwd: &str,
) -> Result<String, String> {
    let (working_path, origin, imported_cwd) = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT s.working_path, s.origin, ss.cwd FROM sessions s LEFT JOIN session_sources ss ON ss.app_session_id = s.id WHERE s.id = ?1 LIMIT 1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .map_err(|error| format!("无法读取会话工作目录: {}", error))?
    };

    if origin == "imported" {
        if let Some(imported_cwd) = imported_cwd.filter(|value| !value.trim().is_empty()) {
            return Ok(imported_cwd);
        }
    }

    if let Some(working_path) = working_path.filter(|value| !value.trim().is_empty()) {
        return Ok(working_path);
    }

    Ok(cwd.to_string())
}

fn resolve_skill_cwd(
    state: &crate::AppState,
    session_id: &str,
    cwd: &str,
) -> Result<String, String> {
    resolve_session_cwd(state, session_id, cwd)
}

async fn preload_project_skills(project_root: String, agent_kind: &str) -> Result<(), String> {
    let Ok(agent_kind) = AgentKind::from_str(agent_kind) else {
        return Ok(());
    };
    tokio::task::spawn_blocking(move || {
        let _ = crate::skills::project::resolve_project_skills(
            std::path::Path::new(&project_root),
            agent_kind,
        );
    })
    .await
    .map_err(|error| format!("Failed to preload project skills: {}", error))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_ensure_session_command(
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
    timeouts: Option<AgentTimeouts>,
    model_limits: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let cwd = resolve_session_cwd(state, session_id, &cwd)?;
    let mut cmd = serde_json::json!({
        "type": "ensure_session",
        "agentKind": agent_kind,
        "cwd": cwd.clone(),
        "sessionId": session_id,
    });

    // 会话必须使用 CodeMUX 托管 Runtime，禁止省略引用后由 sidecar 回退到内置 SDK。
    let runtime_provider = crate::runtime::Provider::from_str(agent_kind)
        .ok_or_else(|| format!("不支持的 Agent Runtime: {}", agent_kind))?;
    let runtime_ref = state
        .runtime_resolver
        .resolve_runtime_ref(runtime_provider)
        .ok_or_else(|| {
            format!(
                "{} Runtime 未安装或不可用，请先在设置中安装",
                runtime_provider.label()
            )
        })?;
    cmd["runtimeRef"] = serde_json::to_value(runtime_ref).map_err(|error| {
        format!(
            "无法序列化 {} Runtime 引用: {}",
            runtime_provider.label(),
            error
        )
    })?;

    let session_origin = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT origin FROM sessions WHERE id = ?1 LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("无法读取会话来源信息: {}", error))?
    };
    if session_origin == "imported" {
        cmd["resumeOnly"] = serde_json::Value::Bool(true);
    }

    if agent_kind == "opencode" || agent_kind == "pi" {
        if let Some(generation) = runtime_generation {
            cmd["runtimeGeneration"] = serde_json::json!(generation);
        }
        if let Some(provider) = provider {
            cmd["provider"] = serde_json::Value::String(provider);
        }
        if let Some(credential_source) = credential_source {
            cmd["credentialSource"] = serde_json::Value::String(credential_source);
        }
        if agent_kind == "pi" {
            // pi 的配置目录重定向到 CodeMUX 托管目录（PI_CODING_AGENT_DIR）：
            // models.json / auth.json / 会话文件都与用户 ~/.pi 硬隔离（ADR 0005），
            // CodeMUX 端点凭据由 sidecar 写入该目录的 models.json。
            let pi_config_dir = state
                .runtime_resolver
                .root()
                .parent()
                .ok_or_else(|| "无法解析 pi 托管配置目录".to_string())?
                .join("pi-agent");
            cmd["piConfigDir"] =
                serde_json::Value::String(pi_config_dir.to_string_lossy().into_owned());
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
    if let Some(timeouts) = timeouts {
        cmd["timeouts"] = serde_json::to_value(timeouts)
            .map_err(|error| format!("无法序列化 Agent 超时配置: {}", error))?;
    }
    if let Some(limits) = model_limits {
        cmd["modelLimits"] = limits;
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
        "pi" => "pi",
        _ => "claude",
    };
    let mut enabled_skills = {
        let db = state.db.lock().unwrap();
        crate::skills::db::get_enabled_skill_names_for_app(&db, app).map_err(|error| {
            format!(
                "Failed to load enabled skills for session_id={} agent_kind={}: {}",
                session_id, agent_kind, error
            )
        })?
    };
    if let Ok(parsed_agent_kind) = AgentKind::from_str(agent_kind) {
        if parsed_agent_kind == AgentKind::ClaudeCode {
            let project_root = cmd
                .get("cwd")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&cwd);
            let project_skills = crate::skills::project::cached_project_skills(
                std::path::Path::new(project_root),
                parsed_agent_kind,
            )
            .unwrap_or_default();
            let mut seen_names = HashSet::new();
            let mut merged_skills = Vec::with_capacity(project_skills.len() + enabled_skills.len());
            for skill in project_skills {
                let key = skill.name.trim().to_lowercase();
                if seen_names.insert(key) {
                    merged_skills.push(skill.name);
                }
            }
            for skill in enabled_skills {
                if seen_names.insert(skill.trim().to_lowercase()) {
                    merged_skills.push(skill);
                }
            }
            enabled_skills = merged_skills;
            cmd["settingSources"] = serde_json::json!(["user", "project"]);
        }
    }
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

pub(crate) async fn send_command_to_session(
    agent_state: &AgentState,
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
    agent_state: &AgentState,
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

pub async fn interrupt_agent_session_for_companion(
    state: &crate::AppState,
    agent_state: &AgentState,
    session_id: &str,
) -> Result<(), String> {
    reject_read_only_session(state, session_id)?;
    let ctx = crate::log_ctx::LogCtx::with_session(session_id);
    crate::log_ctx::with_ctx(ctx, || async {
        crate::log_ctx!(info, target: "agent", "Companion interrupt requested");
        let lifecycle_lock = session_lifecycle_lock(agent_state, session_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        invalidate_session_generation(agent_state, session_id).await;
        let sidecar = {
            let mut sidecars = agent_state.sidecars.lock().await;
            sidecars.remove(session_id)
        };
        if let Some(handle) = sidecar {
            let _ = handle
                .send_command(&OpenCodeRuntime::interrupt_command().to_string())
                .await;
            agent_state
                .sidecars
                .lock()
                .await
                .insert(session_id.to_string(), handle);
            crate::log_ctx!(info, target: "agent", "Companion interrupt command sent");
        } else {
            crate::log_ctx!(info, target: "agent", "Companion interrupt skipped; no active sidecar");
        }
        Ok(())
    })
    .await
}

pub async fn ensure_agent_session_for_companion(
    app: &AppHandle,
    state: &crate::AppState,
    agent_state: &AgentState,
    session_id: &str,
    cwd: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    reject_read_only_session(state, session_id)?;
    let lifecycle_lock = session_lifecycle_lock(agent_state, session_id).await;
    let _lifecycle_guard = lifecycle_lock.lock().await;
    let agent_kind = resolve_session_agent_kind(state, session_id)?;
    let runtime_config = resolve_active_runtime_config(state, session_id)?;
    let runtime_generation = if agent_kind == "opencode" {
        Some(opencode_runtime_generation(agent_state, session_id).await)
    } else {
        None
    };
    let skill_cwd = resolve_skill_cwd(state, session_id, &cwd)?;
    preload_project_skills(skill_cwd, &agent_kind).await?;
    let ensure_cmd = build_ensure_session_command(
        state,
        session_id,
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
        runtime_config.timeouts,
        runtime_config.model_limits,
    )?;
    let channel = tauri::ipc::Channel::new(|_| Ok(()));
    ensure_sidecar_for_session(app.clone(), agent_state, session_id, channel, false).await?;
    send_command_to_session(agent_state, session_id, ensure_cmd).await
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
        AgentKind::GeminiCli | AgentKind::Opencode | AgentKind::Pi => None,
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
        AgentKind::GeminiCli | AgentKind::Opencode | AgentKind::Pi => None,
    };
    let Some(history_path) = history_path else {
        return Ok(None);
    };

    let values = read_json_stream_values(&history_path)?;
    let snapshot = match agent_kind {
        AgentKind::ClaudeCode => latest_claude_usage_from_values(&values, freshness),
        AgentKind::Codex => latest_codex_usage_from_values(&values, freshness),
        AgentKind::GeminiCli | AgentKind::Opencode | AgentKind::Pi => None,
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
    if agent_session_id.is_none() {
        let db = state.db.lock().unwrap();
        let source = db
            .query_row(
                "SELECT agent_session_id, source_locator FROM session_sources WHERE app_session_id = ?1 AND agent_kind = ?2 LIMIT 1",
                rusqlite::params![app_session_id, agent_kind.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .ok();
        if let Some((agent_session_id, source_locator)) = source {
            return Ok(AgentSessionInfo {
                agent_session_id: Some(agent_session_id),
                message_path: Some(source_locator),
            });
        }
    }
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
    let freshness = freshness.unwrap_or_else(|| "restored".to_string());

    load_latest_token_usage_for_session(state.inner(), &app_session_id, agent_kind, &freshness)
        .await
}

pub(crate) async fn load_latest_token_usage_for_session(
    state: &crate::AppState,
    app_session_id: &str,
    agent_kind: AgentKind,
    freshness: &str,
) -> Result<Option<ThreadTokenUsageSnapshot>, String> {
    let Some(agent_session_id) = get_agent_session_id(state, app_session_id, agent_kind)? else {
        return Ok(None);
    };
    let home = home_dir()?;
    let freshness = freshness.to_string();

    tokio::task::spawn_blocking(move || {
        load_latest_token_usage_for_agent_session(&home, agent_kind, &agent_session_id, &freshness)
    })
    .await
    .map_err(|err| format!("Failed to join token usage loader: {}", err))?
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

    reject_read_only_session(&state, &session_id)?;

    let lifecycle_lock = session_lifecycle_lock(agent_state.inner(), &session_id).await;
    let _lifecycle_guard = lifecycle_lock.lock().await;
    let agent_kind = resolve_session_agent_kind(&state, &session_id)?;
    let resolved_cwd = resolve_session_cwd(state.inner(), &session_id, &cwd)?;
    let runtime_config = resolve_active_runtime_config(&state, &session_id)?;
    let runtime_generation = if agent_kind == "opencode" {
        Some(opencode_runtime_generation(agent_state.inner(), &session_id).await)
    } else {
        None
    };
    let skill_cwd = resolve_skill_cwd(state.inner(), &session_id, &resolved_cwd)?;
    preload_project_skills(skill_cwd, &agent_kind).await?;

    let cmd = build_ensure_session_command(
        &state,
        &session_id,
        &agent_kind,
        resolved_cwd,
        runtime_config.api_key,
        runtime_config.base_url,
        runtime_config.model,
        reasoning_effort,
        runtime_config.codex_needs_proxy,
        runtime_config.provider,
        runtime_config.credential_source,
        runtime_generation,
        runtime_config.timeouts,
        runtime_config.model_limits,
    )?;

    ensure_sidecar_for_session(app, &agent_state, &session_id, channel, true).await?;

    let stderr_lines = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.get(&session_id).map(|h| h.stderr_lines.clone())
    };

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
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    prompt: String,
    input_payload: Option<serde_json::Value>,
    display_content: Option<String>,
) -> Result<(), String> {
    reject_read_only_session(&state, &session_id)?;
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
    replace_event_channel: Option<bool>,
) -> Result<(), String> {
    let replace_event_channel = replace_event_channel.unwrap_or(true);
    reject_read_only_session(&state, &session_id)?;
    let ctx = crate::log_ctx::LogCtx::with_session(&session_id);
    crate::log_ctx::with_ctx(ctx, || async {
        crate::log_ctx!(info, target: "agent", "Starting agent session wrapper");

        let lifecycle_lock = session_lifecycle_lock(agent_state.inner(), &session_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let agent_kind = resolve_session_agent_kind(&state, &session_id)?;
        let runtime_config = resolve_active_runtime_config(&state, &session_id)?;
        let runtime_generation = if agent_kind == "opencode" {
            Some(opencode_runtime_generation(agent_state.inner(), &session_id).await)
        } else {
            None
        };
        let skill_cwd = resolve_skill_cwd(state.inner(), &session_id, &cwd)?;
        preload_project_skills(skill_cwd, &agent_kind).await?;

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
            runtime_config.timeouts,
            runtime_config.model_limits,
        )?;

        ensure_sidecar_for_session(
            app,
            &agent_state,
            &session_id,
            channel,
            replace_event_channel,
        )
        .await?;

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
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    interrupt_agent_session_for_companion(state.inner(), agent_state.inner(), &session_id).await
}

#[tauri::command]
pub async fn shutdown_agent(
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    reject_read_only_session(&state, &session_id)?;
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
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    tool_use_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    reject_read_only_session(&state, &session_id)?;
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
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    reject_read_only_session(&state, &session_id)?;
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
    reject_read_only_session(&state, &session_id)?;
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

        if agent_kind == "opencode" && !is_imported_session(&state, &session_id)? {
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

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::{
        begin_session_generation, build_ensure_session_command,
        build_update_permissions_command_from_snapshot, handle_agent_session_mapping_event,
        invalidate_session_generation, load_latest_token_usage_for_agent_session,
        mapping_generation_is_current, parse_agent_session_mapping_event,
        persist_agent_session_mapping_event, resolve_active_runtime_config,
        resolve_agent_session_info, session_lifecycle_lock, AgentState,
    };
    use crate::config::types::AgentKind;

    fn test_model_provider(
        id: &str,
        protocol: crate::model_providers::Protocol,
        base_url: &str,
        api_key: &str,
        default_model: &str,
        models: &[&str],
        codex_needs_proxy: Option<bool>,
    ) -> crate::model_providers::ModelProvider {
        crate::model_providers::ModelProvider {
            id: id.to_string(),
            name: id.to_string(),
            enabled: true,
            api_key: api_key.to_string(),
            api_key_configured: false,
            endpoints: vec![crate::model_providers::ProtocolEndpoint {
                protocol,
                base_url: base_url.to_string(),
                api_key_override: None,
                codex_needs_proxy,
            }],
            models: models
                .iter()
                .map(|model| crate::model_providers::ProviderModel {
                    id: (*model).to_string(),
                    name: None,
                    context_1m: None,
                    context_window: None,
                    max_input_tokens: None,
                    max_output_tokens: None,
                    input_modalities: None,
                    supports_vision: None,
                })
                .collect(),
            default_model: default_model.to_string(),
            builtin_template_id: None,
            opencode_provider_key: None,
            opencode_npm: None,
        }
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
    fn resolves_codex_runtime_config_from_the_active_provider() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-codex", "Codex", "codex", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let mut config = crate::config::types::AppConfig::default();
        config.model_providers.push(test_model_provider(
            "codex-provider",
            crate::model_providers::Protocol::OpenaiCompatible,
            "https://provider.example/v1",
            "internal-secret",
            "gpt-test",
            &["gpt-first", "gpt-test"],
            Some(true),
        ));
        config.active_provider_id = Some("codex-provider".to_string());
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(config),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let resolved = resolve_active_runtime_config(&state, "session-codex").unwrap();

        assert_eq!(resolved.profile_id, "codex-provider");
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
        assert_eq!(snapshot, "codex-provider");
    }

    #[test]
    fn codex_prefers_responses_endpoint_and_dials_direct() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-codex-responses", "Codex", "codex", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let mut config = crate::config::types::AppConfig::default();
        let mut provider = test_model_provider(
            "responses-provider",
            crate::model_providers::Protocol::OpenaiCompatible,
            "https://provider.example/v1",
            "internal-secret",
            "gpt-test",
            &["gpt-test"],
            Some(true),
        );
        provider
            .endpoints
            .push(crate::model_providers::ProtocolEndpoint {
                protocol: crate::model_providers::Protocol::OpenaiResponses,
                base_url: "https://provider.example/api/v1".to_string(),
                api_key_override: None,
                // Even a stray true flag must not route a native Responses
                // endpoint through the chat-completions compat proxy.
                codex_needs_proxy: Some(true),
            });
        config.model_providers.push(provider);
        config.active_provider_id = Some("responses-provider".to_string());
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(config),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let resolved = resolve_active_runtime_config(&state, "session-codex-responses").unwrap();

        assert_eq!(
            resolved.base_url.as_deref(),
            Some("https://provider.example/api/v1")
        );
        assert_eq!(resolved.codex_needs_proxy, Some(false));
    }

    #[test]
    fn opencode_still_resolves_chat_completions_endpoint() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-opencode-responses", "OpenCode", "opencode", "agent", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let mut config = crate::config::types::AppConfig::default();
        let mut provider = test_model_provider(
            "responses-provider",
            crate::model_providers::Protocol::OpenaiCompatible,
            "https://provider.example/v1",
            "internal-secret",
            "gpt-test",
            &["gpt-test"],
            Some(true),
        );
        provider
            .endpoints
            .push(crate::model_providers::ProtocolEndpoint {
                protocol: crate::model_providers::Protocol::OpenaiResponses,
                base_url: "https://provider.example/api/v1".to_string(),
                api_key_override: None,
                codex_needs_proxy: Some(false),
            });
        provider.opencode_provider_key = Some("codemux-openai".to_string());
        config.model_providers.push(provider);
        config.active_provider_id = Some("responses-provider".to_string());
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(config),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let resolved = resolve_active_runtime_config(&state, "session-opencode-responses").unwrap();

        assert_eq!(
            resolved.base_url.as_deref(),
            Some("https://provider.example/v1")
        );
        assert_eq!(resolved.codex_needs_proxy, Some(true));
        assert_eq!(resolved.provider.as_deref(), Some("codemux-openai"));
        assert_eq!(resolved.credential_source.as_deref(), Some("codemux"));
    }

    #[test]
    fn forwards_codex_input_modalities_in_model_limits() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, provider_id, model, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                "session-codex-vision",
                "Codex",
                "codex",
                "codex-provider",
                "gpt-5.6-luna",
                "agent",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();

        let mut provider = test_model_provider(
            "codex-provider",
            crate::model_providers::Protocol::OpenaiCompatible,
            "https://provider.example/v1",
            "internal-secret",
            "gpt-5.6-luna",
            &["gpt-5.6-luna"],
            Some(true),
        );
        provider.models[0].input_modalities = Some(vec!["text".to_string(), "image".to_string()]);

        let mut config = crate::config::types::AppConfig::default();
        config.model_providers.push(provider);
        config.active_provider_id = Some("codex-provider".to_string());
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(config),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let resolved = resolve_active_runtime_config(&state, "session-codex-vision").unwrap();
        let limits = resolved.model_limits.expect("model limits");
        assert_eq!(
            limits["inputModalities"],
            serde_json::json!(["text", "image"])
        );
    }

    #[test]
    fn forwards_opencode_input_modalities_in_model_limits() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, provider_id, model, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                "session-opencode-vision",
                "OpenCode",
                "opencode",
                "opencode-provider",
                "glm-4.7-flash",
                "agent",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();

        let mut provider = test_model_provider(
            "opencode-provider",
            crate::model_providers::Protocol::OpenaiCompatible,
            "https://provider.example/v1",
            "internal-secret",
            "glm-4.7-flash",
            &["glm-4.7-flash"],
            Some(true),
        );
        provider.models[0].input_modalities = Some(vec!["text".to_string(), "image".to_string()]);

        let mut config = crate::config::types::AppConfig::default();
        config.model_providers.push(provider);
        config.active_provider_id = Some("opencode-provider".to_string());
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(config),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let resolved = resolve_active_runtime_config(&state, "session-opencode-vision").unwrap();
        assert_eq!(resolved.provider.as_deref(), Some("codemux-openai"));
        let limits = resolved.model_limits.expect("model limits");
        assert_eq!(
            limits["inputModalities"],
            serde_json::json!(["text", "image"])
        );
    }

    #[test]
    fn codex_without_active_provider_returns_configuration_error() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, provider_id, model, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                "session-codex-default",
                "Codex",
                "codex",
                None::<String>,
                "gpt-5.6-sol",
                "agent",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let err = resolve_active_runtime_config(&state, "session-codex-default").unwrap_err();
        assert!(err.contains("尚未配置可用的模型供应商"), "{err}");
    }

    #[test]
    fn claude_code_without_active_provider_returns_configuration_error() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
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
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let err = resolve_active_runtime_config(&state, "session-claude-builtin").unwrap_err();
        assert!(err.contains("尚未配置可用的模型供应商"), "{err}");
    }

    #[test]
    fn respects_persisted_session_model_within_provider() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, provider_id, model, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                "session-codex-switched",
                "Codex",
                "codex",
                "codex-provider",
                "gpt-test",
                "agent",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();
        let mut config = crate::config::types::AppConfig::default();
        config.model_providers.push(test_model_provider(
            "codex-provider",
            crate::model_providers::Protocol::OpenaiCompatible,
            "https://provider.example/v1",
            "internal-secret",
            "gpt-first",
            &["gpt-first", "gpt-test"],
            Some(true),
        ));
        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(config),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let resolved = resolve_active_runtime_config(&state, "session-codex-switched").unwrap();

        assert_eq!(resolved.profile_id, "codex-provider");
        assert_eq!(resolved.model.as_deref(), Some("gpt-test"));
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
        let runtime_root = tempfile::tempdir().unwrap();
        for (provider, version) in [("opencode", "1.18.3"), ("claude_code", "0.3.170")] {
            let version_dir = runtime_root.path().join(provider).join(version);
            std::fs::create_dir_all(&version_dir).unwrap();
            std::fs::write(version_dir.join("package.json"), b"{}").unwrap();
            std::fs::write(runtime_root.path().join(provider).join("current"), version).unwrap();
        }
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-opencode", "OpenCode", "opencode", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let app_state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(
                runtime_root.path().to_path_buf(),
            ),
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
            None,
            None,
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
            None,
            None,
        )
        .unwrap();
        assert!(claude_command.get("provider").is_none());
        assert!(claude_command.get("credentialSource").is_none());
    }

    #[test]
    fn builds_pi_ensure_command_with_managed_config_dir() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        let version_dir = runtime_root.path().join("pi").join("0.73.1");
        std::fs::create_dir_all(&version_dir).unwrap();
        std::fs::write(version_dir.join("package.json"), b"{}").unwrap();
        std::fs::write(runtime_root.path().join("pi").join("current"), "0.73.1").unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-pi", "pi", "pi", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let app_state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(
                runtime_root.path().to_path_buf(),
            ),
        };

        let command = build_ensure_session_command(
            &app_state,
            "session-pi",
            "pi",
            "D:/workspace/demo".to_string(),
            Some("secret-key".to_string()),
            Some("https://provider.example/v1".to_string()),
            Some("anthropic/glm-5.3-flash".to_string()),
            None,
            None,
            Some("anthropic".to_string()),
            Some("codemux".to_string()),
            None,
            None,
            Some(serde_json::json!({ "contextWindow": 1_000_000, "maxTokens": 128_000 })),
        )
        .unwrap();

        assert_eq!(command["provider"], "anthropic");
        assert_eq!(command["credentialSource"], "codemux");
        // 配置目录指向 CodeMUX 数据根下的 pi-agent（与用户 ~/.pi 硬隔离）。
        let expected_dir = runtime_root.path().parent().unwrap().join("pi-agent");
        assert_eq!(
            command["piConfigDir"],
            serde_json::Value::String(expected_dir.to_string_lossy().into_owned())
        );
        assert_eq!(command["modelLimits"]["contextWindow"], 1_000_000);
        assert_eq!(command["modelLimits"]["maxTokens"], 128_000);
    }

    #[test]
    fn builds_ensure_command_with_timeouts() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        for (provider, version) in [("opencode", "1.18.3"), ("claude_code", "0.3.170")] {
            let version_dir = runtime_root.path().join(provider).join(version);
            std::fs::create_dir_all(&version_dir).unwrap();
            std::fs::write(version_dir.join("package.json"), b"{}").unwrap();
            std::fs::write(runtime_root.path().join(provider).join("current"), version).unwrap();
        }
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-timeouts", "Claude", "claude_code", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let app_state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(
                runtime_root.path().to_path_buf(),
            ),
        };

        let timeouts = crate::provider_profiles::types::AgentTimeouts {
            idle_timeout_ms: Some(300_000),
            approval_timeout_ms: Some(0),
            question_timeout_ms: Some(120_000),
        };
        let command = build_ensure_session_command(
            &app_state,
            "session-timeouts",
            "claude_code",
            "D:/workspace/demo".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(timeouts),
            None,
        )
        .unwrap();

        assert_eq!(command["timeouts"]["idle_timeout_ms"], 300_000);
        assert_eq!(command["timeouts"]["approval_timeout_ms"], 0);
        assert_eq!(command["timeouts"]["question_timeout_ms"], 120_000);

        let without = build_ensure_session_command(
            &app_state,
            "session-timeouts",
            "claude_code",
            "D:/workspace/demo".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(without.get("timeouts").is_none());
    }

    #[test]
    fn refuses_to_build_ensure_command_when_managed_runtime_is_missing() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-missing-runtime", "Claude", "claude_code", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        let app_state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
        };

        let error = build_ensure_session_command(
            &app_state,
            "session-missing-runtime",
            "claude_code",
            "D:/workspace/demo".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect_err("missing managed Runtime must block session startup");

        assert!(error.contains("Claude Code Runtime"));
        assert!(error.contains("安装"));
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
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
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
            app_data_dir: std::path::PathBuf::new(),
            runtime_resolver: crate::runtime::RuntimeResolver::new(std::path::PathBuf::new()),
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
}
