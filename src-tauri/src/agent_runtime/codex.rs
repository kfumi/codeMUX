use async_trait::async_trait;
use log::info;

use super::types::{AgentRuntime, RuntimeRequest};

/// Codex runtime adapter.
///
/// Phase 1: delegates all operations through the sidecar. The sidecar's
/// `CodexSessionRuntime` (in `sidecar/src/codexRuntime.ts`) handles the actual
/// Codex SDK interaction. This struct exists so the runtime factory has a
/// concrete Codex type and the `agent_kind` routing is explicit in Rust.
#[derive(Default)]
pub struct CodexRuntime;

#[async_trait]
impl AgentRuntime for CodexRuntime {
    fn kind_name(&self) -> &'static str {
        "codex"
    }

    async fn ensure(&self, request: RuntimeRequest) -> Result<(), String> {
        info!(
            target: "agent_runtime::codex",
            "ensure session_id={} cwd={}",
            request.session_id,
            request.cwd,
        );
        Ok(())
    }

    async fn start(&self, request: RuntimeRequest) -> Result<(), String> {
        info!(
            target: "agent_runtime::codex",
            "start session_id={}",
            request.session_id,
        );
        Ok(())
    }

    async fn send_input(&self, session_id: &str, prompt: String) -> Result<(), String> {
        info!(
            target: "agent_runtime::codex",
            "send_input session_id={} prompt_len={}",
            session_id,
            prompt.len(),
        );
        Ok(())
    }

    async fn interrupt(&self, session_id: &str) -> Result<(), String> {
        info!(
            target: "agent_runtime::codex",
            "interrupt session_id={}",
            session_id,
        );
        Ok(())
    }

    async fn shutdown(&self, session_id: &str) -> Result<(), String> {
        info!(
            target: "agent_runtime::codex",
            "shutdown session_id={}",
            session_id,
        );
        Ok(())
    }

    async fn reset(&self, session_id: &str) -> Result<(), String> {
        info!(
            target: "agent_runtime::codex",
            "reset session_id={}",
            session_id,
        );
        Ok(())
    }

    async fn load_history(&self, session_id: &str) -> Result<Vec<serde_json::Value>, String> {
        info!(
            target: "agent_runtime::codex",
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
    async fn codex_runtime_kind_name() {
        let runtime = CodexRuntime;
        assert_eq!(runtime.kind_name(), "codex");
    }
}
