use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use super::{SidecarHandle, spawn_sidecar};

/// Managed state for the agent sidecar.
pub struct AgentState {
    pub sidecar: Arc<Mutex<Option<SidecarHandle>>>,
    /// The currently active frontend channel for receiving events.
    /// Set per-query; cleared when the query ends.
    pub active_channel: Arc<Mutex<Option<tauri::ipc::Channel<String>>>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            sidecar: Arc::new(Mutex::new(None)),
            active_channel: Arc::new(Mutex::new(None)),
        }
    }
}

/// Start a new agent session. Spawns the sidecar if needed, sends the prompt,
/// and streams SDKMessage JSON events back through the channel.
#[tauri::command]
pub async fn start_agent_session(
    app: AppHandle,
    agent_state: State<'_, AgentState>,
    session_id: String,
    prompt: String,
    cwd: String,
    channel: tauri::ipc::Channel<String>,
    api_key: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    // Ensure sidecar is running
    let need_spawn = {
        let guard = agent_state.sidecar.lock().await;
        guard.is_none()
    };

    if need_spawn {
        let (handle, mut rx) = spawn_sidecar(&app).await?;
        {
            let mut guard = agent_state.sidecar.lock().await;
            *guard = Some(handle);
        }

        // Spawn persistent forwarding task: reads from sidecar stdout,
        // forwards events to whichever frontend channel is currently active.
        let active_ch = agent_state.active_channel.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let guard = active_ch.lock().await;
                if let Some(ch) = guard.as_ref() {
                    let _ = ch.send(event.clone());
                }
            }
        });
    }

    // Set the active channel for this query
    {
        let mut guard = agent_state.active_channel.lock().await;
        *guard = Some(channel);
    }

    // Use provided API key, or fall back to active provider's key
    let api_key = api_key.unwrap_or_else(|| {
        let state: State<'_, crate::AppState> = app.state();
        let config = state.config.lock().unwrap();
        config
            .providers
            .iter()
            .find(|p| p.is_active)
            .map(|p| p.api_key.clone())
            .unwrap_or_default()
    });

    // Build and send start command
    let mut cmd = serde_json::json!({
        "type": "start",
        "prompt": prompt,
        "cwd": cwd,
        "sessionId": session_id,
        "apiKey": api_key,
    });
    if let Some(m) = model {
        cmd["model"] = serde_json::Value::String(m);
    }

    let guard = agent_state.sidecar.lock().await;
    if let Some(handle) = guard.as_ref() {
        handle
            .send_command(&cmd.to_string())
            .await?;
    }

    Ok(())
}

/// Interrupt the currently running agent query and clear the active channel.
#[tauri::command]
pub async fn interrupt_agent_session(
    agent_state: State<'_, AgentState>,
) -> Result<(), String> {
    {
        let guard = agent_state.sidecar.lock().await;
        if let Some(handle) = guard.as_ref() {
            handle
                .send_command(r#"{"type":"interrupt"}"#)
                .await?;
        }
    }
    {
        let mut guard = agent_state.active_channel.lock().await;
        *guard = None;
    }
    Ok(())
}

/// Shutdown the sidecar process.
#[tauri::command]
pub async fn shutdown_agent(
    agent_state: State<'_, AgentState>,
) -> Result<(), String> {
    {
        let mut guard = agent_state.active_channel.lock().await;
        *guard = None;
    }
    let mut guard = agent_state.sidecar.lock().await;
    if let Some(mut handle) = guard.take() {
        handle.shutdown().await;
    }
    Ok(())
}
