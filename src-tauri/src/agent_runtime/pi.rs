use async_trait::async_trait;
use serde_json::{json, Value};

use super::types::{AgentRuntime, RuntimeRequest};

/// Rust-side adapter for the pi sidecar runtime.
///
/// pi 以 `--mode rpc` 子进程运行在 sidecar 内（见 sidecar `piRuntime`）。
/// 该适配器只负责稳定的命令信封与 kind 标识，命令经既有 sidecar stdin
/// 通道下发。pi 的 Native Session mapping 是其会话文件绝对路径。
#[derive(Default)]
pub struct PiRuntime;

impl PiRuntime {
    pub fn ensure_session_command(request: &RuntimeRequest) -> Value {
        let mut command = json!({
            "type": "ensure_session",
            "agentKind": "pi",
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

    pub fn delete_session_command(
        session_id: &str,
        agent_session_id: &str,
        request_id: &str,
    ) -> Value {
        json!({
            "type": "delete_session",
            "sessionId": session_id,
            "agentSessionId": agent_session_id,
            "requestId": request_id,
        })
    }

    pub fn shutdown_command() -> Value {
        json!({ "type": "shutdown" })
    }
}

#[async_trait]
impl AgentRuntime for PiRuntime {
    fn kind_name(&self) -> &'static str {
        "pi"
    }

    async fn ensure(&self, request: RuntimeRequest) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::pi",
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
            target: "agent_runtime::pi",
            "send_input prompt_len={}",
            prompt.len(),
        );
        Ok(())
    }

    async fn interrupt(&self, _session_id: &str) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::pi",
            "interrupt",
        );
        Ok(())
    }

    async fn shutdown(&self, _session_id: &str) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::pi",
            "shutdown",
        );
        Ok(())
    }

    async fn reset(&self, _session_id: &str) -> Result<(), String> {
        crate::log_ctx!(
            info,
            target: "agent_runtime::pi",
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
            agent_kind: "pi".to_string(),
            cwd: "D:\\workspace".to_string(),
            prompt: None,
            api_key: Some("secret".to_string()),
            base_url: Some("https://example.test".to_string()),
            model: Some("anthropic/claude-sonnet".to_string()),
            channel: tauri::ipc::Channel::new(|_| Ok(())),
        }
    }

    #[test]
    fn builds_pi_command_envelopes_with_pi_agent_kind() {
        assert_eq!(
            PiRuntime::ensure_session_command(&request()),
            json!({
                "type": "ensure_session",
                "agentKind": "pi",
                "cwd": "D:\\workspace",
                "sessionId": "app-session",
                "apiKey": "secret",
                "baseUrl": "https://example.test",
                "model": "anthropic/claude-sonnet"
            })
        );
        assert_eq!(
            PiRuntime::send_input_command("app-session", "hello".to_string(), None),
            json!({ "type": "send_input", "sessionId": "app-session", "prompt": "hello" })
        );
        assert_eq!(
            PiRuntime::interrupt_command(),
            json!({ "type": "interrupt" })
        );
        assert_eq!(
            PiRuntime::reset_session_command("app-session"),
            json!({ "type": "reset_session", "sessionId": "app-session" })
        );
        assert_eq!(
            PiRuntime::delete_session_command("app-session", "C:\\session.jsonl", "request-1"),
            json!({
                "type": "delete_session",
                "sessionId": "app-session",
                "agentSessionId": "C:\\session.jsonl",
                "requestId": "request-1",
            })
        );
        assert_eq!(PiRuntime::shutdown_command(), json!({ "type": "shutdown" }));
    }

    #[tokio::test]
    async fn reports_pi_kind_name() {
        assert_eq!(PiRuntime.kind_name(), "pi");
    }
}
