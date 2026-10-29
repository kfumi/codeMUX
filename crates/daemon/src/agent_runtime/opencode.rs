use serde_json::{json, Value};

use super::types::send_input_command as build_send_input;

/// Rust 侧的 sidecar 命令信封构造器（OpenCode）。
///
/// 这里**没有**运行时对象，也没有 trait 实现：OpenCode SDK 调用全在 sidecar 内，
/// daemon 只负责把稳定的命令信封发过去。曾经这里有一个 `AgentRuntime` trait 的
/// 空实现（六个方法只打日志再返回 `Ok(())`），它的存在让人误以为 daemon 驾驶运行时，
/// 而真正驾驶的是 sidecar。
///
/// 只保留**实际被调用**的信封：`ensure_session` 由
/// `agent::session_lifecycle::build_ensure_session_command` 构造（它要按 kind 拼
/// 权限快照、附加目录、MCP 等十几个字段），这里的同名函数是历史残留，已删除。
pub struct OpenCodeCommands;

impl OpenCodeCommands {
    pub fn send_input_command(
        session_id: &str,
        prompt: String,
        display_content: Option<&str>,
    ) -> Value {
        build_send_input(session_id, prompt, display_content)
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
        cwd: Option<&str>,
        runtime_ref: &crate::runtime::ProviderRuntimeRef,
    ) -> Value {
        let mut command = json!({
            "type": "delete_session",
            "sessionId": session_id,
            "agentSessionId": agent_session_id,
            "requestId": request_id,
        });
        if let Some(cwd) = cwd {
            command["cwd"] = Value::String(cwd.to_string());
        }
        command["runtimeRef"] = serde_json::to_value(runtime_ref).unwrap_or(Value::Null);
        command
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_input_omits_display_content_when_absent() {
        let with = OpenCodeCommands::send_input_command("s1", "hi".into(), Some("shown"));
        assert_eq!(with["displayContent"], "shown");

        let without = OpenCodeCommands::send_input_command("s1", "hi".into(), None);
        assert!(without.get("displayContent").is_none());
    }

    #[test]
    fn permission_response_echoes_the_response_payload() {
        let command = OpenCodeCommands::respond_to_permission_command(
            "r1",
            "s1",
            json!({ "behavior": "allow" }),
        );
        assert_eq!(command["type"], "respond_to_permission");
        assert_eq!(command["response"]["behavior"], "allow");
    }

    #[test]
    fn session_lifecycle_commands_carry_the_session_id() {
        assert_eq!(
            OpenCodeCommands::reset_session_command("s1")["sessionId"],
            "s1"
        );
        assert_eq!(OpenCodeCommands::interrupt_command()["type"], "interrupt");
        assert_eq!(OpenCodeCommands::shutdown_command()["type"], "shutdown");
    }
}
