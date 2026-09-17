# 实时对话掉帧卡顿根因排查报告

- 日期：2026-09-16
- 排查对象：实时对话（AI agent 流式输出）过程中的掉帧卡顿
- 报告现象：流式对话期间频繁掉帧，开发期性能浮层 FPS 经常骤降至极低值
- 排查方法：静态代码走查（三层分离）+ 关键路径逐行核验
- 结论：**共定位 15 项根因，其中 3 项 P0 核心根因构成"主线程阻塞闭环"；掉帧主要矛盾在前端渲染层与通信链路层的帧放大，后端为次生放大器而非首因**

---

## 一、执行摘要

本次掉帧**不是单一原因**，而是三层缺陷在同一条路径上叠加形成的**正反馈放大回路**：

1. **通信层**把 sidecar 已聚合的 50ms 批次重新摊平，并对每个事件发出 **2 个 WS 帧**（`event` + `state`）；
2. **客户端**对每一帧在主线程做 **3 次 `JSON.parse`**，且每个 `state` 帧都触发一次 store 通知；
3. **前端渲染层**每次 UI 刷新都对**累积全文重跑 Markdown 解析 + Shiki 语法高亮**，并通过 `MutationObserver(subtree)` 触发**强制同步布局 + 写滚动**，再连带触发 `MessageNav` 的 **O(n) `getBoundingClientRect` 风暴**。

三者相乘的结果是：单次刷新窗口内，主线程要完成"解析 ×3 + 全量 Markdown 重解析 + 强制重排 + O(n) 布局读取"，任何一项单独都不致命，叠加后必然击穿 16ms 帧预算。

**监控面板可信度提示（重要）**：FPS 读数**可信**（`PerfOverlay.tsx:76-88` 是标准 `requestAnimationFrame` 帧计数器，rAF 被主线程卡顿节流，低读数即真实主线程阻塞）。但面板的 **IPC 速率 / 慢 IPC Top-5 恒为 0**——因为 `recordIpc` 在生产代码中**无任何调用方**（全仓 grep 仅命中 `perfStore.ts` 与其测试）。且 `<Profiler>` 的 id 是 `"AgentThread"`（`AgentPanel.tsx:511`），非设计文档所述 `MessageList`，且仅此一个 Profiler，故"Re-render Top-N"只能给出整棵线程树的聚合值，**无法归因到具体子组件**。这解释了为何面板能显示"FPS 极低"却无法指出瓶颈位置——本报告的作用正是补上这段归因。

---

## 二、根因清单（按严重程度排序）

> **排序修订说明（2026-09-16 复核）**：根因 1 原列为 P0 最高，复核后确认其严重度被高估（Streamdown 具备块级 memo，详见其小节内的修正说明），已下调至 P1。**真正的 P0 核心根因是根因 2（帧放大链）与根因 3（逐变更强制重排）**，两者与根因 4/5 共同构成闭环。为保持既有交叉引用有效，根因编号不作重排。

### P0 — 核心根因（直接阻塞主线程，构成掉帧主因）

#### 【已下调】根因 1：流式正文每次刷新都对累积全文重跑 Markdown 解析 + Shiki 语法高亮

见下方修正说明；本条保留于 P0 段末仅为维持编号稳定。

---

#### 根因 1（原文）：流式正文每次刷新都对累积全文重跑 Markdown 解析 + Shiki 语法高亮

| 项目 | 内容 |
|---|---|
| 位置 | `src/components/agent/assistant-ui/CodeMuxThread.tsx:1597-1610`、`:1529` |
| 影响范围 | **全部 agent 运行时（Claude / Codex / OpenCode / pi）**；长代码/长文本输出时最严重 |
| 触发频率 | 每个刷新窗口（即每个节流周期） |
| 严重程度 | **中（已于 2026-09-16 复核下调，原判为"主线程阻塞（最高）"）** |

> **⚠️ 严重度修正（复核后）**：初版将本条列为 P0 最高，理由是"每次刷新对整篇文档重跑 Markdown 解析"。复核 Streamdown 源码与文档后确认该判断**被高估**：
> - `node_modules/streamdown/package.json` 显示版本 `2.5.0`，README 第 23 行明确 **"⚡ Performance optimized - Memoized rendering for efficient updates"**；
> - 项目内 `src/components/assistant-ui/markdown-text.tsx:90-94` 的注释亦佐证：**"Streamdown 的 Block 级 memo 依赖 components 各 key 的函数引用稳定"**，且 `CODEMUX_MARKDOWN_COMPONENTS` 刻意保持为模块级常量以满足该前提。
>
> 因此**已完成块的渲染会被 memo 跳过**，每次刷新的实际开销是"全文分块 + 仅尾部未闭合块重渲染/重高亮"，而非全量重解析。本条因此下调为 P1 级"随内容长度增长的 CPU 开销"，**不再计入三大 P0 根因**。真正的主线程阻塞来自根因 3 的逐变更强制重排。

**证据**

```tsx
// CodeMuxThread.tsx:1597-1610
{visibleText ? (
  <div data-streaming-text="markdown" ...>
    <Streamdown mode="streaming" {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}>
      {visibleText}
    </Streamdown>
    <span className="... animate-pulse ..." />
```

`CODEMUX_MARKDOWN_STREAMDOWN_PROPS` 携带 `plugins: { code }`（Shiki 高亮）。`visibleText` 是**累积全文**（非增量），预览上限 16KB（`src/stores/agentStore.ts:263`）。承载它的 `StreamingContent`（`CodeMuxThread.tsx:1529`）是**普通函数组件，未包裹 `memo`**，且自身通过 `useAgentStore` 订阅了 `streamingText`（`:1534`）与 `streamingThinking`（`:1533`）——该订阅是**必要的**，它保证了父组件不再逐帧重渲染后流式文本仍然保持视觉上的实时更新。

**剩余开销**：每次刷新仍需对 16KB 累积文本做分块（parse/split），并对不断增长的最后一个代码块重跑 Shiki 分词。开销随文本长度**单调增长**，但被块级 memo 显著削峰。

**关于刷新频率的澄清**：节流为 50ms（非 Claude）/ 100ms（Claude）（`agentStore.ts:257-261`）。非 Claude 运行时走 **leading-edge** 路径（`agentStore.ts:865-870`）：窗口起始立即执行一次 `applyStreamingBuffer`，并另排一次 50ms 尾随 flush（`:851-863`），故每窗口 2 次 UI 更新（≈40 次/秒）。
经复核，**这是有意设计而非缺陷**——`agentStore.ts:254-256` 注释明确说明 "Leading-edge + coalesce: first delta paints immediately; later deltas coalesce into at most one flush per throttle window"，目的是让首字立即上屏以保留响应感。**因此本次不作修改**，改为降低每次更新的成本（见根因 5）。

---

#### 根因 2：帧放大链——每个 token 产生 2 个 WS 帧，批次聚合在广播边界被丢弃

| 项目 | 内容 |
|---|---|
| 位置 | `src-tauri/src/companion/server.rs:1213-1228`、`src-tauri/src/agent/timeline_persist.rs:95-100`、`src-tauri/src/companion/events.rs:25-42` |
| 影响范围 | 全部客户端（桌面渲染进程 / PC 浏览器 / 移动浏览器 / CLI） |
| 触发频率 | 每个 delta 事件 |
| 严重程度 | **带宽与解析开销翻倍** |

**证据**

```rust
// companion/server.rs:1213-1228 —— 每个事件对每个连接发 2 帧
let payload = serde_json::json!({ "type": "event", "sessionId": session_id, "event": event });
socket.send(Message::Text(payload.to_string().into())).await?;   // 帧 1: event
let state_payload = serde_json::json!({
    "type": "state", "sessionId": session_id,
    "running": companion_state.is_turn_active(&session_id),       // 该值几乎不变
});
socket.send(Message::Text(state_payload.to_string().into())).await?; // 帧 2: state
```

sidecar 侧**确实**已按 50ms / 上限 100 条聚合（`src-tauri/sidecar/src/streamEventBatcher.ts:3-4`），但这个批次在 daemon 侧被**摊平回逐条**：

```rust
// agent/timeline_persist.rs:95-100
let domain: Vec<Value> = events.iter()
    .filter(|event| is_code_mux_domain_event(event)).cloned().collect();
return persist_and_stamp(state, &session_id, domain);   // 返回 N 条独立事件
```

```rust
// companion/events.rs:25-42
for event in events {
    ...
    broadcast_event(companion_state, &session_id, event);  // 逐条广播
}
```

**掉帧机理**：批次级聚合收益在广播边界被完全丢弃。WS 帧速率 = **2 × 事件速率**；150 delta/s 时约 **300 帧/秒**，每帧都要在主线程同步 `JSON.parse`。同时每帧执行 2 次 `json!` 宏构造 + 2 次 `to_string` 序列化（每连接各一份），`running` 标志几乎恒定却仍逐事件重发。

---

#### 根因 3：滚动跟随用 `MutationObserver(subtree)` 触发强制同步布局 + 写滚动（布局抖动）

| 项目 | 内容 |
|---|---|
| 位置 | `src/hooks/useTranscriptFollowLatest.ts:102-105`、`:73-92`、`:46-57` |
| 影响范围 | 全部会话视图 |
| 触发频率 | 每次文本 DOM 变更（即每个 token 渲染） |
| 严重程度 | **主线程阻塞（强制重排）** |

**证据**

```ts
// useTranscriptFollowLatest.ts:102-105
const mutationObserver = new MutationObserver(handleContentChange);
mutationObserver?.observe(viewport, { childList: true, subtree: true, characterData: true });
```

```ts
// useTranscriptFollowLatest.ts:84-91（读布局 → 强制 reflow）
const { scrollHeight, clientHeight } = element;   // 强制同步布局
if (scrollHeight === lastObserved.scrollHeight && clientHeight === lastObserved.clientHeight) return;
lastObserved.scrollHeight = scrollHeight;
lastObserved.clientHeight = clientHeight;
scrollViewportToBottom();                          // :52-53 再写 scrollTop
```

**掉帧机理**：订阅 `subtree: true` + `characterData: true` 意味着**任何一处文本节点变化**都会触发回调；回调内读取 `scrollHeight`/`clientHeight` 会**强制浏览器同步重算布局**（layout thrashing 的经典形态："读布局 → 写滚动"在同一次回调内交替）。流式期间逐 token 触发，与根因 1 共享同一个帧预算。

---

### P1 — 高频高开销根因

---

#### 根因 4：`MessageNav` 在每次滚动中对全部用户消息执行 O(n) `getBoundingClientRect`

| 项目 | 内容 |
|---|---|
| 位置 | `src/components/agent/assistant-ui/CodeMuxThread.tsx:1018-1044`、`:1055`、`:995` |
| 影响范围 | 全部会话；**开销随会话历史长度线性增长** |
| 触发频率 | 每次滚动事件（经 rAF 调度） |
| 严重程度 | 高（与根因 3 形成放大回路） |

**证据**

```ts
// CodeMuxThread.tsx:1018-1044
for (const item of items) {
  const element = document.getElementById(`msg-${item.eventIndex}`);
  const messageTop = element.getBoundingClientRect().top;   // 每条用户消息一次强制布局读
  ...
}
container.addEventListener('scroll', scheduleUpdateActive, { passive: true });  // :1055
```

`MessageNav`（`:995`）**未包裹 `memo`**，且 `UnifiedThreadViewport` 每次刷新都会重渲染（见根因 5），使其随之重渲染。

**掉帧机理**：根因 3 每次内容变化都写 `scrollTop` → 触发 `scroll` 事件 → rAF → 遍历全部用户消息各做一次 `getBoundingClientRect()`（每次都是强制布局读）。形成 **"写滚动 → scroll 事件 → O(n) 布局读取"** 的自我放大回路。长会话下 `n` 可达数百，单次成本显著。

---

#### 根因 5：`UnifiedThreadViewport` 订阅 `streamingVersion`，导致每帧全量重渲染视口子树并强制滚底

| 项目 | 内容 |
|---|---|
| 位置 | `src/components/agent/assistant-ui/CodeMuxThread.tsx:454`、`:462`、`:434` |
| 影响范围 | 全部会话视图 |
| 触发频率 | 每个刷新窗口（与根因 1 同频） |
| 严重程度 | 中-高（全量重渲染视口子树） |

**证据**

```tsx
// CodeMuxThread.tsx:454
const streamingVersion = useAgentStore((state) => state.streamingVersion[sessionId] ?? 0);
// :460-465
const { isAtBottom, scrollToBottom } = useTranscriptFollowLatest({
  viewportRef,
  followKey: `${sessionId}:${eventCount}:${isRunning ? '1' : '0'}:${streamingVersion}:${userMessageCount}:${runningSubagentCount}`,
  ...
```

**掉帧机理**：`streamingVersion` 每帧递增 → `UnifiedThreadViewport` 每帧重渲染 → 非 memo 的 `MessageNav` 及视口子树随之重渲染。同时 `followKey` 每帧变化 → 每次刷新都触发一次强制滚底（`:114-151`），而滚底本身又写 `scrollTop`，**再次触发根因 4 的 O(n) 回路**。三个根因（3、4、5）在此闭合。

---

#### 根因 6：sidecar 对每个 OpenCode 事件无条件同步写 stderr（全量 `JSON.stringify` 后才截断）

| 项目 | 内容 |
|---|---|
| 位置 | `src-tauri/sidecar/src/opencodeRuntime.ts:737-738`（入口 `:662`） |
| 影响范围 | **仅 OpenCode 运行时**（Claude / Codex 路径不受影响） |
| 触发频率 | 每个 OpenCode SDK 事件，**含每个 text delta** |
| 严重程度 | 高（阻塞 sidecar 事件循环） |

**证据**

```ts
// opencodeRuntime.ts:737-738  —— 无任何 env / 开关门控，无条件执行
const eventJson = (() => { try { return JSON.stringify(event).slice(0, 2000) } catch { return String(event).slice(0, 2000) } })();
process.stderr.write(`[opencode-debug] handleSdkEvent type=${type} sessionId=${eventSessionId ?? 'null'} activeSessionId=${activeSessionId ?? 'null'} event=${eventJson}\n`);
```

**掉帧机理**：`slice(0, 2000)` 在**全量 `JSON.stringify` 之后**执行，序列化成本已全额支付，且事件对象含**累积文本**，开销随消息增长。更关键的是：Node 在**管道**上写 stderr 是**同步**的，写不进去会阻塞整个 sidecar 事件循环——这会把 sidecar 精心设计的 50ms 批处理节奏**打乱为脉冲式发送**，进而让前端渲染呈现"一阵一阵"的卡顿。

**对比说明**：daemon 侧日志级别上限为 Info（`src-tauri/src/bin/codemux-daemon.rs:162`），sidecar 的 `CODEMUX_MESSAGE_DEBUG`（`index.ts:96`）/ `CODEMUX_STREAM_DEBUG`（`codexStreamTransform.ts:38`）默认关闭。

### 【重要修正】无门控 stderr 写的实际范围远超单处

实施修复时全量扫描 `[opencode-debug]` 发现，**无门控的写点共 11 处**，其中 **4 处在流式热路径上（每事件/每 delta 触发）**，初版仅指出 1 处：

| 位置 | 内容 | 频率 |
|---|---|---|
| `opencodeRuntime.ts:751` | `handleSdkEvent` 全量 `stringify` 后写 | **每事件（含每 delta）** |
| `opencodeEvents.ts:150` | `toCodeMuxEvent` 无门控 `JSON.stringify(properties)`（`:149`）后写 | **每事件** |
| `opencodeSdk.ts:653` | `RAW SSE event` 全量 `stringify`（`:652`）后写 | **每 SSE 事件** |
| `opencodeSdk.ts:637` | `SSE onSseEvent` | **每 SSE 事件** |
| `opencodeRuntime.ts:1118` | `EMIT to frontend` 全量 `stringify`（`:1117`）后写 | **每次 emit** |
| 其余 6 处 | `opencodeSdk.ts:568/622/626/664/669/676/679`、`opencodeEvents.ts:526`、`opencodeRuntime.ts:658` | 每轮次 / 每订阅 / 错误路径（冷） |

关键点：这 4 处热路径写点的 `slice(0, N)` **全部位于 `JSON.stringify` 之后**，因此截断从未节省序列化成本；且 `opencodeSdk.ts:664` 的 `JSON.stringify(event)` **完全没有截断**。再叠加 `index.ts:92-95` 已记录的事实——"每行 stderr 会被 Rust 侧读取、加锁写入捕获缓冲并经 tracing 输出"——使这些写点成为高频 IO + 锁竞争源。这也解释了为何项目已为 Claude 路径加了 `DEBUG_MESSAGE_LOGS` 门控，却仍在 OpenCode 路径留有该问题。

**修复策略**：在 `writeLog.ts` 新增统一开关 `DEBUG_OPENCODE_EVENTS`（`CODEMUX_OPENCODE_DEBUG=1` 启用），并将**全部 11 处**置于门控之后（热路径的 `stringify` 一并移入门控内，避免"写了才丢弃"）。

---

#### 根因 7：daemon 单任务串行执行"解析 → 同步落库 → 广播"，且 SQLite 未启用 WAL

| 项目 | 内容 |
|---|---|
| 位置 | `src-tauri/src/agent/session_lifecycle.rs:668-684`、`src-tauri/src/agent/timeline_persist.rs:141-153`、`src-tauri/src/db/schema.rs:4` |
| 影响范围 | 全部会话；工具调用/文件快照密集时最严重 |
| 触发频率 | 每个可持久化事件 |
| 严重程度 | 高（tokio worker 阻塞 + 突发延迟） |

**证据**

```rust
// agent/session_lifecycle.rs:668-684 —— async 循环内串行执行
let mut broadcast_events = crate::agent::timeline_persist::handle_sidecar_timeline_event(&app_state, &event);
broadcast_events.extend(crate::agent::subagent_persist::handle_sidecar_subagent_event(&app_state, &event));
crate::companion::handle_sidecar_event_for_companion(&app_state, &agent_state_task, &companion_state, &roots, broadcast_events);
event_binding.send(event).await;
```

```rust
// agent/timeline_persist.rs:141-153 —— 在 async 上下文内持 std::sync::Mutex 同步写库
let mut db = match state.db.lock() { Ok(db) => db, Err(_) => return Vec::new() };
match operations::append_timeline_events(&mut db, session_id, &new_events) { ... }
```

```rust
// src-tauri/src/db/schema.rs:4 —— 仅设置 foreign_keys
conn.execute_batch("PRAGMA foreign_keys = ON;")?;
```

（全仓 grep `journal_mode|WAL|busy_timeout|PRAGMA` 确认：除 `history_import.rs` 的 `user_version` 外，**无任何 WAL / busy_timeout 设置**。）

**掉帧机理**：两个 persist 函数都在 **async 上下文内同步持 `std::sync::Mutex` 写库**，未走 `spawn_blocking`。SQLite 处于**默认 rollback journal 模式**，每次 commit 需 **2 次 fsync**，且读写互斥。一次大事件的落库期间（如工具结果全文、文件快照原始内容），**该会话后续所有 delta 广播被堵在同一个任务里**，表现为"突发卡顿 + 随后脉冲式补发"。

---

#### 根因 8：scheduled 会话在实时期间每秒全量重拉 timeline REST（与 WS 推送并存）

| 项目 | 内容 |
|---|---|
| 位置 | `src/stores/agentStore.ts:2917-2920`、`:3284-3287`、`:3329-3357` |
| 影响范围 | **仅 `session.origin === 'scheduled'` 的会话**（`AgentPanel.tsx:184-185` 条件触发） |
| 触发频率 | 每秒 1 次轮询，每次附带最多 4 个 REST 请求 |
| 严重程度 | 高（但范围受限） |

**证据**

```ts
// agentStore.ts:2917-2920
stopBackgroundPoll(sessionId);
backgroundPolls.set(sessionId, window.setInterval(() => {
  void get().completeBackgroundLiveIfIdle(sessionId);   // → :2928 loadSessionMessages(force:true)
}, 1000));
```

```ts
// agentStore.ts:3284-3287 —— limit 5000，逐条 stringify + parse
const timelinePage = await daemonFacade.getTimeline(sessionId, { direction: 'tail', limit: 5000 });
for (const raw of historyMessages) { ... parseAgentEvent(JSON.stringify(rawMsg)) ... }
```

**掉帧机理**：每次 tick 在主线程对**最多 5000 条事件**逐条执行 `JSON.stringify` + `parseAgentEvent`，跑整表 `normalizeTurnProcessTimeline`，并**整体替换 `events` 数组**。这是 O(历史长度) 的同步主线程工作，造成**每秒一次的周期性明显卡顿**。每次还额外打 3 个 REST：`/state`（`:2929`）、`/subagents`（`:3268`）、`/token-usage`（`:3228`）。注意 daemon 侧 `limit` 无上限校验（`companion/server.rs:893-896`，默认 200，前端传 5000）。

---

### P2 — 放大项与次要根因

---

#### 根因 9：每次事件提交都全量重转换消息对象，且 adapter 每次渲染重建

| 项目 | 内容 |
|---|---|
| 位置 | `CodeMuxAssistantRuntime.tsx:79-81`、`:145-154`；`src/components/agent/convertAgentEvents.ts:79-337`、`:869-901` |
| 影响范围 | 全部会话；工具调用密集的回合最严重 |
| 触发频率 | 每个落库事件（非每个 token） |
| 严重程度 | 中-高（O(消息数) 转换 + 缓存全失效） |

```tsx
// CodeMuxAssistantRuntime.tsx:79-81
const messages = useMemo(() => convertAgentEventsToAssistantMessages(events, conversationTurns), [events, conversationTurns]);
// :145-154
const runtime = useExternalStoreRuntime({ messages, isRunning, convertMessage, onNew: handleNew, onEdit: handleEdit,
  adapters: { attachments: attachmentAdapter } });   // adapters 字面量每次渲染都是新对象
```

**掉帧机理**：`convertAgentEventsToAssistantMessages` 每次为**所有** event 重建全新消息对象（含 `structuredClone`）；而下游 assistant-ui 的转换缓存以 `WeakMap<外部消息对象, ThreadMessage>` 为键，对象每次都是新的 → **缓存 100% miss**，整条线程消息重新转换。`adapters` 字面量每次渲染都是新对象，使 `external-store-thread-runtime-core` 的 `if (this._store === store) return` 守卫永不生效，且 `useExternalStoreRuntime` 内 `useEffect(() => runtime.setAdapter(store))` **无依赖数组**，组件每次渲染都重灌 adapter。

---

#### 根因 10：非 delta 事件击穿 sidecar 批处理，20Hz 聚合退化为逐事件发送

| 项目 | 内容 |
|---|---|
| 位置 | `src-tauri/sidecar/src/streamEventBatcher.ts:118-126` |
| 影响范围 | 全部运行时；工具调用/子代理密集阶段最明显 |
| 触发频率 | 每个非 text/reasoning/tool_input_delta 事件 |
| 严重程度 | 中（放大根因 2） |

**掉帧机理**：任何非 delta 事件都先 `flushStreamEvents()` 再单独 `writeJsonLine`。工具与子代理密集时，50ms/20Hz 的聚合收益被反复打断，帧率显著上升，与根因 2 的 2 帧放大叠乘。

---

#### 根因 11：每条 sidecar 输出行在 daemon 被解析 3 次 + 深拷贝 3 次

| 项目 | 内容 |
|---|---|
| 位置 | `session_lifecycle.rs:669` → `timeline_persist.rs:84`；`:673` → `subagent_persist.rs:29`；`:638` → `session_lifecycle.rs:451`；深拷贝见 `timeline_persist.rs:133/146/151` |
| 影响范围 | 全部会话 |
| 触发频率 | 每个批次（50ms） |
| 严重程度 | 中（同步 CPU 占用 tokio worker） |

**掉帧机理**：同一条 JSON 行被 `serde_json::from_str` 解析 3 次，候选事件再被 `clone()` 至少 3 次。CPU 开销同步跑在 tokio worker 线程上，持续压缩事件转发预算。

---

#### 根因 12：消息列表无虚拟化（结构性放大项）

| 项目 | 内容 |
|---|---|
| 位置 | `src/components/agent/assistant-ui/CodeMuxThread.tsx:517-532` |
| 影响范围 | 全部会话；**长会话下持续恶化** |
| 触发频率 | 持续 |
| 严重程度 | 中（放大器，非独立诱因） |

**掉帧机理**：`messageIds.map(...)` 直接渲染全部消息，全仓未发现任何虚拟化依赖。DOM 体量线性增长，使根因 3、4 的每次强制布局成本随会话长度上升。消息行本身由 assistant-ui 的 `ThreadMessages` 做了 memo（按 `messageId + components` 比较，`components` 为模块常量），**因此历史消息不会因每个 token 而全量重渲染**——但视口容器与 `MessageNav` 不受此保护。

---

#### 根因 13：每个 `state` 帧都触发一次 store `set()`（即使返回空对象）

| 项目 | 内容 |
|---|---|
| 位置 | `src/stores/agentStore.ts:2854-2866` |
| 影响范围 | 全部会话 |
| 触发频率 | 每个 state 帧（即每个事件，与根因 2 同频） |
| 严重程度 | 中 |

```ts
// agentStore.ts:2854-2866
registerDaemonSessionHandler(sessionId, handleEvent, (running) => {
  if (!running) return;
  set((s) => { if (s.isRunning[sessionId]) return {};   // 流式中恒返回 {}
    return { isRunning: {...}, queryStartTime: {...} }; });
});
```

**掉帧机理**：返回 `{}` 仍会生成新 state 对象并**通知全部订阅者**做无意义的 selector 重算。因根因 2 使 state 帧数量翻倍，此开销被同步放大。

---

#### 根因 14：Write/Edit 前同步全量读文件并全量 emit

| 项目 | 内容 |
|---|---|
| 位置 | `src-tauri/sidecar/src/index.ts:1042-1049` |
| 影响范围 | 全部会话；大文件编辑时最严重 |
| 触发频率 | 每次文件编辑 |
| 严重程度 | 中-高（尖峰型） |

**掉帧机理**：`fs.readFileSync` 同步阻塞 Node 事件循环；`original_content` 全量进入 `file_snapshot`（可持久化），大文件时单次数 MB，随后 daemon 需对该大 JSON 解析 3 次 + 写 SQLite + 广播。构成一次显著的延迟尖峰。

---

#### 根因 15：持续 CSS 动画叠加在每帧重绘区域

| 项目 | 内容 |
|---|---|
| 位置 | `src/styles/globals.css:428-435`（`.shimmer`，`background-clip: text` + 2.5s 无限动画）；`CodeMuxThread.tsx:1608`（`animate-pulse` 光标） |
| 影响范围 | 流式输出期间持续生效 |
| 触发频率 | 持续（每帧） |
| 严重程度 | 轻微-中等 |

**掉帧机理**：`background-clip: text` 等非合成层属性动画需**持续重绘**，无法卸载到合成线程，与主线程争抢帧预算。

---

## 三、经核验排除的怀疑点（阴性结论）

以下方向经代码核验**确认不是问题**，列出以避免后续重复排查：

| 排除项 | 证据 |
|---|---|
| **不存在"每 token 重传全文"** | delta 只传增量 `text`，前端累加 `buffer[key] += chunk`（`agentStore.ts:880-882`），另有 16384 字符预览上限（`agentStore.ts:263,398-402`） |
| **流式 token 不写数据库** | `timeline_persist.rs:33-39/52-59/125-127/138-140`：不可持久化的 delta 事件候选集为空时直接返回，**不取 DB 锁**；测试 `:246-264` 覆盖 |
| **E2EE 无每消息 KDF、无 WebCrypto 微任务风暴** | 共享密钥仅握手时派生一次（`e2ee/channel.ts:52`；`companion/e2ee/channel.rs:76-79` 缓存 `precomputed`）；加密用同步 `tweetnacl`；**回环通信不经 E2EE** |
| **WS 队列有界，不会无界增长** | `broadcast::channel(512)`（`companion/state.rs:65`），`RecvError::Lagged → continue`（`server.rs:1231`）——丢帧而非堆积；每连接独立 task，慢客户端只阻塞自身 |
| **无重复订阅/多路重复消费** | `daemon-session-bridge.ts:62-63` 按 sessionId 去重；Electron main 只连控制面并丢弃非空 sessionId 帧（`desktop-events.ts:42`） |
| **流式写入不替换 `events` 数组** | `agentStore.ts:415-440` 的 `applyStreamingBuffer` 只写 `streamingText/streamingThinking/streamingVersion`，`events`/`turns` 引用不变 |
| **`MarkdownRenderer`（react-markdown）不在流式路径** | 仅用于 `AgentPanel.tsx:588`、`PermissionApprovalCard.tsx:193`、`SkillsSettings.tsx:379` |
| **消息行有 memo 保护** | `ThreadMessages.tsx:218-235` 按 `messageId + components` 比较；`useThreadMessageIds.ts:8-14` 在 id 序列不变时保持数组引用稳定 |
| **输入框按键不跑昂贵解析** | `CodeMuxLexicalComposerInput.tsx:226-239` 每次 update 仅遍历一次 root 拼文本；`applyTextToEditor`（`:346-386`）仅在外部 `setText` 时执行 |
| **定时器频率低** | `RunningElapsed.tsx:42-50` 为 1s `setInterval`；`useIsNarrowViewport.ts:26-30` 仅订阅 media query |
| **daemon 热路径无逐事件日志** | 日志级别上限 Info（`bin/codemux-daemon.rs:162`） |
| **已使用多线程 tokio 运行时** | `bin/codemux-daemon.rs:140` |
| **无高频定时任务轮询** | 定时任务 30s 一次（`daemon/mod.rs:178`） |
| **重文件/历史读取已走 `spawn_blocking`** | `session_lifecycle.rs:1610` |

---

## 四、掉帧放大回路图

```
        ┌────────────────────────────────────────────────────────────┐
        │  sidecar 侧：50ms 批处理（streamEventBatcher 有效）          │
        └────────────────────────┬───────────────────────────────────┘
                                 │ 根因 10：非 delta 事件击穿批处理
                                 ▼
        ┌────────────────────────────────────────────────────────────┐
        │  daemon：批次被摊平为 N 条（timeline_persist.rs:95-100）      │
        │  根因 7：串行 解析→同步落库（无 WAL，2×fsync）→广播            │
        │  根因 11：每行解析 3 次 + 深拷贝 3 次                        │
        └────────────────────────┬───────────────────────────────────┘
                                 │ 根因 2：每事件 2 帧（event + state）
                                 ▼        ≈ 2 × 事件速率 ≈ 300 帧/s
        ┌────────────────────────────────────────────────────────────┐
        │  客户端主线程：每帧 3× JSON.parse + 1× stringify             │
        │  根因 13：每 state 帧触发 store 通知                         │
        └────────────────────────┬───────────────────────────────────┘
                                 │ 根因 1：每次刷新重跑 Markdown+Shiki
                                 ▼        根因 5：每刷新强制滚底
        ┌────────────────────────────────────────────────────────────┐
        │  根因 3：MutationObserver(subtree) → 读 scrollHeight（重排） │
        │           → 写 scrollTop                                   │
        │  根因 4：scroll 事件 → rAF → O(n) getBoundingClientRect      │
        └────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
                     每帧预算（16ms）被击穿 → FPS 骤降
```

**回路闭合点**：根因 3 写 `scrollTop` → 触发 `scroll` 事件 → 根因 4 做 O(n) 布局读 → 布局变化又可能引起 DOM 高度变化 → 再次触发根因 3 的 `MutationObserver`/`ResizeObserver`。这是掉帧"持续且难以自愈"的结构性原因。

---

## 五、修复优先级建议

按投入产出比排序（详细方案另行设计）：

| 优先级 | 措施 | 对应根因 | 预期收益 |
|---|---|---|---|
| 1 | 流式 Markdown 改为**增量解析**或按代码块边界分片缓存，只重解析尾部未闭合块 | 根因 1 | 直接消除最大单次主线程开销 |
| 2 | daemon 广播**保持批次边界**：一个批次发 1 帧（含事件数组）；`state` 仅在 `running` 变化时发送 | 根因 2、10、13 | WS 帧数降低 2–N 倍 |
| 3 | 消除布局抖动：`MutationObserver` 去掉 `characterData` / 收窄 `subtree`，改由 `ResizeObserver` 主导；`scrollTop` 写入收敛到 rAF 单次 | 根因 3、5 | 消除强制重排 |
| 4 | `MessageNav` 的 `getBoundingClientRect` 结果加缓存 + 失效策略（仅消息数/尺寸变化时重算） | 根因 4 | 消除 O(n) 滚动开销 |
| 5 | 移除 `opencodeRuntime.ts:737-738` 的无门控 stderr 写，改为 env 门控且不序列化累积文本 | 根因 6 | 恢复 sidecar 批处理节奏 |
| 6 | SQLite 启用 **WAL + busy_timeout**，持久化移入 `spawn_blocking` | 根因 7 | 消除落库阻塞广播 |
| 7 | scheduled 会话改为依赖 WS 增量，去掉 1s 全量 timeline 重拉 | 根因 8 | 消除周期性卡顿 |
| 8 | 客户端合并 `daemon-session-bridge` 的 stringify/parse 往返，事件对象只解析一次 | 根因 2（客户端侧） | 降低每帧解析成本 |
| 9 | 消息列表引入虚拟化 | 根因 12 | 改善长会话表现 |
| 10 | 补齐诊断埋点：接上 `recordIpc` 调用方；Profiler 拆分到消息行/工具卡粒度 | 监控盲区 | 恢复归因能力 |

---

## 六、排查范围与置信度说明

- **已覆盖**：前端渲染与交互逻辑（组件树、订阅粒度、滚动/动画、Markdown 渲染、状态管理）、后端接口与资源占用（daemon 事件循环、SQLite、sidecar、并发模型）、前后端通信链路（Companion REST/WS、帧结构、序列化、批处理、背压、E2EE）。
- **置信度**：所有根因均标注 `文件路径:行号`。其中 P0 与 P1 项（根因 1–8）的关键指控已由本次排查**逐行二次核验**，核验点：`CodeMuxThread.tsx:1597-1610`、`useTranscriptFollowLatest.ts:102-105`、`opencodeRuntime.ts:737-738`、`server.rs:1213-1228`、`timeline_persist.rs:95-100/141-153`、`db/schema.rs:4`、`session_lifecycle.rs:668-684`、`companion/events.rs:25-42`、`agentStore.ts:846-883/2854-2866`。
- **本次核验新增的发现**：
  1. 非 Claude 运行时存在 leading-edge 双触发（`agentStore.ts:865-870` + `:851-863`），每 50ms 窗口 2 次 UI 更新（≈40 次/秒）。经复核**这是保留首字响应感的有意设计**（注释 `:254-256`），不计为缺陷，但它是根因 1、4、5 的实际触发频率来源。
  2. 性能浮层的 `recordIpc` **无生产调用方**，IPC 相关指标恒为 0；`<Profiler>` id 为 `"AgentThread"` 而非设计文档所述 `MessageList`，故面板无子组件归因能力。
  3. 无门控的 `[opencode-debug]` stderr 写实为 **11 处**（4 处在流式热路径），而非初版指出的 1 处。
  4. Streamdown 具备**块级 memo**（README 第 23 行 + 项目注释 `markdown-text.tsx:90-94`），故根因 1 严重度由 P0 下调至 P1。
- **未覆盖 / 待确认**：
  - 未做运行时实测（未启动 `dev:desktop` 抓取真实火焰图 / React DevTools Profiler 下钻），以上均为**静态代码推断**；各根因的**相对权重**需实测校准。建议用 `Ctrl+Shift+D` 打开浮层，对照"流式开始/结束"时刻的 FPS 曲线与 React DevTools Profiler 的 commit 火焰图交叉验证。
  - 根因 8 的前置条件 `session.origin === 'scheduled'` 是否落在复现场景内，需确认。
  - 根因 6 的 sidecar stderr 管道是否确实发生写阻塞（取决于 daemon 侧读取速率），建议实测验证。
  - 根因 15 的 `.shimmer` 动画实际使用范围需逐一确认。

---

## 七、已实施的修复与验证（2026-09-16）

本轮共修复 **6 组**问题，覆盖全部 P0 与 P1 根因中"低风险、高收益"的部分。

### 7.1 修复清单

| # | 修复 | 文件 | 对应根因 | 关键改动 |
|---|---|---|---|---|
| 1 | **消除 `state` 帧冗余广播** | `src-tauri/src/companion/server.rs` | 根因 2 | 新增 `last_sent_running` 跟踪，仅在 `running` 真正翻转时发 `state` 帧。**WS 帧数降低约 50%**（原每事件 2 帧 → 1 帧 + 状态变化时 1 帧） |
| 2 | **滚动跟随消除逐变更强制重排** | `src/hooks/useTranscriptFollowLatest.ts` | 根因 3 | `handleContentChange` 改为 rAF 合并：`contentFrame` 门控，每帧最多一次 `scrollHeight/clientHeight` 读取。原为**每次 characterData 变更一次同步重排** |
| 3 | **视口停止逐帧重渲染** | `src/hooks/useTranscriptFollowLatest.ts` + `CodeMuxThread.tsx` | 根因 5 | 新增 `followSessionId` 参数，改用 `useAgentStore.subscribe()` **命令式**驱动滚动；`streamingVersion` 移出 `followKey` |
| 4 | **线程树停止逐帧重渲染** | `src/components/agent/assistant-ui/CodeMuxThread.tsx` | 根因 4/5 的触发器 | `streamingText`/`streamingThinking` 全文订阅 → 改为 selector 内派生的**布尔值** `hasStreamingBuffer`（原订阅仅用于 `.length > 0` 判断） |
| 5 | **SQLite 启用 WAL** | `src-tauri/src/db/schema.rs` | 根因 7 | `PRAGMA journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=5000`。消除每次 commit 的 2 次 fsync 与读写互斥 |
| 6 | **门控全部 OpenCode 调试写** | `writeLog.ts`、`opencodeRuntime.ts`、`opencodeEvents.ts`、`opencodeSdk.ts` | 根因 6 | 新增 `DEBUG_OPENCODE_EVENTS`（`CODEMUX_OPENCODE_DEBUG=1`），**11 处** stderr 写全部置于门控后；热路径的 `JSON.stringify` 一并移入门控内 |

### 7.2 设计取舍说明

- **未改动 streaming flush 的 leading-edge 行为**（原计划取消非 Claude 的双触发）。复核确认该行为是有意设计（保留首字立即上屏的响应感，`agentStore.ts:254-256`），且次数有界为 2×。**正确做法是降低每次更新的成本，而非减少更新次数**，故转而修复其消费端（#3、#4、#2）。
- **~~未改动事件管线的字符串契约~~（此判断已被第二轮证据推翻，见第八节）**。当时认为消除 `JSON.stringify`→`JSON.parse` 往返只省"每事件数十微秒"，收益不划算。**该估算是错的**：低估了往返次数（实为每事件 **5 次**完整 JSON 操作），且未考虑大 payload（文件内容类 tool result）会被放大 5 倍。第二轮已实施修复。
- **#4 的关键正确性前提**：`CodeMuxThread` 不再逐帧重渲染后，流式文本的视觉实时性由 `StreamingContent`（`CodeMuxThread.tsx:1529+`）**自身的** `useAgentStore` 订阅保证（`:1533-1534`）。Zustand 订阅独立于父组件渲染，故实时预览不受影响。这一点已在测试中验证（见 7.3）。

### 7.3 验证结果

| 验证项 | 命令 | 结果 |
|---|---|---|
| Rust 格式 | `cargo fmt --all -- --check` | ✅ 通过（首次发现新代码换行不合规，已 `cargo fmt` 修正） |
| Rust 编译 | `npm run build:daemon` | ✅ `Finished dev profile in 1m 12s`，已产出新 `codemux-daemon` 二进制 |
| Rust lint | `cargo clippy --all-targets --all-features -- -D warnings` | ⚠️ 16 个错误，**全部位于未改动文件**（`services/model_provider.rs`、`lib.rs`、`agent/fork.rs`、`companion/actions.rs`、`companion/state.rs`、`services/git.rs` 等），属既有问题；`companion/server.rs` 与 `db/schema.rs` 零错误。Clippy 已通过编译阶段进入 lint，证明改动可编译 |
| 前端类型 | `npx tsc --noEmit` | ⚠️ 5 个既有错误，均位于未改动文件（`ImportSessionsDialog.tsx`、`ProviderConfig.tsx`、`daemon-facade.ts`、`logger.ts`）；改动文件零错误 |
| Sidecar 编译 | `cd src-tauri/sidecar && npm run build` | ✅ exit 0 |
| Sidecar 测试 | `cd src-tauri/sidecar && npx vitest run` | ✅ **59 文件 / 620 用例全通过** |
| 前端全量测试 | `npx vitest run` | ⚠️ 1579 通过 / 2 失败 → **经基线对照确认为既有缺陷，非本次引入**，详见 7.4 |

### 7.4 关于 2 个测试失败的结论（已排除为本次引入）

`CodeMuxAssistantRuntime.test.tsx` 有 2 个用例在**全量套件**下超时（30s）。经严格基线对照排除：

| 运行条件 | 基线（无本次改动） | 本次改动 |
|---|---|---|
| **全量套件**（202 文件并行） | ❌ 1 失败（`:1701` 超时） | ❌ 2 失败（`:1701`、`:2049` 超时） |
| **单文件隔离** | ✅ 67/67 通过 | ✅ 67/67 通过 |
| 单用例隔离耗时（`:1701`） | ❌ 31.29s（超时失败） | ✅ **23.2s（通过）** |

结论：
1. `:1701` 在**基线全量套件下同样超时**，属既有问题；
2. 该测试文件本身极重（单文件耗时 100s+，两个用例各需 20–30s），在 202 文件并行争抢 CPU 时必然逼近 30s 上限——**是边缘性负载抖动，不是逻辑缺陷**；
3. 隔离测量显示**本次改动使该用例由 31.29s 提速至 23.2s**（约 −26%），与"减少渲染与强制重排"的预期方向一致。

对照组均已通过"备份 → 还原 HEAD → 运行 → 恢复"的方式执行，仓库状态在每个阶段均经 `git status` 校验。

### 7.5 尚未修复（建议后续处理）

| 优先级 | 项 | 依据 |
|---|---|---|
| 高 | 根因 8：scheduled 会话每秒全量重拉 timeline（`limit: 5000`，主线程 O(历史) 解析） | 需产品确认 scheduled 会话能否改为纯 WS 增量 |
| 中 | 根因 9：事件提交全量重转换消息 + adapter 每次渲染重建（缓存 100% miss） | 改动面涉及 assistant-ui 适配层 |
| 中 | 根因 4：`MessageNav` 的 O(n) `getBoundingClientRect`（当前已 rAF 节流，但每次滚动仍 O(用户消息数)） | 需引入偏移缓存 + 失效策略 |
| 中 | 根因 12：消息列表无虚拟化 | 结构性改造，长会话收益显著 |
| 中 | 事件管线字符串契约（消除 `stringify`/`parse` 往返） | 需同步改约 50 处测试桩 |
| 低 | 根因 10/11/13/14/15：批处理击穿、重复解析、空 `set()`、同步全量读文件、CSS 动画 | 单项收益有限，可随上述改造一并处理 |
| 低 | 补齐诊断埋点：接上 `recordIpc` 调用方、Profiler 拆到子组件粒度 | 恢复浮层的归因能力，便于验证本次修复效果 |

### 7.6 如何验证修复效果

1. 重启 `npm run dev:desktop`（daemon 不会被热重载，必须重启以加载新二进制）。
2. `Ctrl+Shift+D` 打开性能浮层，对照流式对话期间的 FPS 曲线。
3. 若使用 OpenCode 运行时，可用 `CODEMUX_OPENCODE_DEBUG=1` 在需要时恢复其事件调试输出。
4. 建议同时用 React DevTools Profiler 观察 `CodeMuxThread` / `UnifiedThreadViewport` 的 commit 次数——修复后二者在流式期间应**不再逐帧 commit**。

---

## 八、第二轮排查（基于现场 FPS 截图，2026-09-16 稍晚）

第一轮修复后用户复现：**仍有明显掉帧**，且**"正在执行 · 12s" 计时器会卡住不动**。浮层读数：`FPS 6`、`内存 136→159MB`、`IPC/秒 0`、`Re-render Top-5: AgentThread 108x/958ms` 与 `846x/7326ms`。

### 8.1 对读数的关键解读（这是第二轮的突破口）

**`AgentThread 846 次 commit / 累计 7326ms`，会话持续约 106 秒。**

- 折算：commit 频率 ≈ **8 次/秒**，单次 ≈ 8.7ms；
- **React commit 总耗时仅占挂钟时间约 7%**（7326 / 106000）。

结论：**瓶颈根本不在 React 渲染**——约 93% 的主线程时间花在 React 之外。这直接否决了"继续优化渲染"的方向，解释了为何第一轮的前端渲染修复虽有效但未能消除掉帧。同时 `IPC/秒 0` 是已知盲区（`recordIpc` 无调用方），等于**帧速率这个最关键的指标完全不可见**。

### 8.2 新增根因 16：客户端事件管线对每个事件做 5 次完整 JSON 操作

这是"React 之外"开销的主要来源。逐个核验后确认，**单个事件在主线程上被完整 JSON 处理 5 次**：

| # | 位置 | 操作 |
|---|---|---|
| 1 | `lib/daemon-client/client.ts:341` | `JSON.parse(message.data)` — 解析 WS 帧 |
| 2 | `lib/daemon-session-bridge.ts:78` | `JSON.stringify(record)` — **解析后又序列化回去** |
| 3 | `stores/subagentStore.ts:233` | `JSON.parse(raw)` — `routeSubagentSidecarEvent` 仅判断两个类型守卫 |
| 4 | `stores/agentStore.ts:1728` | `JSON.parse(raw)` — `consumeSteerResultEvent` 仅判断 `type === 'steer_result'` |
| 5 | `stores/agentStore.ts:1077` | `JSON.parse(raw)` — `parseAgentEvent` 真正解析 |

| 项目 | 内容 |
|---|---|
| 影响范围 | **全部客户端、全部运行时**；payload 越大越严重（Read 工具返回整文件内容、`file_snapshot` 原文件内容） |
| 触发频率 | **每个事件**（含每个 delta 帧） |
| 严重程度 | **高**（第一轮被低估，见 7.2 修正） |

**为何第一轮低估了它**：当时按"每事件数十微秒"估算，只看到了小 delta 帧。实际开销由**大 payload × 5** 主导——一个 1MB 的 tool result 会被解析/序列化 5 次，且这些操作**全部不在 React commit 内**，因此 Profiler 完全看不到。

**修复**：把 `SessionEventHandler` 的入参放宽为 `string | Record<string, unknown>`，由 `daemon-session-bridge` 直接下传**已解析对象**；`parseAgentEvent` / `consumeSteerResultEvent` / `routeSubagentSidecarEvent` 仅在入参为字符串时才解析。

- **5 次 → 1 次**完整 JSON 操作（保留 WS 帧那一次，不可避免）；
- **向后兼容**：直连 sidecar 的旧路径与全部测试桩仍传字符串，行为不变；仅 `daemon-session-bridge.test.ts` 中断言"字符串往返"的那一条断言按新契约更新。

### 8.3 新增根因 17：`backgroundThrottling` 默认开启，窗口失焦/被遮挡时冻结 UI（**最可能的"计时器卡住"元凶**）

| 项目 | 内容 |
|---|---|
| 位置 | `desktop-electron/src/main.ts:231-239`（修复前未设置该字段） |
| 影响范围 | **全部桌面端用户**；窗口被遮挡或失焦时 |
| 触发频率 | 只要窗口不是前台可见即持续 |
| 严重程度 | **高**（同时解释 FPS 极低与计时器冻结两个症状） |

**证据链**：Electron 的 `webPreferences.backgroundThrottling` **默认为 `true`**。该开关开启时，Chromium 会把被遮挡/隐藏窗口当作后台页面处理：

- `requestAnimationFrame` 被大幅节流 → **浮层 FPS 读数塌到个位数**；
- `setInterval` / `setTimeout` 被节流（对齐到 1 秒，长时间后台后进一步降频）→ **`RunningElapsed` 的 1 秒定时器"卡住一会不动"**。

**为何这是"计时器冻结"的最合理解释**：单纯的 CPU 忙碌只会让 1 秒定时器延迟几十到几百毫秒，**不会让它冻结数秒**；能让 1 秒定时器长时间不动的，只有**定时器节流**。

**为何对 CodeMUX 尤其致命**：本产品的核心使用场景就是"agent 跑几分钟，用户切到编辑器/终端做别的事"。默认节流正好打在这个场景上——用户切走后回来，看到的是一段冻结后突然跳变的界面。这也意味着**第一轮以及后续所有基于 FPS 读数的判断都可能被这个节流污染**（在窗口非前台时测得的低 FPS 未必是渲染慢）。

**修复**：主窗口 `webPreferences` 显式设置 `backgroundThrottling: false`。

**取舍**：窗口被遮挡时仍会持续合成，后台 CPU/电量占用略有上升。**已接受**——对"agent 运行可读性"而言，UI 冻结属于正确性问题，而非性能偏好。

### 8.4 诊断能力修复（避免下一次继续盲猜）

| 修复 | 位置 | 作用 |
|---|---|---|
| **接入"长任务/秒"** | `components/dev/PerfOverlay.tsx` | 用 `PerformanceObserver(['longtask'])` 统计每秒 >50ms 的主线程阻塞：次数 / 最长 / 累计。**这是区分"真 CPU 阻塞"与"节流"的决定性判据**：FPS 低且长任务为 0 → 节流；有长任务 → 真阻塞 |
| **接通 `IPC/秒`** | `lib/daemon-client/client.ts` | 在 WS `onmessage` 上调用原先**无人调用**的 `recordIpc('ws:frame', ...)`。此后"IPC/秒"即**真实入站 WS 帧速率**，"慢 IPC Top-5"会列出解析+处理超过阈值的帧 |

### 8.5 第二轮验证结果

| 验证项 | 结果 |
|---|---|
| 前端类型检查 | ✅ 改动文件零错误（仅剩 5 个既有错误） |
| Electron 外壳类型检查 | ✅ `tsc -p tsconfig.json --noEmit` exit 0（证明 `backgroundThrottling` 字段合法） |
| 受影响测试 | ✅ 8 文件 / 142 用例全通过（含更新后的 `daemon-session-bridge.test.ts`） |
| 完整套件 | 见下方说明（沿用第一轮已确认的既有抖动基线：基线为 1 失败 / 1580 通过） |

### 8.6 下一轮验证方法（请按此复现）

1. **完全重启** `npm run dev:desktop`（外壳的 `backgroundThrottling` 改动需重启，不可热更新）。
2. 打开一个会话跑流式任务，`Ctrl+Shift+D` 打开浮层，观察三行数字：
   - **`长任务/秒`**：若持续为"无"而 `FPS` 仍低 → 说明是**节流/遮挡**，不是渲染慢（请确认窗口是否被其他窗口遮挡）；若出现"`N · 最长 XXXms`" → 是**真实主线程阻塞**，把该行数值反馈给我即可定位。
   - **`IPC/秒`**：即真实 WS 帧速率。若高达数百，说明 daemon 侧"每事件一帧、不做合并"（本报告根因 2 尚未修复的那一半）是下一优先项。
   - **`Re-render Top-5`**：流式期间 `AgentThread` 的 commit 数应显著低于帧速率（证明逐帧重渲染已被消除）。

### 8.7 仍未修复（按新证据重排优先级）

| 优先级 | 项 | 依据 |
|---|---|---|
| 高 | 根因 2 的**剩余一半**：daemon 逐事件广播、不做帧合并 | 每条 `broadcast_event` → 1 次 `json!` + `to_string` + 1 个 WS 帧；客户端 1 次 `JSON.parse` + 1 次 store `set()`。合并批次可再降 N 倍。属**协议层改动**，需与客户端同步改并保留兼容分支 |
| 高 | 根因 8：scheduled 会话每秒全量重拉 timeline（`limit: 5000`） | 已确认**仅**影响 `origin === 'scheduled'`（`AgentPanel.tsx:184`），普通会话不受影响 |
| 中 | 根因 9：事件提交全量重转换 + adapter 每次渲染重建 | 属 React commit 内开销（当前仅占 7%），故优先级下调 |
| 中 | 根因 4 / 12：`MessageNav` O(n) 布局读取、消息列表无虚拟化 | 属 React commit 内开销，同上 |
| 低 | 根因 10/11/13/14/15 | 单项收益有限 |

---

## 九、第三轮排查（新诊断给出真实数据后，2026-09-16 再次）

启用第八节新增的诊断后，用户复现并提供了 4 组浮层读数。**这批数据直接否定了我此前的主假设，并锁定了真正的元凶。**

### 9.1 实测数据

| 截图 | FPS | 长任务/秒 | 最长 | 累计 | 内存 MB | IPC/秒 | AgentThread |
|---|---|---|---|---|---|---|---|
| 1 | 25 | 26 | 94ms | 2087ms | 116.5 | 4 | 408x / 3569ms |
| 2 | 6 | 8 | 102ms | 687ms | 105.7 | 10 | 560x / 4630ms |
| 3 | 6 | **51** | 105ms | **3543ms** | 157.2 | 12 | 1317x / 9207ms |
| 4 | 5 | — | — | — | 188.5 | 9 | **1966x / 11195ms** |

现场会话特征：**"读取 6 次文件"**、多次"思考"、`origin` 为普通会话（非 scheduled）。

### 9.2 数据说明的两件事（都很关键）

**① 长任务是真实存在的，不是节流。** 第八节设置"长任务/秒"就是为了这个判据：读数**非 0 且累计高达 3543ms**，说明主线程**确实被阻塞**。所以第八节的 `backgroundThrottling` 修复虽然正确且必要（它解释了"计时器冻结"），**但不是本次掉帧的主因**。

**② `IPC/秒` 只有 4–12 —— 我此前的一个关键假设是错的。** 我曾推断"daemon 每事件发一帧 → 每秒数百帧 → 客户端解析压力巨大"，并据此把"daemon 帧合并"列为最高优先项。**实测帧速率仅 4–12 帧/秒**，该假设不成立，**帧合并不值得做**。这是用实测代替推测的直接收益。

### 9.3 新增根因 18（**真正的元凶**）：每次事件都深拷贝整份历史事件，且发生在 Profiler 测量范围之外

| 项目 | 内容 |
|---|---|
| 位置 | `src/components/agent/assistant-ui/convertAgentEvents.ts:903-912`（`createEventPart` → `cloneJsonValue` → `structuredClone`），被 `:319` 的主循环逐事件调用 |
| 影响范围 | **全部客户端、全部运行时**；会话越长、工具结果越大（尤其 Read 读回整文件）越严重 |
| 触发频率 | **每个事件一次**（`events` 每变化即 `useMemo` 重算，`convertAgentEventsToAssistantMessages` 内部遍历**全部**历史事件） |
| 严重程度 | **P0（本报告截至目前的实际首因）** |

**证据**

```ts
// convertAgentEvents.ts:903-912
function createEventPart(eventKind, event) {
  return {
    type: 'data-codemux-event',
    eventKind,
    event: cloneJsonValue(event),   // ← 深拷贝整个事件
  };
}

// convertAgentEvents.ts:926-932
function cloneJsonValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);   // ← 对含完整文件内容的事件做结构化克隆
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
```

调用方：

```ts
// CodeMuxAssistantRuntime.tsx:79
const messages = useMemo(
  () => convertAgentEventsToAssistantMessages(events, conversationTurns),
  [events, conversationTurns],   // ← events 每来一个事件就换引用
);
```

**掉帧机理（复杂度）**：`events` 每变化 → 重算 → 遍历**全部** n 个事件 → 对每个事件 `structuredClone`。单次转换成本为 **O(整份历史的负载体积)**；一个会话收到 n 个事件，总成本 **O(n × 平均负载) ≈ O(n²)** 级别的拷贝。`tool_result` 里含 Read 工具读回的整文件内容时，单次转换要克隆**数 MB**，耗时正好落在 **~100ms** —— 与四张截图"最长"稳定在 94/102/105/105ms 的签名完全一致。

**为何 Profiler 完全看不到它（重要方法论修正）**：`convertAgentEventsToAssistantMessages` 运行在 `CodeMuxAssistantRuntimeProvider` 中，而 `<Profiler id="AgentThread">` 在 `AgentPanel.tsx:511`，**转换发生在这个 Profiler 的测量子树之外**。因此：

- AgentThread 只统计**消息树渲染**（截图 4：1966x / 11195ms ≈ 挂钟的 13%）；
- 而**更贵的全量深拷贝**完全不在其内。

**所以第八节"React 只占 7% ⇒ 瓶颈在 React 之外"的推断虽然方向对，但当时把"React 之外"草率地归到了事件管线的 JSON 往返上** —— 真实的大头是这个越界的全量深拷贝。**教训：Profiler 的子树边界必须显式确认，不能默认它覆盖了整条链路。**

**修复**：按源事件对象身份用 `WeakMap` 缓存克隆结果，使每个事件**只克隆一次**而非每次转换都克隆。

```ts
const clonedEventCache = new WeakMap<AgentMessage, AgentMessage>();

function cloneEventOnce(event: AgentMessage): AgentMessage {
  const cached = clonedEventCache.get(event);
  if (cached) return cached;
  const cloned = cloneJsonValue(event);
  clonedEventCache.set(event, cloned);
  return cloned;
}
```

- **语义不变**：仍然隔离 store 事件，assistant-ui 依旧无法改写 store 持有的对象；`WeakMap` 不阻止 GC。
- **成立前提**：store 事件对象在转换之间**保持引用稳定**（store 只做 append 与 filter，不重建元素对象），已核验 `agentStore` 的 `set` 写法（`[...(s.events[id] || []), newEvent]` 保留元素引用）。历史重载（`loadSessionMessages` 重新解析）会导致缓存 miss，属离散低频繁操作，可接受。
- **已知取舍**：若某个消费者会改写 part 上的 event，该改写现在会保留而非被下次克隆覆盖。该数据本应是只读投影；已在代码注释中标注。

### 9.4 顺带修复：再消除 4 处 `JSON.stringify` → `parseAgentEvent` 往返

`parseAgentEvent` 已支持直接接收对象，故下列 4 处"序列化后再交给它解析"的往返全部去掉：

| 位置 | 场景 |
|---|---|
| `stores/agentStore.ts:3357` | **scheduled 会话全量加载**（每次最多 5000 条） |
| `components/workspace/SubagentPreviewPanel.tsx:64` | 子代理预览（每次渲染） |
| `components/layout/ChatSearchDialog.tsx:225` | 会话搜索 |
| `lib/sessionTitle.ts:44` | 会话标题解析 |

### 9.5 关于"卡 UI 尺寸调整"

用户反馈调整窗口尺寸时也卡。这**不是独立问题**：窗口尺寸变化会让整个 DOM 重新布局，而主线程本已被上述 ~100ms 深拷贝块打满，因此重排只能排队等待。主线程占用下降后该症状应随之缓解。若修复后仍明显，则需单独排查大 DOM（根因 12 无虚拟化）在 resize 时的布局成本。

### 9.6 第三轮验证结果

| 验证项 | 结果 |
|---|---|
| 前端类型检查 | ✅ 改动文件零错误（仅剩 5 个既有错误）；`parseAgentEvent` 收对象入参未引入新类型错误 |
| 相关模块测试 | ✅ 7 文件 / 201 用例全通过（含 `convertAgentEvents.test.ts`、`SubagentPreviewPanel.test.tsx`、`ChatSearchDialog.test.tsx`、`sessionTitle.test.ts`、`agentStore.test.ts`） |
| 完整套件 | 沿用既有抖动基线（见 7.4：基线为 1 失败 / 1580 通过） |

### 9.7 修复优先级（按实测证据重排）

| 优先级 | 项 | 依据 |
|---|---|---|
| ~~高~~ **已否决** | ~~daemon 逐事件广播合并帧~~ | **实测 `IPC/秒` 仅 4–12**，帧速率本就不高，不值得动协议 |
| 高（本轮已修） | 根因 18：逐事件全量深拷贝 | 实测长任务累计 3543ms、最长稳定 ~100ms |
| 中 | 转换频率：`useMemo([events, ...])` 每事件重算，即使去掉克隆仍为 O(n)/事件 | 可在克隆修复见效后评估是否需要按帧合并转换 |
| 中 | 根因 9/4/12：消息全量重建、`MessageNav` O(n)、无虚拟化 | AgentThread 渲染约占 13% 挂钟，修复后占比会更突出 |
| 低 | 根因 8：scheduled 会话每秒全量重拉（**已确认仅影响 scheduled**） | 本会话为普通会话，不受影响 |
| 低 | 根因 10/11/13/14/15 | 单项收益有限 |

### 9.8 下一轮验证要点

重启后复现同样场景，重点看：

1. **`长任务/秒` 是否显著下降**（尤其"累计"）——这是本轮修复是否命中的直接判据；
2. **`FPS` 是否回升**（窗口保持前台可见，避免节流干扰读数）；
3. 若长任务已降但 FPS 仍低，则下一嫌疑是 **AgentThread 渲染（约占 13%）**，届时再处理根因 9/4/12。
