use async_trait::async_trait;
use log::info;

use super::types::{AgentRuntime, RuntimeRequest};

/// Claude Code runtime adapter.
///
/// Phase 1: delegates all operations through the sidecar by building the
/// appropriate JSON commands. The actual sidecar management (spawn, stdin
/// routing, channel forwarding) remains in `agent::commands` — this struct
/// exists so the runtime factory has a concrete type to return and so the
/// `agent_kind` is explicitly represented in the Rust module tree.
#[derive(Default)]
pub struct ClaudeCodeRuntime;

#[async_trait]
impl AgentRuntime for ClaudeCodeRuntime {
    fn kind_name(&self) -> &'static str {
        "claude_code"
    }

    async fn ensure(&self, request: RuntimeRequest) -> Result<(), String> {
        info!(
            target: "agent_runtime::claude_code",
            "ensure session_id={} cwd={}",
            request.session_id,
            request.cwd,
        );
        // Actual sidecar delegation happens in agent::commands — see
        // ensure_agent_session which calls build_ensure_session_command.
        Ok(())
    }

    async fn start(&self, request: RuntimeRequest) -> Result<(), String> {
        info!(
            target: "agent_runtime::claude_code",
            "start session_id={}",
            request.session_id,
        );
        Ok(())
    }

    async fn send_input(&self, session_id: &str, prompt: String) -> Result<(), String> {
        info!(
            target: "agent_runtime::claude_code",
            "send_input session_id={} prompt_len={}",
            session_id,
            prompt.len(),
        );
        Ok(())
    }

    async fn interrupt(&self, session_id: &str) -> Result<(), String> {
        info!(
            target: "agent_runtime::claude_code",
            "interrupt session_id={}",
            session_id,
        );
        Ok(())
    }

    async fn shutdown(&self, session_id: &str) -> Result<(), String> {
        info!(
            target: "agent_runtime::claude_code",
            "shutdown session_id={}",
            session_id,
        );
        Ok(())
    }

    async fn reset(&self, session_id: &str) -> Result<(), String> {
        info!(
            target: "agent_runtime::claude_code",
            "reset session_id={}",
            session_id,
        );
        Ok(())
    }

    async fn load_history(&self, session_id: &str) -> Result<Vec<serde_json::Value>, String> {
        info!(
            target: "agent_runtime::claude_code",
            "load_history session_id={}",
            session_id,
        );
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn claude_runtime_kind_name() {
        let runtime = ClaudeCodeRuntime;
        assert_eq!(runtime.kind_name(), "claude_code");
    }
}
