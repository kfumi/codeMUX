use async_trait::async_trait;
use serde_json::{json, Value};

use super::types::{AgentRuntime, RuntimeRequest};

/// Rust-side adapter for the OpenCode sidecar runtime.
///
/// OpenCode SDK calls stay in the sidecar. This adapter only owns the stable
/// command envelopes and delegates them through the existing sidecar stdin
/// channel when a handle is supplied by the agent command layer.
#[derive(Default)]
pub struct OpenCodeRuntime;

impl OpenCodeRuntime {
    pub fn ensure_session_command(request: &RuntimeRequest) -> Value {
        let mut command = json!({
            "type": "ensure_session",
            "agentKind": "opencode",
            "cwd": request.cwd,
            "sessionId": request.session_id,
        });
        if let Some(api_key) = &request.api_key {
            command["apiKey"] = Value::String(api_key.clone());
        }
        if let Some(base_url) = &request.base_url {
            command["baseUrl"] = Value::String(base_url.clone());
        }
        if let Some(model) = &request.model {
            command["model"] = Value::String(model.clone());
        }
        command
    }

    pub fn send_input_command(
        session_id: &str,
        prompt: String,
        display_content: Option<&str>,
    ) -> Value {
        let mut command = json!({
            "type": "send_input",
            "sessionId": session_id,
            "prompt": prompt,
        });
        if let Some(display_content) = display_content {
            command["displayContent"] = Value::String(display_content.to_string());
        }
        command
    }

    pub fn interrupt_command() -> Value {
        json!({ "type": "interrupt" })
    }

    pub fn reset_session_command(session_id: &str) -> Value {
        json!({
            "type": "reset_session",
            "sessionId": session_id,
        })
    }

    pub fn shutdown_command() -> Value {
        json!({ "type": "shutdown" })
    }

    pub fn respond_to_permission_command(
        request_id: &str,
        session_id: &str,
        response: Value,
    ) -> Value {
        json!({
            "type": "respond_to_permission",
            "requestId": request_id,
            "sessionId": session_id,
            "response": response,
        })
    }

    pub async fn send_command(
        handle: &crate::agent::SidecarHandle,
        command: Value,
    ) -> Result<(), String> {
        handle.send_command(&command.to_string()).await
    }
}

#[async_trait]
impl AgentRuntime for OpenCodeRuntime {
    fn kind_name(&self) -> &'static str {
        "opencode"
    }

    async fn ensure(&self, request: RuntimeRequest) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::opencode",
            "ensure cwd={}",
            request.cwd,
        );
        Ok(())
    }

    async fn start(&self, request: RuntimeRequest) -> Result<(), String> {
        self.ensure(request).await
    }

    async fn send_input(&self, _session_id: &str, prompt: String) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::opencode",
            "send_input prompt_len={}",
            prompt.len(),
        );
        Ok(())
    }

    async fn interrupt(&self, _session_id: &str) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::opencode",
            "interrupt",
        );
        Ok(())
    }

    async fn shutdown(&self, _session_id: &str) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::opencode",
            "shutdown",
        );
        Ok(())
    }

    async fn reset(&self, _session_id: &str) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::opencode",
            "reset",
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> RuntimeRequest {
        RuntimeRequest {
            session_id: "app-session".to_string(),
            agent_kind: "opencode".to_string(),
            cwd: "D:\\workspace".to_string(),
            prompt: None,
            api_key: Some("secret".to_string()),
            base_url: Some("https://example.test".to_string()),
            model: Some("open-code-model".to_string()),
            channel: tauri::ipc::Channel::new(|_| Ok(())),
        }
    }

    #[test]
    fn builds_opencode_command_envelopes_without_changing_agent_kind() {
        assert_eq!(
            OpenCodeRuntime::ensure_session_command(&request()),
            json!({
                "type": "ensure_session",
                "agentKind": "opencode",
                "cwd": "D:\\workspace",
                "sessionId": "app-session",
                "apiKey": "secret",
                "baseUrl": "https://example.test",
                "model": "open-code-model"
            })
        );
        assert_eq!(
            OpenCodeRuntime::send_input_command("app-session", "hello".to_string(), None),
            json!({ "type": "send_input", "sessionId": "app-session", "prompt": "hello" })
        );
        assert_eq!(
            OpenCodeRuntime::interrupt_command(),
            json!({ "type": "interrupt" })
        );
        assert_eq!(
            OpenCodeRuntime::reset_session_command("app-session"),
            json!({ "type": "reset_session", "sessionId": "app-session" })
        );
        assert_eq!(
            OpenCodeRuntime::shutdown_command(),
            json!({ "type": "shutdown" })
        );
        assert_eq!(
            OpenCodeRuntime::respond_to_permission_command(
                "permission-1",
                "app-session",
                json!({ "approved": true }),
            ),
            json!({
                "type": "respond_to_permission",
                "requestId": "permission-1",
                "sessionId": "app-session",
                "response": { "approved": true }
            })
        );
    }

    #[tokio::test]
    async fn reports_opencode_kind_name() {
        assert_eq!(OpenCodeRuntime.kind_name(), "opencode");
    }
}
