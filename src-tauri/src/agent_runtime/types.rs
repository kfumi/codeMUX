use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Agent kinds supported by the runtime.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeKind {
    ClaudeCode,
    Codex,
    OpenCode,
}

impl AgentRuntimeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
        }
    }

    pub fn from_agent_kind(agent_kind: &str) -> Self {
        match agent_kind {
            "codex" => Self::Codex,
            "opencode" => Self::OpenCode,
            _ => Self::ClaudeCode,
        }
    }
}

/// Shared request envelope passed to every runtime operation.
#[derive(Clone)]
pub struct RuntimeRequest {
    pub session_id: String,
    pub agent_kind: String,
    pub cwd: String,
    pub prompt: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub channel: tauri::ipc::Channel<String>,
}

impl std::fmt::Debug for RuntimeRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeRequest")
            .field("session_id", &self.session_id)
            .field("agent_kind", &self.agent_kind)
            .field("cwd", &self.cwd)
            .field("prompt", &self.prompt)
            .field("api_key", &self.api_key.as_ref().map(|_| "***"))
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("channel", &"<Channel>")
            .finish()
    }
}

/// Contract that every agent runtime must implement.
///
/// The default implementations return `Ok(())` so that runtimes only need to
/// override the operations they actually support. The factory resolves a
/// `Box<dyn AgentRuntime>` from the session's `agent_kind`.
#[async_trait]
pub trait AgentRuntime: Send + Sync {
    fn kind_name(&self) -> &'static str;

    async fn ensure(&self, _request: RuntimeRequest) -> Result<(), String> {
        Ok(())
    }

    async fn start(&self, _request: RuntimeRequest) -> Result<(), String> {
        Ok(())
    }

    async fn send_input(&self, _session_id: &str, _prompt: String) -> Result<(), String> {
        Ok(())
    }

    async fn interrupt(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }

    async fn shutdown(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }

    async fn reset(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }

    async fn load_history(&self, _session_id: &str) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_claude_and_codex_runtime_variants() {
        assert_eq!(
            AgentRuntimeKind::from_agent_kind("claude_code"),
            AgentRuntimeKind::ClaudeCode
        );
        assert_eq!(
            AgentRuntimeKind::from_agent_kind("codex"),
            AgentRuntimeKind::Codex
        );
        assert_eq!(
            AgentRuntimeKind::from_agent_kind("opencode"),
            AgentRuntimeKind::OpenCode
        );
        assert_eq!(
            AgentRuntimeKind::from_agent_kind("unknown"),
            AgentRuntimeKind::ClaudeCode
        );
    }

    #[test]
    fn kind_name_round_trips() {
        assert_eq!(AgentRuntimeKind::ClaudeCode.as_str(), "claude_code");
        assert_eq!(AgentRuntimeKind::Codex.as_str(), "codex");
        assert_eq!(AgentRuntimeKind::OpenCode.as_str(), "opencode");
    }
}
