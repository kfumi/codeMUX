# Paseo 流式对话流畅性归因分析 —— 及对 CodeMUX 的借鉴

> 分析日期：2026-09-16  
> 对照对象：`D:\project\my-project\paseo`（Paseo，Electron + Expo/React Native + Node daemon）  
> 本方：CodeMUX（Electron + React/Vite + Rust daemon + Node sidecar）  
> 目的：解释"为什么 Paseo 用起来很少严重掉帧"，并提炼可移植的做法

---

## 〇、结论摘要

Paseo 不卡，**不是靠某一个巧妙的优化，而是在五个层级上各自设了边界**；而 CodeMUX 在这五个层级上有四个是缺的。

一句话概括差异：

> **&#x20;在事件进入管线之前就把「速率、体积」压到有界，在渲染层再把「重渲染范围、提交频率、绘制节奏」压到有界。CodeMUX 三处都无界：速率靠客户端节流、体积完全无上限、重渲染范围是"全量"。**

排序：**体积无界 > 事件无合并 > 无帧边界提交 > 无分帧绘制 > 无历史身份域**。

其&#x4E2D;**"体积无界"是单项收益最大的一条**，也是与本项目前几轮已经定位到的 `structuredClone` ~100ms 长任务**直接同源**的根因。

---

## 一、Paseo 的完整管线（含代码出处）

官方文档把管线写得非常明确（`docs/agent-stream-performance.md:7-16`）：

```
provider deltas（每个 provider 都是增量流式）
  → AgentStreamCoalescer（daemon，leading + trailing，≤1 条消息 / 60ms / agent）
  → recordTimeline：每次 flush 落一条 canonical row
  → agent_stream ws 消息
  → reducer queue（app，每帧一次 commit）→ session store
  → paced reveal（app，按 assistant/reasoning 条目）→ markdown blocks → paint
```

逐段对照代码：

| 阶段       | 实现                                                                       | 出处                                                             |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 合并       | `AgentStreamCoalescer`，窗口 `AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS = 60` | `packages/server/src/server/agent/agent-stream-coalescer.ts:3` |
| 语义合并     | `collapseEntries` 把同窗口的文本增量**拼接成一段**再发                                   | 同上 `:261-282`                                                  |
| 合并→落库→广播 | `onFlush` 直接调用 `recordAndDispatchTimelineItem`                           | `agent-manager.ts:752-759`                                     |
| 落库       | timeline 是**内存数组** `{ epoch, rows, nextSeq }`，`cloneRow` 是浅拷贝 `{...row}` | `agent-timeline-store.ts:17-27`                                |
| 广播       | 事件**只序列化一次**，按 source 复用 `serializedEvent`                               | `session.ts:1188-1248`                                         |
| 投递范围     | selective delivery：只发客户端**正在查看**的 agent                                  | `session.ts:1238-1243`                                         |
| 客户端提交    | 事件入队，`requestAnimationFrame` 提交，48ms 定时器兜底                               | `session-stream-reducers.ts:1748-1908`                         |
| 存储结构     | 历史 `tail` 与实时 `head` **分成两个身份域**                                         | 同上 `:1920-1943`                                                |
| 行身份保持    | `areLayoutItemsEquivalent` 复用 layout item 身份                             | `agent-stream/layout.ts:252-276`                               |
| 行 memo   | `HistoryStreamRow` 在「item 身份 / layout 身份 / renderer」上 memo               | `agent-stream/view.tsx:229-238`                                |
| 逐帧绘制     | `computeRevealStep`：每帧释放 `ceil(backlog × elapsed / 150ms)`，下限 1 字符       | `agent-stream/text-reveal.ts:36-61`                            |

---

## 二、五道边界，逐条对比

### 边界 1 —— 速率：在 daemon 侧收敛，而不是在客户端节流

**Paseo**：`AgentStreamCoalescer.handle` 对每个 agent 维护一个待发缓冲。`isTerminalToolCall` 为真（工具调用完成/失败/取消）时立即 flush；否则走 leading + trailing：

```ts
// agent-stream-coalescer.ts:119-131
// Leading edge: the first event after an idle window flushes synchronously so
// the first token of a turn isn't delayed a full window. Sustained bursts fall
// through to the trailing timer, which keeps the message rate at one per window.
if (!buffer.timer) {
  const elapsed = buffer.lastFlushAt === null ? Number.POSITIVE_INFINITY : this.now() - buffer.lastFlushAt;
  if (elapsed >= this.windowMs) { this.flushBuffer(agentId); return true; }
  this.scheduleFlush(buffer);
}
```

关键在于合并点位于**落库与广播的上游**（`agent-manager.ts:755`：`onFlush → recordAndDispatchTimelineItem`）。所以"录制 / 广播 / 渲染"三者看到的都是合并后的**一条**。

**CodeMUX 现状**：sidecar 有 50ms 批处理（`sidecar/src/streamEventBatcher.ts`），但——

1. 批内含的是**逐条 `text_delta`**，并未在语义层拼接（见 `streamEventBatcher.test.ts:27-30` 的断言）；
2. daemon 收到 `codemux_event_batch` 后**把批次摊平回逐条**（`timeline_persist.rs:88-100`，函数文档原话："batch messages are flattened"）；
3. 广播路径**每个事件一个 WS 帧**，无任何合并：

```rust
// companion/server.rs:1215-1221 —— 一轮循环处理一个事件，发一帧
event = rx.recv() => {
    match event {
        Ok(CompanionBroadcastEvent { session_id: event_session_id, event }) if event_session_id == session_id => {
            let payload = serde_json::json!({ "type": "event", "sessionId": session_id, "event": event });
            if socket.send(Message::Text(payload.to_string().into())).await.is_err() { break; }
```

即：**生产端做了传输层批处理，中间又被拆回逐条**。等于白批一层。

> 上一轮我已修掉同一分支里的冗余 `state` 帧（`server.rs:1222-1235`），帧数减半。但**每事件一帧**这个结构没变。

### 边界 2 —— 体积：在进入管线之前截断（**收益最大**）

**Paseo** 有一条极短但极关键的不变量（`docs/timeline-sync.md:17-20`）：

> Tool output is bounded before it enters either delivery path. Canonical shell tool output is sliced to 64 KiB, **and the same bounded item is used for runtime timeline rows and live stream events**. Provider history hydration applies the same rule so reopening an agent cannot restore an oversized tool payload.

实现（`agent-timeline-content.ts`）：

```ts
const TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024;   // :4

export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  item = limitFailedShellError(item);
  item = limitPlainText(item);
  // ... shell output 同样 slice 到 64KiB
}
```

截断点覆盖 shell `output`、`plain_text`、以及 failed 的 `error.content`，且**录制与广播共用同一个已截断对象**。

**CodeMUX 现状**：**全仓没有对 agent 工具输出的任何体积上限。** 已核验：

- 全 `src-tauri/` 搜索 `MAX_*_BYTES/CHARS/LEN/SIZE/CONTENT/OUTPUT/PREVIEW`、`64 * 1024`、`65536`、`1_048_576` —— 命中项全部与工具输出无关（skills 元数据、git 指令字数、diff 上限、历史导入上限、HTTP body 上限）。
- 唯一的内联上限是 HTTP 请求体 `MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024`（`companion/server.rs:53`）—— 对本地通信而言等同无上限。
- 前端只有**流式文本预览**的上限（`appendStreamingPreview`），对 `tool_result` 无效。

**后果链条**：Read 工具读回整个文件 → `tool_result` 事件数 MB → 经 IPC（stdin/stdout）→ daemon `persist_and_stamp` 里 `clone()` 两轮（`timeline_persist.rs:133/146`）→ 写 SQLite → 一帧 WS 发到前端 → 客户端 `convertAgentEvents` 对它做 `structuredClone`。

这条链条与上一轮实测到的 **"最长 94–105ms"的长任务签名完全吻合**（多兆字节结构化克隆的耗时量级）。上一轮我用 WeakMap 把"每次转换都克隆"降到"每个事件克隆一次"，**但单次克隆的成本仍然由这个体积决定**。Paseo 的做法是根本不让这个体积存在。

### 边界 3 —— 渲染范围：历史与实时分属两个身份域

**Paseo** 的 store 把时间线分成 `tail`（权威历史）与 `head`（本地实时覆盖层）。流式期间 `changedTail === false`，于是提交时**不 patch `tail`**，历史数组引用保持不动：

```ts
// session-stream-reducers.ts:1928-1943
commit: (agentId, result, events) => {
  if (result.changedTail || result.changedHead || ...) {
    setAgentStreamState(serverId, agentId, {
      ...(result.changedTail ? { tail: result.tail } : {}),   // 只有变了才换引用
      ...(result.changedHead ? { head: result.head } : {}),
```

历史行的重渲染由**身份变化**驱动，而不是数据变化驱动，三层配合：

1. `layoutStream` 用 `areLayoutItemsEquivalent`（`layout.ts:252`）保住未变的 layout item 身份；
2. `useRevisedHistoryRows`（`history-row-revision.ts:28`）只给"内容或显示态真的变了"的行换新身份，其余**原样透传引用**；
3. `HistoryStreamRow` 在「stream item 身份 / layout item 身份 / renderer」上 memo（`view.tsx:229`）。

官方文档把这个 memo 边界的收益量化了（`docs/agent-stream-performance.md:34-42`）：

> The inverted FlatList hands every mounted cell a new `index` and `ref` whenever a row is prepended, so **without a memo boundary each coalesced tick re-rendered every mounted row (about 50 on a phone, 100–250 ms of JS per tick)**.

**CodeMUX 现状**：`convertAgentEventsToAssistantMessages` 是 `useMemo([events, conversationTurns])`，`events` 一变就**遍历全部历史重算**。没有"历史身份稳定"这一层不变量。

> 注意一处**需要澄清的地方**：CodeMUX 的流式文本增量（`text_delta`）进的是 `streamingText[sessionId]` 这个字符串缓冲 + `streamingVersion++`，**并不逐条 append 到 `events`**（`agentStore.ts:2064` 起，走 `queueStreamingDelta`）。`events` 的增长发生在内容块完成、工具调用完成等边界（如 `agentStore.ts:2428` 起的 assistant 收尾路径）。所以"每个 delta 触发全量重转换"这个说法**不准确**；准确的说法是**每次 `events` 变化（工具/内容边界）都要遍历全部历史**，而在"读取 N 个文件"这类场景里，这些边界恰好频繁且每个都携带大 payload。

### 边界 4 —— 提交频率：每帧一次 commit，而不是每事件一次

**Paseo** 把事件**入队**，再在帧边界成批提交（`session-stream-reducers.ts:1748-1908`）：

```ts
// :1877-1895
// Commit deltas on a frame boundary so text lands in step with paint instead of on
// an arbitrary timer that drifts on and off the display beat. A frame callback
// never fires in a hidden tab, so a timer races it and wins when nothing is
// painting — the store has to keep advancing either way.
function scheduleAgentStreamReducerFlush(callback: () => void): number {
  const timerId = setTimeout(run, AGENT_STREAM_REDUCER_FLUSH_DELAY_MS);   // 48ms
  const frameId = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : null;
  ...
}
```

批内用 `processAgentStreamEvents` 在一个循环里连续应用，只有最后 `commit` 一次 store 写入。

注意其中两处设计意图，都与本项目的历史症状直接相关：

- **帧对齐**："text lands in step with paint"，避免定时器与显示节拍漂移；
- **定时器兜底**："a frame callback never fires in a hidden tab" —— 这正是我们前几轮遇到的"窗口失焦时计时器冻结"的**正确应对**：不是把 rAF 当唯一时钟。

**CodeMUX 现状**：事件到达即处理，`events` 的每次变更都是一次独立 store 写入 → 一次 React commit，**没有批内合并、没有帧对齐**。

### 边界 5 —— 绘制节奏：到达决定目标，渲染速率由 backlog 推导（**CodeMUX 完全缺失**）

这是 Paseo 处理得最讲究的一层，也是"手感流畅"的直接来源。文档把动机写得很清楚（`docs/agent-stream-performance.md:20-24`）：

> Arrival is lumpy and there is no fixing that at the source. A 60ms coalescing window carries however many characters the model produced in those 60ms, which **swings by an order of magnitude within a single turn**. Painting each delta as it lands makes the size of those lumps visible, and that is what reads as jagged.
>
> So arrival sets a *target* and the reveal rate is derived from the backlog instead. A burst makes the text catch up faster; it does not make the text jump. **Shrinking the coalescing window does not fix this.**

核心算法是纯函数（`text-reveal.ts:36-61`）：

```ts
export function computeRevealStep(input: { backlog: number; elapsedMs: number; horizonMs?: number }): number {
  const { backlog } = input;
  if (backlog <= 0) return 0;
  const horizonMs = input.horizonMs ?? TEXT_REVEAL_HORIZON_MS;   // 150
  if (horizonMs <= 0) return backlog;                            // 0 = 关闭节流（对照基线用）
  const elapsedMs = Math.min(Math.max(input.elapsedMs, 0), MAX_ELAPSED_MS);  // 250 上限
  if (elapsedMs >= horizonMs) return backlog;
  const step = Math.ceil((backlog * elapsedMs) / horizonMs);
  return Math.min(backlog, Math.max(1, step));
}
```

配套的五条不变量（同一文档 `:26-33`）：

| 不变量                     | 含义                      | 出处                                   |
| ----------------------- | ----------------------- | ------------------------------------ |
| store 存全文，只有渲染切片被节流     | 复制/选中/大纲/滚动几何与屏幕一致      | `text-reveal.ts:11-13`               |
| **首次见到一段文本整段渲染**        | 历史补全、时间线回放、虚拟化行重挂载都无需特例 | `beginTextReveal` `:136-138`         |
| **离开 `streaming` 立即补全** | 已完成的回合绝不残留半截文字          | `completeTextReveal` `:168-173`      |
| 提交按 60Hz 对齐             | 高刷屏不会以硬件帧率渲染            | `nextTextRevealFrame` `:108-121`     |
| 剪裁点对齐字素簇                | 不会把 emoji / 组合字符拆开闪一下   | `clampToSafeRevealBoundary` `:87-97` |

**实测收益**（文档 `:50-59`，2026-08，Expo web + 本地 dev daemon + 真实 Claude Haiku，约 8.5s 采样；对照列是把 `TEXT_REVEAL_HORIZON_MS` 设为 0 即"到达即绘制"）：

| 指标                   | 到达即绘制 | 分帧绘制     |
| -------------------- | ----- | -------- |
| 推进了文字的帧占比            | 6%    | **87%**  |
| chars-per-frame 变异系数 | 4.11  | **1.86** |
| 可见更新间隔 p50           | 317ms | **17ms** |
| 可见更新间隔 p95           | 383ms | **17ms** |

官方的解读值得原样保留：**"总字符数两者基本相同——它改变的是字符什么时候落地，不是落多少。"**

**CodeMUX 现状**：完全没有这一层。`agentStore` 的 50ms 窗口（非 Claude 走 leading + trailing）只做了**速率上限**，没有做**均匀化**。批次大小在一个回合内可能相差一个数量级，而批次直接上屏 → 用户看到的就是"一顿一顿"。

> 这解释了前几轮的一个判断偏差：我当时把非 Claude 的 leading-edge 双触发视为"频率是设计值 2 倍"的问题。**按 Paseo 的框架，那是"批次不均匀"的问题，不是"批次太多"的问题。** 减少批次数量不会改善观感，反而会加重不均匀；正确的方向是保持速率、让其均匀落地。


## 四、它怎么度量"流畅"

这是本项目最该直接抄的一节。Paseo 有专门的 e2e 门禁（`docs/agent-stream-performance.md:44-61`）：

- **测试文件**：`packages/app/e2e/browser/agent-stream-smoothness.spec.ts`，由 `PASEO_AGENT_STREAM_PERF_E2E=1` 开启。
- **两个指标必须同时看**：
  - `chars-per-frame 变异系数` —— 平滑度；
  - `可见更新间隔 p95` —— 停顿。
  - 文档警告：**"两个数都要看：一个完全停顿的流是完美平滑的。"**
- **可复现的复现源**：mock provider 的 `bursty-stream` 模型（`mock-load-test-agent.ts`）产生不均匀的 token 串 + 空闲间隔，**突发大小来自种子生成器，所以同一次运行可精确复现**。
- **策略可脱离渲染器测试**：`computeRevealStep` 是纯函数，`text-reveal.test.ts` 覆盖收敛性与突发削平。
- **测量口径的坑也写下来了**（`:61`）：要累加**所有** `assistant-message` 元素的总长度，不能只采样最后一个——一个回合会产出多条 assistant message，尾部元素身份一直在换，长度非单调，只采尾部会把交接读成"重置"从而报告几乎没有增长。

**对照 CodeMUX**：现有的 `PerfOverlay` 只有 FPS、内存、WS 帧速率、长任务/秒。**缺的正是"平滑度"这个用户真正在抱怨的量。** FPS 高不代表手感流畅（Paseo 的对照列就证明了：到达即绘制时总字符数一样，但 p95 间隔 383ms）。

---

## 五、对 CodeMUX 的建议

按"投入产出比"排序。**第一梯队三项都是小改动，且与我们已定位的根因重合。**

### 第一梯队

**① 在 daemon 侧给工具输出加体积上限（对齐 64KiB）**

- 落点：`src-tauri/src/agent/timeline_persist.rs` 的入口处（或 sidecar 产出 `tool_result` / `tool_finished` 时更早），对 `tool_result.content`、shell output、失败 error 内容做 slice。
- 必须遵守 Paseo 的同一条纪律：**录制与广播共用同一个已截断对象**，避免"库里是截断的、WS 发的是全量"这种分裂。
- 收益贯穿全链路：IPC 体积、DB 行大小、WS 帧大小、客户端 `structuredClone`、Markdown 渲染、语法高亮**同时下降**。
- 需要产品取舍：截断后 UI 要给出"内容已截断"的提示与查看全文的出口。

**② 把"每事件一帧"改为"每帧一帧"（客户端帧边界提交）**

- 落点：`src/stores/agentStore.ts` 的事件处理入口 —— 改成**入队 + `requestAnimationFrame` 提交**，用定时器兜底（Paseo 用 48ms；CodeMUX 的流式窗口是 50ms，可取相近值）。
- 关键细节照抄 Paseo 的注释精神：**rAF 在不可见标签页不触发，必须有定时器竞速兜底**，否则后台会话的 store 会停止推进。
- 顺带把 daemon 侧的逐事件广播也合并（见 ③），两侧一起收敛才有意义。

**③ 合并点前移：daemon 不要摊平 sidecar 的批次**

- 落点：`timeline_persist.rs:88-100` + `companion/server.rs:1215` 的循环。
- 目标形态与 Paseo 一致：**合并发生在"落库 + 广播"的上游**，同一批文本增量在语义层拼成一条（`collapseEntries` 的做法），落一条 row、发一帧。
- 注意保留现有语义：工具调用终结事件要**立即 flush**（Paseo 的 `isTerminalToolCall` 分支），否则权限弹窗、工具结果会延迟一个窗口。

### 第二梯队（结构性的"手感"层）

**④ 新增分帧绘制（paced reveal）**

- 形态：**新增一个纯函数模块**（移植 `computeRevealStep` 及其不变量）+ **一个薄 hook**（只管 rAF 接线）。Paseo 明确把"策略"和"帧时钟"分开，策略可脱离渲染器测试——这个切分值得照做。
- 必须实现的不变量，按重要性：
  1. **首次见到一段文本整段渲染**（否则历史补全会闪）；
  2. **离开 streaming 立即补全**（否则回合结束残留半截字）；
  3. 按时长归一而不是按字符数（`backlog × elapsed / horizon`），这样突发会"追赶"而不是"跳跃"；
  4. 剪裁点对齐字素簇（用 `Intl.Segmenter`；Chromium 支持，不支持的运行时退回"到达即绘制"）。
- 与现有 50ms 窗口的关系：**不是替换，是叠加**。50ms 窗口决定"多久收到一批"，reveal 决定"每帧画多少"。上一轮的 leading-edge 设计（首字立即上屏）应保留。
- 这一项直接对应"用户抱怨的那个感觉"，但**需要一个新的度量才能验证**（见 ⑥）。

**⑤ 引入"历史身份稳定"这一条不变量**

- 不建议照搬 Paseo 的 `tail`/`head` 双数组（其依赖"权威历史 + 乐观本地提交"模型，与 CodeMUX 会话模型不同，直接搬风险高）。
- 可先只取其中**与数组结构无关的那一条**：`convertAgentEventsToAssistantMessages` 的产物——对未变化的事件，**其投影对象引用必须保持稳定**，让消息行组件的 `memo` 真正生效。
- 可参考 Paseo 的三层配合：布局层做等价性判断 → 只给变化的行换身份 → 行组件在身份上 memo。
- 相关：本项目的 `WeakMap` 克隆缓存（`convertAgentEvents.ts:928-937`）已经是"按身份"的思路，这一条是它的自然延伸。

### 第三梯队（验证能力）

**⑥ 补一个"平滑度"指标 + 可复现的突流 mock**

- 在 `PerfOverlay` 增加两个读数：**可见更新间隔 p95**、**每帧增长字符数的变异系数**。口径注意累加**所有**消息元素的总长度，不要只采样最后一个。
- 加一个种子化的 bursty mock 事件源，使"复现 → 修复 → 复测"可比。当前我们只有 `bursty` 之外的真实会话，不可复现。
- 这项不是"锦上添花"——前几轮我三次判断被推翻，靠的正是上一轮新增的 `长任务/秒` 与接通的 `IPC/秒`。**没有度量就只能靠猜。**

---

## 六、不能照搬的地方

| Paseo 的做法                    | 为什么不直接照搬                                                |
| ---------------------------- | ------------------------------------------------------- |
| 无数据库，timeline 只在内存           | CodeMUX 的权威源定位不同（daemon 是权威、需跨客户端一致）；但"热路径无同步 IO"这条结论适用 |
| `tail` / `head` 双数组          | 服务于它的权威历史 + 乐观本地提交模型；CodeMUX 会话模型不同                     |
| selective delivery（≤5 agent） | 需要先确认多会话并行场景；影响通知与后台会话                                  |
| 渲染原语是 RN 的 View/Text         | CodeMUX 是 DOM/CSS，具体行组件实现不可移植                           |
| `Intl.Segmenter` 字素切分        | 不可用时 Paseo 会退回"到达即绘制"；Electron/Chromium 支持，不受影响         |

**好消息**：第五节里的五道边界，**全部与渲染器无关**（速率、体积、身份、提交频率、绘制节奏），所以可移植性不依赖 RN vs DOM。

---

## 七、置信度与未验证项

**已验证（本次逐行读过源码）**

- 第二节全部代码引用与行号。
- "Paseo 工具输出 64KiB 上限"：`agent-timeline-content.ts:4` 及其文档不变量。
- "CodeMUX 无工具输出体积上限"：全 `src-tauri/` 检索未命中任何相关上限；`MAX_REQUEST_BODY_BYTES` 为 64MB。
- "CodeMUX 每事件一 WS 帧"：`companion/server.rs:1215-1221`。
- "CodeMUX daemon 摊平批次"：`timeline_persist.rs:88-100` 及其函数文档。
- "CodeMUX 流式文本为字符串缓冲而非逐条入 events"：`agentStore.ts:2064` 起。

**未验证（重要）**

- 我**没有运行 Paseo**，也没有测它的 FPS。"Paseo 很少卡"是用户的主观观察，加上其自建 e2e 门禁的存在作为支撑的推断；我没有独立复现。
- 第四节表格里的数字（317ms → 17ms 等）是 **Paseo 团队 2026-08 在 Expo web 上测的**，**不是 CodeMUX 的实测**，只能当量级参考，不能当预期收益。
- "体积无界是 CodeMUX 当前第一瓶颈"这个排序，建立在上一轮实测的 ~100ms 长任务签名（与多兆字节结构化克隆的量级吻合）之上，**是推断而非直接测量**。要坐实它，建议先做一次对照实验：临时把 `tool_result` 内容截到 64KiB，看"长任务累计"是否显著下降。
- 上一轮接通的 `IPC/秒` 读数为 4–12 帧/秒，与本节的"每事件一帧"在数量级上**似乎不一致**（若真按 token 速率逐条广播，应有数十帧/秒）。可能原因：该读数取自"读取文件"阶段而非文本流式阶段，或该截图早于接线改动。**建议在纯文本流式期间重测该数值**，再决定 ③ 的优先级。

---

## 附：一页速查

| 层级    | Paseo                                          | CodeMUX                       | 优先级 |
| ----- | ---------------------------------------------- | ----------------------------- | --- |
| 体积    | 进入管线前截断 64KiB，录制/广播共用同一对象                      | **无任何上限**                     | ★★★ |
| 速率    | daemon 侧合并（≤1 条/60ms/agent），合并点在落库与广播上游        | 生产端批处理，中间被摊平回逐条，每事件一帧         | ★★★ |
| 提交频率  | 入队 + rAF 提交 + 定时器兜底                            | 事件到达即写 store                  | ★★  |
| 绘制节奏  | 每帧释放 `ceil(backlog × elapsed / 150ms)`，下限 1 字符 | 无                             | ★★  |
| 重渲染范围 | 历史身份稳定，行在身份上 memo                              | `useMemo([events])` 全量重算      | ★★  |
| 存储    | 内存数组 + 浅拷贝；持久化交给 provider JSONL                | SQLite + async 内同步锁 + WAL（新加） | ★   |
| 序列化   | 一次序列化，多订阅者复用                                   | 每个订阅者重建 payload               | ★   |
| 投递范围  | 只发正在查看的 agent（≤5）                              | 全量                            | ★   |
| 度量    | 平滑度（CV + p95 间隔）+ 种子化 bursty mock + 纯函数策略测试    | FPS/内存/长任务/帧速率                | ★★  |
