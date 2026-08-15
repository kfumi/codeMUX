use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::agent::commands::{send_command_to_session, AgentState};
use crate::agent_runtime::opencode::OpenCodeRuntime;
use crate::db::operations;
use crate::AppState;

pub fn resolve_session_cwd(state: &AppState, session_id: &str) -> Result<String, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    let session = operations::get_session(&db, session_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Session not found".to_string())?;

    if let Some(project_id) = session.project_id {
        let project_path: Option<String> = db
            .query_row(
                "SELECT path FROM projects WHERE id = ?1",
                [project_id.as_str()],
                |row| row.get(0),
            )
            .ok();
        if let Some(path) = project_path {
            return Ok(path);
        }
    }

    crate::agent::commands::home_dir()
        .map(|path| path.display().to_string())
        .map_err(|error| error.to_string())
}

pub async fn send_companion_message(
    app: &AppHandle,
    session_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let agent_state = app.state::<AgentState>();

    crate::agent::commands::reject_read_only_session(&app_state, session_id)?;

    let sidecar_running = {
        let sidecars = agent_state.sidecars.lock().await;
        sidecars.contains_key(session_id)
    };

    if sidecar_running {
        let cmd = OpenCodeRuntime::send_input_command(session_id, prompt.to_string(), None);
        return send_command_to_session(&agent_state, session_id, cmd).await;
    }

    let cwd = resolve_session_cwd(app_state.inner(), session_id)?;
    let channel = tauri::ipc::Channel::new(|_| Ok(()));
    let reasoning_effort = {
        let db = app_state.db.lock().map_err(|error| error.to_string())?;
        operations::get_session(&db, session_id)
            .map_err(|error| error.to_string())?
            .and_then(|session| session.reasoning_effort)
    };

    crate::agent::commands::start_agent_session(
        app.clone(),
        app_state,
        agent_state,
        session_id.to_string(),
        prompt.to_string(),
        cwd,
        channel,
        reasoning_effort,
        None,
        None,
    )
    .await
}

pub async fn respond_companion_permission(
    app: &AppHandle,
    session_id: &str,
    request_id: &str,
    response: serde_json::Value,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let agent_state = app.state::<AgentState>();
    crate::agent::commands::reject_read_only_session(&app_state, session_id)?;

    let cmd = OpenCodeRuntime::respond_to_permission_command(request_id, session_id, response);
    send_command_to_session(&agent_state, session_id, cmd).await
}

pub fn resolve_static_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let release_dir = manifest_dir.join("../dist-mobile");
    if release_dir.exists() {
        return release_dir;
    }
    manifest_dir.join("../src-mobile/dist")
}
