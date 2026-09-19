# 01 — 子智能体声明收紧：只有派生调用能建轨道

**What to build:** 用户在 Codex 会话里不再看到标题固定为「Sub-agent」、描述为空、内容永远为 0 的伪子智能体条目；`wait_agent` 这类编排调用不再出现在对话时间线里（连同它没有对应开始的孤儿结果行）。真正的派生调用（`spawnAgent`）行为不变：一张父卡片、一条轨道、完成结果正常回收。带目标线程 id 的编排调用仍然只把状态归到已存在的子智能体上，不新建轨道。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] `wait_agent` / `send_input` / `resume_agent` / `close_agent` 调用不再创建新的子智能体轨道（会话持久化里不再出现描述为空、标题为「Sub-agent」的轨道记录）。
- [x] 编排调用不再在父时间线产生「Sub-agent call …」结果行；派生调用的父卡片与其别名完成结果仍按现状正常呈现。
- [x] 带目标线程 id 的编排调用仍把子智能体状态聚合到已存在的轨道上，且不产生新轨道。
- [x] 针对未知任务的状态观察保持空操作，不会隐式创建描述符或轨道。
- [x] 单测覆盖：编排调用（带目标 / 不带目标）都不建轨道、派生调用二次宣告仍只有一条轨道；用例输入取自真实 wire 快照（见 spec 的证据段落）。
- [x] 既有 `codexSubagentSource` 与 `codexAppServerRuntime` 测试全绿，Sidecar 构建通过（本票不涉及 Rust 与前端）。

**Outcome（2026-09-19）:** 完成。声明收窄为 `tool === 'spawnAgent'`（`codexSubagentSource.ts` `observeParentItem`），未知目标的编排调用不再产生状态观察；`runtimeEvents.ts` 的 collab 结果行对非 spawn 返回 `null`。新增 `CodexSubagentSource orchestration calls` 用例（4 个 tool × 不见轨道 + 聚合到已声明子代理）。
