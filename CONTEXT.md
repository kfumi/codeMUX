
# codeMUX Domain Context

## Glossary

### Message UUID
Agent 原生消息 UUID，用于标识一轮具体对话消息。前端 assistant message 的 `uuid` 作为跨层日志中的 message ID。

### Log Context
跨层日志上下文，包含应用 session ID 和可选的 message UUID。Rust 核心路径使用 task-local 上下文，Sidecar 使用轻量运行时上下文；日志以 `[session=...][msg=...]` 前缀输出。

### CodeMUX Event
跨智能体运行时传递的一条规范化对话事件，描述用户消息、助手消息、文本或推理增量、工具生命周期、系统状态、诊断、错误、用量或一轮结束结果。它不包含具体 provider 的事件语义。
_Avoid_: provider event, stream event

### User Message
用户提交给智能体、并且应当在对话历史中恢复的可见消息。它与智能体内部注入的环境上下文、压缩摘要和工具结果不同。
_Avoid_: prompt, input event

### System Event
不属于用户或助手正文、但会改变对话解释方式的领域事件，例如上下文压缩边界。它可以被 UI 投影为状态提示，但不应被当作助手正文。
_Avoid_: provider system message

### Diagnostic Event
描述事件流异常、缺口或无法识别输入的 CodeMUX Event。它用于诊断和审计，不改变一轮的 Turn Outcome。
_Avoid_: runtime error

### Application Control Event
驱动应用生命周期或控制面的事件，例如 Sidecar 就绪、MCP 状态、代理端口、Todo、文件快照和重连状态。它不是对话领域事件，不进入历史 CodeMUX Event 序列。
_Avoid_: conversation event

### Turn Outcome
一轮对话最终的完成状态，表示已完成、失败、中断或取消。它与描述中途原因的错误事件分开。
_Avoid_: result status, error status

### Event Sequence
同一会话内 CodeMUX Event 的有序位置。它用于保证增量事件顺序、识别事件缺口，并使结束事件具备幂等语义。
_Avoid_: event index, provider sequence

## Preferred Terms


| Use | Avoid |
|-----|-------|

## Out of Scope (for this feature's first cut)

