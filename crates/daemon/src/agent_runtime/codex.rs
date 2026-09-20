use async_trait::async_trait;

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
        crate::log_ctx!(
            info,
            target: "agent_runtime::codex",
            "ensure cwd={}",
            request.cwd,
        );
        Ok(())
    }

    async fn start(&self, _request: RuntimeRequest) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::codex",
            "start",
        );
        Ok(())
    }

    async fn send_input(&self, _session_id: &str, prompt: String) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::codex",
            "send_input prompt_len={}",
            prompt.len(),
        );
        Ok(())
    }

    async fn interrupt(&self, _session_id: &str) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::codex",
            "interrupt",
        );
        Ok(())
    }

    async fn shutdown(&self, _session_id: &str) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::codex",
            "shutdown",
        );
        Ok(())
    }

    async fn reset(&self, _session_id: &str) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::codex",
            "reset",
        );
        Ok(())
    }

    async fn load_history(&self, _session_id: &str) -> Result<Vec<serde_json::Value>, String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::codex",
            "load_history",
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
