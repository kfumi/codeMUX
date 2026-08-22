# 08 — 手动上下文压缩

**What to build:** 用户输入 `/compact` 触发 app-server `thread/compact/start`（非文本 prompt）。时间线展示 compaction loading → completed；区分 manual 与 auto trigger；正确处理 `thread/compacted` notification 与 `contextCompaction` item 双通道完成去重；compact summary 不重复渲染为普通助手消息。

**Blocked by:** 03 — 官方上游基础 Codex turn

**Status:** ready-for-agent

- [x] `/compact` slash command 路由到 native compact RPC
- [x] compaction timeline item 展示 loading 与 completed 状态
- [x] manual compact 标记 `trigger: manual`（或等价领域字段）
- [x] 双通道 dedup：notification 与 item lifecycle 不重复 emit 边界
- [x] turn 结束前 flush 未配对的 compaction completion（兼容部分 build 行为）
- [x] 单测覆盖 compact 发起与完成事件序列

**实现说明（机制偏离）：** 双通道按互补语义实现——`contextCompaction` item lifecycle 为权威，`thread/compacted` notification 仅作补充（flush 未配对 item；无 item 时合成边界）。`pre_tokens` 取自当回合 turn usage（`input_tokens + cached_input_tokens`），协议不提供压缩后计数故 `post_tokens` 恒为 0。
