# Turn 级产物汇总（Agent Artifact Summary）

**Status:** superseded by [2026-09-30-turn-artifact-summary-v2.md](2026-09-30-turn-artifact-summary-v2.md)

> 本文档的「工具识别（MVP 白名单）」与「OpenCode 隔离」两节已与现状不符：
> 统一汇总器实际上已接入 OpenCode，而 OpenCode 的原生 summary 已被主动停用；
> MVP 明确排除的批量编辑与补丁类工具，经实测确认是用户可见的漏报来源。
> 正文保留原样，仅作为决策历史。当前生效的决策见 v2。

## Problem Statement

OpenCode Agent Kind 在每一轮对话结束时，会自动携带 turn 级文件变更摘要（`session_summary`），CodeMUX 已将其渲染为「N 个文件已更改」折叠卡片，用户可展开查看路径、增删行数并点开 diff。

Claude Code 与 Codex 的消息/事件流中没有等价的 turn 级产物信息。虽然单个 Write/Edit/apply_patch 工具调用在聊天气泡里可见，但用户无法在**一轮对话结束**时一眼看到「这轮改了哪些文件」的汇总视图。前端 store 里虽有 `changedFiles` 追踪逻辑，但没有对应的 turn 级 UI，且 Codex 路径对 patch 内容的保留不完整。

用户需要在 Claude Code 与 Codex 上获得与 OpenCode 一致的体验：每轮 turn 结束后，在最终 assistant 消息下方看到统一的产物汇总卡片。

## Solution

在 sidecar 层新增 **Turn Artifact Aggregator**（产物汇总器）：监听已归一化的工具事件与 turn 生命周期，识别会修改文件的结构化工具调用，在 turn 结束时 emit 与 OpenCode 同形的 `session_summary` 系统事件。前端**复用**现有 `SessionSummaryCard`，但**必须同时改实时事件管道与刷新重载管道**，保证两条路径都能解析、挂载并渲染 summary。

本功能有**两条同等重要的交付路径**（见下文「双路径架构」），只做 sidecar _emit 不够。

汇总规则：

- **每轮 turn 一张卡片**（不是整段 session 一张）
- **同一文件多次修改**：只保留该 turn 内**最新一次**成功变更的统计与 diff 内容
- **只统计成功的工具**：`tool_finished` 且非 error 的 Write/Edit/apply_patch
- **用户中断 turn**：仍展示该 turn 内已完成的成功变更（partial summary）
- **忽略 shell/终端改文件**：不解析 Bash/shell_command 内嵌 patch
- **OpenCode 不介入**：继续依赖 SDK 原生 `session_summary`
- **`changedFiles` store 首版不动**：新卡片为主，store 后续再决定是否收敛

## User Stories

### 汇总展示（Claude Code）

1. As a Claude Code 用户，我希望每轮 turn 正常结束后，在最终 assistant 消息下方看到「N 个文件已更改」卡片，以便快速了解本轮产物。
2. As a Claude Code 用户，我希望卡片展示每个变更文件的路径、新增行数与删除行数，以便评估改动规模。
3. As a Claude Code 用户，我希望点击卡片中的某个文件后打开 side panel diff 视图，以便审查具体变更。
4. As a Claude Code 用户，当 agent 在一轮内对同一文件多次 Write/Edit 时，我希望产物卡片只反映**最后一次**成功修改的结果，以便不被中间态误导。
5. As a Claude Code 用户，当 agent 新建文件（Write 到不存在的路径）时，我希望行数显示为 `+N −0` 而不额外标注「新建」，以便与现有 OpenCode 卡片风格一致。
6. As a Claude Code 用户，当某次 Write/Edit 工具执行失败时，我希望该次调用不计入 turn 产物，以便卡片只展示真正落盘的变更。
7. As a Claude Code 用户，当我中断正在运行的 turn 时，我希望仍看到该 turn 内**已成功完成**的文件变更汇总，以便知道 agent 已经改了什么。
8. As a Claude Code 用户，当一轮 turn 没有任何成功文件变更时，我希望不显示产物卡片，以便界面保持简洁。
9. As a Claude Code 用户，我希望产物卡片出现在该轮最终 assistant 回复之后（与 OpenCode 相同位置），以便语义上属于「这轮工作的结果」。
10. As a Claude Code 用户，我希望历史 Session 重新打开后，过去 turn 的产物卡片仍可从时间线还原，以便回顾旧对话。

### 汇总展示（Codex）

11. As a Codex 用户，我希望每轮 turn 结束后看到与 OpenCode 相同风格的产物汇总卡片，以便跨 Agent Kind 体验一致。
12. As a Codex 用户，我希望 Codex 通过 `apply_patch`（app-server `fileChange` item）修改的文件出现在汇总中，以便覆盖 Codex 的主要写文件路径。
13. As a Codex 用户，我希望汇总卡片中的 diff 来自 Codex 提供的完整 patch/diff 文本，而不是 turn 结束后临时读盘猜测，以便内容与 agent 实际执行的 patch 一致。
14. As a Codex 用户，当一轮内多次 apply_patch 触及同一文件时，我希望卡片只保留最新一次成功 patch 的统计，以便与 Claude 行为一致。
15. As a Codex 用户，当 apply_patch 失败或被拒绝时，我希望该次 patch 不计入产物，以便卡片可信。
16. As a Codex 用户，当我中断 Codex turn 时，我希望仍看到已成功 apply 的文件变更汇总，以便 partial 工作可见。
17. As a Codex 用户，我希望从 Codex 历史 JSONL 回放加载的 Session 中，apply_patch 工具输入里的 `*** Begin Patch` 文本也能被正确汇总，以便旧会话不丢产物卡片。

### OpenCode 与跨 Kind 一致性

18. As an OpenCode 用户，我希望继续看到 SDK 原生的 turn 级 `session_summary`，以便不被新逻辑破坏现有体验。
19. As a 多 Agent Kind 用户，我希望 Claude、Codex、OpenCode 的产物卡片视觉与交互一致，以便切换 Kind 时无需重新学习。
20. As a 多 Agent Kind 用户，我希望同一 Session 内不同 Kind 的 turn 各自独立汇总，以便不会串线。

### 工具覆盖范围（MVP）

21. As a 产品维护者，我希望 MVP 只监控 Claude 的 Write/Edit 与 Codex 的 apply_patch，以便首版范围可控、可测。
22. As a 产品维护者，我希望 MVP 不监控 MultiEdit、NotebookEdit、shell 内嵌 patch，以便避免首版解析复杂度爆炸。
23. As a 产品维护者，我希望 MVP 不汇总子 agent（Task/subagent/spawnAgent 子线程）内的文件变更，以便父 thread 卡片语义清晰。
24. As a 产品维护者，我希望 Bash/shell_command 即使包含 patch 文本也不计入 turn 产物，以便与用户确认的「忽略终端改文件」策略一致。

### 数据与持久化

25. As a 用户，我希望 turn 产物 summary 进入 CodeMUX Event 时间线并被持久化，以便刷新页面后仍可见。
26. As a 用户，我希望 summary 事件在 turn 边界（`turn_finished`）发出，以便与 OpenCode 的挂载时机一致。
27. As a 系统维护者，我希望 summary 的 diff 条目至少包含 `file`、`additions`、`deletions`，以及 `patch` 或 `before`/`after` 之一，以便现有 diff 打开逻辑可直接复用。
28. As a 系统维护者，我希望 OpenCode 原生 summary 与 Aggregator 不会在同一 turn 重复 emit，以便前端 coalesce 逻辑不被双倍卡片干扰。

### Claude before 内容

29. As a Claude Code 用户，我希望 Edit 类工具的 diff 尽可能准确反映修改前内容，以便 side panel diff 可信。
30. As a 系统维护者，我希望 Aggregator 优先消费 sidecar 已有的 `file_snapshot`（PreToolUse）作为 before 来源，以便与现有 Claude 快照链路对齐。
31. As a 系统维护者，当缺少 snapshot 时，我希望 Write 将 before 视为空、Edit 在无法还原 before 时仍记录 after 与行数（可能降级），以便不因边缘时序完全丢失条目。

### 非目标交互（首版明确不做）

32. As a 用户，我理解首版产物卡片是**只读汇总**，不提供撤销/保存全部等操作（那是 `changedFiles` 面板范畴），以便 MVP 聚焦展示。
33. As a 用户，我理解首版不改动 AgentPanel 顶部的「改动列表」按钮与 `changedFiles` store 行为，以便避免并行两套 UX 冲突。

### Mobile Companion

34. As a Mobile Companion 用户，我希望若桌面 Session 时间线已含 `session_summary` 事件，移动端聊天布局也能渲染等价的汇总行，以便离开桌面仍可扫一眼本轮改了什么（复用现有 mobile session summary 组件路径即可，无新交互要求）。

### 可观测性与失败

35. As a 系统维护者，我希望 Aggregator 解析 patch 失败时跳过该文件条目而不是让整个 turn summary 失败，以便 partial 展示优于完全缺失。
36. As a 系统维护者，我希望 Aggregator 不阻塞 turn 完成或 tool 执行，以便汇总逻辑纯增量、可失败静默。

### 实时对话 vs 刷新重载

37. As a 用户，我希望 agent 正在跑 turn 时，turn 结束后产物卡片**立刻**出现在聊天里，而不需要手动刷新页面。
38. As a 用户，我希望刷新页面或重新打开 Session 后，历史每一轮的产物卡片仍完整显示，与实时对话时一致。
39. As a 用户，我希望在 turn 进行中（尚未 `turn_finished`）页面上不出现半成品产物卡片，以便只在 turn 边界展示汇总。
40. As a 用户，当我中断 turn 后刷新页面，仍能看到该轮 partial 产物卡片，以便 reload 不丢已落盘变更。
41. As a 系统维护者，我希望 `session_summary` 写入 CodeMUX Timeline DB，以便 `loadSessionEvents` 重载时优先从 DB 还原，而不是每次从 tool 事件重算。
42. As a 系统维护者，当 Timeline DB 为空、需要从 Claude/Codex 原生 JSONL 首次 hydrate 时，我希望 hydrate 管线在写入 DB 前**合成** turn 级 `session_summary`，以便旧 Session / 未持久化 Session 刷新后也有卡片。
43. As a 系统维护者，我希望实时流 append 与 `loadSessionMessages` 重载走**同一套** `parseAgentEvent` → `convertAgentEvents` 挂载规则，以便不出现「live 有卡片、reload 没卡片」的分叉。
44. As a 用户，我希望 Session 仍在运行时触发 history reload（例如 resync / 并发 hydrate）不会把已收到的 live `session_summary` 冲掉，以便 merge 策略与现有 compact 事件一致可靠。
45. As a Mobile Companion 用户，我希望 Companion 拉取的 Session 时间线若含 `session_summary`，移动端与桌面 reload 行为一致。

## Implementation Decisions

### 双路径架构：实时对话 vs 刷新重载

产物汇总必须同时在**两条管道**生效；缺任意一条都会导致「跑的时候有 / 刷新没了」或反过来。

```
┌─────────────────────────────────────────────────────────────────┐
│ 路径 A：实时对话（Live Turn）                                      │
├─────────────────────────────────────────────────────────────────┤
│ Sidecar Aggregator                                              │
│   → emit system_event/session_summary（turn_finished 前/同批）     │
│   → stdout → Rust session_lifecycle                             │
│   → timeline_persist 写入 DB                                     │
│   → IPC/Tauri → agentStore.parseAgentEvent                      │
│   → events[] append                                             │
│   → convertAgentEvents.attachSessionSummaries…                  │
│   → SessionSummaryCard 渲染                                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ 路径 B：刷新 / 重载（Reload Session）                              │
├─────────────────────────────────────────────────────────────────┤
│ loadSessionMessages(sessionId)                                  │
│   → loadSessionEvents（优先 Timeline DB）                        │
│   │     若 DB 已有 session_summary → 直接 parse + 挂载（主路径）   │
│   └─ 若 DB 空 → native JSONL hydrate                           │
│         → normalize_history_events / codex_history 转换           │
│         → **Timeline Artifact Synthesizer** 按 turn 合成 summary  │
│         → replace_session_timeline 写入 DB                       │
│   → parseAgentEvent / mapPersistedClaudeMessage                 │
│   → convertAgentEvents（与 live 相同挂载规则）                     │
│   → SessionSummaryCard 渲染                                      │
└─────────────────────────────────────────────────────────────────┘
```

**关键原则**

1. **汇总算法只写一次（可测纯函数）**，sidecar Aggregator 与 history synthesizer **共用同一套规则**（同文件 latest wins、只统计成功工具、MVP 工具白名单等）。避免 live 用 sidecar 算、reload 用另一套前端/Rust 逻辑。
2. **Timeline DB 是 reload 的权威来源**：live 产生的 `session_summary` 必须被 `timeline_persist` 持久化（OpenCode 已有先例）。
3. **Native hydrate 是 reload 的兜底**：从 Claude/Codex JSONL 首次灌入、或旧 Session 无 summary 行时，在 Rust hydrate 管线末尾合成 summary 再落库。
4. **前端不做二次汇总**：store 只 parse/存储事件；`convertAgentEvents` 只负责把已有 `session_summary` 事件挂到正确 assistant 消息——但挂载条件**必须修改**（见下）。

### 测试接缝（Seam）

**主接缝：可测试的 Turn Artifact Summary 纯函数 + 两个薄集成层。**

| 层级 | 职责 |
|------|------|
| **Turn Artifact Summary（纯函数/模块）** | 输入单 turn 事件切片 → 输出 `diffs[]` 或 null；集中实现 Write/Edit/apply_patch 解析与同文件覆盖规则 |
| **Sidecar Aggregator（Live 集成）** | 喂 live 事件 → turn 边界调用纯函数 → emit `system_event/session_summary` |
| **Timeline Artifact Synthesizer（Reload 集成）** | hydrate/normalize 后按 turn 切片 → 调用与 sidecar **同算法**（TS 实现为源，Rust hydrate 侧 port 或共享 fixture 对齐）→ 插入 summary 行再 persist |
| **Frontend attach（展示集成）** | 不改汇总算法；扩展 `convertAgentEvents` 使 `completed` **与** `interrupted` turn 均挂载卡片 |

不在 `agentStore` 里维护 parallel `changedFiles` 式汇总；但 **`loadSessionMessages`、`parseAgentEvent`、`convertAgentEvents` 必须改**。

### 实时对话路径（路径 A）必须修改的模块

1. **Sidecar Turn Artifact Aggregator**（Claude + Codex runtime 挂接；OpenCode 不挂接）。
2. **Codex app-server item 适配**：保留 `fileChange.changes[].diff`，否则 live Codex 无 patch 文本。
3. **事件顺序**：`session_summary` 必须在同一 turn 的 `turn_finished` **之前** emit（与 OpenCode 一致），并进入 `TurnEventNormalizer` sequence，以便 `attachSessionSummariesToFinalAssistants` 按 turn 分组。
4. **Rust timeline_persist**：确认 `session_summary` 已在 persist 白名单（OpenCode 已有测试）；Claude/Codex aggregator emit 的同形事件一并持久化。
5. **agentStore 实时 append**：现有 `parseAgentEvent` 对 `system_event` + `toLegacySystemMessage` 已映射 `session_summary`；实现后需补 live 集成测试，确认新事件进入 `events[sessionId]` 后 UI 刷新。
6. **convertAgentEvents 挂载条件（必须改）**：当前 `attachSessionSummariesToFinalAssistants` **仅在** `turn.status === 'completed'` 时挂卡片；用户要求 interrupted turn 也要 partial summary，因此需扩展为 `completed` **或** `interrupted`（有 `footerAnchorEventIndex` 且 summary.diffs 非空）。`failed` turn 若 Aggregator 仍 emit partial summary，同样挂载；无 summary 事件则不渲染。

### 刷新重载路径（路径 B）必须修改的模块

1. **loadSessionEvents / loadSessionMessages（主路径）**：Timeline DB 命中时，返回的 `system_event/session_summary` 经 `parseAgentEvent` → `kind: session_summary` → `convertAgentEvents` 挂载。需补 **reload 集成测试**：mock `loadSessionEvents` 返回含 summary 的时间线，断言 assistant-ui message part 出现 `SessionSummaryCard` 数据。
2. **agentEventParsing 持久化格式**：DB/legacy 行可能是 `type: system_event, subtype: session_summary`（CodeMUX 域事件）或 `type: system, subtype: session_summary`（旧映射）；两种 parse 路径都要测，避免 reload 后 summary 变 `raw` 丢弃。
3. **Native JSONL hydrate 兜底（Rust）**：当 `load_session_events` 走 `load_native_session_events` → `normalize_history_events` / `codex_history` 且 timeline 无 summary 时，在 **replace_session_timeline 之前** 按 turn 边界（`turn_finished` / user message 切分）运行 Timeline Artifact Synthesizer，为每个含成功 mutation 的 turn 插入 synthetic `session_summary` 行。Prior art：OpenCode history 模块已有 `pending_session_summary` + flush 模式可参考。
4. **resyncSessionFromNative**：resync 后 `loadSessionMessages({ force: true })` 须走同一 synthesizer，避免 CLI 重灌后丢卡片。
5. **Live / reload merge**：`loadSessionMessages` 中 `shouldKeepLiveEventsOnHistoryLoad` / `shouldPreferLocalEventsOnHistoryLoad` 行为须验证：running session reload 不丢已 append 的 summary；实现后加回归测试。
6. **Mobile / Companion**：若 Companion 读 Timeline DB，summary 行随 DB 即可；无需单独算法，但需确认 event 形状与桌面 parse 一致。

### 事件协议

### 事件协议

Summary 事件沿用 OpenCode 已有信封：

```typescript
{
  type: 'system_event',
  subtype: 'session_summary',
  diffs: Array<{
    file: string;
    patch?: string;
    before?: string;
    after?: string;
    additions?: number;
    deletions?: number;
    status?: string;
  }>,
  session_id: string;
  // 现有 sequence / event_id / provider_turn_id 等元数据由 normalizer 填充
}
```

前端 `codeMuxProtocol` → `agentEventParsing` → `convertAgentEvents.attachSessionSummariesToFinalAssistants` 路径已存在；**须扩展挂载条件**（interrupted turn）并补 live/reload 测试。**`SessionSummaryCard` 组件本身不改。**

### Aggregator 状态机（per active turn）

```typescript
type TurnArtifactState = {
  files: Map<string, SessionSummaryDiff>; // key = normalized absolute path
  snapshots: Map<string, { content: string; isNew: boolean; toolUseId?: string }>;
  pendingTools: Map<string, PendingMutation>; // toolUseId → parsed intent, awaiting finish
};

// On tool_started (mutation tool, not error path):
//   parse intent, stash in pendingTools
//   optionally bind file_snapshot by tool_use_id

// On file_snapshot:
//   merge into snapshots (first snapshot wins for original, matching existing store semantics)

// On tool_finished (success only):
//   compute SessionSummaryDiff entry
//   files.set(path, entry)  // latest wins per path

// On turn_finished (completed | interrupted | failed-with-partial):
//   if files non-empty → emit session_summary
//   reset turn state
```

**同文件最新 wins**：直接在 `files.set` 覆盖，与 OpenCode `coalesceSessionSummaries` 语义一致。

**只统计成功工具**：仅在 `tool_finished` 且 `is_error === false` 时 commit；`tool_started` 只建立 pending，不写入 `files`。

**中断 turn**：`turn_finished.outcome === 'interrupted'` 仍 emit 当前 `files` 快照（可能为空则 silent skip）。

### 工具识别（MVP 白名单）

| Agent Kind | 监控工具名（大小写归一化后） | 解析来源 |
|------------|------------------------------|----------|
| Claude Code | `write`, `edit` | `tool_started.input`：file_path/filePath + content 或 old_string/new_string |
| Codex | `apply_patch` | 实时：`fileChange.changes[].{path, kind, diff}`；历史回放：`tool_started.input.input` 的 `*** Begin Patch` 文本 |

**明确排除**：`multiedit`, `notebookedit`, `bash`, `shell_command`, MCP 写文件工具, 子 agent 线程内工具（首版 runtime 作用域仅主 thread normalizer）。

### Claude Write/Edit 解析

- **Write**：`before` 来自 `file_snapshot` 或空（新文件）；`after` 来自 input.content；行数用现有 line diff 工具函数（与 store 中 `countDiffLines` 同语义）。
- **Edit**：在 `before`（snapshot）上应用 old→new 替换得 `after`；若 snapshot 缺失，仍记录 path 与 best-effort 行数，但 `before`/`after` 可能不完整——不阻塞 emit。
- **file_snapshot 来源**：继续依赖 Claude SDK `PreToolUse` hook 已 emit 的事件；Aggregator 订阅 wire 上的 `file_snapshot`，不在 Aggregator 内重复读盘（除非后续 PR 扩展）。

### Codex apply_patch 解析

**协议事实（已调研）**：Codex app-server 的 `fileChange.changes[]` 含 `{ path, kind, diff }`，其中 `diff` 对 Update 为 unified diff，对 Add/Delete 为完整内容。另有 `item/fileChange/patchUpdated` 与 `turn/diff/updated` 可提供更完整 turn 级 diff。

**当前缺口**：sidecar 在 app-server item 适配时**丢弃了 `diff` 字段**，只保留 `kind`+`path`。实现时必须修复适配层，使 Aggregator 在 **`tool_finished`（item/completed）** 时拿到完整 diff。

**解析策略**：

1. **实时 app-server 路径**：以 `tool_finished` 为准（不用 `tool_started` 的部分 patch），从 completed item 的 `changes[].diff` 构建 summary entry。
2. **历史 JSONL 路径**：从 `tool_started.input.input` 解析 Codex freeform patch（`*** Begin Patch` … `*** End Patch`），在 successful `tool_finished` 时 commit。
3. **diff 形态映射**：
   - 若有 unified patch 文本 → 填 `patch`，并用现有 `parseUnifiedDiffPatch` 兼容逻辑统计 additions/deletions。
   - 若仅有 before/after 字符串 → 填 `before`/`after`。
4. **不依赖 turn 结束后读盘**作为 MVP 主路径（用户已确认 patch 文本应由协议提供）。

### OpenCode 隔离

- OpenCode runtime 继续由 `opencodeEvents` 从 SDK `message.updated` / `session.diff` 等 emit 原生 `session_summary`。
- Aggregator **不注册**到 OpenCode normalizer。
- 若未来双 emit，前端 `coalesceSessionSummaries` 按 file 取最新可兜底，但首版应避免。

### Runtime 挂接方式

- **Claude**：在 SessionRuntime turn 循环中，与 `TurnEventNormalizer.accept` 并行 feed Aggregator；turn settle 时 `aggregator.flush()` emit summary。
- **Codex**：在 CodexAppServerRuntime 的 `handleItemStarted/Completed` 与 turn completed/interrupted 路径同样 feed + flush。
- **不新增 Rust hook 框架**；Rust 仍只做 sidecar stdout 转发与 timeline 持久化。

### 与 `changedFiles` store 的关系

- 首版 **不修改** `extractChangedFilesFromEvents` 与 `changedFiles` 更新逻辑。
- 产物展示以 `session_summary` 卡片为唯一新增 UX。
- 后续可选 PR：让 `changedFiles` 从 summary 衍生或废弃 store 路径——**本 spec 范围外**。

### 路径归一化

- Aggregator 内部 key 使用工作区绝对路径（与各 runtime `cwd` 拼接相对路径），与现有 `normalizeFilePath` 语义对齐。
- Summary `diffs[].file` _emit 绝对路径或与会话 working path 一致的形式，以便 `openDiffTab` 与 OpenCode 卡片行为一致。

## Testing Decisions

### 什么算好测试

- **只测外部行为**：给定一组 wire 级输入事件，断言 Aggregator 在 turn 边界 emit 的 `session_summary.diffs` 形状与内容；不断言内部 Map 实现细节。
- **不测 UI 像素**；UI 已有 `SessionSummaryCard` 与 `convertAgentEvents` 测试，只需一条集成式 smoke（可选）确认 Claude/Codex summary 事件能变成 message part。
- **fixture 驱动**：使用确定性事件序列，不依赖真实 sidecar 进程或磁盘（读盘仅在 Claude snapshot 单元测试中用内存 snapshot 事件替代）。

### 测试模块与 prior art

| 模块 | 测试类型 | Prior art |
|------|----------|-----------|
| Turn Artifact Summary 纯函数 | sidecar 单元测试（主战场） | `opencodeEvents.test.ts` 的 `session_summary` 断言；`agentStore.test.ts` 的 `extractChangedFilesFromEvents` 用例（Write/Edit 语义参考） |
| Sidecar Aggregator（Live 集成） | sidecar 单元/集成测试 | 各 runtime test harness 喂事件序列，断言 stdout 含 summary 且顺序在 `turn_finished` 前 |
| Timeline Artifact Synthesizer（Reload 集成） | Rust 单元测试 | `opencode_history.rs` 的 `pending_session_summary` / flush；`codex_history_golden.json` fixture |
| Codex item 适配（保留 diff） | sidecar 单元测试 | `runtimeEvents.ts` adapt 测试；`codex_history.rs` apply_patch fixture |
| 前端 parse（reload） | `agentEventParsing.test.ts` 扩展 | 已有 OpenCode `session_summary` parse 用例 |
| 前端 attach（live + reload） | `convertAgentEvents.test.ts` 扩展 | 已有 `session_summary` part 渲染；**新增 interrupted turn 挂载** |
| 前端 loadSessionMessages | `agentStore.test.ts` 扩展 | 已有 `loadSessionEvents` reopen 用例；**新增含 summary 时间线 reload** |
| timeline_persist | Rust 单元测试 | 已有 `persists_session_summary_system_events` |

### 必覆盖场景

**Aggregator / 纯函数（sidecar）**

1. Claude：单 Write 新文件 → summary 一条，`+N −0`。
2. Claude：单 Edit 有 snapshot → 正确 before/after 与行数。
3. Claude：同文件 Write 后再 Edit → 只保留 Edit 结果。
4. Claude：Edit 失败（tool_finished error）→ 不进入 summary。
5. Claude：turn interrupted，前面有成功 Write → partial summary 仍在。
6. Claude：turn 无成功 mutation → 不 emit summary。
7. Codex：fileChange completed，`changes[].diff` 为 unified patch → summary 含 patch 与行数。
8. Codex：同文件两次成功 apply_patch → 最新 wins。
9. Codex：apply_patch 失败 → 不进入 summary。
10. Codex：历史回放 `input.input` patch 文本 → 解析成功。
11. 混合 turn（Read + Write + Bash）→ 只有 Write 进 summary。
12. OpenCode fixture 事件流不经过 Aggregator → 无 double summary。

**Live 管道（前端 + persist）**

13. Live：`parseAgentEvent` 收到 `system_event/session_summary` → `kind: session_summary`。
14. Live：事件 append 后 `convertAgentEvents` 在 **completed** turn 最终 assistant 下挂卡片。
15. Live：事件 append 后 `convertAgentEvents` 在 **interrupted** turn 最终 assistant 下挂 partial 卡片（**当前缺失，必须新增**）。
16. Live：`session_summary` 在 `turn_finished` 之前进入 events 序列。

**Reload 管道**

17. Reload：`loadSessionEvents` 返回含 `session_summary` 的 DB 时间线 → reload 后卡片与 live 一致。
18. Reload：DB 行为 `type: system, subtype: session_summary` legacy 格式 → 仍能 parse 并挂载。
19. Reload：Timeline 空，从 Codex golden JSONL hydrate → synthesizer 插入 summary → reload 后有卡片。
20. Reload：Timeline 空，从 Claude tool 事件 hydrate → synthesizer 插入 summary → reload 后有卡片。
21. Reload：running session + history load merge → 不丢失 live 已收到的 summary。
22. Reload：`resyncSessionFromNative` 后 summary 仍存在。

## Out of Scope

- MultiEdit、NotebookEdit、Notebook 专用路径。
- Bash / shell_command 内嵌 `*** Begin Patch` 解析。
- 子 agent / subagent / Task 子线程内的文件变更汇总到父 turn。
- OpenCode Aggregator 统一化或替换原生 SDK summary。
- `changedFiles` store、AgentPanel「改动列表」面板、单文件撤销/全部保存。
- `turn/diff/updated` 作为 Codex 主数据源（可作为后续增强，MVP 以 per-tool fileChange diff 为准）。
- PostToolUse hook 新增、Rust 层 hook 框架。
- 新 UI 组件或卡片样式改版。
- 产物卡片的 acknowledged/dismiss 交互。
- Mobile 端新增编辑能力（仅继承时间线渲染）。
- **在 agentStore 实时路径做 parallel 汇总**（应用 sidecar emit + DB；reload 用 synthesizer，不在 store 里再算一遍）。

## Further Notes

### 与既有设计文档的关系

- `docs/specs/2026-06-07-changed-files-panel.md` 描述的是 **session 级改动列表面板** + `changedFiles` store，与本 spec 的 **turn 级只读汇总卡片** 互补而非替代。首版故意不合并，避免 scope 膨胀。

### Codex 调研结论（写入 spec 供 implementer 参考）

Codex app-server 协议中 `fileChange.changes[]` **确实包含完整 `diff` 文本**；CodeMUX sidecar 当前适配层丢失该字段，这是 Codex 产物汇总的前置修复项，不是协议能力缺失。

历史 Codex JSONL 回放路径中，apply_patch 的完整 patch 存在于 `tool_started.input.input`（见仓库 golden fixture）。

### 前端挂载时机（含已知缺口）

`convertAgentEvents.attachSessionSummariesToFinalAssistants` 将 pending `session_summary` coalesce 后挂到 `footerAnchorEventIndex` 对应的最终 assistant 消息。Aggregator / synthesizer 须保证 summary 落在同一 turn 的 event 序列内、`turn_finished` 之前。

**已知缺口（本 spec 必须修）**：当前挂载条件为 `turn.status === 'completed'` 才挂卡片；`interrupted` turn 即使用户已确认要 partial summary，reload/live 均**不会**显示卡片。实现须扩展为 `completed | interrupted`（有 summary diffs 时）。

### 实现交付清单（Checklist）

| # | 路径 | 交付物 |
|---|------|--------|
| 1 | Live | Sidecar Aggregator + Codex diff 字段保留 |
| 2 | Live | summary persist 进 Timeline DB |
| 3 | Live | `parseAgentEvent` 确认无回归 |
| 4 | Live + Reload | `convertAgentEvents` 支持 interrupted turn 挂载 |
| 5 | Reload | `loadSessionEvents` DB 路径 reload 测试 |
| 6 | Reload | Rust Timeline Artifact Synthesizer（native hydrate 兜底） |
| 7 | Reload | `resyncSessionFromNative` + live/reload merge 回归 |
| 8 | Both | 共享汇总纯函数 + 双端测试对齐 |

### 失败降级原则

单文件 patch 解析失败：跳过该文件，继续 emit 其它文件条目。整个 Aggregator 抛错不得导致 turn 无法 `turn_finished`。
