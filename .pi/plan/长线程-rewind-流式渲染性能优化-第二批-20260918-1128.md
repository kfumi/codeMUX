# 长线程 rewind / 流式渲染性能优化（第二批）

## 0. 起点：已测得的成本结构

已提交的 `f8f9d86e` 把 rewind 改成单代发布（`waves=-T|ET → ET`，React 工作量 305ms → 210ms，提交数 5 → 2）。同一个基准（480 事件 / 约 240 行，jsdom + 轻量 markdown 替代）还给出了三项**尚未解决**的成本：

| 成本 | 实测 | 对症的优化 |
|---|---|---|
| 每帧仍对约 240 行做一次全量 React 协调 | 单波 ~210ms | 工作流 C（窗口化），B 只能削减其中的布局/绘制部分 |
| 离屏行的布局与绘制 | jsdom 测不到，真实浏览器里随行数线性增长，是卡顿大头 | 工作流 B |
| 流式每个事件仍发布两代更新 | 与 rewind 修复前同构 | 工作流 A |
| MessageNav 每帧对全部用户消息各做一次 `getBoundingClientRect` | 每次 rewind 120 次 | 并入工作流 C（或独立小改） |

本批计划按**风险从低到高**排：A（可测、低风险）→ B（低风险、浏览器级收益，需你实机确认）→ C（结构性，需你实机验收后决定是否做）。

---

## 工作流 A — 流式事件也单代发布（低风险）

### 现状（`src/stores/agentStore.ts`，行号为当前版本）
6 处写入 `events`，每处都会让模块级订阅器（`:3754-3787`）在**第二次提交**里补算 `turns`：

| 行 | 路径 | 热度 |
|---|---|---|
| `:2210` | `content_block_stop` 合成 tool_use 事件（每个工具调用一次） | 高 |
| `:2531` | 通用事件追加 | 高 |
| `:1063` | `simulateStreamingContent` 收尾提交 | 中 |
| `:1008` | `commitPendingSimulatedStream` | 中 |
| `:1037` | `simulateStreamingContent` 无 chunk 直接提交 | 低 |
| `:3434` | 历史加载（`nextEvents`） | 低 |

### 改动
1. 在 `agentStore.ts` 里新增（紧邻现有 `computeSessionTurns`，`:3722`）：
   ```ts
   /** 在同一个 set 提交里带上该会话的 turns 投影,避免订阅器再发第二代。 */
   function turnsForCommit(state: AgentState, sessionId: string, next: Partial<AgentState>)
     : Pick<AgentState, 'turns'> {
     return { turns: { ...state.turns, [sessionId]: computeSessionTurns({ ...state, ...next } as AgentState, sessionId) } };
   }
   ```
2. 上述 6 个站点各自把 `eventTimestamps` 的新数组**先存入局部变量**，然后
   `return { ...base, ...turnsForCommit(s, sessionId, base) };`
   —— 局部变量必须同时供 `events`/`eventTimestamps` 和 `turnsForCommit` 使用，否则 turns 的时长派生会与订阅器口径不一致。
3. 订阅器**不需要**再改：`f8f9d86e` 已加入「同一提交内 `turns` 已更新则跳过」的守卫（`:3769-3771`），这 6 个站点会自动获得单代发布。

### 为什么这 6 处比 rewind 安全
rewind 的坑是「同一个 set 里把 `isRunning`/`forceStopped` 从 true 改成 false」，所以必须把新值一并喂给推导。这 6 处**都不在同一提交里改 `isRunning`/`forceStopped`**，因此 `{ ...s, events, eventTimestamps }` 与订阅器看到的状态完全一致，不存在口径分歧。

### 验证
- 在 `src/stores/agentStore.test.ts` 新增回归测试：分别驱动 `content_block_stop` 的合成事件路径与通用追加路径，断言只产生**一次** `{events:true,turns:true}` 更新、且没有 `{events:false,turns:true}` 的独立第二代。
- 反向验证（沿用 rewind 那次的实证做法）：临时把 `turnsForCommit` 展开去掉，确认新测试**确实失败**，证明断言不是空转。
- 受影响范围：`npx vitest run src/stores src/components/agent`。
- 全量：`npx vitest run`（当前基线 208 文件 / 1638 测试）。
- 预期收益：流式每个事件少一轮全量重渲染（按 rewind 的实测类比约 -30% 渲染工作量/帧）。**不改善 rewind 本身。**

---

## 工作流 B — 离屏行跳过布局与绘制（低风险，浏览器级收益）

### 做法
1. `src/components/agent/assistant-ui/CodeMuxThread.tsx:415-421`：给 `data-testid="thread-content-shell"` 的元素加条件属性
   `data-long-thread={events.length > 120 ? '' : undefined}`（约 60 行消息；短会话完全不受影响）。
2. `src/styles/globals.css`：新增一条带注释的规则
   ```css
   /* 长会话:离屏消息行跳过布局与绘制(Chromium content-visibility)。
      `auto <length>` 会记住已渲染过的真实高度,只有从未渲染过的行使用估算值。 */
   [data-long-thread] [data-message-row] {
     content-visibility: auto;
     contain-intrinsic-size: auto 200px;
   }
   ```
   适用范围：主会话线程（行根元素已在 `:721-722` 用户行、`:1313-1314` 助手行上带 `data-message-row`）。`CodeMuxTranscriptMessage.tsx` 只被 `SubagentPreviewPanel` 使用（侧栏子代理预览），**不纳入**本次范围。

### 为什么值得做
rewind 后存活行内容不变但必须重新布局/绘制；浏览器里 240 行的 layout/paint 是卡顿大头。`content-visibility: auto` 让视口外的子树直接跳过 layout/paint，且 `contain-intrinsic-size: auto 200px` 会复用已测高度，避免滚动条长度失真。Electron 与浏览器端同源（皆为 Chromium）。

### 风险与缓解
- **从未渲染过的行返回估算 rect**：`MessageNav` 的标记位置对这些行是近似值，滚动到附近后自动校正（自校正，非错误累积）。
- **与底部吸附共存**：底部行始终在视口内、始终渲染，`useTranscriptFollowLatest` 的 `scrollHeight/clientHeight` 判定不受影响。
- **只对长线程启用**：短会话（绝大多数）行为完全不变，也避免影响现有测试。

### 验证
- jsdom 不实现 `content-visibility`，单测**只能**断言「阈值属性是否按预期出现/缺席」（`data-long-thread` 在短/长会话下的有无），不能断言视觉效果——这一点我会在报告里明确写清，不会把「属性存在」说成「性能已改善」。
- 需要你实机验收（我给出步骤）：打开一个数百轮的长会话 → ① 滚到中部看滚动是否顺滑、滚动条长度是否跳变；② 连续上滑/下滑检查是否有空白闪烁；③ 点 MessageNav 跳到首尾消息是否落点正确；④ 折叠/展开一个工具组看是否跳位；⑤ 执行一次 rewind 看卡顿是否明显减轻。

---

## 工作流 C — 真正的窗口化（结构性，风险最高；建议在 A+B 实机验收后再决定）

### 已确认的前提
`@assistant-ui/react@0.14.24` / `@assistant-ui/core@0.2.19` **未提供**任何虚拟列表导出（已查 dist 类型声明），仓库也没有虚拟化依赖 → 需要自研窗口化或新增依赖（会触及 AGENTS 的依赖与打包约束）。

### 若做的设计要点
1. **窗口化模型抽成纯函数**（便于单测）：以 `messageId` 为键的高度缓存 + 估算 + 渲染后测量校正，配合上下 spacer 与 overscan，输入（id 列表 / 高度缓存 / scrollTop / 视口高）→ 输出（渲染区间 + spacer 高度）。
2. **必须同时改造的耦合点**（否则会出现静默错误，不会报错）：
   - `MessageNav`（`:1039` 活跃标记、`:1139` 跳转）依赖 `document.getElementById('msg-'+eventIndex)`，离窗行不在 DOM 中 → 活跃标记失效、跳转 no-op。必须改为读窗口化模型并支持「先滚动、后测量」。
   - `useTranscriptFollowLatest`（`src/hooks/useTranscriptFollowLatest.ts`）用 MutationObserver + ResizeObserver + `scrollHeight/clientHeight` 判底，窗口切换会频繁触发它的观测；需要改为基于模型总高判定，并保住 `isTranscriptViewportAtBottom` 语义。
   - `useCollapsibleScrollLock` 的锚定、以及折叠面板/Rich diff 的行高变化必须回报给高度缓存，否则滚动会漂移。
3. **验证边界**：jsdom 无法验证滚动锚定与跳动手感。可单测的是窗口化模型纯函数与「挂载行数有上界」「rewind 目标行仍在窗口中」这类不变量；其余必须在真实应用里点检（跳转、折叠展开、流式追加、切换会话、rewind）。

### 我的建议
先做 A + B 并请你实机确认残留卡顿程度；若仍明显，再把 C 拆成「窗口化模型（纯函数 + 单测）」与「接线」两个独立提交来做。**不建议**在没有实机验收的情况下一次性盲改滚动路径。

---

## 明确不做的部分
- 不把 `state.turns` 改成惰性派生（消费方只有 `CodeMuxThread.tsx:187` 与 `CodeMuxAssistantRuntime.tsx:72` 两处，看似可行，但会改变 store 契约与现有测试语义，收益与 A 重叠）。
- 不改 MessageNav 的 O(n) 测量（除非进入工作流 C——窗口化后它必须一起改）。
- 不动 Rust / sidecar。

---

## 提交与验收方式
- 工作流 A、B 各自独立提交，遵循仓库中文 Conventional Commits（`perf(agent): …` / `perf(ui): …`）。
- 每个提交的门禁：受影响测试 → 全量 `npx vitest run`（基线 208/1638）→ `npm run build`（含 tsc，上一批刚修好）→ `npm run build:web`（渲染层改动需刷新浏览器端产物）。
- Rust/sidecar 不受影响，不重建守护进程。
- B 的效果以你的实机点检为准，我会如实区分「已测得的数字」与「待你确认的手感」。

## 交付物
1. 工作流 A 的代码 + 反向验证过的回归测试。
2. 工作流 B 的 CSS 与阈值属性 + jsdom 可断言部分的测试 + 实机点检清单。
3. 一份实测对照（流式渲染工作量前后、以及 B 上线前后的实机观察记录）。
4. 若你选择继续：C 的窗口化模型纯函数与其单测（独立提交）。
