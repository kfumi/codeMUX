# 04 — Native Session resume 与 rebuild 降级

**What to build:** 已有 Codex Native Session mapping（`thr_*`）在 ensure 时优先 `thread/resume`；resume 失败则 mint 新 thread、替换 mapping，并 emit System Event（`subtype=native_session_rebuilt`）。CodeMUX Event 时间线保持不变，用户仍看到完整对话历史。

**Blocked by:** 03 — 官方上游基础 Codex turn

**Status:** ready-for-agent

- [x] 有 mapping 时 ensure 走 `thread/resume` 而非总是 `thread/start`
- [x] resume 成功：同一 thread id 继续后续 turn
- [x] resume 失败：新建 thread、更新 agent_session_mapping、emit `native_session_rebuilt` System Event
- [x] 单测覆盖 resume 成功与失败降级路径
- [x] UI 可投影 System Event 为可读状态提示（非助手正文）
