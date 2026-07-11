use async_trait::async_trait;
use log::info;
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

    pub fn send_input_command(prompt: String) -> Value {
        json!({
            "type": "send_input",
            "prompt": prompt,
        })
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
        info!(
            target: "agent_runtime::opencode",
            "ensure session_id={} cwd={}",
            request.session_id,
            request.cwd,
        );
        Ok(())
    }

    async fn start(&self, request: RuntimeRequest) -> Result<(), String> {
        self.ensure(request).await
    }

    async fn send_input(&self, session_id: &str, prompt: String) -> Result<(), String> {
        info!(
            target: "agent_runtime::opencode",
            "send_input session_id={} prompt_len={}",
            session_id,
            prompt.len(),
        );
        Ok(())
    }

    async fn interrupt(&self, session_id: &str) -> Result<(), String> {
        info!(
            target: "agent_runtime::opencode",
            "interrupt session_id={}",
            session_id,
        );
        Ok(())
    }

    async fn shutdown(&self, session_id: &str) -> Result<(), String> {
        info!(
            target: "agent_runtime::opencode",
            "shutdown session_id={}",
            session_id,
        );
        Ok(())
    }

    async fn reset(&self, session_id: &str) -> Result<(), String> {
        info!(
            target: "agent_runtime::opencode",
            "reset session_id={}",
            session_id,
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
            OpenCodeRuntime::send_input_command("hello".to_string()),
            json!({ "type": "send_input", "prompt": "hello" })
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
