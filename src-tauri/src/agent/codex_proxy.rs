//! Codex compat proxy lifecycle: starting and stopping the sidecar-hosted
//! proxy, parsing its port from stderr, and exposing the live port.

use std::sync::Arc;

use log::warn;

use super::session_lifecycle::AgentState;

/// Parse the proxy port from captured sidecar stderr lines.
#[allow(dead_code)]
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
