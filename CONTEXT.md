
# codeMUX Domain Context

## Glossary

### Message UUID
Agent 原生消息 UUID，用于标识一轮具体对话消息。前端 assistant message 的 `uuid` 作为跨层日志中的 message ID。

### Log Context
跨层日志上下文，包含应用 session ID 和可选的 message UUID。Rust 核心路径使用 task-local 上下文，Sidecar 使用轻量运行时上下文；日志以 `[session=...][msg=...]` 前缀输出。

## Preferred Terms


| Use | Avoid |
|-----|-------|

## Out of Scope (for this feature's first cut)

