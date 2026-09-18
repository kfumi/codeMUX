# 长会话渲染规模：让开销只与"正在看的那一段"成正比

**Status:** ready-for-agent

## Problem Statement

会话一旦变长（数百轮、上千条 CodeMUX Event），CodeMUX 的对话区就开始变得难受，而且**越长的会话越难受**：

1. **rewind 卡顿。** 在长会话里回退到较早的一条 User Message，界面会明显冻结一下。这是本轮工作中唯一被确认真实存在、且能稳定复现的性能问题。
2. **滚动时左栏导航不准。** 对话区左侧的回合导航标记需要在滚动时判断"当前在看哪一回合"。它每帧对**全部**用户消息逐条读取布局几何，消息越多每帧越贵；同时它的判定依赖这些几何值，渲染被跳过时读数会失真。
3. **点导航跳转落点偏。** 长会话首次打开时停在底部，早期消息从未被渲染过；此时点导航跳到较早的回合，落点可能明显偏离目标。
4. **窗口尺寸调整卡。** 主线程被长会话的渲染成本占住时，重排只能排队。
5. **打开/切换长会话慢。**

这些症状与已经修过的问题**不是同一类**。仓库此前做过四轮流式性能修复（工具输出体积上限、历史身份稳定、分帧绘制、平滑度度量、种子化突流源、Rust 侧持久化移出 tokio worker、消除空 `set({})`），它们治的是**逐 token 路径上的固定成本**——每个事件深拷贝整份历史、每次转换重建全部消息对象、批次不均匀导致"一顿一顿"。这些成本与消息数量无关，或已经被压到了 O(1)/事件。

本 spec 要治的是另一条线：**成本随会话长度线性甚至超线性增长**。仓库自己的第三轮排查报告已经把这条线列为"仍未修复"，并明确把它们排在流式修复之后：

- 根因 4：消息导航的 O(n) 布局读取（"当前已 rAF 节流，但每次滚动仍 O(用户消息数)"，需引入偏移缓存 + 失效策略）
- 根因 9：事件提交时的全量重转换
- 根因 12：消息列表无虚拟化（"结构性改造，长会话收益显著"）

还有一条更根本的问题：**四轮修复都没有做端到端实测**。报告自己写明："全部结论来自静态核验 + 单元测试……因此各修复的相对权重仍未校准。"结果是：我们知道改了很多东西，但不知道长会话里现在到底哪一项最贵，也就无法判断下一个改动该往哪使劲。**这个"不知道"本身是首要问题**——它让每一次后续优化都变成猜测，而本项目的排查纪律明确反对用"应该会很贵"下结论（此前已因此吃过亏）。

最后，本轮工作为了缓解长会话滚动成本，给超过阈值的对话区加上了离屏跳过布局绘制的规则。这套规则**引入了上面第 2、3 条症状的失效模式**：被跳过的行高度退化为占位估算，"从未渲染过"的行尤其不准，而导航恰好靠测量这些位置工作。所以第 2、3 条不只是"还没优化"，其中一部分是**本轮改动带来的回归风险**，需要一并处理。

## Solution

让长会话的渲染成本与"用户正在看的那一段"成正比，而不是与整条会话长度成正比；并且把这件事从"靠手感判断"变成"可复现、可断言"。

1. **挂载量有界。** 对话区不再把整条历史的所有消息行都留在渲染树里，而是保留一个**尾部连续窗口**。被扣掉的历史仍在历史数据里（可以搜索、可以导航、可以回退），只是不再占用渲染资源。这是内存与每帧成本的双重上界。
2. **导航仍然精确。** 跳转与"当前在看哪一回合"的判定，在长会话里结果与短会话一致——不因为跳过了离屏渲染而算错位置。被扣掉的历史在导航上表现为一个明确的"更早"标记，而不是一个点了没反应的标记。
3. **导航不再每帧读全量布局。** 滚动时判断当前回合用的是缓存的偏移量，而不是每帧遍历全部用户消息测量几何。
4. **结论可复现。** 有带预算的自动化断言覆盖长会话场景，改动前后能给出"哪一项指标变好了多少"，而不是靠人肉看浮层读数。
5. **短会话零变化。** 阈值以下的会话，行为与现在完全一致——不引入新的首帧延迟、不改变滚动与跟随手感。
6. **三宿主同时成立。** 桌面壳、PC 浏览器、移动浏览器共用同一渲染层，长会话优化在三者都成立。

不做的事（依据是本仓库已有的实测否决，不是遗漏）：不动 Daemon / Companion 协议，不做协议层帧合并，不引入第三方虚拟化库，不把历史从状态里丢弃。

## User Stories

1. As a user with a long Session, I want rewinding to an earlier User Message to respond immediately, so that the action feels like a normal UI action rather than a freeze.
2. As a user scrolling through a long Session, I want the scroll to stay smooth no matter how far back I have read, so that reading old context does not become progressively worse.
3. As a user scrolling a long Session, I want the left-hand turn navigation to highlight the turn I am actually looking at, so that I can trust it as a position indicator.
4. As a user, I want clicking a navigation marker to land on that turn, so that navigation is reliable rather than approximately right.
5. As a user opening a long Session, I want it to appear promptly, so that switching between Sessions does not feel like a penalty for having had a long conversation.
6. As a user, I want the first paint of a long Session to show real content instead of an empty or skeleton viewport, so that the switch feels instant.
7. As a user, I want the scrollbar thumb to be stable while I scroll through a long Session, so that I do not lose my sense of position in the conversation.
8. As a user, I want no blank flashes or jumping content while scrolling, so that reading stays comfortable.
9. As a user, I want expanding or collapsing a tool group to keep that row anchored where I clicked it, so that disclosure does not move my reading position.
10. As a user who scrolled up to read history, I want new streamed content to not yank me back to the bottom, so that I can read in peace.
11. As a user who is pinned to the bottom, I want the transcript to keep following new content, so that I can watch a turn stream without babysitting the scroll position.
12. As a user, I want jumping to the first and last turn of a long Session to be exact, so that the two most common navigation actions are trustworthy.
13. As a user, I want the long Session I am reading to stop growing in memory as I scroll back, so that a long reading session does not degrade the whole application.
14. As a user, I want resizing the window to stay responsive during a long conversation, so that layout changes are not queued behind transcript work.
15. As a user, I want typing in the composer to remain responsive while a turn is streaming in a long Session, so that the input never feels hijacked.
16. As a user with a short conversation, I want it to behave exactly as it does today, so that optimizations aimed at long Sessions do not change everyday use.
17. As a user, I want text selection and copy to match what is on screen, so that the streaming presentation never diverges from the underlying content.
18. As a user, I want in-app search over a long Session to still reach messages outside the rendered window, so that bounding what is rendered does not bound what I can find.
19. As a user, I want the browser's own find-in-page to keep working for the part of the conversation I am reading, and to be told plainly if it cannot reach content that is not currently rendered, so that I am not misled by a silent narrowing.
20. As a user on the mobile browser or a PC browser, I want the same long-Session improvements, so that performance is a property of the product rather than of the desktop shell.
21. As a user, I want the performance overlay to report a smoothness measure that cannot be satisfied by a completely stalled stream, so that I am not shown a perfect score for a frozen UI.
22. As a user, I want a reproducible way to replay a bursty stream, so that a change in perceived smoothness can be compared against the previous build instead of remembered.
23. As a maintainer, I want a long-Session scenario to be covered by automated assertions with explicit budgets, so that a regression is caught in CI instead of by a user report.
24. As a maintainer, I want those assertions to be counts and ratios rather than wall-clock milliseconds, so that the gate is not flaky on a loaded machine.
25. As a maintainer, I want the layout-dependent claims (measurement accuracy, scroll anchoring) to be verified in a real browser engine, so that they are not asserted against a DOM implementation that does not implement the relevant CSS.
26. As a maintainer, I want the reason each rejected alternative was rejected to be written down with its measurement, so that the next round does not relitigate it from intuition.
27. As a maintainer, I want a documented precondition under which the previously rejected frame-coalescing work becomes worth revisiting, so that a decision made from one set of measurements is not treated as permanent.
28. As a maintainer, I want the windowing constants to be named and centralized, so that tuning them is one edit rather than a search across the transcript.
29. As a maintainer, I want the per-frame work of the navigation to be guarded by an assertion that it reads no layout geometry inside its loop, so that the O(n)-per-frame pattern cannot be reintroduced.
30. As a maintainer, I want any measurement that depends on layout to run inside an explicit measurement scope, so that skipping offscreen rendering may never silently corrupt a measurement.

## Implementation Decisions

### 方向：尾部挂载窗口，而不是测量式虚拟化

被否决的是"带高度缓存的测量式虚拟化"（为每一行测量并缓存偏移、用 spacer/绝对定位模拟未挂载行）。否决理由与本项目现实一致：消息行高度高度依赖内容，并且**挂载之后还会变**（流式增长、工具组展开折叠、代码块与 diff 的懒渲染），所以测量式方案需要一整套高度缓存与失效策略，并且会与既有的"贴底跟随"和"上方插入时的滚动锚定"逻辑互相干扰。尾部窗口用同样的资源上界换到同样的收益，活动部件少一个数量级。此项参考了同类项目 PI-Desktop 的 ADR 0130，该文档在同样的权衡下做出了同样否决，并把理由写进了"Alternatives considered"。

同时否决**双向卸载**（按与视口的距离在上下两个方向都卸载）：对话从底部读、在底部流式，卸载视口**下方**的行只会与贴底跟随打架，没有收益。

也不引入任何第三方虚拟化库：现有依赖里没有，而本 spec 选择的方案不需要它们。

### 窗口模型

- 新增一个**纯函数**窗口解析器：输入"已加载历史行数、当前窗口预算、是否处于首帧"，输出"本帧挂载多少行、上方隐藏多少行、是否被裁剪"。
- 常量集中命名：首次提交挂载约 15 行，稳态上限约 60 行，每次触顶增长约 40 行。
- 挂载的是尾部**连续**一段，行留在正常文档流里（不做绝对定位、不撑总高度占位）。
- 窗口按 Session 重置，并夹取到实际已加载行数，避免上一会话增长的预算漏进新会话的首帧。
- CodeMUX 的历史是整体装载进状态、没有分页，因此同类方案里的"两级升级"（先挂载已加载的、再取更旧一页）在本项目退化为一级：只增长窗口，不引入任何新的 IPC 或协议动作。这一点是刻意保留的简化。

### 首帧与滚动锚定

- **首帧门控必须在 render 期派生**，不能由 layout effect 翻转。后者会出现"先挂载全量、再丢弃重建"的三次提交，长会话反而白付一次全量 DOM 的代价。
- 窗口增长会在阅读位置**上方**增加高度，因此必须与"上方插入历史"共用**同一个 pre-paint 锚点**：增长前记录滚动高度，在 layout 阶段按高度差修正滚动位置。放在 passive effect 会留下一帧位置错误的可见画面。
- 首帧的占位 spacer 只服务"让有界后的底部可达"，**不得**按未挂载行数估算高度。按条数估算的 spacer 与它替代的真实行不匹配，展开时会把可见文本推走，表现为一次页面翻转式的跳变。
- 展开窗口后的重新贴底必须在 layout 阶段完成，且**仅当用户仍处于贴底状态**时执行；用户在有界的那一帧内向上滚动过，就必须保留其位置。
- "待重新贴底"的标记必须从 effect 里设置，不得在 render 期写入（并发渲染与 StrictMode 双渲染会为一个从未提交的渲染置位，把用户已经翻上去的画面重新拽到底部）。

### 导航：从已挂载条目构建，隐藏部分显式表达

- 导航标记的来源改为**当前已挂载的消息行**。被窗口扣掉的历史**不生成标记**，而是在导航栏上表现为一个明确的"更早历史"延续标记（虚线/省略样式），它触发窗口增长。
- 理由：标记必须与"能跳到的位置"一一对应。为未挂载行画标记会产生"点了没反应"的死标记，这比缺少标记更糟。
- 因此导航的存在性条件也要相应放宽：当存在被隐藏的历史时，即使已挂载部分不足以构成常规的标记密度，也保持导航可见并显示那个延续标记。
- 跳跃落点仍需精确：增长窗口与跳转都以"目标行的真实几何"为前提，因此跳转必须在测量事务内进行（见下）。

### 几何测量与"跳过离屏渲染"的冲突（本轮回归的修复）

- 现状：超过阈值的对话区对消息行启用跳过离屏布局与绘制，并给出占位高度。其语义是"记住渲染过的真实高度"，**从未渲染过的行**仍是估算值。
- 测量元素恰好就是被跳过元素自身，因此 `getBoundingClientRect` 返回的不是空矩形而是**基于估算的高度**：位置看起来合法，但累计偏移是错的。长会话首次打开时（早期行从未渲染过）误差最大。
- 决定：
  1. 保留跳过离屏渲染的规则（它的 CPU 收益是明确的），但**为测量目标提供逃逸口**：与测量相关的行在该行上强制可见布局。
  2. 任何依赖布局的读取（导航高亮、跳转落点、锚定修正）都必须运行在**显式的测量事务**内：进入时确保相关行参与真实布局，测量/滚动完成后退出。禁止在规则生效状态下直接测量并据此决定滚动目标。
  3. 这一点的同类先例同样来自 PI-Desktop（其搜索目标行显式恢复可见布局，否则定位会拿到占位高度）。
- 由于 jsdom 不实现该 CSS，**这条决定无法被现有契约测试覆盖**，必须由真实浏览器探针负责（见 Testing Decisions）。

### 导航的每帧成本

- 把"滚动时判断当前回合"的实现从"每帧遍历全部用户消息并逐条读取布局几何"改为**缓存偏移 + 失效策略**：偏移在布局变化（窗口增长、行高变化、容器尺寸变化）时重算一次，滚动期间只做读缓存 + 比较。
- 同时钉死一条不变量：**每帧执行的热循环内禁止读取布局几何**。用源码契约断言覆盖，避免它被重新引入。

### 事件转换频率（仅设观测，不预设结论）

- 已知剩余成本：每次事件到达都会重算一次"事件 → 助手消息"的投影，该投影本身要遍历全部历史事件。历史身份复用已经消除了其中"每次重建对象"的部分，但**遍历**仍在。
- 本 spec **不**顺带改造它，理由是**证据不足**：本仓库第四轮已经用实测否掉了"按帧合并"的两个变体（入站帧速率实测仅 4–12 帧/秒，可合并的量很小），并把该结论明确写成"不要用应该会很贵下结论"。在没有新的实测数据前，把转换改成按帧合并属于同一类未经证实的推断。
- 决定：把它列为**观测对象**并给出重估判据——(a) 纯文本流式期间入站帧速率；(b) 对话区的 commit 计数与累计耗时；(c) 长任务累计值。若这三项显示转换遍历重新成为长任务主因，则按帧合并转换值得重估；判据与结论一并写入文档。

### 验证设施的分层

- **纯函数层（CI 安全）**：窗口解析器的边界与夹取规则；平滑度采样与种子化突流源的重放一致性。
- **状态层（CI 安全）**：一次 append 只产生一次 store 发布（沿用本仓库已有的"发布代计数"断言方式）。
- **组件层（CI 安全，jsdom）**：大历史夹具下的可见行为——无半截文字、滚动跟随/释放的判定、导航标记集合与隐藏标记的存在性、阈值属性契约。
- **真实引擎层（新增，唯一的缝合点）**：一个无头 Electron 探针，负责只由布局引擎能回答的断言——跳过离屏渲染对导航几何的影响、跳转落点精度、锚定修正后位置是否正确、滚动条总高度是否连续。这是本 spec 唯一新增的测试接缝，理由是现有的 jsdom 契约测试在原理上无法覆盖这一类断言。

### 预算形式

- CI 门禁用**计数与比值**：渲染/commit 次数、store 发布次数、每次事件产生的转换次数、可见更新间隔的分位数比、字节数比值。
- **毫秒不进 CI 门禁**：只在 dev 浮层作为观测读数，用于人工对比与归因。这既是本仓库已有的实践，也与同类项目把"字节/CPU 比值"与"渲染次数"作为门禁、把时间留给人工观测的做法一致。
- 每个改动都必须有**反向验证**：临时还原实现，确认对应断言确实失败，再恢复。

### 接口与边界

- 不改变 CodeMUX Event 协议、Daemon / Sidecar 行为、Companion 协议、状态存储契约。
- 不改动"状态存全文、只有渲染切片被节流"的既有流式不变量：复制、选中与滚动几何必须与屏幕一致。
- 不改变短会话行为：窗口规则在阈值以下必须等价于现状。
- 三宿主（桌面壳、PC 浏览器、移动浏览器）共用同一渲染层，浏览器宿主需要重新构建前端产物才能看到变化。
- 不新增运行时依赖；不新增 daemon 侧工作量。

## Testing Decisions

**什么样的测试算好测试。** 只断言外部可观察行为：一次操作产生多少次 store 发布、一次流式更新导致多少次组件提交、导航标记集合是什么、点击某个标记后最终滚动到哪、可见更新间隔的分布形态。不断言实现细节（不测试内部函数是否被调用、不测试具体的高度缓存数据结构）。不用毫秒做门禁。每个性能改动都要有一条"改之前会失败"的断言支撑，即临时还原实现后测试必须失败。

**将被测试的模块。**

- 窗口解析模型（新增的纯函数）：边界（0 行、恰好等于稳态上限、超过上限）、首帧与稳态的差异、按会话重置、夹取到已加载行数、触顶后的增长步长与增长上限。
- 导航的偏移缓存与失效：窗口增长、容器尺寸变化、行高变化后偏移被重算；滚动期间不重算。
- 导航标记的构建：隐藏历史存在时出现"更早历史"延续标记；不存在时回到常规标记规则。
- 平滑度采样与突流回放（既有模块）：重放同一种子得到可比较的分布。
- 状态层发布代计数（既有断言方式的扩展）：窗口相关操作不应引入额外的发布波次。
- 真实引擎探针（新增）：在启用与不启用跳过离屏渲染两种状态下，对同一段长历史和同一个跳转目标，断言落点一致且精确；断言导航标记的几何与真实布局一致。

**Prior art（本项目已有的同类测试）。**

- 状态层的 store 发布代计数断言：用订阅器记录每次发布影响的字段集合，断言"一次追加 = 一代"，并附有说明"单独的 turns 代会让每个存活的消息行重渲染两次，这正是长会话 rewind 冻结的原因"。本 spec 的窗口相关工作沿用同一模式。
- 组件层的渲染计数 harness：用假 rAF 帧钟 + 探针组件的计数，断言一段时间内的提交次数落在区间内，并与"关闭节流"的对照组比较。这是本项目唯一已存在的真实重渲染计数断言。
- 平滑度与突流的纯函数测试：断言恒定间隔的变异系数为 0、**完全停顿的流不会被算成平滑**、突发分布的变异系数超过阈值且与同量程均匀分布可区分。本 spec 复用这套判据。
- 大历史夹具：既有的"按轮数生成事件"构造器（每轮 4 条事件，含 Markdown 与代码围栏）已经在 200 轮 / 480 事件规模下使用，并有 30s 超时的先例。本 spec 的窗口测试以它为基线夹具，按需扩大规模。
- 阈值属性的契约测试：既有测试只断言"长会话带上阈值属性、短会话不带"，并已注明"jsdom 不实现该 CSS，因此只能断言属性有无"。本 spec 新增的真实引擎探针正是为了补上这一句所承认的空白。

**哪些设施不能用作 CI 断言。** dev 性能浮层、布局抖动探针、以及 IPC/Profiler 采集点全部由 DEV 环境判断与 localStorage 开关门控，其中 Profiler 采集在非 DEV 下没有任何生产调用方。它们只用于人工观测与归因，不作为门禁。

## Out of Scope

- **协议层帧合并与"帧边界提交"**：已被本仓库第四轮以实测否决（入站帧速率仅 4–12 帧/秒，可合并的量很小）。本 spec 不重开这两项，只留下重估判据。
- **Daemon 侧持久化与广播**：已修（移出 tokio worker、单行只解析一次）。
- **工具输出体积上限**：已修（sidecar 唯一出口截断）。
- **scheduled 会话每秒全量重拉**：属于"是否需要产品决策"的独立项（是否让该来源改走纯增量），不在本 spec。
- **事件管线的字符串契约**（消除 stringify/parse 往返）：需同步改动大量测试桩，独立成项。
- **引入第三方虚拟化库**：明确不做。
- **从状态里丢弃历史**：明确不做（历史仍全部可用于搜索与导航）。
- **浏览器原生查找（find-in-page）的覆盖范围**：有界渲染必然使原生查找只能到达已挂载的行。本 spec 承认这一收窄，并选择在使用界面明确表达，而不是为了恢复它而放弃内存上界。
- **移动端富渲染**（终端、diff 全展开、语法高亮等）：沿用项目既有的首版范围外结论。
- **端到端 FPS 门禁**：浮层读数不作为 CI 依据。
- **Daemon 或 Companion 协议的兼容分支**：不做协议改动。

## Further Notes

**沿革与定位。** 本 spec 是同类工作的第五轮，前四轮聚焦"逐 token 路径上的固定成本"，均已交付并记录在案。本轮聚焦"随会话长度增长的成本"——这一条线在本仓库第三轮排查报告里已被明确列为未修复项（导航的 O(n) 布局读取、事件提交的全量重转换、消息列表无窗口/虚拟化），但一直被排在流式修复之后。此外，本轮工作为缓解长会话滚动成本引入的"跳过离屏渲染"规则，引入了导航几何测量失真的失效模式，属于需要一并处理的回归风险，建议优先修。

**第一交付物是度量，不是优化。** 四轮修复的共同缺口是**没有端到端实测**，报告自己写明各修复的相对权重仍未校准，并给出了下一轮的观测清单（长任务累计值、平滑度与更新间隔分位、对话区 commit 数与累计耗时）。因此本 spec 的顺序是：先让长会话场景**可复现、可断言**（含真实引擎探针），再据此决定优化项的取舍与权重。否则第五轮会重复前四轮的处境——改了很多，但说不清哪一项起了作用。

**跨项目参考。** 本 spec 的窗口方案、导航与隐藏历史的表达方式、以及"测量目标需要逃逸口"的做法，参考了同类项目 PI-Desktop 的架构决策记录（其"有界挂载窗口"决策、"增量流式更新"决策），该项目的相关决策同样是在"跳过离屏渲染已存在但不能解决内存与每帧成本"的前提下做出的。本 spec 与其一致的部分：否决测量式虚拟化、否决双向卸载、导航只覆盖可到达的位置、把布局相关断言交给真实引擎。本 spec 与其不同的部分：本项目没有分页，因此两级升级退化为一级；本项目已有分帧绘制与历史身份复用，因此不需要重建这两项。

**诚实的边界。**

- 本 spec 中的结论若标注为"实测"，均指仓库既有报告中记录过的数据；除此之外的因果关系（例如窗口化对 rewind 卡顿的改善幅度）属于**待验证**，需由本 spec 的度量设施产出数据后才能确认。
- 跳过离屏渲染的回归目前是**基于机制的推论**（测量元素自身被跳过 → 返回基于占位高度的位置），尚未在真实引擎上复现确认。这正是新增真实引擎探针的第一个用例。
- 桌面壳、PC 浏览器与移动浏览器共用渲染层，但浏览器宿主需要重新构建前端产物；人工验收需在至少一个浏览器宿主上补做。

**需要人工确认的事项（不可由 agent 自行判定）。**

- 长会话滚动手感、跳转落点是否符合预期。
- 滚动条长度是否出现跳变、是否有空白闪烁。
- 工具组展开折叠是否保持锚定。
- 是否接受"原生查找只覆盖已挂载行"这一能力收窄。
