# 主/子智能体共享消息行渲染

> labels: `ready-for-agent`
>
> 日期: 2026-09-01
> 前置: [2026-08-28 子智能体独立时间线与实时预览](./2026-08-28-subagent-streaming-preview-design.md)
> 决议: 一次到位抽出共享消息行；子智能体不承接主线程全部能力；footer 保持节减

## Problem Statement

用户点开子智能体 SidePanel 后，看到的文字、思考块、工具卡片和消息 footer，和主会话时间线不是同一套呈现。两边已经共用事件投影（把 CodeMUX Event 转成助手消息），但消息行本身是两套实现：主会话走完整聊天线程，子智能体面板手写了一份「看起来差不多」的只读列表。

结果是：Markdown、思考折叠、工具卡片、footer 何时出现、滚到底部这些本该一致的行为会各自漂移。用户无法信任「点卡片进去看到的过程」和主会话里同一类内容长得一样。同时，子智能体面板是只读预览，不该把主线程的输入框、回退、分叉、消息导航、工具分组、计划卡片等能力一起带进来。

## Solution

抽出一层与聊天运行时解耦的**消息行渲染器**：同一条已投影的助手消息，在主会话时间线和子智能体时间线里用同一套部件画出文本、思考、工具调用和 footer。

主会话继续当完整聊天线程：输入、回退、分叉、消息导航、工具分组、紧凑折叠、计划解析、完整 footer 都留在主线程壳子里。子智能体 SidePanel 继续当只读预览：自己的标题、空态、运行中指示、任务提示卡片，footer 只保留复制和时间。两边共享「这条消息要不要 footer」的规则：User Message 有 footer；助手中间过程没有；只有回合最后一条助手消息有；子智能体仍在 running 时，尾部那条助手消息也没有。

不把完整聊天线程塞进 SidePanel。

## User Stories

1. As a 桌面用户，我希望子智能体面板里的助手正文和主会话使用同一套 Markdown 呈现（含代码块、链接、表格样式），以便两边读起来是同一种对话。
2. As a 桌面用户，我希望子智能体面板里的思考内容用与主会话相同的折叠思考块呈现，默认收起，以便过程细节不把预览撑爆。
3. As a 桌面用户，我希望子智能体面板里的工具调用卡片与主会话同一套工具卡片（摘要、展开、错误态、文件类点击打开既有 file/diff tab），以便我验收子智能体做了什么时不必换一套视觉语言。
4. As a 桌面用户，我希望子智能体时间线里的任务提示（声明时写入的那条 User Message）仍显示为只读提示卡片，而不是主会话那种可回退、可编辑的用户气泡，以便我分清「这是任务说明」和「这是我在主会话里发的话」。
5. As a 桌面用户，我希望子智能体面板没有输入框、排队消息和停止按钮，以便我不会误以为可以在这里给子智能体发话；停止和 Interactive Request 仍只在父会话。
6. As a 桌面用户，我希望子智能体面板的消息 footer 只提供复制和时间，以便预览保持干净，不会出现分叉、排查提示词或耗时统计。
7. As a 桌面用户，我希望子智能体面板的 footer 仍按回合规则出现：任务提示有 footer；助手中间过程没有；已完成回合的最后一条助手消息有；子智能体仍 running 时最后一条助手消息没有，以便 footer 不会被读成「这轮已经结束」。
8. As a 桌面用户，我希望消息 footer 默认隐藏、悬停或聚焦该行才出现，以便阅读时不被操作条打断，行为与主会话一致。
9. As a 桌面用户，我希望点击子智能体消息 footer 的复制后，剪贴板里是该行可见的文本与思考内容，以便我能把子智能体结论拷出去。
10. As a 桌面用户，我希望子智能体仍在跑、面板贴在底部时，新出现的文字和工具卡片自动跟上；我向上翻历史后不再被拽回去，并看到回到底部的按钮，以便实时预览和回看互不打架。
11. As a 桌面用户，我希望子智能体尚无事件且仍 running 时看到「启动中」，已结束且无记录时看到空态，以便打开过早或从未宣布成功的卡片不会一片空白。
12. As a 桌面用户，我希望子智能体 running 时时间线底部仍有「运行中」及描述符字幕，以便确认它没卡住。
13. As a 桌面用户，我希望主会话时间线在这次改动后外观与操作不变：回退、编辑、分叉、完整 footer（复制 / 排查 / 分叉 / 耗时）、消息导航、工具分组、紧凑输出折叠、计划卡片、data 类系统消息全部仍在，以便主对话能力不被共享层削掉。
14. As a 桌面用户，我希望主会话在异步子智能体流程尚未收束时，父时间线的助手消息仍然不出现「已完成」footer，以便父会话不会被误读成已经结束。
15. As a 桌面用户，我希望点主会话里的 Agent/Task 卡片打开的仍是现有 `kind: 'subagent'` SidePanel tab，而不是一个带输入框的完整聊天线程，以便一期「只读预览、批准留在父 Composer」不被破坏。
16. As a 只读或导入 Session 的用户，我希望子智能体面板若无记录就保持空态，不为导入会话伪造过程。
17. As a 中文界面用户，我希望相关文案、工具提示和空态仍为中文，并与现有语气一致。
18. As a 系统维护者，我希望共享层吃的是已经投影好的助手消息，而不是 raw CodeMUX Event 或 Claude/Codex/OpenCode 字段，以便子智能体时间线继续由现有转换函数供数，适配器层零改动。
19. As a 系统维护者，我希望共享层不依赖聊天运行时的消息原语（分组 parts、复制 action bar、流式 Markdown primitive），以便只读面板不必挂一整套 assistant runtime。
20. As a 系统维护者，我希望「要不要画 footer」的公共规则抽成可复用判定，主线程在此之上叠加自己的完成态 / 系统消息 / 子智能体流程未收束过滤，以免两套 if 再次分叉。
21. As a 系统维护者，我希望 Message Footer 用变体区分完整与节减，而不是子智能体再写一个 hover 条，以便复制、时间格式、hover 显隐只有一份。
22. As a 系统维护者，我希望贴底滚动的「跟随最新 / 用户上翻则释放 / 回到底部」从两处复制逻辑收敛到同一套跟随策略，主线程仍可保留历史灌入多等一帧、新 User Message 强制跟随等额外规则。
23. As a 系统维护者，我希望这次不把完整聊天线程参数化成「只读模式」塞进 SidePanel，以免 Composer、Rewind、Fork、消息导航以禁用分支的形式泄漏进子智能体预览。
24. As a 后续要给子智能体加工具分组或计划卡片的维护者，我希望共享层的消息 part 分发是显式白名单（文本 / 思考 / 工具调用），未声明的 part 类型在子智能体侧直接跳过，以便二期加能力是加白名单而不是解开隐藏耦合。
25. As a Mobile Companion 用户，我希望这次改动不把子智能体预览带到手机上，主对话行为也不因共享层而崩溃。

## Implementation Decisions

- **抽的是消息行，不是完整线程。** 共享模块是「把一条已投影助手消息画出来」。主会话时间线仍由现有聊天线程组件拥有 runtime、视口、Composer、消息导航、中断条、流式尾巴。子智能体 SidePanel 仍拥有标题、空态、运行中指示和只读视口。禁止把完整线程组件以 `readOnly` 开关塞进子智能体 tab。这落实一期规格「用现有消息部件只读渲染」，而不是把整条聊天线程搬过去。

- **共享能力白名单（本期对齐的呈现）。** 文本（同一套 Markdown / Streamdown 配置，含链接与代码块）、思考折叠块、工具调用卡片、footer 显隐规则、hover 显隐、复制、贴底跟随滚动。工具卡片的文件点击继续走既有 SidePanel file/diff tab，不为子智能体再做一套预览。

- **子智能体明确不承接的主线程能力。** 输入与排队消息、停止、回退、编辑用户气泡、Fork、排查提示词复制、耗时统计、消息导航、连续工具分组、紧凑 AI 输出折叠、计划卡片解析、data 类系统消息（流状态、提问卡、会话摘要等）。这些继续只存在于主线程壳子。子智能体遇到未在白名单内的 part 类型时跳过，不尝试「顺便渲染」。

- **用户行两种模式。** 主线程：现有交互用户气泡（回退 / 编辑 / 附件预览）。子智能体：`prompt` 模式，把声明写入时间线的那条 User Message 画成只读任务提示卡片。共享层用模式切换，而不是让子智能体去禁用回退按钮。

- **Footer 变体。** 现有 Message Footer 增加节减变体：只保留复制 + 时间，不要调试、Fork、耗时。完整变体保持现状。复制在没有聊天运行时 action bar 时必须走显式文本（该行文本与思考拼接），不能依赖 runtime 的 copied 状态。hover 显隐 class 与 `data-message-footer` 契约两边共用。

- **Footer 显隐判定分层。** 公共规则：User Message 显示；助手消息仅当 `isFinalAssistantMessage` 且当前时间线不处于「仍在跑的尾部」时显示。主线程在公共规则为真之后，再要求该回合已完成、来源不是 system、异步子智能体流程已收束。子智能体只消费公共规则（`running` 描述符 ⇒ 尾部助手消息不算完成）。不要让子智能体去读父会话的回合表或 `subagentFlowPending`。

- **共享层与运行时解耦。** 输入是已投影的助手消息 + 会话身份 + 时间戳 + footer/用户模式，而不是 assistant-ui 的 Message primitive。文本与思考不得使用依赖 runtime 上下文的 Markdown primitive；必须使用与主线程完成后相同的静态 Streamdown 配置，避免子智能体链接/代码块和主会话完成态不一致。主线程流式中的 Markdown primitive 可以继续走现有流式路径；共享层负责**完成后的消息行**。工具调用继续复用现有工具卡片组件（它本身已不依赖 runtime）。

- **数据入口不变。** 子智能体面板继续：`subagentStore` 事件 → 解析为 CodeMUX Event → 现有 `convertAgentEvents`（可不传回合表，转换函数内部会按事件重建）。不改 Sidecar、Rust 子表、领域事件形状、卡片打开 tab 的协议。

- **贴底滚动。** 抽出「贴底则跟随、上翻则释放、提供回到底部」的跟随策略，供子智能体视口与主线程视口复用。主线程保留自己的额外时机：历史首次灌入多等一帧、新 User Message 强制跟随、流式版本号触发。子智能体用事件条数 + 描述符 `running` 作为跟随触发，不必接入主会话 store 的 streaming 版本号。

- **一次到位。** 单次交付抽出共享消息行、合并 footer 变体、收敛滚动跟随、改两边调用点。不做「先点对点替换、再抽组件」的两段式。

共享消息行的对外形状（比散文更精确，来自讨论收敛，不是实现草稿）：

```ts
type TranscriptFooterVariant = 'full' | 'minimal';
type TranscriptUserMode = 'interactive' | 'prompt';

type TranscriptMessageRenderInput = {
  message: /* convertAgentEvents 产出的助手消息 */;
  sessionId: string;
  timestamp?: number;
  showFooter: boolean;
  footerVariant: TranscriptFooterVariant;
  userMode: TranscriptUserMode;
  toolDurations?: Record<string, number>;
  // 仅 full：耗时 / Fork / 排查。minimal 忽略这些。
  footerStats?: { durationMs?: number };
  canFork?: boolean;
  onFork?: () => void | Promise<void>;
};
```

公共 footer 判定（主线程可再收紧，不可再放宽到「中间过程也显示」）：

```ts
function shouldShowTranscriptFooter(input: {
  role: 'user' | 'assistant' | 'system';
  isFinalAssistantMessage?: boolean;
  isTimelineRunning: boolean;
}): boolean {
  if (input.role === 'user') return true;
  return input.isFinalAssistantMessage === true && !input.isTimelineRunning;
}
```

## Testing Decisions

只测用户可见行为，不测共享层内部是否拆了几个文件、也不测 className 拼装细节（footer 的 hover 显隐契约除外，现有用例已经在断言它）。

**两条既有接缝，不新建第三条。** 共享层本身不单独开测试入口；通过两个消费者证明「同一套呈现」。

1. **子智能体预览面板（主接缝）。** 现有面板测试继续用 `subagentStore` fixture 挂载只读面板。必须继续覆盖：running 空态、完成空态、底部运行中指示、中间助手消息无 footer、完成回合最后一条有 footer、running 时只有任务提示有 footer、思考默认折叠、复制写出文本。并补上共享层落地后应保持一致的外部行为：助手正文走 Markdown（至少代码/链接不会退化成纯文本）、工具调用出现既有工具卡片而不是自制摘要。滚动：内容增高且未上翻时贴底；模拟上翻后出现回到底部。

2. **主会话线程挂载（回归接缝）。** 现有聊天线程 / runtime 挂载测试必须继续通过：完整 footer（复制、耗时、hover）、中间助手消息无 footer、子智能体流程未收束时父消息无 footer、工具分组、回退入口、计划卡片、data 部分。若共享层误把主线程削成节减 footer 或拆掉分组，这条缝会红。

Message Footer 现有单测补一则节减变体：有时间与复制，没有耗时、没有分叉、没有排查按钮；复制不依赖 runtime copied 状态（传入显式文本即可）。这是接缝 1/2 的附属，不是第三条产品接缝。

不测：Sidecar 适配器、Rust 子表、`convertAgentEvents` 投影（除非改到它；本期不应改）。那些仍由一期子智能体规格的既有缝负责。

## Out of Scope

- 把完整聊天线程组件参数化后塞进 SidePanel。
- 子智能体面板发送、排队、Stop、detach 成独立 Session。
- 子智能体承接工具分组、紧凑折叠、计划卡片、AskUserQuestion / stream_status 等 data 消息、Fork、回退、耗时。
- 改 CodeMUX Event、`subagent_upsert` / `subagent_timeline`、Rust 子表、Sidecar 适配器。
- 移动端 / Companion 上的子智能体预览。
- 为共享层新建与消费者对等的第三套测试入口。

## Further Notes

- 一期规格原文写的是「把该子智能体的 CodeMUX Event 数组交给现有 convertAgentEvents，再用现有消息部件 / tool fallback 渲染」。实现时面板手写了消息行，只复用了工具卡片。本 spec 补上那条未完成的呈现收敛，不重新设计子智能体轨道。
- 主线程 footer 比公共规则更严，是有意的：父会话在子智能体仍跑或父轮次未完成时，footer 会像「对话已结束」。子智能体面板用描述符 `running` 表达同一意图即可，不必复用父回合表。
- 思考块在主线程流式时有 streaming 态；子智能体预览一期按静态折叠块对齐完成态外观。不要为了共享而把子智能体挂进 assistant-ui runtime 只为拿到 streaming 标记。
- 与 ADR 0003 相容：共享的是 UI 投影，不是第二条父 Timeline。
