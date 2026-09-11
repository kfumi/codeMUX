use crate::agent::commands::{
    delete_opencode_native_session, home_dir, send_permission_update_to_session, AgentState,
};
use crate::agent::native_cleanup::{
    cleanup_claude_native_session, cleanup_codex_app_interactive_events,
    cleanup_codex_native_session,
};
use crate::config::types::AgentKind;
use crate::db::operations::{self, NativeSessionRef};
use crate::AppState;
use log::{info, warn};
use std::str::FromStr;
use std::sync::Arc;

use tauri::State;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_session(
    state: State<'_, Arc<AppState>>,
    title: String,
    agent_kind: Option<String>,
    mode: Option<String>,
    project_id: Option<String>,
    permission_config: Option<String>,
    plan_mode: Option<String>,
    model: Option<String>,
) -> Result<operations::Session, String> {
    let agent_kind = AgentKind::from_str(agent_kind.as_deref().unwrap_or("claude_code"))?;
    info!(
        target: "session",
        "Creating session title={} agent_kind={} mode={} project_id={}",
        title,
        agent_kind.as_str(),
        mode.as_deref().unwrap_or("chat"),
        project_id.as_deref().unwrap_or("none")
    );
    let db = state.db.lock().unwrap();
    let mode_str = mode.as_deref().unwrap_or("chat");
    match project_id.as_deref() {
        Some(pid) => operations::create_session_for_project_with_permissions(
            &db,
            &title,
            agent_kind,
            mode_str,
            pid,
            permission_config.as_deref(),
            plan_mode.as_deref(),
            model.as_deref(),
        )
        .map_err(|e| e.to_string()),
        None => operations::create_session_with_mode_and_permissions(
            &db,
            &title,
            agent_kind,
            mode_str,
            permission_config.as_deref(),
            plan_mode.as_deref(),
            model.as_deref(),
        )
        .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn get_all_sessions(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<operations::Session>, String> {
    let db = state.db.lock().unwrap();
    operations::get_all_sessions(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_archived_sessions(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<operations::Session>, String> {
    let db = state.db.lock().unwrap();
    operations::get_all_archived_sessions(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_session(
    daemon: tauri::State<'_, Arc<crate::daemon::DaemonState>>,
    session_id: String,
) -> Result<(), String> {
    delete_session_impl(daemon.inner(), session_id).await
}

pub async fn delete_session_impl(
    daemon: &crate::daemon::DaemonState,
    session_id: String,
) -> Result<(), String> {
    let state = &daemon.app;
    let agent_state = &daemon.agent;
    info!(target: "session", "Deleting session session_id={}", session_id);
    let (skip_native_cleanup, native_sessions) = {
        let db = state.db.lock().unwrap();
        let session =
            operations::get_session(&db, &session_id).map_err(|error| error.to_string())?;
        let skip = session
            .as_ref()
            .is_some_and(|session| session.origin == "imported" || session.is_read_only);
        let natives = if skip {
            Vec::new()
        } else {
            operations::list_native_sessions_for_cleanup(&db, &session_id)
                .map_err(|error| error.to_string())?
        };
        (skip, natives)
    };

    if !skip_native_cleanup {
        cleanup_native_sessions_best_effort(
            &daemon.roots,
            state,
            agent_state,
            &session_id,
            &native_sessions,
            true,
        )
        .await;
    }

    let db = state.db.lock().unwrap();
    operations::delete_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn archive_session(state: State<'_, Arc<AppState>>, session_id: String) -> Result<(), String> {
    info!(target: "session", "Archiving session session_id={}", session_id);
    let db = state.db.lock().unwrap();
    operations::archive_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unarchive_session(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<(), String> {
    info!(target: "session", "Unarchiving session session_id={}", session_id);
    let db = state.db.lock().unwrap();
    operations::unarchive_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_session_pinned(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    info!(target: "session", "Setting session pinned session_id={} pinned={}", session_id, pinned);
    let db = state.db.lock().unwrap();
    operations::set_session_pinned(&db, &session_id, pinned).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_session_read_only(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    read_only: bool,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let session = operations::get_session(&db, &session_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Session not found: {}", session_id))?;
    if session.origin != "imported" {
        return Err("Only imported sessions can change read-only state".to_string());
    }
    operations::set_session_read_only(&db, &session_id, read_only).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_title(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    operations::update_session_title(&db, &session_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_working_path(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    working_path: String,
) -> Result<operations::Session, String> {
    update_session_working_path_impl(state.inner(), session_id, working_path)
}

pub fn update_session_working_path_impl(
    state: &AppState,
    session_id: String,
    working_path: String,
) -> Result<operations::Session, String> {
    let db = state.db.lock().unwrap();
    operations::update_session_working_path(&db, &session_id, &working_path)
        .map_err(|error| error.to_string())?;
    operations::get_session(&db, &session_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "会话不存在".to_string())
}

#[tauri::command]
pub fn touch_session(state: State<'_, Arc<AppState>>, session_id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    operations::touch_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_provider(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    provider_id: Option<String>,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    update_session_provider_impl(
        state.inner(),
        session_id,
        provider_id,
        model,
        reasoning_effort,
    )
}

pub fn update_session_provider_impl(
    state: &AppState,
    session_id: String,
    provider_id: Option<String>,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    info!(
        target: "session",
        "Updating session provider session_id={} provider_id={:?} model={} reasoning_effort={}",
        session_id,
        provider_id,
        model,
        reasoning_effort.as_deref().unwrap_or("unchanged")
    );
    let db = state.db.lock().unwrap();
    operations::update_session_provider(
        &db,
        &session_id,
        provider_id.as_deref(),
        &model,
        reasoning_effort.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_reasoning_effort(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    reasoning_effort: String,
) -> Result<(), String> {
    update_session_reasoning_effort_impl(state.inner(), session_id, reasoning_effort)
}

pub fn update_session_reasoning_effort_impl(
    state: &AppState,
    session_id: String,
    reasoning_effort: String,
) -> Result<(), String> {
    info!(
        target: "session",
        "Updating session reasoning effort session_id={} reasoning_effort={}",
        session_id,
        reasoning_effort
    );
    let db = state.db.lock().unwrap();
    operations::update_session_reasoning_effort(&db, &session_id, &reasoning_effort)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_session_permissions(
    state: State<'_, Arc<AppState>>,
    agent_state: State<'_, Arc<AgentState>>,
    session_id: String,
    permission_config: Option<String>,
    plan_mode: Option<String>,
) -> Result<(), String> {
    update_session_permissions_impl(
        state.inner(),
        agent_state.inner(),
        session_id,
        permission_config,
        plan_mode,
    )
    .await
}

pub async fn update_session_permissions_impl(
    state: &AppState,
    agent_state: &AgentState,
    session_id: String,
    permission_config: Option<String>,
    plan_mode: Option<String>,
) -> Result<(), String> {
    info!(
        target: "session",
        "Updating session permissions session_id={} has_permission_config={} plan_mode={}",
        session_id,
        permission_config.as_ref().map(|value| !value.is_empty()).unwrap_or(false),
        plan_mode.as_deref().unwrap_or("unchanged")
    );
    if state
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT is_read_only FROM sessions WHERE id = ?1",
            [&session_id],
            |row| row.get::<_, i32>(0),
        )
        .unwrap_or(0)
        != 0
    {
        return Err("会话为只读，原生会话无法恢复".to_string());
    }
    {
        let db = state.db.lock().unwrap();
        operations::update_session_permissions(
            &db,
            &session_id,
            permission_config.as_deref(),
            plan_mode.as_deref(),
        )
        .map_err(|e| e.to_string())?;
    }

    if let Err(error) = send_permission_update_to_session(&state, &agent_state, &session_id).await {
        warn!(
            target: "session",
            "Runtime permission update skipped after DB save session_id={} error={}",
            session_id,
            error
        );
    }

    Ok(())
}

pub(crate) async fn cleanup_native_sessions_best_effort(
    roots: &crate::paths::PathRoots,
    state: &AppState,
    agent_state: &AgentState,
    app_session_id: &str,
    sessions: &[NativeSessionRef],
    include_codex_interactive: bool,
) {
    let home = home_dir().ok();
    for session in sessions {
        match session.agent_kind {
            AgentKind::ClaudeCode => {
                if let Some(home) = home.as_ref() {
                    if let Err(error) =
                        cleanup_claude_native_session(home, &session.agent_session_id)
                    {
                        warn!(
                            target: "session",
                            "Failed to clean Claude native session app_session_id={} agent_session_id={}: {}",
                            app_session_id,
                            session.agent_session_id,
                            error
                        );
                    }
                }
            }
            AgentKind::Codex => {
                if let Some(home) = home.as_ref() {
                    if let Err(error) =
                        cleanup_codex_native_session(home, &session.agent_session_id)
                    {
                        warn!(
                            target: "session",
                            "Failed to clean Codex native session app_session_id={} agent_session_id={}: {}",
                            app_session_id,
                            session.agent_session_id,
                            error
                        );
                    }
                }
            }
            AgentKind::Opencode => {
                if let Err(error) = delete_opencode_native_session(
                    roots,
                    state,
                    agent_state,
                    app_session_id,
                    &session.agent_session_id,
                )
                .await
                {
                    warn!(
                        target: "session",
                        "Failed to clean OpenCode native session app_session_id={} agent_session_id={}: {}",
                        app_session_id,
                        session.agent_session_id,
                        error
                    );
                }
            }
            // pi 的 mapping 即会话文件绝对路径；仅删除 .jsonl 会话文件。
            AgentKind::Pi => {
                let path = std::path::Path::new(&session.agent_session_id);
                if path.is_absolute() && path.extension().is_some_and(|ext| ext == "jsonl") {
                    if let Err(error) = std::fs::remove_file(path) {
                        warn!(
                            target: "session",
                            "Failed to clean pi native session app_session_id={} agent_session_id={}: {}",
                            app_session_id,
                            session.agent_session_id,
                            error
                        );
                    }
                }
            }
            AgentKind::GeminiCli => {}
        }
    }

    if include_codex_interactive {
        if let Some(home) = home.as_ref() {
            if let Err(error) = cleanup_codex_app_interactive_events(home, app_session_id) {
                warn!(
                    target: "session",
                    "Failed to clean Codex interactive events app_session_id={}: {}",
                    app_session_id,
                    error
                );
            }
        }
    }
}

pub async fn delete_session_with_agent_cleanup_for_companion(
    daemon: &crate::daemon::DaemonState,
    session_id: String,
) -> Result<(), String> {
    let state = &daemon.app;
    let skip_cleanup = {
        let db = state.db.lock().unwrap();
        operations::get_session(&db, &session_id)
            .map_err(|error| error.to_string())?
            .map(|session| session.origin == "imported" || session.is_read_only)
            .unwrap_or(true)
    };
    if !skip_cleanup {
        let _ = crate::agent::session_lifecycle::shutdown_agent_for_companion(
            state,
            &daemon.agent,
            &session_id,
        )
        .await;
        let _ = crate::agent::session_lifecycle::reset_agent_session_for_companion(
            state,
            &daemon.agent,
            &session_id,
        )
        .await;
    }
    delete_session_impl(daemon, session_id).await
}

pub fn update_session_working_path_for_companion(
    state: &AppState,
    session_id: String,
    working_path: String,
) -> Result<operations::Session, String> {
    update_session_working_path_impl(state, session_id, working_path)
}

pub fn update_session_provider_for_companion(
    state: &AppState,
    session_id: String,
    provider_id: Option<String>,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    update_session_provider_impl(state, session_id, provider_id, model, reasoning_effort)
}

pub fn update_session_reasoning_effort_for_companion(
    state: &AppState,
    session_id: String,
    reasoning_effort: String,
) -> Result<(), String> {
    update_session_reasoning_effort_impl(state, session_id, reasoning_effort)
}

pub async fn update_session_permissions_for_companion(
    daemon: &crate::daemon::DaemonState,
    session_id: String,
    permission_config: Option<String>,
    plan_mode: Option<String>,
) -> Result<(), String> {
    update_session_permissions_impl(
        &daemon.app,
        &daemon.agent,
        session_id,
        permission_config,
        plan_mode,
    )
    .await
}
