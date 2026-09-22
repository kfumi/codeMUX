# 参照 PI-Desktop 的性能改造清单：流式掉帧与空闲卡顿

- 日期：2026-09-21
- 参照对象：`D:\project\PI-Desktop`（vastsa/PI-Desktop，HEAD `0111e306c`，Electron + React + Rust host-core）
- 调研对象：本仓库 CodeMUX（Electron 外壳 + 统一前端 `src/` + Rust daemon + Node sidecar）
- 现象：**实时对话时明显掉帧；不对话时也有静态卡顿，只是程度轻**
- 方法：双仓库静态代码走查 + `git log`/`git show` 读性能提交 + 读两边已沉淀的性能文档（PI-Desktop 的 ADR / decisions-log，本仓库的四轮排查报告与长会话 spec）
- 结论：CodeMUX 已经吸收过 PI-Desktop 的一个决策（有界挂载窗口，见 `docs/specs/2026-09-18-long-session-render-scale.md:77,191`），但**流式路径上还有两块结构性缺口**（memo 边界 / 增量 Markdown 高亮），**空闲路径上有五处 PI-Desktop 明确避免或硬禁的开销**，另有**一处 CodeMUX 做了、PI-Desktop 明确否决过的机制**（rAF 分帧绘制）值得重估。

---

## 一、两边已有的共同底座（不重复论证）

本仓库前五轮的成果与 PI-Desktop 已经对齐的部分：

| 机制 | CodeMUX | PI-Desktop |
|---|---|---|
| delta 而非全文上链 | ✅ `agentStore.ts:441-477` 只传增量，预览上限 16KB | ✅ `message-stream.ts:62-74` `toWireMessageUpdate` |
| 工具输出体积上限 | ✅ `boundEventVolume.ts`（64KiB / 256KiB） | ✅ `agent-host.ts:1035-1047`（1MiB 帧上限 + 2000 字预览） |
| 有界挂载窗口 | ✅ `src/lib/threadWindow.ts`（8/30/20 轮） | ✅ `lib/transcript-window.ts`（15/60/40 行，ADR 0130） |
| 离屏跳过布局绘制 | ✅ `globals.css:38-41` `content-visibility` | ✅ `messages.css:7-22` |
| 历史对象身份复用 | ✅ `assistantMessageIdentity.ts` | ✅ `reuseTranscriptEntries` |
| 单代发布（一次 append 一代） | ✅ `agentStore.ts:3867-3882` | ✅ `applyMessageUpdate` 无变化短路 |
| 持久化不阻塞事件循环 | ✅ `spawn_blocking` + SQLite WAL | ✅ host-core 侧异步 |
| 流式不被逐帧整树重渲染驱动 | ✅ 派生布尔 `hasStreamingBuffer` | ✅ 历史/尾部拆 memo |
| 防"先渲染全量再砍回" | ✅ 首帧 render 期派生 | ✅ `e28300066` |

**所以本轮要谈的不是"从零优化"，而是剩下的结构性缺口。**

---

## 二、流式路径：PI-Desktop 有、CodeMUX 缺的机制

### 2.1 【最高收益，已实测 + 已实施第一步】历史与流式尾部的两个 memo 边界

**PI-Desktop**：`features/chat/transcript/` 把完成的历史与流式尾部拆成**两个独立的 memo 边界**——
`TranscriptHistory`(memo) 与 `TranscriptTail`(memo) 并列，配合 `reuseTranscriptEntries` 逐槽位复用
数组与对象身份。流式 token 只让尾部出现新 commit，**历史树的重建在 `TranscriptHistory` 的比较器
第一层就被身份短路**。历史提交 `1654e8144` / `8a04fc8b0` 就是这件事。

**CodeMUX 现状**：没有这条边界。取而代之的是一个**随 `events` 重建、扇出给每一行**的 context：

- `CodeMuxThread.tsx:99` 定义 `CodeMuxThreadRenderContextValue`
- `:546` `const threadRenderContextValue = useMemo(...)` —— 内含 `collapseInfoByEventIndex`、
  `activityRuns`、`subagentRunActivity`、`turnByEventIndex` 等全是新对象
- `:608` `<CodeMuxThreadRenderContext.Provider value={threadRenderContextValue}>`
- `:767`（用户行）与 `:844`（助手行）各自 `useCodeMuxThreadRenderContext()`

**Context 的值更新不受 `React.memo` 保护**——这是 React 语义，不是遗漏。因此**每一个事件提交
都会让全部已挂载行（稳态约 92 行）重新协调**，工单 03 的窗口只是把这个数字从 600 压到 92，
没有消除"每次提交全量协调"这件事。本仓库自己的报告也承认过这一点。

**改法**：把流式尾部（`StreamingContent` 及其状态行）从 context 消费面里摘出来，拆成独立组件，
让历史行只消费**按行稳定**的窄 props；context 里真正随事件变化的部分只传给尾部。
这是移植收益最大、语义风险最低的一条。

### 2.2 【高收益，成本已实测拆解】Markdown 分块与 Shiki 高亮的增量复用

**PI-Desktop**：

- `useBlocks`——累积文本按块缓存，**只有尾部未闭合块重新解析**；
- Shiki `LineCache`——按行增量 tokenize，**复用到首个不一致行**，之后用 `grammarState` 串链；
- **未闭合围栏延迟渲染**（`closedFence` 判定，避免 mermaid 在围栏未闭合时反复重跑）；
- 语言包按需 `import("shiki/langs/x.mjs")`；历史提交 `0cc184104` 收窄了语言集；
- `Markdown.tsx:232-253` 用 `IntersectionObserver` 把高亮推迟到进入视口。

**CodeMUX 现状**：`CodeMuxThread.tsx:2058-2062` 把**累积前缀（上限 16KB）整体**交给 `Streamdown`。
`Streamdown` 有块级 memo（`markdown-text.tsx:90-94` 的注释佐证），所以已完成块会被跳过——
**但尾部那个不断增长的代码块每个提交仍要重新分块 + 重新分词**，且
`StreamingContent`（`:1969`）**是普通函数组件，没有 `memo`**。

第四轮报告自己把这条列为"**真实的未知数**"（`round4-fixes` §五），
并且没有实测过。这条与 2.3 是同一个成本的两个出口。
**2026-09-21 实测修正**：上述"尾部块每个提交仍要重新分块 + 重新分词"里，
**"重新分词（Shiki）"部分被实测否定**——去掉 Shiki 后提交耗时几乎不变（5.12 节结论一）；
Shiki 的实际代价是首次使用时的 159–275ms 初始化阻塞，可用预热消除（5.12 节结论二）。
"重新分块 + 尾部块 DOM 重建"这半句仍成立，且是 662ms 的主体，但内部占比尚未拆分。

### 2.3 【已实测，结论：保留】分帧绘制（paced reveal）——PI-Desktop 明确否决过的机制

这是本次对照里**最需要决策**的一条。

**PI-Desktop D152（`docs/spec/08-meta/decisions-log.md:456`）原文结论**：

> **The renderer does not add a `requestAnimationFrame` typewriter state loop.** Assistant content
> renders each runtime stream chunk directly **through the incremental Markdown block cache**.

否决理由是：**重复的动画循环可能在持续流式期间触发 React 的 nested-update 守卫**。
也就是说 PI-Desktop 在同一个问题上**选择了"降低每次渲染的成本"而不是"用 rAF 把渲染铺匀"**。

**CodeMUX 现状**：第四轮反其道而行，加了 `useStreamingTextReveal`：

- `useStreamingTextReveal.ts:195` —— **常驻 rAF 循环**（注释明说"追平后不应停掉循环"，
  所以整个流式期间一直在排帧）；
- `:2023/:2024` —— 同一个气泡里**跑两个实例**（正文 + 思考），也就是**两条常驻 rAF 链**；
- `:192` —— 每帧无条件 `recordRevealFrame`（非 DEV 门控）；
- `:57` —— 提交节流 40ms ≈ 25Hz。

**而且代码注释自己写明了前提不成立**（`useStreamingTextReveal.ts:20-31`）：

> Paseo 可以在 60Hz 做分帧绘制，是因为它的每帧渲染只是一个纯文本 `<Text>`，没有解析成本
> —— 这个前提在 CodeMUX 不成立。

**建议**：不要凭直觉保留或删除，而是**先实测再决定**。仓库已经备好 A/B 开关
（`localStorage['codemux:textRevealHorizonMs']='0'` 关闭；`codemux:textRevealMinFrameMs` 降频）。
判据用现成的浮层三行：`长任务/秒` 累计、`StreamingContent`/`AgentThread` 的 commit 数与累计毫秒、
`流式平滑度` + `更新间隔 p50/p95`。**若 2.2 的增量高亮落地后，把 horizon 设大或直接关掉分帧绘制
能同时改善长任务与 commit 耗时，就应该回到 PI-Desktop 的路线。**

> **2026-09-21 已实测并下结论：保留现状 40ms 节拍。** 四条臂的真实引擎数据见 5.1；
> 顺带发现并修掉了 `horizon = 0` 这条 A/B 开关的真实缺陷（见 5.2）。

### 2.4 渲染侧节流：`setTimeout` 节流 → rAF 帧合并器 + 终止事件强制 flush

**PI-Desktop** 双层合并，两层都很短、无依赖：

- 生产端 `packages/agent-runtime/src/stream-coalescer.ts:60-133`：16ms 窗口，
  `key = sessionId\0parentToolCallId\0messageId`，同 key 的多个 delta 用 `mergeMessageUpdates`
  串成一条再 emit；**任何非 delta 事件先 `flushPending()` 再 emit**（`:108-112`），保证顺序不乱；
  reset 语义（provider 替换而非追加）也由合并函数处理。
- 消费端 `apps/desktop/src/lib/frame-batcher.ts:10-62`：`requestAnimationFrame` + `Map<key,value>`
  按 key 合并，`flushNow()` 供终止事件立即落地；无 rAF 环境降级 `setTimeout(...,16)`。
- 接线 `stores/slices/events-slice.ts:79-89,159-176`：`message_update`/`tool_update` 入队合并，
  **其它事件一律 `flushNow()` 后再处理**。

**CodeMUX 现状**：`agentStore.ts:275-282` 用 **`setTimeout`** 做 50ms（非 Claude）/100ms（Claude）
leading-edge + trailing 双触发，**不是 rAF**。它与 2.3 的分帧绘制**语义重叠**（一个按时间窗铺，
一个按帧铺），两套机制叠加是当前复杂度的主要来源之一。

**改法**：合并成一层。保留"终止/工具事件先 flush"的不变量（这条 PI-Desktop 和本仓库都对）。

### 2.5 daemon 保持批次边界（低成本、确定收益）

**现状链路**（本仓库）：

1. sidecar `streamEventBatcher.ts:4-5` 按 **50ms / 最多 100 条**聚合，写成一行 `codemux_event_batch`；
2. daemon `agent/timeline_persist.rs:117-140` 把 batch **摊平成 N 条**独立事件；
3. `companion/events.rs:25-48` **逐条** `broadcast_event`；
4. `companion/server.rs:1217-1237` **每个事件一个 WS 帧**。

**要点**：第四轮用"入站帧速率实测仅 4–12 帧/秒"否决了帧合并改造——但那个读数是在**纯文本流式**
期间取的，**不覆盖工具/子代理密集阶段**。而 `streamEventBatcher.ts:113-123` 显示：任何非 delta 事件
都会先 `flushStreamEvents()` 再单独写一行，**批处理在工具密集阶段退化为逐事件发送**（第三轮根因 10，
至今未修）。两者叠加时帧数可以高一个数量级。

**好消息**：前端**已经能处理批事件**（`agentStore.ts:1217-1226` 有 `case 'codemux_event_batch'`），
所以"一个批 = 一帧"是**客户端无需改动**的低成本改动。建议先补一次工具密集阶段的帧速率实测再动手
（沿用本仓库"不要用'应该会很贵'下结论"的纪律）。

### 2.6 其余可移植细节

| 机制 | PI-Desktop | CodeMUX 建议 |
|---|---|---|
| 大 payload 产物不进热路径 | `file_snapshot` 由 host 侧按需读；RACP 快照只带 50 条 item | `file_snapshot.original_content` 懒加载（第四轮只做了"部分缓解"） |
| 热路径避免 `JSON.stringify` | `deltaStreamPayloadFits`（`chars*3 < maxBytes`）先廉价估长再决定是否序列化 | `boundEventVolume` 在唯一出口做截断时仍需序列化，可对常见小帧加估算快路径 |
| 中间态落盘节流 | `inflight-checkpoint.ts:8` 1.5s | 核对是否每个 delta 都触发 checkpoint |
| 长会话打开成本与历史解耦 | Rust `crates/host-core/src/transcripts.rs` 布局索引 + 按字节 `Seek`（ADR 0127，实测 3000 条 0.7–0.8ms vs 旧的 6→25ms） | 本仓库是 REST tail 拉 5000 条后**在主线程逐条 parse + normalize**（`agentStore.ts:3432-3435`） |
| 后台会话事件不驱动渲染 | `events-slice.ts:395-424` `cacheBackgroundTranscriptEvent` | 后台 scheduled 会话仍是 1s `/state` + 3s 全量重拉 |
| 滚动的读/写分离 | minimap 缓存偏移 + 二分，hover 绝不逐 dash 量几何（`46761cdb1`） | 工单 02 已做缓存 + 测量作用域，但每次失效仍是全项测量事务（`CodeMuxThread.tsx:1267-1289`） |

---

## 三、空闲路径：PI-Desktop 硬禁 / 明确避免、CodeMUX 仍在付的开销

### 3.1 【已实施】`backdrop-filter` 常驻

PI-Desktop 把它**当成不变量用测试锁死**：

```
apps/desktop/test/interaction-performance.test.mjs:380
  assert.doesNotMatch(styles, /backdrop-filter:\s*blur/)
```

全 `src/styles` 里 `backdrop-filter | filter: blur` **零命中**。历史提交 `7bfff4c10` 甚至专门
去掉了插件主题在设置面板上的 `backdrop-filter`。

**CodeMUX 现状**：约 **15 处** `backdrop-blur` / `backdrop-filter`，其中：

- `src/components/layout/MainLayout.tsx:216` —— **常驻侧栏** `backdrop-blur-xl`（收起时元素仍在 DOM）；
- `src/styles/globals.css:623-624` —— `.glass { backdrop-filter: blur(12px) saturate(1.02) }`；
- 多处悬浮层（`CodeMuxThread.tsx:1672`、`CodeMuxComposer.tsx:639,1077`、上下文菜单…）。

**并且方向相反**：`src/components/layout/MainLayout.test.tsx:119` **断言 `backdrop-blur-xl` 必须存在**。

> 对比：PI-Desktop 有一个测试**禁止** backdrop-filter；CodeMUX 有一个测试**要求**它存在。
> 这是本次对照里最直观、最容易动的一处。

改法：把常驻侧栏换成不透明/半透明纯色背景（PI-Desktop 的 `.sidebar-surface` 就是纯色），
只在**一次性、短命**的浮层上保留 blur（PI-Desktop 连这个都去掉了）。同时把那条测试断言反转。

> **2026-09-21 已实施**：侧栏去掉 `backdrop-blur-xl`、删除零引用的 `.glass`、把那条**反向断言**
> 反转，并新增源码级契约用例。见 5.5。注意这一项**没有**性能测量——它成立的理由是"blur 作用在
> 平整纯色上是恒等变换"，属于 CSS 事实，不是性能判断。

### 3.2 【已实施】轮询把整棵会话列表重渲染

**CodeMUX 现状**：

- `src/components/session/SessionList.tsx:113` —— 15s 轮询伴侣状态；
- `src/components/companion/CompanionSidebarButton.tsx:27` —— 12s 再轮一次；
- `src/hooks/useCompanionStatus.ts:24,32,42` —— 裸 `setInterval`，且**每 tick 先 `setLoading(true)`
  再 `false`**，所以每次轮询触发**两次**整树提交；而 `SessionList` 是整店订阅（`:99-112`）。

**PI-Desktop 对照**：渲染进程**全部** `setInterval` 只有 **9 处 / 7 个文件**，
**没有任何一处是会话列表 / token 用量 / context 用量 / git 状态的轮询**：

- 会话列表是**纯 push**：`useAppShellRuntime.tsx:618-624` 订阅 `IPC.event.sessionsChanged`；
- health 只在启动调一次（`app-store.ts:561`）；
- git 状态/diff 事件驱动 + 500ms debounce + window focus（决策 D140）；
- 其余 1s tick 全部门控在"**运行中/活跃**"而非"可见中"（`TurnProcess.tsx:55-60`、
  `ToolRow.tsx:323-328`、`ActivityGroup.tsx:481-489`…）。

改法：伴侣状态走 push，或至少把 `setLoading` 改成只在首次加载置位、并把 `SessionList`
的订阅粒度收窄到它真正用到的字段。

> **2026-09-21 已实施**：收敛成**模块级单例轮询**（一个定时器、一个请求、一份共享状态），
> 后台 tick 静默、内容未变不落状态、隐藏时跳过。见 5.6。

### 3.3 【已实施】`backgroundThrottling: false` 与"全仓定时器/动画不看可见性"叠加

- CodeMUX `apps/desktop/src/main.ts:255` 显式 `backgroundThrottling: false`（第二轮为了修
  "计时器卡住"加的，注释已写明代价是"遮挡时仍全速合成与跑定时器"）；
- PI-Desktop **没有覆盖该字段**（`electron/main/bootstrap/window.ts:203` 起只有
  `webPreferences` 基础项），即保留默认 `true`。

**PI-Desktop 能保留默认值而不出问题，是因为它空闲时根本没有常驻开销**：没有会话级轮询、
没有常驻无限动画（下面 3.4）、没有常驻 blur（3.1）、并且**删掉了内建终端**（3.5）。

**CodeMUX 现在两头都占**：既关掉了节流，又留下常驻 rAF 链（2.3）、常驻轮询（3.2）、
常驻 CSS 无限动画与常驻 backdrop-filter。窗口一旦被遮挡，这些全部按全价付费。

改法建议（二选一，不要两个都不做）：

- **A**：恢复默认节流，把 `RunningElapsed` 一类计时器改成**基于绝对时间戳重算**而不是累加 tick——
  这样"计时器冻结"的观感消失（回来的那一帧直接显示正确值），也就不再需要绕过节流；
- **B**：保留 `false`，但给所有轮询 / 动画 / 采样加 `document.hidden` + `visibilitychange` 门控
  （PI-Desktop 有 3 处 `visibilitychange`，可作模板：`useComposerDraft.ts:409`、
  `useSessionHoverCard.ts:67`、`ui.tsx:79`）。

> **2026-09-21 已按方案 A 实施**：移除 `backgroundThrottling: false`、保留默认节流，
> 并给计时器加恢复可见时的补刷。见 5.3。

### 3.4 常驻动画与绘制类动画

**PI-Desktop 的做法**：23 个 `@keyframes` 无限动画**全部挂在状态类上**——没有对话在跑、
没有 warning、没有加载态时这些动画**根本不存在**。且动画只动 `transform` / `opacity`
（`sessions.css:388-397` 的呼吸点只改 opacity + scale，box-shadow 环是静态的）。
`prefers-reduced-motion` 逐规则穷举覆盖 30 处 / 17 个 CSS 文件。

**CodeMUX 现状**：`.animate-pulse-soft`、`.animate-glow-pulse`、`.shimmer`
（`background-clip: text`，2.5s 无限）、`DotMatrix` 25 个 SVG 点的 infinite blink。
本仓库报告已经实测过其后果：这些都是**绘制类**动画，无法卸载到合成线程，
**主线程一满就全应用一起冻住**（`useStreamingTextReveal.ts:22-26` 有记录）。
`.shimmer` 这类"文字上跑高光"的写法，PI-Desktop 在 ADR 0149 里**专门删掉了**
（改为静态语义文字色 + 一个小状态标记），理由是可读性——顺带也去掉了持续重绘。

改法：把 `.shimmer` 换成静态文字 + 小标记（照 ADR 0149）；核对 `.animate-pulse-soft` /
`animate-glow-pulse` 是否真的只在活跃态挂载。

### 3.5 【终端部分已实施】隐藏面板仍然全速工作

**CodeMUX 现状**：

- `src/components/workspace/SidePanel.tsx:304-342` —— 终端与浏览器标签**永不卸载**，
  隐藏态只是 `pointer-events-none invisible`；
- `src/components/workspace/terminal/TerminalPanel.tsx:269-284` —— `handleEvent` **不看 `isActive`**，
  隐藏时仍把每个 PTY chunk `terminal.write(...)` 进 xterm，且 `cursorBlink: true`；
- `src/lib/browser/electronBrowserHost.ts:296-299` —— `hide` = `display:none`（注释自述"停放不销毁"）；
  `src/components/browser/BrowserPanel.tsx:75-80` 挂 `<webview>` 只依赖 `activePageId`，**不依赖 isActive**
  ⇒ 每个浏览器标签留一个活着的 Chromium guest 进程（自带定时器、动画、长连接）。

**PI-Desktop 对照**：

- `electron/main/browser-view.ts:229-317` —— 预览用 `WebContentsView`，**attach/detach** 而不是长期挂载，
  文件监听 `{ persistent: false }` + debounce，换目录先 close；
- `electron/main/plugin-watcher.ts` —— `MAX_WATCHED_PLUGINS=16`、debounce 300ms、忽略
  `node_modules/.git/dist/target`、timer `unref()`；
- **`docs/adr/0108-remove-built-in-interactive-terminal.md`** —— 干脆删掉了内建交互终端，
  打包里断言不含 `node-pty`。这是最彻底的"消除常驻后台开销"。

改法（不需要像 PI-Desktop 那样激进）：隐藏的终端暂停 `write`（缓存或丢弃），
`isActive` 进入 `BrowserPanel` 的挂载条件，隐藏标签 detach webview。

### 3.6 常驻诊断开销与回归防护的形态

**CodeMUX 现状**（原先常开，非 DEV 门控）：

- `useStreamingTextReveal.ts` 每帧无条件 `recordRevealFrame`——是**每帧**（流式期间实测 ≈60 次/秒），
  它在提交闸门**之外**，所以比"可见提交"（40ms 一次）密得多；采样数组上限 2048；
- `agentStore.ts` 的流式遥测 `logger.debug('Streaming flush telemetry')`——实测是**每个
  `content_block_stop` 一条**（1 秒突发里 1~2 条），**不是**"每次 flush 一条"；
- `agentStore.ts` 两条 `logger.info('MODEL_TRACE ...')`——量级是每回合 1 条 + 每会话 1 条。

> **2026-09-21 已实施**：以上四处全部收进构建期 DEV 门控
> （`src/lib/dev/devDiagnostics.ts`），并用产物 grep 证明 DCE 生效。见 5.11——那一节也**纠正了本节
> 原先两处错误归因**（"每 flush 一条"与"IPC + 落盘"）。

**PI-Desktop 没有运行时性能浮层 / `<Profiler>` / 埋点**（全仓库零命中），
它把回归防护放在**测试**里：

- `apps/desktop/test/interaction-performance.test.mjs`（390 行 / 19 用例）——**源码契约式**锁住性能写法：
  断言 frame batcher 被接线、pane 首帧有界、minimap hover 不逐 dash 量几何、**禁 backdrop-filter**；
- `scripts/e2e-transcript-render.mjs` —— 真实 Electron + Chromium 跑生产组件，
  用 esbuild 往 `ActivityGroup` 注入渲染计数器，断言**"一次流式文本更新只让一个 group 重渲"**，
  并额外校验构建产物 CSS 与源码一致（防止拿过期产物跑过）；
- `packages/agent-runtime/src/streaming-benchmark.test.ts` —— 量化合并收益（序列化字节 < 朴素快照 1/20，
  且 4k→40k 文本不是二次增长）；
- `scripts/check-architecture.mjs` —— **文件行数预算进 CI**（`app-store ≤1000`、`main/index ≤1500`、
  新增 `ts/tsx ≤800`、`rs ≤1000`）。

**改法**：把常开采样与遥测收到 DEV 门控后面；把"流式期间只有尾部重渲"这类不变量
**写成断言**（本仓库已有 `CodeMuxThread.navActiveSource.test.ts` 这样的源码契约测试，
可扩展）。CodeMUX 的分层测试（工单 01 的真实引擎探针 + `longSessionBenchmark.ts` 的计数型读数）
方向是对的，缺的是**把它接进 CI 并把常开开销关掉**。

### 3.7 其他空闲项

| 项 | CodeMUX | PI-Desktop |
|---|---|---|
| 大文件清单 | `agentStore.ts` 3919 行、`CodeMuxThread.tsx` 2295 行 | 行数预算进 CI（3.6） |
| 文件树预热 | `AgentPanel.tsx:214-218` 会话打开即无条件 `loadFileTree`，`previewStore.ts:313-319` 深度 5 | 按需 + 缓存 + 上限 |
| 主进程重活 | `electron/main/fs-index.ts` 同类风险；`d8f32feaa`/`ffbe3264a` 证明过扫描能冻结主进程几分钟 | `fs-index.ts:33-63` 已带 4s 超时 + 8000 上限 |
| 构建期 | 需核对 Vite 侧 minify 与 Shiki 语言集 | `electron.vite.config.ts:95-98` 显式 `minify:"esbuild"` + 剥离字体回退（JS 12.53→7.72 MiB）；`0cc184104` 收窄 Shiki |
| 窗口材质 | 未使用 transparent/vibrancy —— **保持现状** | `window.ts:187,189` 用了 `vibrancy:"sidebar"` + `transparent:true`，**它自己把这个列为静态卡顿的 TOP1 嫌疑** |

---

## 四、建议的落地顺序

按"证据充分度 × 收益 / 风险"排，前三项不需要新的实测即可动手。
**进展（2026-09-22 收尾）：1 / 2（叶子 5.8 + 行级 5.16）/ 3 / 4 / 5（预热 + 尾块增量 + 残余成本拆解）/
6 / 8（终端 5.7 + 浏览器按证据 5.23）/ 9（含后台完成探测改事件驱动 5.22）/ 11 均已实施；
「未闭合围栏延迟高亮」与第 7 项（rAF 合并器）按实测**否决**（5.19 / 5.20）；第 10 项已给读数（5.21）。
逐项证据见 5.1–5.26。**

| 序 | 事项 | 类型 | 依据 |
|---|---|---|---|
| 1 | ~~反转 `MainLayout.test.tsx:119` 的断言，去掉常驻侧栏与 `.glass` 的 `backdrop-filter`~~ → **已实施：侧栏去 blur、死规则删除、断言反转 + 源码契约** | 空闲 | 见 5.5 |
| 5 | ~~Markdown 尾块增量 + Shiki 逐行缓存 + 未闭合围栏延迟高亮~~ → **已实施预热（5.13）与尾块增量分块（5.14，−19%）并复核修复（5.15）；残余成本已拆解（5.18：尾块 ≈154ms、已闭合块 + React 协调 ≈394ms）；"未闭合围栏延迟高亮"据此否决（5.19）** | 流式 | 2.2 / 5.12–5.19 |
| 3 | ~~`useCompanionStatus` 每 tick 的 `setLoading` 与 15s/12s 轮询去重~~ → **已实施：单例轮询 + 静默 tick + 内容未变不落状态** | 空闲 | 见 5.6 |
| 4 | ~~常开 `recordRevealFrame` / 遥测 / `MODEL_TRACE` 收到 DEV 门控~~ → **已实施：构建期 DEV 门控，两臂计数型断言 + 产物 grep 证明 DCE** | 空闲 + 防护 | 见 5.11 |
| 5 | ~~Markdown 尾块增量 + Shiki 逐行缓存 + 未闭合围栏延迟高亮~~ → **已实施预热（5.13）与尾块增量分块（5.14，−19%）并复核修复（5.15）；残余成本已拆解（5.18：尾块 ≈135ms、已闭合块 + React 协调 ≈408ms）；"未闭合围栏延迟高亮"据此否决（5.19）** | 流式 | 2.2 / 5.12–5.19 |
| 6 | ~~分帧绘制 A/B 实测后决定保留 / 加大 / 移除~~ → **已实测，结论：保留**（并修掉附带发现的 `horizon=0` 缺陷） | 流式 | 见第五节 |
| 7 | ~~把渲染侧 `setTimeout` 节流换成 rAF 帧合并器~~ → **已实测并否决（5.20）：提交次数 +32%、总耗时 +22%，单次最长与长任务不变** | 流式 | 2.4 / 5.20 |
| 8 | ~~隐藏终端暂停 `write`~~ → **终端部分已实施（5.7）；浏览器面板隐藏态经证据核对后不改（5.23：`display: none` 已接线且有测试，卸载会丢 guest 状态）** | 空闲 | 3.5 / 5.23 |
| 9 | ~~`backgroundThrottling` 二选一~~ → **已实施：恢复默认节流 + 恢复可见时补刷计时器** | 空闲 | 见第五节 |
| 10 | ~~补一次工具密集阶段的帧速率实测，再决定 daemon 是否保持批边界~~ → **已给读数（5.21）：每帧 0.0081–0.0139ms ⇒ 批边界保持不动** | 流式 | 2.5 / 5.21 |
| 11 | ~~文件行数预算~~ → **已实施（5.24：`npm run check:size` + 30 个冻结基线 + 7 条单测）；构建期 minify/Shiki 收窄、文件树预热带条件仍属未验证** | 工程 | 3.6 / 3.7 / 5.24 |

---

## 五、实测与实施记录（2026-09-21）

### 5.1 工单 6：分帧绘制的 A/B 实测 —— 结论：**保留**

新建真实引擎探针 `scripts/e2e/stream-reveal-probe/`（`npm run test:e2e:stream-reveal-probe`）：
在无头 offscreen Electron 里用**真实** `useStreamingTextReveal` + **真实**
`CODEMUX_MARKDOWN_STREAMDOWN_PROPS`（含 Shiki code 插件）+ 真实 `Streamdown`，渲染一段含
持续增长代码围栏的 Markdown；上游按生产的 50ms leading-edge + coalescing 节流喂文本。
提交耗时/次数来自 `<Profiler>`——探针把 `react-dom` 别名到 profiling 构建，否则生产版 React
下 `onRender` 根本不会回调；长任务来自 `PerformanceObserver('longtask')`。

四条臂各跑 2 次取中位数（复现性极好，逐项偏差 <2%）：

| 指标 | `direct`（真基线＝完全不调用 hook） | `reveal-default`（现状 40ms） | `reveal-slow`（80ms） |
|---|---|---|---|
| 提交耗时合计 | 428.9ms | 676.3ms | 576.0ms |
| 提交次数 | 735 | 1453 | 1130 |
| 单次提交最长 | 14.2ms | 14.2ms | 12.0ms |
| 长任务合计 | 501.0ms | 482.5ms | 488.0ms |
| 可见更新/秒 | 14.7 | 28.9 | 22.8 |
| 可见更新间隔 p50 | 51.0ms | 28.8ms | 32.1ms |
| 可见更新间隔 p95 | 199.6ms | **53.3ms** | 92.2ms |
| 字符/次 变异系数 | 1.062 | **0.704** | 0.772 |
| 单次最大推进 | 264 字符 | **93 字符** | 152 字符 |
| hook 的 rAF 回调数 | 0 | 902 | 901 |
| 流式结束时屏上字符 | 9468 | 9463 | 9460 |

理由：

1. **手感收益是决定性的**：p95 更新间隔 200ms → 53ms（−73%），变异系数 1.06 → 0.70，
   单次最大推进 264 → 93 字符。这正是"一顿一顿"与"顺"的分界。
2. **"更贵"是真的，但绝对代价可忽略**：提交耗时 429 → 676ms（1.58×），**绝对增量 247ms 只占
   14s 流式的 1.8%**；而且**长任务合计没有变差**（501 → 483ms，0.96×），单次提交最长同样是
   14.2ms。多出来的工作被摊进了更多更小的提交，**没有击穿 16ms 帧预算**。
3. **"加大节拍"（80ms）不划算**：省下 100ms 提交耗时，p95 却从 53ms 退到 92ms。
4. **常驻 rAF 循环确实存在**（902 次回调 ≈ 独立帧钟 901，其中约 400 次真正提交），但空转部分
   是每帧几次算术加两次数组 push，在提交耗时之外且量级可忽略。PI-Desktop 在 D152 里否决 rAF
   typewriter 循环、改走"降低每次渲染成本"（增量 Markdown 块缓存），**两条路不互斥**：本次结论
   支持保留分帧绘制，同时 2.2 的增量高亮依旧值得做——它会同时降低这 1453 次提交的单次成本。

### 5.2 附带发现的缺陷：`horizon = 0` 不是"到达即绘制"，而是"流式期间什么都不画"

`useStreamingTextReveal` 的模块注释把 `localStorage['codemux:textRevealHorizonMs'] = '0'` 写成
"关闭分帧绘制（到达即绘制）"的 A/B 开关。实测（`horizon-zero` 臂）确认它**不是**：

- 流式结束时 store 正文 **9468 字**，屏幕上 **0 字**；中点采样同样 0 字；
- 单次提交最长 104.5ms——那一笔就是回合结束时把全部正文一次性渲染出来。

根因：那个 effect 的依赖数组是 `[streaming]`，所以 `horizon <= 0` 分支**只在挂载时跑一次**；
而 `revealedRef.current` 只由帧循环推进，帧循环在 `horizon <= 0` 时根本不会启动，于是它永远
停在挂载时的初始值 0 上。

后果不止是"看不见"：**这个仓库里没有人真正做过分帧绘制的 A/B 对照**——按注释去用这个开关的人
只会看到一屏空白，任何据此得出的结论都是反的。

已修复（`useStreamingTextReveal.ts`）：`horizon <= 0` 时直接渲染全文。修复后 `horizon-zero` 臂与
`direct` 臂逐项吻合（提交 739 vs 735、p95 199.2 vs 199.6ms），两条互相独立的"到达即绘制"
实现互为交叉验证。

### 5.3 工单 9：恢复 Electron 默认窗口节流

按 3.3 的方案 A 实施：

- `apps/desktop/src/main.ts`：**移除** `backgroundThrottling: false`，保留默认 `true`。
  遮挡/失焦时 Chromium 把渲染进程当后台页面（rAF 暂停、定时器先对齐到 1s 再降频），正好省掉
  遮挡期间的合成、轮询与动画——与 PI-Desktop 一致。
- 新增 `src/hooks/useRefreshOnVisible.ts`：在 `visibilitychange`（转为可见）与窗口 `focus` 时补一次
  刷新，接进 `RunningElapsedTimer` 与 `useLiveNow`。

**为什么原来的理由站不住**：这两个计时器的显示值一直按 `Date.now() - base` 绝对时间算，节流只
推迟**刷新时机**、不会算错值。为了一个显示时机问题关掉整窗节流，代价是把遮挡期间的全部开销
恢复全速——远超收益。

**已知取舍**：窗口被遮挡时 dev 浮层会读出个位数 FPS、长任务为 0。那是节流而非渲染慢；做性能
对照必须让窗口保持前台上屏（见第六节开头的纪律）。

### 5.4 本次改动清单

| 文件 | 改动 |
|---|---|
| `scripts/e2e/stream-reveal-probe/probe-entry.tsx`、`runner.mjs` | 新增：分帧绘制 A/B 真实引擎探针 |
| `package.json` | 新增 `test:e2e:stream-reveal-probe` |
| `src/components/agent/assistant-ui/useStreamingTextReveal.ts` | 修掉 `horizon <= 0` 的空白缺陷 |
| `src/components/agent/assistant-ui/useStreamingTextReveal.test.tsx` | 新增该缺陷的回归用例 |
| `src/hooks/useRefreshOnVisible.ts`、`.test.tsx` | 新增 hook + 5 条用例 |
| `src/components/agent/assistant-ui/RunningElapsed.tsx`、`src/components/assistant-ui/subagent-activity.tsx` | 接入恢复可见时的补刷 |
| `apps/desktop/src/main.ts` | 移除 `backgroundThrottling: false` 并改写理由注释 |

验证：`npx vitest run src/hooks src/components/assistant-ui src/components/agent/assistant-ui`
→ 38 文件 / 421 用例全通过；`npx tsc -p tsconfig.json --noEmit` 与
`cd apps/desktop && npm run typecheck` 均零错误（本仓库的 pre-commit 门禁就是 `npm run typecheck`）。

### 5.5 工单 1：去掉常驻表面的 `backdrop-filter`（**已实施**）

`MainLayout.tsx:216` 的常驻侧栏原本带 `backdrop-blur-xl`，而 `MainLayout.test.tsx:119`
**断言它必须存在**——与 PI-Desktop「用测试硬禁 backdrop-filter」方向正好相反。

**这里不提「应该会很贵」，因为这一处根本不需要性能论证**：侧栏背后是**平整的纯色**，
`blur` 对纯色是恒等变换。证据链都在 CSS 里：`globals.css:107` `--color-background: hsl(var(--background))`
（`--background` 是不透明常量 `0 0% 100%` / `0 0% 9.4%`）、`globals.css:251-263`
`body { background-color: var(--color-background); background-image: none }`、
`MainLayout.tsx:196` 根节点的 `app-shell … bg-background` 是同一纯色、
`globals.css:318-321` `.app-shell { position: relative; isolation: isolate }`；
而桌面形态下侧栏是 `relative shrink-0`，它背后除了这个纯色什么都没有。
也就是说这条 blur **只有开销没有观感收益**，且不依赖任何测量就能判定。

改动：

- `MainLayout.tsx:216` 删掉 `backdrop-blur-xl`（保留 `bg-[hsl(var(--surface-2)/0.88)]`），
  并在该 className 上方写明理由；
- 删除 `globals.css` 里**零引用**的 `.glass { backdrop-filter: blur(12px) saturate(1.02) }` 死规则；
- `MainLayout.test.tsx:119` 的断言反转为 `not.toContain('backdrop-blur')`，用例名与注释改成
  "这是不变量，不是少写了一个类"；
- 新增**源码级契约**用例：读 `MainLayout.tsx` 文本，断言常驻表面上不再出现 `backdrop-blur`
  （唯一豁免：`MainLayout.tsx:209` 窄屏遮罩那 1px blur，短命浮层，不在本次范围）。

**取舍**：窄屏抽屉复用同一个 className，所以它也不再模糊。这是有意的——那是 92vw × 全高的
大面积模糊、且背后正是**正在流式的内容**，正是最贵的一类用法；靠 88% 不透明底色依然可读。
一次性短命浮层（弹出菜单、popover、上下文菜单、设置页 sticky 头）的 blur 一律保留。

### 5.6 工单 3：伴侣状态轮询收敛成单例（**已实施**）

病灶（`useCompanionStatus.ts` 原实现）：`loadStatus` **每次调用**都先 `setLoading(true)`
再 `setLoading(false)`；而 `SessionList.tsx:113`（351 行、`useSessionStore` 整店订阅，却只取
`status` 一个字段）每 15s 被这两次状态翻转各打一次重渲染，`CompanionSidebarButton.tsx:27`
每 12s 同样两次；两个消费方还各自起了一个**互相独立**的轮询器（12s + 15s = 两条请求）。

改法：新增 `src/lib/companionStatusPoll.ts` —— 模块级单例（订阅集合 + 单一定时器 +
在飞请求合并 + **内容比较后保留旧引用** + `document.hidden` 跳过 + 恢复可见补拉一次），
`useCompanionStatus` 改用 `useSyncExternalStore` 读它；`loadStatus({ silent })` 默认保持旧语义，
只有内部节拍走静默路径。

**回归防护用计数型断言（不用毫秒）**，新增 4 条：

1. 两个消费方共用一个节拍 → 一个节拍只发一次 `getStatus`；
2. 轮询结果内容相同（引用不同）→ 消费组件**首帧之后零重渲染**（并对该用例做了变异验证：
   把内容比较短路成 `false`，用例立刻失败，说明它真的在守东西）；
3. 轮询是静默的 → tick 期间 `loading` 不再翻回 `true`；
4. `document.hidden` 时跳过该次轮询、恢复可见时补拉一次。

**行为变化（有意）**：节拍取所有订阅方 interval 的**最小值**（于是 15s → 12s，不改调用方就无法
只留一个定时器）；`status/loading/error` 由单例共享，`SessionList` 只消费 `status`，唯一消费
`error` 的是伴侣对话框；已有数据时后挂载的订阅方走静默刷新，不再闪 loading。

### 5.7 工单 8：隐藏终端不再解析输出（**已实施，终端部分**）

事实：`SidePanel.tsx:304-323` 让**所有**终端标签常驻挂载，只靠 `invisible` 隐藏；而
`TerminalPanel` 的 `handleEvent` 无条件 `terminal.write(...)`，`isActive` 只被滚动条与
`resize` 用到（`:145`、`:284`）。xterm 的 `write` 是同步解析的，所以一个在后台跑着 dev server
的标签会持续占主线程解析输出、推进 scrollback——**没人看得见它**。

改法：标签不在前台时把输出攒进 `pendingOutputRef`（上限 128 KiB；超限时**按行首**截断、
保留尾部并插入一行省略提示——直接按字符切会把 ANSI 转义序列切成两半，终端会把半截转义码当
普通文本渲染出来）；切回前台的那一帧在 layout effect 里一次性写入。

计数型断言 6 条（复核后又补了 3 条）：后台期间 `write` 调用数为 0；切回前台恰好一次且内容为
全部缓冲；前台时直接写入不缓冲；超限截断对齐 `\r`/`\n` 行界（不切坏 ANSI 序列）；尾部无行界时
整段丢弃只留提示；切回前台会补跑一次尺寸同步。

**取舍**：切回前台时一次性解析这段缓冲，是一次几毫秒到几十毫秒的突发；换来的是后台期间
的持续开销归零。超限时丢的是最早、已经滚出视野的内容，与 xterm 自身 scrollback 的语义一致。

**未做**：浏览器面板的 `<webview>` 仍是无条件挂载的（`BrowserPanel.tsx:75` 的 effect），
后台标签页里跑的 JS/动画/媒体不受我们控制。改成按 `isActive` 挂载会导致每次切标签**重载页面**
（丢页面状态、丢滚动位置），属于 UX 回退；应先实测"隐藏的 `<webview>` 是否真的没被 Chromium
节流"，有结论再决定。本次不动。

### 5.8 工单 2：事件追加的重渲染（**已实测 + 已实施第一步；行级收窄待做**）

**手法 1（毫秒，只作旁证）**：临时诊断（跑完即删）：复用 `CodeMuxThread.navActive.test.tsx` 的挂载
骨架，把 `threadWindowSizes` 设为轮数使**全量挂载**，用 `<Profiler>` 量"追加一个事件"这一次操作：
8 轮 3 次提交 / 38.7ms，40 轮 3 次提交 / 136.2ms——随挂载行数近乎线性（每轮约 +3.0ms）。
（jsdom + stub 掉 Markdown/Shiki，**只看规模效应、不看绝对值**。）

**手法 2（计数，本仓库的货币）**：把 `CodeMuxMessageParts` 的三个叶子用**同样带 `memo` 的**计数器
包一层，数"追加一个事件"让它们渲染了几次：

| 全量挂载 | 挂载行数 | 一次追加的叶子渲染次数（**修前**） | 修后 |
|---|---|---|---|
| 8 轮 | 24 | 33（text 17 + tool 16） | **1** |
| 40 轮 | 120 | **161**（text 81 + tool 80） | **1** |

约每行 1.35 次、与挂载行数严格线性 → **每来一个事件，所有已挂载的历史行都跟着重渲染一遍**。

**机理（已在代码里核过）**：`CodeMuxAssistantMessage`（`:826`）消费 `CodeMuxThreadRenderContext`
的**全部 15 个字段**；而 context value（`:546-578`）的依赖里有 `activityRuns`（`:526-531`，无缓存）、
`toolDurations`（`:391-405`，每次返回新对象）、`subagentRunActivity`（`:535-544`）。于是每次
`events` 身份变化 → context value 换身份 → 两个消费点（`:767` / `:844`）重渲染 →
`AssistantLikeMessage`（`:1690`，未 memo）→ 全部已挂载行。**React 的 `memo` 挡不住 context 变化**，
所以这**不是**"加几个 memo 就能解决"的问题。

**已实施的第一步（叶子层）**：`CodeMuxMessageParts.tsx` 的三个叶子全部包上 `memo` ——
`CodeMuxTextMessagePart` / `CodeMuxToolCallMessagePart` / `CodeMuxDataMessagePart`。

- **为什么它有效**：`MarkdownText` 早已是 `memo`（`markdown-text.tsx:141`），所以真正被反复付的是
  **叶子自身**的渲染——工具行尤其重（`getToolHeaderSummary`、状态解析、图标树与 Tooltip 结构）。
  这解释了为什么"给叶子加 memo"不是无用功：它消掉的正是 161 里的大头。
- **为什么语义安全**：这三个组件只读 props 与自己持有的订阅（`useSubagentStore`、
  `useSidePanelStore`、assistant-ui 的 `useMessagePartText`）。`memo` 只在浅比较相等时跳过渲染；
  那些订阅仍然独立触发渲染，所以不会出现"数据变了但界面不更新"。
- **配套改动**：工具行的 `args` 必须在**组件内部**用 `useMemo` 记住（把 `CodeMuxThread.tsx` 里
  只此一处的 `asRecord` 搬成叶子内部的 `asToolArgs`，调用点改为直传 `part.args`）——在调用方
  每次 render 新建一个对象会把 `memo` 直接击穿。

**守卫**：`src/components/agent/assistant-ui/CodeMuxThread.rowRenderCounts.test.tsx`。全量挂载 8 轮
与 40 轮各追加一个事件，断言"叶子渲染次数与挂载行数**无关**"且 ≤ 8；同时断言挂载行数 >20 / >100
作为**前置条件**，避免测试因"什么都没挂载"而假通过。需要读数时设 `CODEMUX_ROW_COUNT_TRACE=1`。

**仍未消除的部分（下一步：按行收窄）**：上面解决的是**叶子**层。被 context 变化击中的
`CodeMuxAssistantMessage` → `AssistantLikeMessage` **本身仍然会为每一行重渲染**（这是 React 的语义：
context 的消费者在 value 身份变化时必然重渲染，`memo` 拦不住它），每行还会重算
`getMessageText(message)` 之类的派生值。要消掉它只能按行收窄：

1. 抽出纯函数 `deriveRowBindings(message, collapseInfoByEventIndex, activityRuns, toolDurations,
   subagentRunActivity)` 作为该行派生值的**唯一真源**，渲染与比较共用它（否则比较器与渲染会各自
   漂移，产出"UI 不更新"的静默错误）；
2. 在 `CodeMuxThreadMessages`（`:724`）的 map 外层按 `messageId` 缓存 bindings；
3. 把 `AssistantLikeMessage` 包成 `memo`，比较 bindings 引用 + 稳定 props；
4. 守卫沿用同一套计数断言，把"叶子渲染次数"换成"**行**渲染次数"。

**风险**：`CodeMuxThread.tsx` 2295 行，该目录 34 个用例 + `CodeMuxAssistantRuntime` 74 个用例；
比较器写错会退化成"UI 不更新"。这一条应当**单独排一轮**，不要顺手做。

### 5.9 本轮改动清单与验证

| 文件 | 改动 |
|---|---|
| `src/lib/companionStatusPoll.ts` | 新增：伴侣状态单例轮询器 |
| `src/hooks/useCompanionStatus.ts`（+`.test.tsx`） | 改为 `useSyncExternalStore` 读单例；4 条计数型用例 |
| `src/components/layout/MainLayout.tsx`（+`.test.tsx`） | 侧栏去 `backdrop-blur-xl`；断言反转 + 源码契约 |
| `src/styles/globals.css` | 删除零引用的 `.glass` 规则 |
| `src/components/workspace/terminal/TerminalPanel.tsx`（+`.test.tsx`） | 后台标签缓冲输出、切回前台一次性写入 + 补尺寸同步；6 条计数型用例 |
| `src/components/agent/assistant-ui/CodeMuxMessageParts.tsx` | 三个叶子（text/tool/data）包 `memo`；`args` 规整搬进叶子并用 `useMemo` 记住 |
| `src/components/agent/assistant-ui/CodeMuxThread.tsx` | 工具行调用点直传 `part.args`；删除只此一处的 `asRecord` |
| `src/components/agent/assistant-ui/CodeMuxThread.rowRenderCounts.test.tsx` | 新增计数型守卫：一次追加的叶子渲染次数不得随挂载行数增长 |
| `src/lib/dev/devDiagnostics.ts`（+`.test.ts`） | 新增：构建期 DEV 门控；用例锁住"取值不缓存" |
| `useStreamingTextReveal.ts`（+`.devDiagnostics.test.tsx`）、`src/stores/agentStore.ts`（+`.test.ts`） | 4 处常开诊断入门控；DEV/非 DEV 两臂计数型用例 |
| `src/lib/codeHighlightWarmup.ts`（+`.test.ts`） | 新增：应用空闲时预热 Shiki 高亮器（12 条计数型用例 + `main.tsx` 源码契约） |
| `scripts/e2e/stream-reveal-probe/probe-entry.tsx`（+`runner.mjs`） | 新增 5 条诊断/探路臂、长任务时间线采集与自检读数、`CODEMUX_REVEAL_PROBE_ARMS` / `CODEMUX_REVEAL_PROBE_LONG_TASKS` |
| `src/lib/incrementalMarkdownBlocks.ts`（+`.test.ts`） | 新增：尾块增量分块（10 条用例：与真实参考实现逐前缀+逐字符对比、传给参考实现的字符量占比、`[^` 保守退让、接线源码契约） |
| `CodeMuxThread.tsx`、6 个 mock 了 `streamdown` 的测试 | 流式正文注入增量分块；同步补全 mock 门面（漏了会让 74 条用例变红） |

验证：`npx vitest run` → **234 文件 / 1892 用例全通过**（含叶子 memo 守卫、门控两臂用例、预热 12 条
与增量分块 10 条）；本轮首次门禁时根 `typecheck` 报出 `codeHighlightWarmup.ts` 的 `language` 需要收窄到
插件的语言联合类型，已按插件签名修好。`npm run typecheck` 与 `cd apps/desktop && npm run typecheck`
→ 均零错误。

### 5.10 复核（code-reviewer 只读复核）与据此的修复

对上面 5 组改动做过一次对抗性复核。**已修的真缺陷**：

1. **截断会切坏 ANSI 序列**：原实现只找 `\n`，找不到就退化成按字符切——正是注释声称要避免的
   那件事。`\r`（进度条覆盖同一行）也是行界，现在按 `\r`/`\n` 对齐；**尾部一个行界都没有**时
   （无换行的超长单行）整段丢弃、只留提示，因为此时任何字符级截断都可能吐出半截转义码。
2. **缓冲跨终端重建回放**：`codeFontSize` 一变就会重建 xterm（等于换了一条 PTY），而缓冲挂在
   ref 上会活过这次重建，于是新终端的屏幕上出现"新 shell banner + 旧会话尾部"。现在创建 effect
   一进来就清空缓冲。
3. **清空早于空值检查**：`pendingOutputRef.current = ''` 原本在 `terminalRef.current?.write()`
   之前执行，终端为 null 时缓冲被静默丢掉；现在先确认终端存在再清空。
4. **`exit` 提示从 CRLF 退化成 LF**：进程在行中间退出时光标不回零，之后的输出会从那一列续写。
   改回 `\r\n`。
5. **切回前台不补尺寸同步**（既有缺陷，正在同一代码路径上顺手修掉）：
   `resizeConnectedTerminal` 在非前台时直接 return，而 ResizeObserver 只在尺寸变化那一刻回调一次
   ——后台期间改过窗口宽度的话，切回来会一直用旧 `cols/rows`。现在激活时补跑一次（尺寸没变时
   内部去重，不会多打请求）。
6. **轮询单例的跨用例串味**：`resetCompanionStatusPollForTests` 取消不掉在飞的 promise，它落地时
   会写进下一个用例的模块状态。加世代号（`epoch`），遗留请求落地时直接丢弃结果。
7. **源码契约可被绕过 / 用例注释口径过大**：豁免改成"先摘掉 `backdrop-blur-[1px]` 再检查"
   （原来"含它就整行免检"，把 `backdrop-blur-xl` 追加到同一行即可绕过）；注释里"硬不变量"收窄为
   "常驻布局表面"，与实现（sticky 头仍保留 blur）一致。

**记录但不改（既有缺陷 / 需要先实测）**：

- **终端重建会泄漏 PTY**（既有，非本轮引入）：`TerminalPanel` 创建 effect 的依赖含
  `codeFontSize`，而 `ThemeToggle` 每点一次 ±1 就改它；重建时 `connect()` 因 `terminalIdRef`
  已被 cleanup 置空而走 `getOrStartTerminal`，daemon 每次都新开一条 PTY
  （`crates/daemon/src/terminal.rs:158-192`，不按 cwd 复用），旧会话只在"标签已被移除"时才关，
  于是每点一次字号泄漏一个活动 shell + 一条没人消费的终端 WS。修它要动 `terminalId` 的生命周期，
  是独立一件事。
- **`backgroundPolls`（1s）是"跑完通知"的唯一通道**：后台久留时可能被 intensive throttling 压到
  分钟级。已把这一点写进 `main.ts` 的注释；是否真会被压取决于 Chromium 对"持有 WebSocket 的页面"
  的豁免规则，**需要实测**再决定是否为它单独开豁免。
- **浏览器面板的 `<webview>` 仍无条件挂载**（5.7 未做的那半，理由见 5.7）。

**复核确认无缺陷的项**：`useStreamingTextReveal` 的修复（`readHorizonMs` 有模块级缓存，渲染期
读取不引入每帧开销、也不产生渲染循环）；`useRefreshOnVisible`（监听完整摘除、回调取最新、
`document.hidden` 时直接返回）；`companionStatusPoll` 的快照稳定性与 `inFlight`/`visibleLoads`
计数；`.glass` 删除后全仓零引用。

**修完复核条目后复跑门禁**：`npx vitest run` → 229 文件 / 1864 用例全通过；
`npm run typecheck` 与 `cd apps/desktop && npm run typecheck` → 均零错误。

### 5.11 工单 4：常开诊断收进构建期 DEV 门控（**已实施**）

新增 `src/lib/dev/devDiagnostics.ts` 提供 `isDevDiagnosticsEnabled()`——实时读 `import.meta.env.DEV`，
**刻意不做模块级缓存**（缓存成常量会让门控本身无法被测试覆盖）。四处加门控：
`useStreamingTextReveal` 的每帧平滑度采样、`agentStore` 的 `Streaming flush telemetry`、两条
`MODEL_TRACE`。**调用的内容与时机都没改**，只是加了守卫。

**这一节同时纠正了 3.6 节原先两处错误归因**（复核时逐条核过，不是修修补补）：

1. `Streaming flush telemetry` **不是**"每次 flush 一条"：它只在 `logStreamingTelemetry`
   （`agentStore.ts:418-423`）里发出，调用点只有 `content_block_stop`（`:2164`）与
   `clearPendingStreaming`（`:510`）——1 秒流式突发里实测 **1~2 条**，而同期 flush 约 20 次。
2. 它是 **`debug` 级**，而 `src/lib/logger.ts:20-22` 在非 DEV 下把 `minLevel` 设为 `'info'`，
   所以**打包态里它本来就不会走到 `console.debug`**。原先"20 次/秒 IPC + 追加 `renderer.log`"
   的说法是错的：这条没有那笔 I/O 成本。

**真正被收掉的大头是 `recordRevealFrame`**：它在帧回调里位于提交闸门**之外**，因此是**每帧**调用
（实测 60 帧突发 → 60 次调用，且其中包含 `committed === 0` 的帧），流式期间约 60 次/秒。

**证据（不是推测）**：门控靠构建期替换 + DCE 生效，用**产物 grep** 验证——`npm run build` 之后
`dist/assets/*.js` 里 `Streaming flush telemetry` / `MODEL_TRACE` / `pushCapped` 命中 **0**；
同一 grep 对**未**门控的 `Thinking block started` / `Text block stopped` 命中 1 个文件（证明 grep 本身有效）。

**计数型断言（两臂对照，不测毫秒）**：

| 用例 | 锁住了什么 |
|---|---|
| `src/lib/dev/devDiagnostics.test.ts` | 门控取值必须实时跟随 `import.meta.env.DEV`（false→true→false 都跟着变），防"缓存成常量后门控静默失效" |
| `useStreamingTextReveal.devDiagnostics.test.tsx` | DEV：60 帧突发**恰好 60 次**采样，且含 `committed === 0` 的帧（证明是"每帧"而非"每次提交"）；非 DEV：**0 次**，且两臂可见长度**逐字相等**（证明门控没顺带砍掉绘制） |
| `agentStore.test.ts > dev diagnostics gating` | DEV：1 秒突发 = **2 条** telemetry + 两条 `MODEL_TRACE` 各一次；非 DEV：三条诊断**全为零**，而 `streamingText` 仍含正文（证明流式路径本身照旧） |

**结论口径**：这一项**不宣称毫秒收益**。它的可验证收益是"打包态不再执行这些诊断"——其中
`recordRevealFrame` 从每帧一次降到 0。这正是本仓库"毫秒不进 CI 门禁"的一次实践。

### 5.12 工单 5：Markdown / Shiki 的成本拆解（**已实测，据此改方案**）

**探针新增的臂**（`scripts/e2e/stream-reveal-probe/`；每条臂都与 `reveal-default` 逐项相同，
只替换 Markdown 的渲染方式。`CODEMUX_REVEAL_PROBE_ARMS=臂名,臂名` 可只跑子集，
`CODEMUX_REVEAL_PROBE_LONG_TASKS=1` 打印长任务时间线）：

| 臂 | 替换了什么 |
|---|---|
| `reveal-plain` | Markdown 整体换成 `<pre>`：给出"Markdown 渲染"的成本上限 |
| `reveal-nocode` | 保留 Markdown 解析与 DOM，只去掉 Shiki 插件：把高亮单独摘出来 |
| `reveal-warm` | 与现状相同，但流式**开始前**先用离屏代码块把 Shiki 热起来（候选修法 A） |
| `reveal-lazy-code` | 流式期间不高亮、结束后一次性装上（候选修法 B 的最激进版本） |

**读数一：拆开高亮与解析**（6 条臂那次运行，2 次的中位数，14s 流式 / 9468 字 / 含增长代码围栏）

| 指标 | `direct` | `reveal-default` | `reveal-plain` | `reveal-nocode` |
|---|---|---|---|---|
| 提交耗时合计 (ms) | 437.9 | 700.7 | **19.3** | 681.4 |
| 提交次数 | 738 | 1454 | 453 | 1481 |
| 单次提交最长 (ms) | 12.1 | 14.9 | 0.2 | 14.3 |
| 长任务合计 (ms) | 489.5 | 474.5 | 55.5 | **55.0** |
| 长任务次数 | 3 | 4 | 1 | 1 |

**结论一：提交耗时的大头是 Markdown 解析 + DOM，不是语法高亮。**
`reveal-nocode`（去掉 Shiki）与 `reveal-default` 的提交耗时**基本相同**（681 vs 701ms，
提交次数 1481 vs 1454），所以 `reveal-nocode − reveal-plain ≈ 662ms` 属于
**对累积全文的分块/解析 + 尾部块的 DOM 重建**。2.2 节原先"每次提交都对尾部未闭合代码块
重跑 Shiki 分词很贵"的写法**没有得到数据支持**，已改口。

**读数二：长任务时间线**（`t` 相对流式开始；四条臂两次运行各打印一行）

```
reveal-default    t=-359ms 59ms · t=618ms  61ms · t=679ms 275ms · t=957ms  62ms
                  t=-366ms 55ms · t=635ms 159ms · t=794ms 241ms
reveal-nocode     t=-357ms 60ms                        ← 只剩启动底噪
                  t=-357ms 55ms
reveal-plain      t=-368ms 57ms
                  t=-355ms 55ms
reveal-warm       t=-1323ms 57ms · t=-895ms 172ms      ← 初始化被挪到流式开始之前
                  t=-1268ms 56ms · t=-895ms 185ms · t=716ms 54ms
reveal-lazy-code  t=-374ms 62ms · t=12417ms 524ms      ← 推到末尾：末尾一次性阻塞半秒
                  t=-358ms 54ms · t=12423ms 532ms
```

所有臂都有一条 `t≈-360ms / 55–60ms` 的共同底噪（页面初始化，与 Markdown 无关）。
`reveal-default` 比 `reveal-nocode` 多出的 159–275ms **全部落在流式开始后 0.6–1.0 秒**，
之后 12 秒再无阻塞。**即：那一下卡是"第一次遇到代码块"时的语法/正则引擎初始化，
不是全程的 O(n²)。**

**读数三：两条候选修法**（4 条臂那次运行，2 次的中位数）

| 指标 | `reveal-default` | `reveal-warm` | `reveal-lazy-code` | `reveal-nocode` |
|---|---|---|---|---|
| 提交耗时合计 (ms) | 687.2 | 685.4 | 695.0 | 693.7 |
| 单次提交最长 (ms) | 14.0 | **5.3** | 14.9 | 12.3 |
| 长任务合计 (ms) | 456.0 | 262.5（含预热期的负时刻条目） | **586.0** | 57.5 |
| 长任务次数 | 4 | 3 | 2 | 1 |

**结论二：候选修法 A（预热）成立，候选修法 B（整体延后）更差。**
预热把初始化挪到流式之前后，流式窗口内长任务近乎清零，**单次最长提交从 14.0ms 降到 5.3ms**
（回到 16ms 帧预算以内）。而 `reveal-lazy-code` 在流式结束后出现一次 **524–532ms** 的阻塞，
比现状的两次 150–275ms 更糟，且正好发生在用户要看结果时。所以：

- **不做**"流式期间一律不高亮、结束后补上"；
- 做**预热**：在流式开始前（更理想是应用空闲时）用一次极小的代码块把语法与引擎热起来；
- 2.2 的"未闭合围栏延迟渲染"仍可作第二步，但必须**逐块**生效（围栏一闭合就高亮），
  不能攒到最后——这正是 B 臂失败的原因。

**仍未量过**：那 662ms 里"每次提交对全文 `remend` + `marked` 重新分块"与
"尾部块 remark/rehype + DOM 重建"各占多少。要动 2.2 的 `useBlocks` 那条线，得先补这个拆分。

### 5.13 按上面的结论实现预热（**已实施**）

**实现**（`src/lib/codeHighlightWarmup.ts`，`main.tsx` 启动时调用一次）：
不做离屏渲染，直接调用 `@streamdown/code` 公开的插件方法
`code.highlight({ code: 语料, language, themes: code.getThemes() })`——未命中缓存时它返回 `null`、
结果走回调，而副作用正是"把该语言的高亮器建起来"并写进**模块级**缓存；渲染路径用的是同一个
`code` 单例，所以预热结果会被后面的真实渲染命中。调度用 `requestIdleCallback({ timeout: 5000 })`，
**一次空闲回调只热一种语言**，默认集合 = `typescript / tsx / bash / json`。

**为什么语料不能只有一行**：第一版语料是 `const warmed: number = 1;`，再测之后窗口内仍有约 185ms
阻塞；换成 27 行的代表性 ts 语料（接口、泛型、联合类型、模板字符串、正则、`async`/`await`）后，
窗口内阻塞**降到 0**。原因是正则引擎按实际输入惰性编译规则，语料太短等于只热了一小部分。

**再验证**（探针的 `reveal-warm` 臂改成直接调用**发货函数**，2 次运行的中位数）：

| 指标 | `reveal-default` | `reveal-warm`（发货函数） |
|---|---|---|
| 长任务时间线 | `t≈600ms 151–186ms`、`t≈750ms 222–235ms` | `t≈-900ms 293–304ms`（**窗口内 0**） |
| 长任务合计 | 452.5ms | 354.5ms |
| 单次提交最长 | 12.5ms | 10.9ms |

**代价与取舍**：预热本身现在要 293–304ms（语料变长的代价），它发生在**空闲回调里、流式之前**，
对用户不可见；换来的是流式期间 380–420ms 阻塞的消失。默认热 4 种语言 = 4 次空闲回调，
四种语言都给的是多行代表性语料（复核后统一），所以每种都是一次真实的文法编译 + 分词；
四种的**合计**代价没有单独测量。

**回归防护**（12 条计数型用例，`src/lib/codeHighlightWarmup.test.ts`）：不在启动路径同步预热、
一次空闲回调只热一种、真空闲才预热 / 强制投递退让且有界放弃、幂等、无 `requestIdleCallback` 时
退化 `setTimeout`、**主题身份相等**（必须用插件自己的 `getThemes()`，自造一份会让缓存键对不上）、
**每种默认语言的语料都不少于 3 行**、单语言失败不冒泡不打断且**留下 warn 日志 + 不重试**，
以及 `main.tsx` 源码契约（拒绝"被注释掉"与"塞进 `if (false)`"两种形态）。

**复核（code-reviewer 只读）与据此的修复** —— 5 个真缺陷都成立，已全部修掉：

1. **`timeout` 兜底会把 300ms 阻塞塞进忙碌窗口**：原实现忽略 `deadline`。Chromium 在超时后会以
   `didTimeout: true` / `timeRemaining() === 0` 强制投递，而预热的挂载点在首帧之前——冷启动连续
   忙过 2 秒就会撞上。现在**只接受真空闲**：强制投递一律重新排队，最多退让 8 次后放弃
   （宁可永不预热，也不在忙碌或交互时插这一下）。附带记录：隐藏窗口不投递空闲回调，
   所以托盘/后台启动形态会在窗口恢复后才预热。
2. **下一种语言的排队时机**：原实现从 `import()` 的 settle 排队（`highlight()` 立即返回 `null`），
   等于没把峰值限制在单语言成本内。现在"每次投递必须是真空闲"保证了每次空闲时段只做一种语言。
3. **其余三种语言的语料只有一行**：与本改动自己的论证冲突（正则规则按输入惰性编译）。
   `tsx`/`bash`/`json` 现在也都是多行代表性语料，兜底语料从一行改成两行。
4. **失败语义的原注释与上游行为相反**：上游在 await **之前**就把 `createHighlighter` 的 promise
   写进模块级缓存、失败也不清缓存，所以失败不是"渲染时照常懒建"，而是"该语言在这次页面生命期内
   不再有机会"。注释照实改、补 `logger.warn`（失败不再静默），账本 `primedLanguages` 改名
   `attemptedLanguages` 并写明"尝试过"语义，用例把"失败不重试"固定下来。
5. **数字三处不一致**：全部收敛到"直接调发货函数"那条臂（窗口内 380–420ms → 0、
   单次最长提交 12.5ms → 10.9ms）。

**验证口径的诚实说明**：探针的 `reveal-warm` 臂只热 `typescript` 并固定等 900ms 后开流，
发货代码则热 4 种语言、经 `requestIdleCallback` 逐个排队——**两者不是同一场景**。已测量的只有
"ts 围栏 + 前台空闲"这一种组合；四种语言的合计代价、语言与主题 chunk 的按需拉取、
4 个 highlighter 实例的常驻内存**均未测量**。

**记录但不改的上游行为**（以后遇到高亮异常可从这里定位）：`@streamdown/code` 的 token 缓存键是
`lang:light:dark:长度:前100字符:后100字符`，中段不同但首尾相同的代码块会共用 tokens（可能高亮错），
且该缓存无逐出；同一插件在缓存**命中**时先 `return` 再注册回调，回调永远不会被调用——
预热不看结果所以无影响，但渲染路径的 `setState` 依赖它。

### 5.14 尾块增量分块（**已实施**）

**发现的可注入缝隙**：`streamdown` 导出 `parseMarkdownIntoBlocks(markdown) => string[]`，且
`Streamdown` 接受 `parseMarkdownIntoBlocksFn`。所以不必自己拆成两个 `<Streamdown>`（那需要自己猜块
边界、有明显语义风险），换掉分块器即可。上游每次提交会先 `remend` 再对**整段文本**重新分块——它的块级
memo 只能挡住"已完成块不重跑 unified 管线"，挡不住这次全文分块。

**实现**（`src/lib/incrementalMarkdownBlocks.ts` + `CodeMuxThread.tsx` 的 `StreamingContent`）：
`createIncrementalBlockParser(parse)` 记住上一次的块，把"除最后一块以外"的全部块冻结，只把尾部交给
参考实现；尾部从**上一次解析出的最后一块的起点**开始，所以最后一块永远整体重解析，追加内容不会漏。
前缀对不上（例如 `remend` 改写了尾部之外的文本）就整体重解析——正确性优先。
缓存每实例一份（`useMemo`）；`StreamingContent` 是**常驻**的（`:2035` 的 `return null` 不卸载组件、也没有 `key`），所以实例会跨回合、跨会话带缓存 —— 只在"新文本仍以上一次冻结前缀开头"时复用，否则整体重解析（安全性论证见 5.15）。

**A/B**（探针第 9 条臂 `reveal-tail-lex`，与 `reveal-default` 只差这一处；两轮各 2 次运行的中位数）：

| 指标 | `reveal-default` | `reveal-tail-lex` | 修复守卫后复跑（default → tail-lex） |
|---|---|---|---|
| 提交耗时合计 (ms) | 697.7 / 694.5 | **562.9 / 564.2**（−19%） | 687.7 → **545.8**（−20.6%） |
| 单次提交最长 (ms) | 12.2 / 14.1 | **12.2 / 12.3** | 14.1 → 14.8（两轮原值 13.9/14.3、19.2/10.3，属读数噪声） |
| 长任务合计 (ms) | 424 / 454 | 412 / 453（不变，符合 5.12 的结论） | 462 → 455（不变） |

**正确性自检**（探针在结算期用同一串输入重放比对，不干扰测量窗口）：
两轮分别是 **395 次与 391 次输入、0 次与参考实现不一致**；补上 `[^` 守卫后复跑（只跑两条臂、2 次/臂）又比对了 **386 次与 393 次，仍是 0 次不一致**。

**回归防护**（`src/lib/incrementalMarkdownBlocks.test.ts`，10 条）：与真实 `parseMarkdownIntoBlocks` 在 30 个增长前缀上
**逐项一致**、只把尾部交给参考实现并断言冻结深度恰好是"除最后一块"、参考实现累计收到字符量占比 < 0.8（直通实现会让它等于 1）、
`[^` 出现时整篇重解析且追加后仍一致、四个语料的逐字符前缀一致性（见 5.15）、同输入稳定，以及源码契约。

**代价与教训**：把 `parseMarkdownIntoBlocks` 加进导入之后，6 个只 mock 了 `Streamdown` 的测试文件里
这个导出成了 `undefined`，组件一渲染就抛错、**74 条用例变红**。修法是同步补全 mock 的门面
（mock 只返回单块即可：增量缓存自然退化为整体解析）。教训：**给上游模块新增导入 = 所有 mock 该模块的
测试都要同步**，否则失败点会出现在离改动很远的地方。

**仍未做**：那 662ms 里现在只砍掉约 135ms（全文分块）。剩下的约 527ms 是尾部块的
remark/rehype + DOM 重建 + React 开销；长任务读数不变说明它不在"阻塞块"里，要再往下拆需要单独一轮。

### 5.15 尾块增量分块的对抗性复核与修复（**已实施**）

`code-reviewer` 只读复核抓到一条**正确性缺陷**，并且指出 5.14 那批用例**覆盖不到它**。

**上游分块器不是前缀局部的**。`node_modules/streamdown/dist/chunk-BO2N2NFS.js` 里
`parseMarkdownIntoBlocks` 做的第一件事是：

```js
var Is=/\[\^[\w-]{1,200}\](?!:)/, Ns=/\[\^[\w-]{1,200}\]:/;
if (Is.test(e) || Ns.test(e)) return [e];   // 全文任意位置出现脚注样式 → 整段文本当成 1 块
```

两个正则都**没有锚点**，所以代码块里的取反字符类（`[^0-9]`、`[^-]`、`[^a]`）同样命中。这条规则
"要看全文才决定"，前缀局部的冻结表达不了：当 `[^` 出现在**新追加**的文本里时 `startsWith` 守卫
恰好放行，我返回 ≥2 块而参考实现返回 1 块，并且这个偏差会在此后每次提交上持续（消息提交后走
static 路径才恢复）。触发概率不低——本项目的回答里正则片段很常见。

我另外把上游本体逐行核了一遍，确认**只有这一条**是非局部的：另外两条特殊规则（`$$` 计数为奇数时
把下一个 token 并进上一块、未闭合 HTML 标签栈非空时全部并入上一块）都只看前缀，且"已冻结的块边界
都是 token 边界、独立重解析结果一致"，所以补上守卫之后这个设计是成立的。

**修法**：文本里出现 `[^` 就整篇重解析（`GLOBAL_RULE_MARKER`）。这是上游两条正则的**保守超集**
——`[^\s]` 之类其实不会触发上游早退，我也会退让。误判只损失性能、不会算错：这些文本上游本来就
返回 1 块并每次全文重解析，我不会比它更差。

**测试增强**。复核同时指出原来只有"参数长度 < 全文"那一条能区分"真增量"与 `parse(markdown)`
直通（字符串 `toBe` 按值比较，挡不住直通），且没有任何用例碰 `[^`。现在补到 10 条：新增
"参考实现累计收到字符量占比 **< 0.8**"（直通实现会让这个比值等于 1），以及**四个语料的逐字符
前缀一致性**（`[^0-9]` 的代码块 / 真脚注 / `$$` 行间公式 / 未闭合 `<div>`）。

**变异检验**（证明这些用例不是空转）：临时摘掉守卫再跑，3 条变红，逐字符那条在**前缀长度 31**
（`const re = /[^0-9]` 刚出现）就失败：`expected [ '先给结论。', '\n\n', …(1) ] to deeply equal
[ Array(1) ]`；脚注那条是 `expected [ Array(3) ] to deeply equal [ '第一段\n\n第二段\n\n[^1]:
脚注定义\n' ]`——与复核预测的分叉完全一致。恢复守卫后 10/10 通过；守卫就位后再复跑探针，687.7 → 545.8ms
（−20.6%，长任务 462 → 455ms 不变），说明这条保守退让在真实语料上没有带来代价。

**另一处按复核改掉的表述**：原注释写"`StreamingContent` 一次流式只挂一个，不跨消息共享"——
这句是**假的**：`:613` 的 `<StreamingContent sessionId={sessionId} events={events} />` 没有 `key`，
`:2035` 的早退只是 `return null`（不卸载组件），实例会跨回合、跨会话继续带缓存。已在源码注释与
本节改为按实描述，并说明安全性不依赖"实例独占"，而依赖"前缀一致 + `[^` 保守退让"。

**复核记录但不改**：① 每次调用仍有 `frozen.join('')`、`startsWith` 与 `markdown.slice()` 的
O(前缀) 开销，且子串会让上一份全文多活一会儿（一条消息量级）；② 依赖"块 raw 拼接严格等于输入"
这条上游没写进类型的 tiling 不变量，被破坏时的表现是"尾部偏移/文本重复或丢失"而**不是**安全回退；
③ 源码契约用例原来用 `process.cwd()` 定位文件（**已修**，见 5.25）；仍然成立的部分是"正则可被注释满足"。

### 5.16 工单 2 第二步：行级收窄 + 渲染输入单一真源（**已实施，201 → 2**）

5.8 已经把**叶子**层消掉（一次追加的叶子渲染 161 → 1），但被 context 变化击中的
`AssistantLikeMessage` **本身仍会为每一行重渲染**。这一步把它按行收窄。

**先立守卫、确认它为红**。`CodeMuxThread.rowRenderCounts.test.tsx` 用 partial mock 把
`MessagePrimitive.Root` 包一层计数器——assistant-ui 每渲染一行都要经过它一次，于是
"**行**渲染次数"变成可数（与 5.8 的叶子计数是两个不同粒度）。读数（`CODEMUX_ROW_COUNT_TRACE=1`）：

| 全量挂载 | 挂载行数 | 一次追加的行渲染次数（**收窄前**） | 收窄后 |
|---|---|---|---|
| 8 轮 | 24 | **41** | **2** |
| 40 轮 | 120 | **201** | **2** |

本轮实跑（`CODEMUX_ROW_COUNT_TRACE=1`）的**原始读数**：
`ROW_RENDER_COUNTS {"small":{"turnCount":8,"mountedRows":24,"leafRenders":1,"rowRenders":2},"large":{"turnCount":40,"mountedRows":120,"leafRenders":1,"rowRenders":2}}`
——24 行与 120 行挂载下，**行渲染都是 2 次、叶子渲染都是 1 次**，与挂载规模无关
（`mountedRows` 是前置断言，防止"其实什么都没挂载"的假通过）。

**做法：单一真源派生 + memo 比较器**（而不是拆 context——改动面更小，语义也更容易机械守住）：

1. `deriveAssistantRowBindings(...)` 产出 `AssistantRowBindings`，作为这一行**唯一的渲染输入**；
2. `CodeMuxAssistantMessage` 变薄：只算 `useIsLastMessage` + 派生 bindings，把 bindings 交给
   `memo` 包住的 `AssistantLikeMessage`；**行体只从 `bindings` 取值**，不再直接读
   `activityRuns` / `subagentRunActivity` / `toolDurations`；
3. `assistantRowBindingsEqual` 逐字段比较，`areAssistantRowPropsEqual` = 几个跨行稳定的 props + bindings；
4. 用户行同样处理：`UserMessage` → `memo(…, areUserRowPropsEqual)`，`CodeMuxUserMessage` 派生
   `text` / `timestamp` / `imageAttachments`。**用户行正文也由外层派生后传入**——否则会出现
   "渲染读一处、比较比另一处"的漂移，表现是"UI 静默不更新"。

**两个刻意的例外（都写在源码注释里）**：

- **不比 `message` 身份**：assistant-ui 每次线程更新都可能重建 `MessageState`，比身份会让这条优化
  彻底失效；而"渲染输出依赖什么"已由 `bindings` 完整表达。
- **`usedDurations` 比内容指纹**：那个 Map 每次都是新对象，比身份等于永远判不等；等价性改由
  `bindings.usedDurationsKey`（`toolId:ms` 排序拼接）表达。

**完备性用例（AC2 的机械守卫）**：逐字段翻转派生结果，断言比较器必须判为不同——标量字段、
`collapse` 的每个子字段、每个 part 的每个字段（`args` / `result` / `status` / `data` 按身份）、
卡片活动对象换成另一个实例、以及 `usedDurationsKey` 的内容指纹例外。**漏比任何一个字段，这条用例就红。**

**变异检验（AC1）**：把 `areAssistantRowPropsEqual` 临时改成恒返回 `false`（等价于摘掉行级收窄），
行级用例**立刻变红**（`1 failed`），而叶子那条仍然绿——两层守卫互相独立，确实各自守着各自那一层。
还原后该目录 **24 文件 / 322 用例全通过**。

### 5.17 复核提出的未确认项：`markdown-text.tsx` 的流式路径要不要全文分块（**结论：不成立**）

复核当时的问题是"流式增长的文本会不会每次都被全文重新分块"。用**计数证据**回答
（`CodeMuxThread.rowRenderCounts.test.tsx` 的 `流式期间的 markdown 重画落在哪条路径`）：
把实时缓冲推进 20 次，一次运行的原始读数就是
`{"committedMarkdown":0,"liveMarkdown":20,"rowRenders":0}`。

即：这 20 次推进**一次都没有碰 committed 路径的 markdown**，全部落在**实时缓冲**上。
机理是"delta 只进实时缓冲、从不进 `events`"，committed 行只在块收尾时才更新。
所以"流式增长文本触发**已提交行**全文重新分块"这件事**不成立**，不需要为它做注入。

真正会随流式增长反复分块的是**未闭合尾块**，那正是 5.14 那条优化处理的对象：注入点在
`StreamingContent`（`CodeMuxThread.tsx:2338`）→ `:2441` `parseMarkdownIntoBlocksFn={blockParser}`，
作用在 `revealedText` 这条**实时**文本上。

**顺带纠正一条早先笔记里的说法**：曾记下"注入 `parseMarkdownIntoBlocksFn` 会关掉 streamdown 的
tail-remend（`shouldTailRemend = mode === 'streaming' && … && !parseMarkdownIntoBlocksFn`）"。
这个表达式在本仓库**实际安装的两个包里都找不到**（`node_modules/streamdown/dist/*` 与
`node_modules/@assistant-ui/react-streamdown/dist/*` 的 `grep` 命中 0）。安装的这一版里条件只有
`mode === 'streaming' && parseIncompleteMarkdown !== false`——在
`node_modules/streamdown/dist/chunk-BO2N2NFS.js` 里就是那个 `useMemo` 中的
`let k = t === "streaming" && n ? Ws(e, T) : e`，其中 `Ws` 即 remend——**与 block parser 无关**。
所以这里按实测口径写：注入增量分块不会改变 remend 的观感。

### 5.18 残余成本的拆解（**已实测**）

要回答"下一步值不值得做"，先得把 5.14 之后剩下的成本分成两段。新增探路臂 `reveal-tail-plain`：
与 `reveal-tail-lex`（现状：已闭合前缀走 Markdown + 尾块增量分块）逐项相同，只把**未闭合尾块**
按纯文本渲染。下面这一版是**本轮复跑**（7 条臂、每臂 2 次取中位数；命令见"六、怎么验证"）：

| 臂 | 提交耗时合计 | 提交次数 | 含义 |
|---|---|---|---|
| `reveal-tail-lex`（现状） | 565.2ms | 1450 | 已闭合块（Markdown + Shiki）+ 尾块（增量分块） |
| `reveal-tail-plain`（尾块纯文本） | 411.5ms | 685 | 已闭合块（Markdown + Shiki）+ 尾块（纯文本） |
| `reveal-plain`（全部纯文本） | 18.0ms | 459 | 一条下界：完全不进 Markdown 管线 |

拆解结果：

- **开着的尾块 ≈ 154ms**（565.2 − 411.5），约占现状的 27%；
- **已闭合块 + React 协调 ≈ 394ms**（411.5 − 18.0）——这才是大头；
- 完全不进 Markdown 管线时只有 **18.0ms**，说明可优化空间确实在 Markdown 管线里。

还有一条不能忽略的副作用：`reveal-tail-plain` 把长任务**集中化**了——两轮各是**单段 425ms / 430ms**，
而 `reveal-tail-lex` 是"95 + 232ms"与"58 + 239 + 114ms"的多段。总时长接近，单段却长得多。

**自检行**（这条臂每条运行都会打印，用来证明"增量分块真的接上了、且与参考实现一致"）：
`增量分块自检：398 次输入，0 次与参考实现不一致（逐项一致）`（另一轮是 393 次输入，同样 0 次不一致）。

### 5.19 未闭合围栏延迟解析/高亮（**实测后否决：不以观感换性能**）

按 5.18 的拆解，这一条的**收益上界**就是尾块那约 154ms / 约 27%；代价是尾块在流式期间
**完全失去 Markdown 观感**，而且长任务集中化（单次 425ms / 430ms 两轮都是单段）。契约预先声明过：
"若某项的收益必须以观感换取，只记录方案与读数、不改观感。"
⇒ **记录，不实施。** 真要动，应该先把那约 394ms（已闭合块 + React 协调）打下来，而不是拿观感换 27%。

**还有一条独立的旁证（本轮复跑）**：`reveal-nocode`（保留 Markdown 解析与 DOM、只去掉 Shiki 高亮）
是 686.4ms，与 `reveal-default` 的 687.6ms **几乎完全相同（−0.2%）**——也就是说
**"延迟高亮"这个方向本身几乎没有收益**，与 5.12 早先的结论一致；真正贵的是"重新解析 + 重建 DOM"，
而不是高亮。上面 `reveal-tail-plain` 给出的 154ms 已经是这一整条路线的**上界**。

### 5.20 工单 7：rAF 帧合并器（**实测后否决**）

新增探路臂 `reveal-frame`（`minFrame: 16`，约等于每帧 flush），与现状逐项对照（2 次重复）：

| 指标 | `reveal-default`（现状 40ms） | `reveal-frame`（≈每帧） | 变化 |
|---|---|---|---|
| 提交耗时合计 | 687.6ms | 822.3ms | **+20%** |
| 提交次数 | 1443 | 1951 | **+35%** |
| 单次提交最长 | 14.2ms | 14.8ms | **略差** |
| 长任务合计 | 450.0ms | 422.5ms | 基本不变 |
| 更新间隔 p95 | 53.1ms | 28.1ms | −25.0ms |

判定（判据在 `runner.mjs` 顶部预先声明）：**提交次数明显变差（+35%）、单次提交最长还略差了
（14.2 → 14.8ms）、长任务基本不变**，只有 p95 间隔继续下降——而 53ms 本身已落在"1~3 帧"的边际区间。
⇒ **保持 40ms，不换 rAF 合并器。** 卡顿的来源不在这里。

### 5.21 工单 10：工具密集阶段的每帧处理成本（**读数 + 局限**）

工单 10 原来缺的是"工具密集阶段前端每帧要付多少"。临时基准（**跑完即删**，见下）走的是生产同一
条分发路径（`registerDaemonSessionHandler` 注册的 handler → `JSON.parse` → store 分发）：

| 臂 | 帧数 | 耗时 | 每帧 |
|---|---|---|---|
| `text_delta`·单帧 | 3010 | 24.33ms | **0.0081ms** |
| 工具密集·逐帧（tool_use 开块 + 6 个 `input_json_delta` + 收块） | 4800 | 66.57ms | **0.0139ms** |
| 同一批帧按 transport 批投递（每批 8 个事件） | 600 批 | 22.93ms | 0.0382ms/批（= **0.0048ms/事件**） |

结论：**前端每帧的 store 分发成本在 10⁻² 毫秒量级**——要吃掉一个 8ms 的帧预算，需要约
**7 万帧/秒**。所以 daemon 的批边界（`agentStore.ts:278` 注释写明与 sidecar 的 50ms stream batch
对齐）**不是瓶颈、不该动**；"前端已支持批事件"这件事也不需要再往上加码。

局限（必须一起看，否则这个数字会被误用）：

1. **不含 React 渲染**，所以它是**下限**；真正贵的是渲染（见 5.18 的约 408ms）。
2. 不含 WS 传输与背压。
3. 载体是一条**临时**用例（`agentStore.test.ts` 里的 `[TEMP-BENCH]`），按"毫秒不进 CI 门禁"的
   纪律，取到读数后**已删除**；要复跑得把它加回去。
4. 单次运行的抖动不小：`text_delta` 这条早先一次是 0.0056ms/帧、本轮 0.0081ms/帧（约 40% 差异），
   所以只能当**量级**用。

### 5.22 工单 9 补强：后台回合的完成探测改成事件驱动（**已实施**）

5.3 恢复了 Electron 默认的窗口节流，副作用是"窗口在后台时定时器被压到分钟级"，
于是**后台回合的完成**要等一个被节流的兜底节拍才被发现（通知因此迟到）。

改法（`agentStore.ts`）：

- 新增 `backgroundLiveProbes`（按会话存防抖句柄）、`BACKGROUND_LIVE_PROBE_DEBOUNCE_MS = 250`、
  `scheduleBackgroundLiveCompletionProbe`、`withBackgroundLiveProbe`；
- 两处 `registerDaemonSessionHandler` 调用点（`:2978`、`:3105`）把 `handleEvent` 包一层：
  **WS 事件一到就防抖触发一次完成探测**；
- `stopBackgroundPoll` 顺手清掉在途定时器，避免会话停下后还多探一次；
- 1s 轮询**保留**作兜底，不删。

为什么有效：**WS 推送不受隐藏窗口的定时器节流影响**，事件驱动那条路在后台仍然即时，
轮询只是保险。守卫是计数型用例（`agentStore.test.ts` 的"后台回合的完成探测由事件驱动，
不用等被节流的兜底节拍"），断言事件到达后 `isSessionTurnActive` 的调用次数按预期变化。

### 5.23 工单 8 补强：浏览器面板隐藏时的行为（**按证据交付，不改代码**）

"隐藏的面板是否还在渲染 guest"这条，**机制已经存在并且已经接线**，不需要新代码：

- `src/lib/browser/electronBrowserHost.ts`：`showPage`（`:515-518`）与 `hidePage`（`:520-523`）都调用
  `applyVisible`（`:296-299`），后者的实现就是 **`record.el.style.display = visible ? '' : 'none'`**
  ——即"隐藏"是 **`display: none`**，元素与 guest 都留着（另有两处调用：`:450` 创建后初始隐藏、
  `:522` 隐藏页）；
- 谁来调用它：`src/stores/browserStore.ts` 的 `syncGlobalBrowserVisibility`（`:531`）与
  `hideAllBrowserHosts`（`:523`）——前者由 `:28` 的可见性同步调用，后者由 `sidePanelStore.ts:447`
  与 `SidePanel.tsx:105` 调用；`src/lib/browserVisibility.test.ts` 覆盖这条链路；
- 已有测试直接断言这条行为：`src/lib/browser/electronBrowserHost.test.ts:223`
  「show/hide:纯 CSS 显隐;切走停放不销毁,destroy 才移除」，以及 `:126` 断言新建的 webview
  初始就是 `display: none`。

**为什么不改成"隐藏就卸载元素"**：卸载会 destroy 掉 guest（丢登录态、页面滚动位置与表单状态），
而这里需要的是**停止绘制/合成**，`display: none` 已经做到这件事。把 `isActive` 加进挂载条件是净损失。
⇒ 不改代码，把证据留在这里。

### 5.24 工单 11：行数预算门禁 `npm run check:size`（**已实施**）

借鉴 PI-Desktop 的 `scripts/check-architecture.mjs`，但**不照抄"一刀切"**：

- 预算：`.ts` / `.tsx` **800 行**、`.rs` **1000 行**；只扫源码（`src`、`scripts`、`apps/*/src`、
  `crates/daemon/src`），跳过依赖、产物与测试文件。
- **冻结基线**：首次运行的真实结果是"585 个文件里 30 个超预算"，这 30 个进
  `scripts/file-size-baseline.json`。基线**内**允许保持现状，但**一行都不许再涨**；基线**外**的新文件
  超预算即失败。理由是"一上来就给 2000+ 行的巨文件设死线，等于要求先做一次大重构，
  那种门禁最后一定会被绕过"。
- 单测 `scripts/check-file-size-budget.test.mjs`（7 条）：恰好等于预算算通过、超一行失败、
  基线内允许超标但涨一行失败、基线内瘦下来不算违规、每种扩展名各用各的预算、基线生成只冻结
  超预算文件且排序稳定、行数统计（CRLF / 末尾换行 / 空文件）、只扫源码跳过依赖与测试文件。
- 用法：`npm run check:size`；`node scripts/check-file-size-budget.mjs --update-baseline`
  **只在有意收紧或新增豁免时**跑，并且要人工审 `scripts/file-size-baseline.json` 的 diff。
- 当前读数：`npm run check:size` →「通过：585 个文件都在预算内（基线冻结 30 个）」。

### 5.25 测试去环境依赖（`process.cwd()` → 本文件位置）（**已实施；被全量测试抓出过一次回归**）

`incrementalMarkdownBlocks.test.ts` 的源码契约用例原来用 `process.cwd()` 定位 `CodeMuxThread.tsx`，
**只在"从仓库根跑 vitest"时成立**。

第一版修改写成 `fileURLToPath(new URL('../../components/…', import.meta.url))`——**这是错的**，
而且**单文件跑是绿的、只有全量测试才把它抓出来**：Vite 会把这种写法当成**资源 URL 改写成 http 地址**，
`fileURLToPath` 随后抛 `ERR_INVALID_URL_SCHEME`（这条坑本仓库早有先例注释，就写在
`CodeMuxThread.navActiveSource.test.ts:37`）。全量测试当时的读数是
`Test Files 1 failed | 234 passed`、`Tests 1 failed | 1907 passed`。

改成先例的 `dirname(fileURLToPath(import.meta.url))` + `join` 之后，**从仓库根**与**从 `src/lib`**
两个 cwd 各跑一次都通过（各 10/10）。这条顺带说明：改动必须跑全量，只跑受影响测试会漏掉这一类回归。

### 5.26 本轮改动清单与验证

| 文件 | 改动 |
|---|---|
| `src/components/agent/assistant-ui/CodeMuxThread.tsx` | 行级收窄：新增 `AssistantRowBindings` / `deriveAssistantRowBindings` / `assistantRowBindingsEqual` / `areAssistantRowPropsEqual`；`AssistantLikeMessage` 与 `UserMessage` 改 `memo`；行体只从 `bindings` 取值；用户行正文由外层派生后传入 |
| `src/components/agent/assistant-ui/CodeMuxThread.rowRenderCounts.test.tsx` | 新增**行级**计数守卫（partial mock `MessagePrimitive.Root`）+ 5 条比较器完备性用例 + "流式期间 markdown 重画落在哪条路径"的计数用例 |
| `src/stores/agentStore.ts` | 后台完成探测改事件驱动：`backgroundLiveProbes` / `BACKGROUND_LIVE_PROBE_DEBOUNCE_MS = 250` / `scheduleBackgroundLiveCompletionProbe` / `withBackgroundLiveProbe`；两处注册点各包一层；`stopBackgroundPoll` 清理在途定时器 |
| `src/stores/agentStore.test.ts` | 新增"后台回合的完成探测由事件驱动"计数型用例 |
| `src/components/workspace/terminal/TerminalPanel.tsx`（+`.test.tsx`） | 改代码字号不再重建 PTY：只更新 xterm `options.fontSize` 并重新 fit；1 条计数型用例 |
| `scripts/check-file-size-budget.mjs`、`scripts/file-size-baseline.json`、`scripts/check-file-size-budget.test.mjs`、`package.json` | 新增行数预算门禁 + 冻结基线（30 个）+ 7 条单测 + `check:size` 脚本 |
| `scripts/e2e/stream-reveal-probe/probe-entry.tsx`、`runner.mjs` | 新增两条臂：`reveal-tail-plain`（拆解残余成本）、`reveal-frame`（帧合并器探路） |
| `src/lib/incrementalMarkdownBlocks.test.ts` | 去掉 `process.cwd()` 依赖（含 5.25 的那次回归与修法） |

**本轮最终门禁（实际读数）**：

| 门禁 | 命令 | 读数 |
|---|---|---|
| 根全量测试 | `npx vitest run` | **235 文件 / 1908 用例全通过**，退出码 0（上一次是 1 个失败 / 234 个通过，即 5.25 那个回归） |
| 伴侣包测试 | `cd apps/sidecar && npx vitest run` | 60 文件 / 676 用例全通过 |
| 类型检查 | `npm run typecheck` | 零错误 |
| 类型检查（外壳） | `cd apps/desktop && npm run typecheck` | 零错误 |
| 行数预算 | `npm run check:size` | 通过：585 个文件都在预算内（基线冻结 30 个） |
| 行数预算单测 | `npx vitest run scripts/check-file-size-budget.test.mjs` | 7 / 7 通过 |
| 行级渲染守卫 | `npx vitest run src/components/agent/assistant-ui/CodeMuxThread.rowRenderCounts.test.tsx` | 8 / 8 通过（读数见 5.16） |
| 探针（7 条臂 × 2 次） | 见"六、怎么验证"第 1 条 | 7 条臂全部 `runs:2, ok:2`，含自检行；对照表见 5.18 / 5.20 |

探针日志留在 `%TEMP%\codemux-stream-reveal-probe-*`（`CODEMUX_REVEAL_PROBE_KEEP_TEMP=1` 可保留）。
说明一句：探针按臂单独跑时要**独占机器**，不要与全量测试同时跑，否则读数会被别的进程污染。
---

## 六、怎么验证

**先记住一条纪律**：做任何流式/空闲的性能对照，都必须让窗口保持**前台上屏**。窗口被遮挡时
Chromium 会节流（5.3 节），此时浮层读到的低 FPS / 0 长任务是节流而非渲染慢，据此下结论会得到
反方向的答案。

1. **分帧绘制 + Markdown/Shiki 成本拆解**：`npm run test:e2e:stream-reveal-probe`——真实引擎、可复现、
   带机械判据，会打印每条臂的对照表与 `keep` / `raise-horizon` / `remove` 结论。调参与诊断开关：
   `CODEMUX_REVEAL_PROBE_REPS`（重复次数）、`CODEMUX_REVEAL_PROBE_ARMS=臂名,臂名`（只跑子集，例如
   `reveal-default,reveal-warm` 把一轮从 6.5 分钟压到约 1.5 分钟）、`CODEMUX_REVEAL_PROBE_LONG_TASKS=1`
   （打印每条臂的长任务时间线：相对流式开始的毫秒数 + 耗时，这是区分"一次性初始化"与
   "每次提交都在做"的直接证据）、`CODEMUX_REVEAL_PROBE_KEEP_TEMP=1`（保留临时目录）。
  十一条臂：`direct`（真基线）、`reveal-default`（现状）、`reveal-slow`、`horizon-zero`、
  `reveal-plain`（Markdown 换纯文本）、`reveal-nocode`（去掉 Shiki）、
  `reveal-warm`（调用**发货的**预热函数）、`reveal-lazy-code`（流式期间不高亮）、
  `reveal-tail-lex`（调用**发货的**尾块增量分块）、`reveal-tail-plain`（尾块按纯文本——用来把
  "尾块"与"已闭合块 + React 协调"拆开，见 5.18）、`reveal-frame`（`minFrame: 16`，约等于每帧
  flush——帧合并器探路，见 5.20）。后七条是诊断/探路臂，**不参与**保留/移除判定。
   A/B 开关 `localStorage['codemux:textRevealHorizonMs']`：`0` 关闭分帧绘制（2026-09-21 修复后才真的可用）。
2. **会话与空闲整体**：`Ctrl+Shift+D` 打开浮层，看 `长任务/秒` 累计、`AgentThread` commit 数与累计
   毫秒、`流式平滑度` 与 `更新间隔 p50/p95`。**两个平滑度指标必须一起看**——"一个完全停顿的流是
   完美平滑的"。
3. **布局相关（长会话窗口、跳转落点、离屏跳过）**：`npm run test:e2e:transcript-probe`。
4. **重渲染计数**：`longSessionBenchmark.ts` 的计数型读数（commit 数、挂载行数、DOM 节点数、
   布局读取调用计数、入站帧速率）——**毫秒不进 CI 门禁**，这条纪律本仓库与 PI-Desktop 一致。
5. **行级重渲染计数**：`npx vitest run src/components/agent/assistant-ui/CodeMuxThread.rowRenderCounts.test.tsx`
   ——叶子与**行**两层计数断言（见 5.8 / 5.16）；要读数就设 `CODEMUX_ROW_COUNT_TRACE=1`。
6. **仓库级门禁**：`npm run typecheck`（本仓库 pre-commit）+ `cd apps/desktop && npm run typecheck`、
   `npx vitest run`（根；sidecar 另跑 `cd apps/sidecar && npx vitest run`）、
   `npm run check:size`（行数预算门禁，用法与基线维护见 5.24）。

---

## 七、边界与未验证

- 第二节的结论最初来自**双仓库静态代码走查**。截至 2026-09-22 的落地情况：
  2.3（分帧绘制）已用真实引擎实测（5.1）、3.3（窗口节流）已实施（5.3）、
  3.1（backdrop-filter）与 3.2（轮询）已实施（5.5 / 5.6）、3.5 的终端部分已实施（5.7）、
  3.6（常开诊断收 DEV 门控）与行数预算已实施（5.11 / 5.24）、2.1（memo 边界）的叶子层（5.8）与
  行级（5.16）**都已实施**、2.4（rAF 合并器）已实测**否决**（5.20）、2.5（批边界）已给读数（5.21）。
  **仍未做运行时实测的是 2.2 的剩余部分、2.6、3.4、3.7**，相对权重未校准——引用它们时请
  当作待验证的假设。另外 5.11 那里**撤回**了本文档早先关于流式遥测的两条错误归因（"每 flush
  一条"与"IPC + 落盘"）：写文档时也要照这个口径——**没核过的量级不要写进结论**。
- 5.11 这一项**不宣称毫秒收益**：它的可验证收益是"打包态不再执行这些诊断"，靠**产物 grep**
  证明（`dist/assets/*.js` 里相关字符串命中 0）。这是一条比"应该会快一点"更硬的证据形态，
  可以复用到其它"收掉常开代码"的改动上。
- 5.5 那一项**不依赖性能测量**：它成立的理由是"blur 作用在平整纯色上是恒等变换"，
  证据全在 CSS 里（见 5.5 的证据链）。这里刻意不说"它很贵"——本仓库历史上曾因
  "用'应该会很贵'下结论"吃过亏。
- 5.8 的读数来自 **jsdom + stub 掉 Markdown/Shiki** 的诊断，**只能用来看规模效应**（代价是否
  随挂载行数增长），**不能当作真实毫秒**：真实环境里 Markdown + Shiki 的每行成本高得多，
  jsdom 的每次 DOM 操作又慢得多，两个偏差方向相反。要真实毫秒，得用真实引擎探针
  （`scripts/e2e/stream-reveal-probe/` 那一套）。
- 5.8 的**行级收窄已在本轮完成**（5.16，201 → 2），5.8 末尾"收益尚未量化"的说法已过时：
  现在叶子与行两层都有计数守卫。**残余的约 408ms 落在"已闭合块的 Markdown 管线 + React 协调"**
  （5.18）——下一步若要继续，方向是减少每次提交参与协调的块数与 Markdown 重建量，
  而不是再动调用节拍。
- 5.7 未做的那半（`<webview>` 的挂载条件）本轮**用证据核对后决定不改**（5.23）：`display: none`
  的显隐已经接线且有测试覆盖；卸载元素会 destroy 掉 guest、丢登录态与页面状态。它不再是"待实测"。
- 2.5（批次边界）**本轮已给读数、不再是"只给判据"**：前端每帧的 store 分发成本在 10⁻² 毫秒量级
  （5.21）⇒ **保持 daemon 的批边界不动**。已实测的那一项（分帧绘制）的判据与阈值写在
  `scripts/e2e/stream-reveal-probe/runner.mjs` 顶部，可复核与复算。
- 5.6 引入了两处**有意的行为变化**：轮询节拍取所有订阅方 interval 的最小值（15s → 12s）、
  `status/loading/error` 由单例共享（A 实例的动作报错 B 实例也能看到）。若要保持 15s，
  得改 `SessionList.tsx:113` 的调用参数——本次刻意没动调用方。
- PI-Desktop 不是无懈可击：它自己的空闲卡顿 TOP 嫌疑是 `vibrancy + transparent` 整窗合成层
  （`window.ts:187,189`）、失焦时 CSS 动画无暂停机制（全库 `animation-play-state` 零命中）、
  以及"运行中后台会话持续 1s tick"。**这几条不要照搬。**
- 浏览器宿主（PC / 移动）共用 `src/`，但改动后需 `npm run build:web` 重新产出 `dist-web/`
  才能在浏览器宿主上看到效果。
