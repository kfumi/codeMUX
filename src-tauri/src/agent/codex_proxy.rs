//! Codex compat proxy lifecycle: starting and stopping the sidecar-hosted
//! proxy, parsing its port from stderr, and exposing the live port.

use std::collections::HashMap;
use std::sync::Arc;

use log::{info, warn};
use tauri::State;

use super::session_lifecycle::{send_command_to_session, AgentState};
use super::{spawn_sidecar, SidecarHandle};

const PROXY_SESSION_ID: &str = "__codex_proxy__";

/// Find any active sidecar to send a global command (e.g. proxy management).
/// Skips the dedicated proxy sidecar — it has no Codex session initialized.
fn find_any_active_sidecar(sidecars: &HashMap<String, SidecarHandle>) -> Option<String> {
    sidecars
        .keys()
        .find(|id| id.as_str() != PROXY_SESSION_ID)
        .cloned()
}

/// Parse the proxy port from captured sidecar stderr lines.
pub(crate) fn parse_proxy_port_from_stderr(lines: &[String]) -> Option<u16> {
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
async fn get_live_proxy_port(agent_state: &Arc<AgentState>) -> Option<u16> {
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

#[tauri::command]
pub async fn start_codex_proxy(
    daemon: State<'_, Arc<crate::daemon::DaemonState>>,
    api_key: String,
    base_url: String,
    provider_name: String,
    codex_needs_proxy: Option<bool>,
) -> Result<u16, String> {
    let agent_state = &daemon.agent;
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
            let (handle, mut rx) = spawn_sidecar(
                &daemon.roots,
                super::sidecar_events::SidecarEventBinding::unbound(),
            )
            .await?;

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
pub async fn stop_codex_proxy(agent_state: State<'_, Arc<AgentState>>) -> Result<(), String> {
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
    agent_state: State<'_, Arc<AgentState>>,
) -> Result<Option<u16>, String> {
    Ok(*agent_state.proxy_port.lock().await)
}

#[cfg(test)]
mod tests {
    use super::parse_proxy_port_from_stderr;

    #[test]
    fn parse_proxy_port_from_reuse_log() {
        let lines = vec![
            "[codex-compat-proxy] port 15722 busy, retrying (1/5)...".to_string(),
            "[proxy-manager] Reusing existing proxy on port 15722".to_string(),
        ];

        assert_eq!(parse_proxy_port_from_stderr(&lines), Some(15722));
    }
}
