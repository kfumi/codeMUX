
# codeMUX Domain Context

## Glossary

### Message UUID
Agent 原生消息 UUID，用于标识一轮具体对话消息。前端 assistant message 的 `uuid` 作为跨层日志中的 message ID。

### Log Context
跨层日志上下文，包含应用 session ID 和可选的 message UUID。Rust 核心路径使用 task-local 上下文，Sidecar 使用轻量运行时上下文；日志以 `[session=...][msg=...]` 前缀输出。

### CodeMUX Event
跨智能体运行时传递的一条规范化对话事件，描述文本、推理、工具、用量、状态、错误或一轮结束结果。它不包含具体 provider 的事件语义。
_Avoid_: provider event, stream event

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

