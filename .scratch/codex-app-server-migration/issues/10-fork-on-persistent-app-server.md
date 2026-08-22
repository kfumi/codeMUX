# 10 — Fork 并入长连接 app-server

**What to build:** Session Fork 使用主 runtime 长期 app-server 连接上的 `thread/fork` RPC，不再为 fork 单独临时 spawn app-server 进程。Fork 后子 Session 获得新 Native Session id，父 Session CodeMUX Event 历史拷贝语义符合 ADR 0007 Fork 定义。

**Blocked by:** 03 — 官方上游基础 Codex turn

**Status:** ready-for-agent

- [x] Fork 走同一 app-server 进程的 `thread/fork`（必要时 `thread/turns/list` 解析 lastTurnId）
- [x] 删除或退役 fork 专用临时 app-server spawn 路径
- [x] 子 Session mapping 指向新 thread id
- [x] Fork 端到端测试或集成测通过（父 Session Codex、fork 点正确）
- [x] Fork 失败时用户可见错误
