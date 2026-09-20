# Session Timeline 重构设计（Paseo 式简化）

## Status

accepted

## 背景

CodeMUX 当前会话历史存在三套互相拉扯的来源：

1. **实时路径**：sidecar → CodeMUX Event → `session_event_snapshots` 增量写入
2. **重载路径**：Rust native loader（Claude JSONL / Codex rollout / OpenCode DB）→ 若非空则 **覆盖** 快照
3. **切换路径**（ADR 0007）：`merge_history_events` 合并快照与 native

这导致：

- OpenCode 等会话重开后，UI 内容与实时对话时不一致
- `session_event_snapshots` 名义上是权威（ADR 0003/0008），实现上却被 native 覆盖
- ADR 0007 会话内 Agent Kind Switch 引入 briefing、双源合并、`runtime_switch` 接缝，复杂度高、体验有损

同期调研了 Paseo。Paseo **并非**「不存历史、每次读 provider 原生文件」，而是用 **daemon 侧 canonical timeline** 统一对外，native 仅作一次性 hydration 输入。

本设计借鉴 Paseo 的分层原则，在 CodeMUX 内收敛为：**去掉 Agent Switch，确立 Timeline 为唯一 UI 权威，native 仅负责 hydration 与 runtime resume。**

### 前置假设

**当前无存量会话数据需要迁移。** Phase 1 可直接删除 switch 相关代码与表结构，无需兼容 `runtime_switch` 历史事件或双源合并逻辑。

---

## 目标

1. **删除会话内 Agent Kind Switch**（撤销 ADR 0007；保留 Fork 等同种类分支）
2. **确立 canonical timeline 为 UI / 移动端 / 搜索的唯一历史来源**
3. **native loader 降级为 hydration 与显式刷新**，不再在每次打开会话时覆盖 timeline
4. **Companion API 对齐 Paseo 的 live vs authoritative 双路径**，并支持分页读取
5. **保留 ADR 0003 CodeMUX Event 作为 wire 格式**（不重写前端 `AgentMessage` 投影层）

## 非目标

- 不把 CodeMUX 重构成 Paseo 的 daemon + 多对等客户端架构（仍保持 Tauri 桌面权威 + Companion thin client）
- 不在本阶段物理删除 `session_event_snapshots` 表（先改语义与读写规则；表可后续重命名为 `session_timeline_events`）
- 不改变各 provider 的 runtime resume 机制（仍通过 `agent_session_mappings` 连 native session）
- 不实现 Paseo 的 selective subscription / epoch rewind（列为后续优化）

---

## 术语：`session_event_snapshots` 与 Timeline

这两个名字**不是两套存储**，而是**物理表名 vs 架构角色**：

| 名称 | 含义 |
|------|------|
| **`session_event_snapshots`** | SQLite 表名。每行一条 CodeMUX Event，`sequence` 单调递增。 |
| **Timeline** | 架构概念：一条 Session 的**权威事件时间线**。物理上就是这张表里的有序行集合。 |

类比：

- `session_event_snapshots` = 硬盘上的文件
- Timeline = 这个文件在系统里扮演的角色（UI / 移动端 / 搜索的唯一历史真相）

本设计**不新建第二套 Timeline 存储**。要做的是：

1. **读写规则**：所有消费者只认这张表；native 只在 timeline 为空时灌入一次
2. **命名收敛**（Phase 4 可选）：表重命名为 `session_timeline_events`，代码中 `snapshot` 逐步改为 `timeline`，减少「快照会被覆盖」的误导

```
改前（混乱）：
  session_event_snapshots = 有时权威、有时被 native 覆盖、有时还要 merge

改后（清晰）：
  Timeline（物理上仍是 session_event_snapshots）= 唯一权威
  native loader = hydration 输入 + runtime resume，不驱动 UI 重载
```

---

## Paseo 可借鉴的原则

| 原则 | Paseo 做法 | CodeMUX 现状 | 本设计目标 |
|------|-----------|-------------|-----------|
| Live ≠ 权威 | `agent_stream` 即时；`fetch_agent_timeline` 权威 | WS/实时与 `load_session_events` 可能不一致 | 明确分层，fetch 只读 timeline |
| Native 角色 | `streamHistory()` 一次性导入 → committed snapshot | 每次打开可能重解析 native 并覆盖 | hydration 一次性或显式刷新 |
| 客户端缓存 | Replica cache 仅展示尾段，非权威 | 前端 `agentStore.events` 内存态 | 移动端 IndexedDB 可选，标注非权威 |
| 分页 | `tail` / `after` / `before` + `hasNewer` | Companion 仅 `after=sequence` 增量 | 扩展 fetch 参数 |
| 跨 provider 同会话 | 不支持；换 provider = 新 agent | ADR 0007 支持有损切换 | **删除** |

---

## 目标架构

```
                    ┌─────────────────────────────────────┐
                    │      CodeMUX Timeline（权威）         │
                    │  物理存储：session_event_snapshots    │
                    │  seq 单调递增 · CodeMUX Event rows   │
                    └──────────────▲──────────────────────┘
                                   │
         实时 append ──────────────┤
    (sidecar → snapshot_persist) │
                                   │
         hydration 一次性写入 ─────┤
    (native loader → reconcile)  │
                                   │
    ┌──────────────────────────────┴──────────────────────────────┐
    │                                                              │
桌面 UI (Tauri)                                          移动端 Companion
fetch_timeline(tail/after/before)                        GET /sessions/:id/timeline
Tauri events / 内存态 (live)                             WS live + gap fetch
```

### 三层语义

1. **Canonical Timeline（权威）** — `session_event_snapshots` 中的 CodeMUX Event 序列；UI、搜索、Companion fetch 的唯一来源
2. **Live Stream（即时）** — sidecar 实时事件；进入 timeline 前展开为单条 Event；断线后必须以 timeline fetch 补齐 gap
3. **Native Provider Store（执行 + 导入）** — Claude JSONL、Codex rollout、OpenCode DB；仅用于 runtime resume 与 **timeline hydration**，不直接驱动 UI 重载

---

## Phase 1 — 删除 Agent Kind Switch

### 产品行为

- 创建 Session 时选定 `agent_kind`，**生命周期内不可更改**
- 换 agent：**新建 Session**，或使用 **Fork**（同种类拷贝 native 历史）
- 导入会话（`origin: imported`）保持只读，逻辑不变

### 代码删除清单

| 区域 | 删除 |
|------|------|
| Rust | `src-tauri/src/agent/switch_briefing.rs`（整模块） |
| Rust | `commands/session.rs::switch_session_agent_kind` |
| Rust | `history_import.rs` 中 `session_has_runtime_switch` 分支与 `merge_history_events` |
| Rust | `companion/actions.rs` 中 `update.agent_kind != current.agent_kind` 切换逻辑 |
| Rust | `session_lifecycle.rs` 中 `take_pending_switch_briefing` / `apply_switch_briefing` |
| DB | `session_runtime_switches` 表 |
| DB | `sessions.pending_switch_briefing` 列 |
| DB | `session_kind_model_selection`（若确认仅服务 switch；实施前 grep 确认无其他用途） |
| 前端 | `AgentPanel` 运行中会话的 Agent 切换确认 Dialog |
| 前端 | `sessionStore.switchSessionAgentKind`、`tauri.ts` 中 `switchAgentKind` |
| 前端 | `RuntimeSwitchSeam` 及相关 `runtime_switch` 解析/展示（无存量数据，可整段删除） |
| 移动端 | companion settings 中修改 `agent_kind` 的分支 |
| 文档 | ADR 0007 标记 superseded |

### 收口行为

- 运行中会话的 `AgentSelector` **只读展示**当前 kind，或从会话面板移除改 kind 入口
- `AgentSelector` 继续用于 **新建草稿**（`NewSessionPanel`）

### 任务清单

- [x] 移除 switch 命令、UI、companion 改 kind 分支
- [x] 删除 `switch_briefing` 模块及所有引用
- [x] 删除 DB 表/列（无迁移脚本）
- [x] ADR 0007 superseded 说明
- [x] 测试：创建会话、Fork、导入、Companion 发消息回归

**风险**：低。无存量会话，边界清晰。

---

## Phase 2 — Timeline 权威化

### 读写规则（核心变更）

**写入**

| 场景 | 行为 |
|------|------|
| 实时对话 | sidecar 域事件 → `append_snapshot_events`（`snapshot_persist.rs`，不变） |
| 首次打开 native 会话 | timeline 为空且存在 mapping → native loader → reconcile → `replace_session_snapshot` **一次** |
| 显式「从 provider 刷新」 | 诊断/设置入口 → native loader → reconcile → replace（**非默认**） |
| 导入会话 | `import_session_snapshot` 直接写入 timeline（不变） |

**读取**

| 场景 | 行为 |
|------|------|
| 桌面 `loadSessionMessages` | **只读 timeline** |
| Companion | 读 timeline（Phase 3 升级为分页 API） |
| 聊天搜索 | 读 timeline（SQLite） |
| WS 连接初始 replay | timeline **尾段**（Phase 3），非全量、非 native |

**删除的逻辑**

```rust
// history_import.rs — 删除
if !native_events.is_empty() {
    replace_session_snapshot(..., &native_events);
    return Ok(native_events);
}
```

**替换为**

```rust
// 伪代码
if timeline.is_empty() && session.origin == "native" {
    if let Ok(native) = load_native_events(...).await {
        let hydrated = reconcile_native_to_timeline(native);
        replace_session_snapshot(..., &hydrated);
        return Ok(hydrated);
    }
}
return Ok(timeline.unwrap_or_default());
```

### Hydration 与 Reconcile

- **输入**：`load_claude/codex/opencode_session_events` + `normalize_history_events`
- **输出**：与实时 sidecar 路径等价的 CodeMUX Event 序列（ADR 0003）
- **一致性测试**：同一 fixture 经 sidecar adapter 与 history loader 产生等价 timeline（`event_id` 可不同，`sequence` 单调即可）
- **可选列** `timeline_hydrated_at` / `timeline_history_complete`：标记已完成首次 hydration，避免重复全量导入

### 与 native resume 的关系

| Concern | 权威 |
|---------|------|
| 屏幕上显示什么 | Timeline |
| 模型下次请求带什么上下文 | Native session（mapping + sidecar resume） |
| 两者不一致时 | 执行以 native 为准；后续可提供「从 provider 同步到 timeline」修复入口 |

**UI 连续 ≠ 模型上下文连续**（Fork、Rewind、Compaction 已存在类似缝隙）。删除 Agent Switch 后，此类缝隙仅来自单 provider 自身行为。

### 任务清单

- [x] 重写 `load_session_events`：只读 timeline + 空时 hydration
- [x] 删除 native 覆盖 timeline 逻辑
- [x] 加强 sidecar vs history loader 等价性测试（重点 OpenCode）
- [x] 桌面重开会话回归：消息与实时对话时一致

**风险**：中。需 Claude / Codex / OpenCode 三条历史路径回归。

---

## Phase 3 — Companion 分页 API

### 为什么需要分页 API

移动端通过 Companion 读历史，当前有两种方式：

```
GET /sessions/{id}/events?after=-1   → 全量拉取（且可能走 native loader，有问题）
GET /sessions/{id}/events?after=N    → 从 sequence N 之后增量拉取
WS /ws?session_id=...                → 连接时 replay 全量 timeline + 订阅 live
```

问题在于：

1. **打开慢**：长会话全量传输，手机端内存和网络压力大
2. **重连脆**：WS 丢了几条事件时，只有 `after=N` 增量，没有「先拉尾部再按需往前翻」的标准语义
3. **职责混**：全量路径仍可能绕到 native loader，与 timeline 权威模型冲突

分页 API 借鉴 Paseo 的 **`fetch_agent_timeline`**，把「怎么读 timeline」标准化。

### 设计原则：Live ≠ 权威

| 路径 | 职责 | 特点 |
|------|------|------|
| **WebSocket `agent_stream` 等价物** | 即时推送 live 事件 | 快；可能丢包；带 `sequence` |
| **HTTP timeline fetch** | 权威历史 | 慢但正确；支持分页；只读 SQLite timeline |

客户端 invariant（对齐 Paseo `timeline-sync.md`）：

> 持续订阅时按 sequence 顺序应用每条 committed event。打开或恢复会话时，用**一次有界的 tail 请求**建立当前尾部；更早历史通过 `before` 分页按需加载。检测到 sequence gap 时，用 `after` 分页追到 `hasNewer=false`。

### API 规格

```
GET /sessions/{id}/timeline
  ?direction=tail|after|before   （默认 tail）
  &cursor=<sequence>             （分页游标；tail 时可省略）
  &limit=<n>                     （默认 200，按 Event 条数计）

Response:
{
  "events": [...],           // CodeMUX Event[]
  "seqStart": 0,
  "seqEnd": 199,
  "hasOlder": true,
  "hasNewer": false,
  "historyComplete": true
}
```

| `direction` | 行为 |
|-------------|------|
| `tail` | 返回最近 `limit` 条（打开会话默认） |
| `after` | 从 `cursor` 之后向前取（断线 gap 补齐） |
| `before` | 从 `cursor` 之前向后取（用户上滑加载更早历史） |

### 好处

| 好处 | 说明 |
|------|------|
| **秒开会话** | 默认只拉尾部 200 条，不必一次灌完整历史 |
| **断线重连可靠** | 发现 seq 42→50 缺口 → `after=42` 分页直到 `hasNewer=false` |
| **省流量与内存** | 手机按需加载；老消息上滑再 `before` |
| **与 Timeline 权威模型配套** | fetch 只读 SQLite；native 不再参与 Companion 读路径 |
| **WS 轻量化** | 连接时只 replay tail 页，不全量推送 |

### 兼容与 WS 变更

- **保留** `GET /sessions/{id}/events` 作为别名（deprecated），内部转调 timeline fetch
- **WS 连接**：
  - 初始只 replay tail 页（如 200 条）
  - Live 事件带 `sequence`
  - 客户端 gap recovery → `direction=after` 循环直到 `hasNewer=false`

### 移动端客户端（`src-mobile/`）

- 冷启动：IndexedDB 缓存最近 tail（**display-only**，带 `cacheVersion`）
- 连上后：`fetch timeline tail` 与本地 `seqEnd` 对账
- 上滑：`direction=before`
- 删除 agent switch settings 相关逻辑

### 任务清单（移动端补充）

- [x] IndexedDB tail 冷启动缓存（`cacheVersion` + 与 tail 对账）
- [x] 上滑 `direction=before` 加载更早历史

### 任务清单

- [x] 新增 `fetch_session_timeline` Rust 命令 + Companion HTTP handler
- [x] WS 连接改为 tail replay
- [x] `src-mobile` gap recovery 分页循环
- [x] 兼容旧 `?after=` 参数

**风险**：中。移动端断连重连需手测。

---

## Phase 4 — 清理与命名收敛

无存量数据，可直接删表删列，无需迁移脚本。

```sql
DROP TABLE IF EXISTS session_runtime_switches;
ALTER TABLE sessions DROP COLUMN pending_switch_briefing;
-- 可选
ALTER TABLE sessions ADD COLUMN timeline_hydrated_at TEXT;
ALTER TABLE sessions ADD COLUMN timeline_history_complete INTEGER NOT NULL DEFAULT 0;
-- 可选重命名（需同步改 operations.rs / schema.rs）
-- ALTER TABLE session_event_snapshots RENAME TO session_timeline_events;
```

- [x] 删废弃表/列
- [x] 代码中 `snapshot` → `timeline` 命名收敛（`timeline_persist`、DB 操作函数；物理表名 `session_event_snapshots` 保留）
- [x] 更新 ADR 0003 / ADR 0008；ADR 0007 标 superseded

**风险**：低。

---

## 保留项

| 组件 | 原因 |
|------|------|
| `session_event_snapshots` 表 | Timeline 物理存储 |
| `timeline_persist.rs` | 实时 append 管道 |
| ADR 0003 Event 类型与 sidecar adapter | wire 格式统一 |
| `agent_session_mappings` | runtime resume |
| Native history loaders | hydration 输入 |
| `history_import` 发现/导入 | imported 会话无 native |
| Fork（同种类） | 与 switch 无关 |
| `load_agent_latest_token_usage` | 上下文统计独立链路 |

---

## 测试计划

### 单元 / 集成

- `load_session_events`：空 timeline + 有 mapping → hydration 一次；非空 → 不触发 native
- `snapshot_persist` append 后 fetch 一致
- timeline 分页：`tail` / `after` / `before` 边界与 `hasOlder` / `hasNewer`
- OpenCode / Claude / Codex：实时 vs hydration 等价性

### 端到端

- 桌面：对话 → 切走 → 重开 → 消息一致
- 移动端：配对 → tail 打开 → 上滑 `before` → 断网重连 → gap 补齐
- Fork、导入、只读会话不受影响
- 运行中会话不可改 `agent_kind`

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Hydration 与实时路径不一致 | 等价性测试门禁；OpenCode 优先修 |
| 搜索性能（大会话） | 暂用 SQLite 全表扫；后续可加索引 |
| 移动端 tail 与 live 短暂不一致 | gap fetch 追到 `hasNewer=false`；以 fetch 为准 |

---

## 与 Paseo 的差异（刻意保留）

| 维度 | Paseo | CodeMUX |
|------|-------|---------|
| 进程模型 | 独立 daemon | Tauri + sidecar |
| 客户端 | 多对等 | 桌面权威 + mobile companion |
| Timeline 存储 | JSON 文件 per agent | SQLite per session |
| Item 模型 | Projected timeline items | CodeMUX Event → `AgentMessage` |
| Epoch / rewind | 有 | 本阶段不做 |

---

## 决策记录

1. **撤销 ADR 0007** 会话内 Agent Kind Switch；一个 Session 绑定一个 `agent_kind`。
2. **Timeline**（物理表 `session_event_snapshots`）为 UI / 移动端 / 搜索的唯一权威历史；native loader 不再默认覆盖。
3. **Native loader** 职责收窄为 hydration、显式刷新、runtime resume。
4. **Companion 分页 fetch + live WS 双路径**，对齐 Paseo 的 authoritative vs immediacy 分离。
5. **无存量会话**：switch 相关代码与表结构直接删除，不做迁移兼容。

---

## 参考

- CodeMUX ADR 0003 — CodeMUX Event 协议
- CodeMUX ADR 0007 — Agent Kind Switch（superseded by 本文）
- CodeMUX ADR 0008 — Mobile Companion
- Paseo `docs/timeline-sync.md`
- Paseo `packages/server/src/server/agent/file-agent-timeline-store.ts`
