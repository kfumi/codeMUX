# 0002 — Structured log context for cross-layer debugging

Rust 和 Sidecar 日志不带 sessionId / messageId 上下文，排查问题时无法精准定位到某轮对话。顶层选择了两项关键策略：

1. **前缀式文本 `[session=xxx][msg=yyy]` 而非 JSON lines** — `tauri-plugin-log` 不支持自定义 JSON 格式器，为 JSON 改造文件轮转层成本过高；前缀格式 AI 同样能可靠解析，改动最小。
2. **只注入核心路径而非全量覆盖** — 只在 `agent/commands.rs`、`agent_runtime/*.rs`、`turn_meta.rs` 以及 warn/error 路径加入日志上下文；高频 streaming 路径不动，避免性能影响。

Rust 端用 `tokio::task_local!` 承载上下文，`log_with_ctx!` 宏自动注入前缀；Sidecar 端包一层 `stderrWrite(ctx, ...)` 在关键路径使用。
