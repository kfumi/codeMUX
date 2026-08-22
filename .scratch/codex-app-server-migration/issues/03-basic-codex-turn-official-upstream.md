# 03 — 官方上游基础 Codex turn

**What to build:** 在 Sidecar Codex Session Runtime 边界上，用 app-server 替代 SDK 完成最小端到端路径：每个 Codex Native Session 在 ensure 时 spawn 长期存活的 app-server 进程，用户发送 User Message 后经 `turn/start` 收到流式助手输出与 Turn Outcome，事件归一化为 CodeMUX Event 协议。官方 OpenAI Protocol Endpoint 直连，不经 compat 代理。本 ticket 是 spec 定义的主测试 seam。

**Blocked by:** 01 — 托管 Runtime 切换至 Codex CLI; 02 — App-server 传输层与 fake 测试基建

**Status:** ready-for-agent

- [ ] `ensure_session` spawn app-server 并完成 initialize；`delete_session` dispose 子进程
- [ ] 新 Session：`thread/start` + `turn/start`；文本 User Message 产生流式 assistant 增量与 turn 完成
- [ ] `turn/interrupt` 可中止进行中的 turn
- [ ] app-server notification 归一化为现有 CodeMUX 侧事件形状（助手文本、Turn Outcome、token usage 等基础子集）
- [ ] fake-app-server 单测覆盖完整 send_input 往返（Sidecar Runtime 边界）
- [ ] 官方 OpenAI 路径不启动 compat 代理（`codex_needs_proxy: false`）
- [ ] app-server 崩溃后可观测错误 emit，不 silent hang
