## 目标最终形态（改造后的渲染结构）

一个助手回合 `assistant turn`，按源码顺序切成「处理段（activity run）」与「文本片段」交替：

```
[已处理 1m 30s · 5 个步骤  ▸]      ← run 组头：图标 + 文案 + 步骤数 + 箭头
│ 实时时头下一行尾预览：「正在读取 CodeMuxThread.tsx」
│ ├─ ✦ 思考   结尾一行摘要        ▸   ← 步骤行（思考），展开=markdown
│ ├─ 📄 读取  CodeMuxThread.tsx   ✓ 1.2s  ▸
│ ├─ ⌨ 运行   npm run build     ⟳(spinner)
│ └─ ✦ 思考   再确认一下边界        ▸
「先确认范围。」                    ← 文本片段打断 run
[处理中 · 12s · 3 个步骤  ▾]       ← 下一段，实时中默认展开
│ └─ …
「最终答复……」                     ← 最终总结，始终可见
```

与现状的差别：不再出现 `思考 ▸`、`读取 2 次文件 ▸`、`思考 ▸` 这样多个各自带标题的嵌套折叠块；**一整段连续的过程（思考+工具混排）只占一个组头**，组内按源码顺序平铺步骤行，左侧一条竖线。

不改的东西：`compact_ai_output`（「精简 AI 输出」）的整轮折叠语义、`assistantCollapse.ts` 的全部计算、`AgentStore`/sidecar/Rust、消息转换语义、`MessageFooter`、窗口化、消息导航、子智能体运行行。

---

## 一、分组：由「按类型分组」改为「按运行段分组」

**关键机制**：`@assistant-ui/core` 的 `buildGroupTree` 是**相邻合并**（`groupParts.js:78-127`）。把 `reasoning` 与 `tool-call` 指向**同一个 group key**，就自动得到「连续思考+工具 = 一段，文本/data 打断」的语义，不需要手写分组函数。

### 1.1 `src/components/agent/assistant-ui/CodeMuxThread.tsx`
- `GROUP_BY_PART_INNER` 映射改为 `{ reasoning: ['activity-run'], 'tool-call': ['activity-run'], 'standalone-tool-call': [] }`；`GROUP_BY_PART` 里 `isAskUserQuestionToolName` 返回 `[]` 的特判保留（问询卡片仍独立成行、不并入 run）。
- `switch` 分支收敛为：
  - `case 'activity-run'` → 新的 `CodeMuxActivityRun`（见 1.3），`children` 为其内部步骤行；
  - `case 'text'` / `case 'reasoning'` / `case 'tool-call'` / `case 'data'` 保持现有叶子渲染。
- 删除 `CodeMuxReasoningGroup`（1806-1831）与 `CodeMuxToolGroup`（1833-1875），以及 `ToolGroup` 的 import。

### 1.2 `src/components/agent/assistant-ui/CodeMuxTranscriptMessage.tsx`（只读副本：右侧子智能体预览）
- `groupTranscriptParts` 重写为 `groupTranscriptParts` → `Array<{ kind:'activity'; items: {partIndex, part}[] } | { kind:'part'; partIndex, part }>`：`reasoning` 与 `tool-call` 累进当前 activity 段，`text` 与 `AskUserQuestion` 打断；删除 `tool-group` 变体。
- `CodeMuxTranscriptMessage` 的渲染分支同步：`activity` → `CodeMuxActivityRun`（同一套组件），`text` → 现有 `Streamdown` 块。

### 1.3 新组件 `src/components/assistant-ui/activity-run.tsx`
对外只暴露两个组件，主线程与只读副本共用：

**`ActivityRunHeader`**（受控；props：`open` / `onToggle` / `live` / `onlyThinking` / `thinkingNow` / `durationMs` / `stepCount` / `tail`）
- 结构：`button[data-slot="activity-run-trigger"][aria-expanded]` → `activity-run-icon`(Sparkles 15px) + `activity-run-label` + `activity-run-count`（仅 `stepCount > 1` 渲染 `{n} 个步骤`）+ `activity-run-caret`(ChevronRight 12px)；
  下方：`!open && live && tail` 时渲染 `activity-run-preview`（单行省略）。
- 文案判定（严格对齐参考 `chat.*` 文案）：
  | 条件 | 文案 |
  |---|---|
  | `live && (thinkingNow \|\| onlyThinking)` | `思考中 · {time}` |
  | `live` | `处理中 · {time}` |
  | `!live && onlyThinking && durationMs` | `已思考 {time}` |
  | `!live && onlyThinking` | `思考` |
  | `!live` | `已处理 {time}` |
  `time` 用现有 `formatElapsed`（`1m 30s` / `12s` / `0s`，与参考 `formatToolDuration` 输出一致）。
- 样式对齐参考 `.tool-activity-header`：外层 `my-1.5 w-full`；头 `inline-flex max-w-full min-h-[26px] items-center gap-[5px] -mx-[3px] rounded-sm px-[5px] text-ui-body text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-2))]/60 hover:text-foreground`；label `font-medium`；count `text-ui-caption text-muted-foreground truncate`；caret `opacity-0 group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100`，窄屏用 `useIsNarrowViewport()` 常显；running 时 label 后跟 4px 脉冲圆点（`animate-pulse`，`motion-reduce` 下关闭）。
- 计时：**只在 head 内部**、且仅 `live` 时挂一个 `setInterval(…, 1000)`（不每行一个 interval）。

**`ActivityRunBody`**（容器）
- 复用现有 `Collapsible` / `CollapsibleContent`（`@/components/ui/collapsible`）+ `useCollapsibleScrollLock`，沿用现有 `data-open:animate-collapsible-down` / `data-closed:animate-collapsible-up` 动画。
  **不采用**参考的 `grid-template-rows: 0fr→1fr`（会与 codeMUX 的折叠滚动锚定机制冲突）。
- 样式：`relative my-0.5 mb-1.5 ml-[7px] pl-3`，左侧 1px rail 沿用现有 `bg-muted-foreground/18`（原 `tool-group-rail` 的视觉），步骤行 `flex flex-col gap-0.5`。

---

## 二、状态：run 级自动开合 + 整轮「已处理」保留

### 2.1 主线程 `CodeMuxThread.tsx`
新增两份状态，与现有 `expandedTurnKeys`（`CodeMuxThread.tsx:294`）同构：
- `expandedRunKeys: Set<string>`、`claimedRunKeys: Set<string>`；
- 在现有 `useEffect(() => setExpandedTurnKeys(new Set()), [sessionId, compactAiOutput])` 中一并清空。

run 开合判定（对齐参考 `useAutomaticDisclosure`）：
1. 用户在 `claimedRunKeys` 里 → 以 `expandedRunKeys` 为准；
2. 否则 `live === true` 自动展开、`live === false` 自动收起；
3. 点击时写入 `claimedRunKeys` + 翻转 `expandedRunKeys`。

`live` 判定：该 run 属于「仍在运行的尾回合」且其后没有该回合的其他过程事件。

### 2.2 `compact_ai_output` 语义完全保留（两种模式并存，不打架）
- **关闭（默认）**：每个 run 都有自己的组头，按 2.1 自动开合 → 即上面的目标形态，也是本次要修的观感问题。
- **开启**：`AssistantCollapseToggle`（「已处理 + 时长」整轮折叠）与 `collapseInfoByEventIndex` / `expandedTurnKeys` / `omitLatestTurnCollapse` 逻辑一行不改；此时**该回合内抑制 run 组头**，展开后按新的平铺步骤行显示（今天展开后是嵌套的 `思考 ▸`/工具组 ▸，改后统一成平铺，视觉更一致）。判定条件：`compactAiOutput && getMessageCollapseInfo(message, collapseInfoByEventIndex) != null`。

### 2.3 只读副本 `SubagentPreviewPanel.tsx` / `CodeMuxTranscriptMessage.tsx`
现有 `collapseInfo` / `collapseExpanded` / `onToggleCollapse` props 与 `expandedTurnKeys` 保持原样；同一判定规则（`collapseInfo` 存在时抑制 run 组头）通过 prop 下传，两个视图表现一致。

---

## 三、步骤行

### 3.1 思考行 `ActivityStepThinking`（放在 `activity-run.tsx`）
- 行外壳与工具行同形：`Sparkles` 15px + `思考` + 单行摘要 + caret。
- 摘要取该 thinking 文本的最后一行、去掉 `#` / `**` 后 trim（对齐参考 `activityItemDetail`）。
- 展开内容复用 `ReasoningRoot` / `ReasoningContent` / `ReasoningText`（`src/components/reasoning.tsx`），**不改动** `ReasoningTrigger` 组件本体；在 `ReasoningRoot` 内放自定义 `CollapsibleTrigger`，并给它补上 `data-slot="reasoning-trigger"` 及子 slot `reasoning-trigger-icon` / `reasoning-trigger-label` / `reasoning-trigger-summary` / `reasoning-trigger-chevron`，让既有断言只需补一个 slot。

### 3.2 工具行（`tool-fallback.tsx` + `CodeMuxMessageParts.tsx` + `toolHeaderSummary.ts`）
- `toolHeaderSummary.ts` 新增 `getToolActionLabel(toolName, { running })`：`读取/正在读取`、`列出/正在列出`、`搜索/正在搜索`、`写入/正在写入`、`编辑/正在编辑`、`运行/正在运行`、`获取/正在获取`、`委派/正在委派`；`use` 类回落 `getToolDisplayName`（保留「更新待办 / 技能 / 退出计划模式」等既有可读名称）。附单测。
- 新增 `ToolActionIcon`（lucide）：Read→FileText、LS/Glob→Folder、Grep→Search、Write/Edit/apply_patch→Pencil、Bash/shell_command→Terminal、WebFetch/WebSearch→Globe、Task/Agent/subagent→Bot、其余→Wrench。
- `ToolFallbackTrigger` 改造：
  - 首位改为动作图标；名称改为 `getToolActionLabel(...)`；
  - 摘要沿用 `getToolHeaderSummary().text`（含完整路径 tooltip 逻辑不变），样式改 `min-w-0 truncate font-mono text-ui-caption text-muted-foreground`；
  - 状态右对齐：运行中 → 11px 边框旋转 spinner；失败 → `text-destructive` + 「失败」；拒绝 → 「已拒绝」；完成 → 无文字；
  - 保留现有 `durationMs` chip，样式简化为 `tabular-nums text-ui-caption text-muted-foreground`，紧贴 caret 左侧；
  - caret 由 `trigger:hover` 改为整行 hover 显隐；
  - 行距：`ToolFallbackRoot` 的 `py-0.5` → `my-[3px]`；trigger `min-h-6 gap-1 -mx-1 px-1 rounded-sm`；
  - **保留全部既有 `data-slot="tool-fallback-*"` 名称与 `aria-expanded` 语义**，避免测试大面积改写。
- 详情体（`ToolFallbackArgs` / `Result` / `CommandOutput` / `ConversationArgs` / `ConversationResult` / `ToolCodeDiff` / 子智能体 chip / ExitPlanMode 链接）内容与行为一律不变，只调整 `mt` / `pl` 以适配组内缩进。

---

## 四、实时流（`StreamingContent`，`CodeMuxThread.tsx:1959-2053`）
- `isThinking` 时，把实时思考**作为当前尾段 run 的一个缩进步骤行**渲染（沿用 3.1 的缩进行样式 + rail），不再单独渲染一个顶层 `ReasoningRoot` 块；组头此时显示 `思考中 · {time}`，尾预览显示实时思考的最后一行。
- **必须保留** `data-streaming-reasoning="true"` 属性（`CodeMuxThread.streamingSegments.test.tsx:165-172` 依赖它）与 `data-streaming-text="markdown"`。
- 实时正文的 reveal 节流（`useStreamingTextReveal`）、`duplicateLiveText` / `textIsMisroutedThinking` 判定逻辑一行不改。
- `StreamingStatusFooter`（1942-1957）：保留 `DotMatrix` + `RunningElapsedTimer`，间距/字号对齐参考 `.working-indicator`（`gap-2.5 py-1 text-ui-body text-muted-foreground`）。

---

## 五、间距 / 排版 / Markdown 对齐（只调 token 层，不换渲染器）

| 位置 | 改为（对齐 `messages.css`） |
|---|---|
| 助手消息行 | `MessagePrimitive.Root` 由 `mb-2/mb-4` 改为固定 `py-3`（等价 12px），保留 `data-message-row` |
| 行内列 | `space-y-1.5` → `space-y-1`（4px） |
| run 组 | `my-1.5`（≈7px） |
| run 头 | `min-h-[26px] gap-[5px] px-[5px] -mx-[3px]` |
| run body | `my-0.5 mb-1.5 ml-[7px] pl-3` |
| 步骤行 | `my-[3px]`，头 `min-h-6 gap-1` |
| 工具摘要 | `font-mono text-ui-caption text-muted-foreground truncate` |
| 思考正文 | `text-ui-compact leading-relaxed text-muted-foreground` |
| 助手正文 | 保持 `Streamdown` + `pl-1 text-sm leading-6`；`markdown-text.tsx` 段落类间距对齐参考 `.prose-chat`（`p { margin: 0.65em 0 }`、`p + p { margin-top: 0.8em }`、`first:mt-0 last:mb-0`） |

- 全部走 codeMUX 既有语义 token（`text-ui-*` / `text-code` / `--surface-*` / `text-muted-foreground` / `text-foreground`），不引入硬编码色值、不写 `text-foreground/45` 这类透明度后缀。
- 长会话性能：现有 `[data-long-thread] [data-message-row] { content-visibility: auto; contain-intrinsic-size: auto 200px }` 规则不变；**不**给 run 容器新加 `content-visibility`（与折叠滚动锚定有冲突风险，本次不做）。

---

## 六、清理
- 删除 `src/components/assistant-ui/tool-group.tsx` 与 `src/components/assistant-ui/tool-group.test.tsx`。
- 实施时确认 `buildToolGroupSummary` / `buildToolGroupLabel` 的剩余引用点（`src/components/assistant-ui/context-display.tsx`、`src/components/workspace/SubagentPreviewPanel.tsx`），把仍需保留的摘要逻辑迁到 `toolHeaderSummary.ts`（已有 `toolHeaderSummary.test.ts` 覆盖 `getToolGroupPhrase` 等）。
- `src/components/reasoning.tsx` 中 deprecated 的 `ReasoningGroup` 保持不动。

---

## 七、测试改动

**新增**
- `src/components/agent/assistant-ui/activityRun.test.tsx`：组头文案矩阵（live/结束 × 仅思考/含工具 × 有/无时长）、`N 个步骤` 阈值、尾预览只在 `live && !open` 显示、running 脉冲点与 `prefers-reduced-motion`、窄屏 caret 常显。
- `CodeMuxAssistantRuntime.test.tsx` 新增两条：
  1. **顺序回归**：事件序列 `thinking A → tool(Read) → thinking B → tool(Bash) → text`，断言 DOM 文档序为 `reasoning → tool → reasoning → tool → text`（用 `container.querySelectorAll` 收集 `[data-slot="reasoning-trigger"]` 与 `[data-slot="tool-fallback-trigger"]` 后比较顺序，而非只断言存在）；
  2. **单组断言**：同一序列只产生 **1** 个 `[data-slot="activity-run-trigger"]`，且文案含 `个步骤`。

**重写/删除（旧分组断言）**
- `CodeMuxAssistantRuntime.test.tsx`：`renders consecutive related tool calls inside one tool group`（1698-1705）、`keeps thinking separate from grouped tools between two text messages`（1707-1736）、`groups write tools with surrounding tools in one tool group`（1738-1750）、依赖 `[data-slot="tool-group-trigger"]` 的 1771-1773；`renders the reasoning trigger like the native assistant-ui component`（1691-1695）子 slot 由 3 个改为 4 个（补 `reasoning-trigger-summary`）。
- `SubagentPreviewPanel.test.tsx`：`思考内容用思考折叠组件渲染…`（226-244）按新思考行 slot 微调；`紧凑输出开启时中间过程收成已处理…`（502-528）必须继续通过（这是「保留已有功能」的看门测试）。

**必须保持绿（回归看门）**
- `CodeMuxAssistantRuntime.test.tsx` 中全部 `compact_ai_output: true` 的用例（2681 / 2701 / 2747 / 2791 / 2808 / 2835 / 2866 / 2879 / 2994）与两条 `已处理` 断言（2690 / 2799）。
- `CodeMuxThread.streamingSegments.test.tsx`：`data-streaming-reasoning`（165-172）与 `reasoning-trigger` 计数（236-237）。
- `CodeMuxMessageParts.test.tsx`：`tool-fallback-trigger` / `-chevron` / `-args` / `-result` slot 与展开态断言（93-97）。
- `assistantCollapse.test.ts`、`toolHeaderSummary.test.ts`：不改逻辑，应自然通过。

---

## 八、验收
- 迭代期按受影响范围跑：`npx vitest run src/components/agent/assistant-ui src/components/assistant-ui src/components/workspace src/lib`
- 门禁：`npx vitest run`（根）全绿；`npm run build`（tsc + vite）通过。
- `npm run dev:desktop` 人工核对：
  1. 交错思考/工具严格按源码顺序，一整段连续过程只占一个组头；
  2. 组头文案与计时：运行中 `处理中 · 12s` / `思考中 · 12s` → 结束 `已处理 12s` / `已思考 12s`，数字每秒跳动；
  3. live 自动展开、settle 自动收起、用户点击后由用户接管（不再被自动收起）；
  4. 尾预览行只在「运行中且已收起」时出现；
  5. 工具行：动作图标 + 动作词 + 等宽摘要 + 状态（spinner / 失败 / 已拒绝）+ 时长 + 整行 hover 显箭头；
  6. 「精简 AI 输出」开与关两态都不回归（开＝整轮「已处理」如旧）；
  7. 右侧子智能体预览面板表现一致；
  8. 长会话滚动与折叠锚定、窄屏 caret 常显、暗色主题与不同字号/圆角设置下不破版。
- 不涉及 `src-tauri/`，无需 `npm run build:daemon`；不涉及 sidecar。

## 九、风险与回滚
- 若相邻合并语义不满足预期（例如后续要求「文本不打断 run」），需改为自定义 `groupBy`；当前参考实现同样是文本打断，本次不需要。
- 运行中 run 的自动收起依赖 `live` 计算；`buildActivityRuns` 会是**纯函数**并配单测，先把 `live` / `startedAt` / `endedAt` 的边界测住，再落 UI。
- 全部改动集中在渲染层与 `tool-fallback`/`activity-run` 两个组件；store、sidecar、Rust、消息转换语义均不动，整体一次提交也可整块 revert。

## 十、实施顺序（同一批内，不单独交付）
1. `src/lib/activityRuns.ts` + 单测（纯函数，先把顺序/分段/计时边界测住）
2. `src/components/assistant-ui/activity-run.tsx`（`ActivityRunHeader` / `ActivityRunBody` / `ActivityStepThinking` / `ToolActionIcon`）+ 单测
3. `toolHeaderSummary.ts` 的 `getToolActionLabel` + 单测
4. `tool-fallback.tsx` / `CodeMuxMessageParts.tsx` 工具行视觉改造
5. `CodeMuxThread.tsx` 接入（groupBy、run 状态、StreamingContent、间距）
6. `CodeMuxTranscriptMessage.tsx` + `SubagentPreviewPanel.tsx` 接入
7. `markdown-text.tsx` / `assistantCollapse.tsx`（`AssistantCollapseToggle` 改用新组头样式）
8. 删除 `tool-group.tsx` 与 `tool-group.test.tsx`，同步全部测试
9. 跑门禁 + `dev:desktop` 人工核对
