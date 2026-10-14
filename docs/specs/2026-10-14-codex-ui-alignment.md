# 对齐 Codex/ChatGPT 桌面端设计体系

**Status:** implemented（08 的三宿主截图验收待人工执行）

## Problem Statement

CodeMUX 当前的视觉体系是「手挑色值 + 手写样式」拼出来的，和用户认可的 Codex 桌面端观感差距明显。用户要求把 UI、布局、组件细节**整体对齐** Codex，视觉上要「就是那个样子」。

差距不在某一处，而在体系：

1. **颜色是手挑的 HSL 三元组，明暗两套独立手写**。`globals.css` 里浅色和深色各写一遍 `--background` / `--foreground` / `--border` / `--muted-foreground` …，彼此没有推导关系。想整体加重或减轻 UI 没有旋钮；换强调色时只有 `--primary` / `--ring` 跟着变，hover 底、focus 环、选中态不会一起重着色。
2. **边框用的是灰，不是墨色低 alpha**。CodeMUX 的 `--border` 在浅色下是 `0 0% 90%`（一个灰），Codex 是 `rgba(ink, .06 + contrast*.04)`（接近纯墨但几乎透明）。这是「通透」与「发灰」的分界。
3. **圆角刻度缺一半，且没有 superellipse**。CodeMUX 从单一 `--radius` 派生出 4/6/8/12 四档；Codex 的刻度是 2/4/6/8/12/16/24/32，并且在支持 `corner-shape: superellipse()` 的引擎上整体放大 1.25 倍换成超椭圆。四档重合、三档缺失、超椭圆没有。
4. **阴影是常规投影**。CodeMUX 用 `0 1px 2px`；Codex 是「0.5px 描边 + 极近距离小模糊 + 超大 spread 极低透明度」三段式，模拟环境光。`globals.css` 里虽然已有 `surface-panel` 用了类似的 `0 3px 7.5px` / `0 0 20px` 组合，但没有描边打底，也没有推广到浮层。
5. **外壳少了一半**。CodeMUX 是「自绘标题栏 + 可拖拽侧栏 + 矩形内容区」；Codex 是「原生 caption + 窄图标导航栏（rail）+ 侧栏 + 带圆角裁切的内容面」。CodeMUX 的内容区圆角靠两个手写 inline SVG 画 1.5px 弧线来补偿分割线的抗锯齿损耗（明确的 workaround），非对称圆角再来一个状态就得再写两个 SVG。
6. **composer 是单层**。CodeMUX 的输入框内部底部挤了 附件 / 权限 / 计划模式 / 模型 / 发送 五件。Codex 是两层：上方一条独立 context bar 回答「在哪儿工作、用哪个分支」，下方输入框回答「用什么权限、什么模型」。CodeMUX 其实已经有等价的草稿工作区工具条，但形态是三个各自带边框的按钮，与输入框平铺在同一层。
7. **外观设置缺关键旋钮**。CodeMUX 有 强调色 / 字体 / 字号 / 圆角 / 内容宽度，没有 **对比度**，没有 **diff 增删语义色**。Codex 有对比度，且它的 diff 增删色是可配的。
8. **样式债务**：1047 处硬编码样式散在 121 个文件里（`hsl(var(--…))` 任意值、`/46` `/76` 透明度后缀、`shadow-[…]`、`rounded-[…]`、`text-[11px]`），密度最高的是消息渲染、设置面板、对话输入三处。

## Solution

把 Codex 桌面端的设计体系整体移植过来，**照抄它的算法与刻度，而不是抄它的色值**。

核心是三件事：

1. **颜色从「手挑」改成「种子 + 派生」**。只暴露 4 个种子——表面色、文字色、强调色、对比度——其余几十个语义色全部在运行时由算法派生，明暗共用同一份代码。这套算法（`jba` 浅色 / `Nba` 深色及其混色原语）可以从本机安装包中逐字还原，是可验证的。
2. **补齐圆角刻度并接上 superellipse**，用 `@supports` 做渐进增强；阴影改用 Codex 的描边式 elevation 配方并推广到所有浮层。
3. **补齐外壳的三个结构特征**：窄图标导航栏、圆角裁切的主内容面（用 token 化 `clip-path` 取代 SVG 弧线 hack）、composer 的两层结构（context bar 重画成无边框 chip 的独立面）。

范围严格限定在**视觉与外壳构图**，**不动信息架构**：项目/会话的两级树、agent 选择入口的位置、设置页的分页结构全部保持现状。

## User Stories

### 配色与视觉语言

1. As a CodeMUX 用户, I want 明暗两套主题的观感完全一致, so that 切换主题时我不会觉得换了个产品
2. As a CodeMUX 用户, I want 边框是墨色的极低透明度而不是灰色, so that 界面看起来通透而不是发灰
3. As a CodeMUX 用户, I want 换一个强调色后所有相关颜色一起变（hover 底、focus 环、选中态、强调背景）, so that 强调色是真的「主题色」而不是只染了一处
4. As a CodeMUX 用户, I want 有一个对比度滑块能整体加重或减轻 UI 的边界与次级文字, so that 我不用换主题就能调整到舒服的程度
5. As a CodeMUX 用户, I want 浅色下的次级文字足够可读, so that 长时间阅读不会累
6. As a CodeMUX 用户, I want 深色下的三级文字比浅色下更亮一点, so that 深色模式的层级不会糊成一片
7. As a CodeMUX 用户, I want diff 的新增行/删除行颜色可以自己配, so that 不同项目的 diff 观感符合我的习惯
8. As a CodeMUX 用户, I want 主按钮、输入框、选中态在不同主题下的层级关系一致, so that 我不需要重新学习界面的深度结构
9. As a 维护 CodeMUX 的开发者, I want 所有语义色都能追溯到 4 个种子, so that 我改一个种子就知道会影响哪些地方

### 圆角、阴影与动效

10. As a CodeMUX 用户, I want 圆角是 Codex 那一档的观感, so that 卡片和浮层的形状看起来是「同一套模具」
11. As a CodeMUX 用户, I want 支持的引擎上圆角是超椭圆而不是正圆弧, so that 界面有 Codex 那种「软」的质感
12. As a CodeMUX 用户, I want 不支持的引擎上自动退回标准圆角, so that 浏览器和移动端不会变形
13. As a CodeMUX 用户, I want 浮层（对话框/下拉/提示）有很轻的投影和一圈细描边, so that 它们有「浮起来」的感觉
14. As a CodeMUX 用户, I want 能选三档圆角强度, so that 我可以按显示器和审美调整整体圆润度
15. As a CodeMUX 用户, I want 选圆角档位时整套阶梯的相对关系保持不变, so that 档位之间只有「整体缩放」的差异，不会让某些组件单独变形
16. As a CodeMUX 用户, I want 面板展开、Toast 弹出这些动画的节奏和 Codex 一致, so that 手感统一
17. As a 对动效敏感的用户, I want 系统开启「减少动态效果」时动画被关闭, so that 我不会因为动画产生不适
18. As a CodeMUX 用户, I want 动画时长保持在 300ms 以内, so that 界面不会让人觉得拖沓

### 外壳与布局

19. As a CodeMUX 用户, I want 窗口最左侧有一条窄图标导航栏, so that 我能一眼跳到会话/自动化/工单/设置
20. As a CodeMUX 用户, I want 图标导航栏上的当前项有明确的选中态, so that 我知道自己在哪个顶层视图
21. As a CodeMUX 用户, I want 设置入口固定在图标导航栏底部, so that 它永远在同一个地方
22. As a CodeMUX 用户, I want 主内容区有圆角并从窗口边缘浮起来, so that 窗口外壳有层次
23. As a CodeMUX 用户, I want 侧栏收起时内容区的左角自动变成直角, so that 不会有半截圆角悬在窗口边上
24. As a CodeMUX 用户, I want 窗口标题栏看起来接近 Windows 原生, so that 和系统里其它应用一致
25. As a Windows 用户, I want 悬停最大化按钮仍能弹出贴靠布局, so that 我不被剥夺系统级窗口操作
26. As a CodeMUX 用户, I want 标题栏里的会话头、侧栏开关、主题切换这些按钮还在, so that 照抄外观不会让我丢功能

### Composer 与草稿工作区

27. As a CodeMUX 用户, I want 新建对话时输入框上方出现一条独立的上下文条, so that 我发消息前能确认「发到哪个项目、哪个工作树、哪个分支」
28. As a CodeMUX 用户, I want 上下文条上的项目/工作树/分支可以直接点选修改, so that 我不用去别处改再回来
29. As a CodeMUX 用户, I want 打开一个已有会话后上下文条消失, so that 界面不会一直显示已经锁定的信息
30. As a CodeMUX 用户, I want 上下文条上的按钮没有边框、和输入框是两个独立的面, so that 它读起来是「背景信息」而不是「一排按钮」
31. As a CodeMUX 用户, I want 分支选择只在工作树模式下出现, so that 界面不会给我一个改了也没用的选项
32. As a CodeMUX 用户, I want 在输入框里仍能直接看到 agent 是哪个, so that 我不用跳出去确认
33. As a CodeMUX 用户, I want 输入框内部底部的附件/权限/模型/发送保持现在的排布, so that 常用操作的位置不变

### 外观设置

34. As a CodeMUX 用户, I want 在外观设置里看到一个对比度滑块, so that 我能整体调整界面的浓淡
35. As a CodeMUX 用户, I want 能设置 diff 新增/删除行的颜色, so that 我可以按项目习惯配色
36. As a CodeMUX 用户, I want 保留现有的强调色预设板, so that 我已经调好的偏好不会丢
37. As a CodeMUX 用户, I want 保留现有的 UI 字号和代码字号调节, so that 大屏和视力不佳的用户仍能放大界面
38. As a CodeMUX 用户, I want 保留现有的内容宽度选项, so that 宽屏用户仍能铺满
39. As a CodeMUX 用户, I want 改完外观设置后界面立刻响应, so that 我能边调边看
40. As a CodeMUX 用户, I want 外观设置改坏了能一键恢复默认, so that 我敢随便试

### 三宿主一致

41. As a PC 浏览器用户, I want 浏览器里的界面和桌面端是同一套视觉语言, so that 我在两端切换时不需要重新适应
42. As a 移动端用户, I want 移动端的界面也来自同一套 token, so that 它不会看起来像另一个产品
43. As a CodeMUX 用户, I want 侧栏在窄屏下变抽屉时圆角关系仍然正确, so that 不会出现半截圆角
44. As a CodeMUX 用户, I want 不同宿主下超椭圆圆角的启用条件是一致的, so that 不会出现桌面端圆、移动端方的突兀差异

### 规范与验证

45. As a 维护 CodeMUX 的开发者, I want 文档里只有一套外观规范, so that 未来的改动不会写出第二套规则
46. As a 维护 CodeMUX 的开发者, I want 文档说明颜色是派生出来的而不是列出来的, so that 有人加颜色时会知道要先加种子还是加派生
47. As a 维护 CodeMUX 的开发者, I want 文档保留文字对比度的实测数据和减少动效的处理约定, so that 这些已有的高价值约束不因为照抄而丢失
48. As a 维护 CodeMUX 的开发者, I want 有一份测试能证明我们的颜色算法和 Codex 的公式逐值相等, so that 「对齐」不是我的主观判断
49. As a 维护 CodeMUX 的开发者, I want 用户拧过强调色和对比度之后的组合也有测试覆盖, so that 对拍不只覆盖默认种子
50. As a 维护 CodeMUX 的开发者, I want 有一份期望值快照能发现算法被无声改动, so that 回归会变红

## Implementation Decisions

### D1 — 范围：照抄外壳构图，不动信息架构

对齐的是**视觉语言 + 外壳构图**。明确不动的部分：项目/会话的两级侧栏树、agent 选择入口的位置、设置页的分页结构、侧栏宽度可拖拽的行为。

### D2 — 导航栏承载顶层视图

新增一条窄图标导航栏（约 56px，宽度实施时实测校准），承载三个顶层视图 + 底部设置：

- 会话（Home）—— 高亮当前项
- 自动化（Timer）—— 从侧栏顶部按钮提级上来
- 工单（ListTodo）—— 从侧栏顶部按钮提级上来
- 设置 —— 钉在底部

侧栏随之变成「随导航栏当前项切换的上下文侧栏」：选中会话时是现有的项目/会话树，选中自动化/工单时是对应列表。功能一个不少。

### D3 — 颜色：4 个种子 + 算法派生

主题对象只保留 4 个种子：**surface / ink / accent / contrast**。其余语义色全部运行时派生，明暗共用同一份代码。

预设值照抄 Codex：

| 种子 | light | dark |
|---|---|---|
| accent | `#3a83f7` | `#3a83f7` |
| ink | `#0d0d0d` | `#ededed` |
| surface | `#fcfcfc` | `#000000` |
| contrast | 45 | 60 |
| diffAdded | `#00a240` | `#40c977` |
| diffRemoved | `#ba2623` | `#fa423e` |

派生规则照抄 Codex 的浅色/深色两套函数（结构对称，只是混色目标不同：浅色往 white 混，深色往 black 混）。关键配方：

- 边框一律用**墨色低透明度**：`borderLight = rgba(ink, .04 + c*.02)`、`border = rgba(ink, .06 + c*.04)`、`borderHeavy = rgba(ink, .09 + c*.06)`
- 三档文字：primary = ink、secondary = `rgba(ink, .65 + c*.10)`、tertiary = `rgba(ink, .45 + c*.10)`；深色下 tertiary 放宽为 `.42 + c*.13`
- 强调背景 = `mix(surface, accent, .11 + c*.04)`
- hover 一律往 ink 方向 `color-mix` 加 4~8%，不用深浅
- 主按钮反色：浅色 ink 底 / 深色 `mix(surface, white, .38 + c*.12)` 底
- focus 环 = accent

`contrast` 是 0–100 的旋钮，先做归一化再喂进所有 alpha 公式。

### D4 — 保留 CodeMUX 的消费层 token 名，只换值

**关键决策：不对 CSS 变量改名。** 全仓有 338 处引用 CodeMUX 私有 token（`--sidebar-fg` 72、`--surface-2` 46、`--surface-shadow` 45、`--sidebar-muted` 30、`--surface-3` 25、`--sidebar-border` 20…），Codex 体系里没有同名对应。改名会把地基绑死在 338 处散点修改上，出问题无法定位是算法错还是改错。

做法是**两层命名**：

- **派生层内部**用 Codex 的命名（`elevatedPrimary` / `textForegroundTertiary` / `borderHeavy` / …），是模块内的局部变量，不泄漏到 CSS
- **消费层对外**仍是 CodeMUX 短名（`--surface-1/2/3`、`--sidebar-*`、`--border`、`--muted-foreground`、shadcn 的 `--background` 等），值换成派生结果

这样对外仍然只有一套词表，338 处零改动，token 层可以单独提交、独立验证、独立回滚。

映射原则（实施时逐个确认）：

| Codex 派生量 | CodeMUX 消费层 |
|---|---|
| `elevatedPrimary` | `--surface-1`（主表面 / 内容面底） |
| `elevatedSecondary` | `--surface-2`（次级表面 / 侧栏底） |
| `controlBackground` | `--surface-3`（输入框等控件底） |
| `textForeground` | `--foreground` / `--card-foreground` / `--popover-foreground` |
| `textForegroundSecondary` | `--muted-foreground` |
| `textForegroundTertiary` | 新增第三档 `--foreground-tertiary` |
| `iconTertiary` | `--sidebar-muted` |
| `border` | `--border` / `--layout-divider` |
| `borderHeavy` | `--surface-edge` |
| `borderLight` | shadcn 的 `--input` 等浅描边位 |
| `accent` | `--primary` / `--ring` / `--sidebar-accent` / `--glow` |

⚠️ **`--sidebar-fg`（72 处引用，是全仓最高频）落到 secondary 还是 tertiary 必须在实施时用截图定夺**，这是整个 token 层最容易埋错的一处。

CodeMUX 现有的三档表面阶梯（浅色 `100% / 96.5% / 93%`，深色 `11% / 12.9% / 15.7%`）会被算法产出整体替换。

### D5 — 圆角：补齐刻度 + superellipse，用户设置改语义

**好消息：CodeMUX 现有刻度与 Codex 已经重合大半**（sm/md/lg/xl 四档逐个对得上）。缺的是 xs=2、2xl=16、3xl=24、4xl=32 四档，以及 superellipse。

圆角阶梯定为 Codex 的 `2 / 4 / 6 / 8 / 12 / 16 / 24 / 32`，并用 `@supports` 渐进增强：支持 `corner-shape: superellipse(1.5)` 的引擎上整体乘 1.25 并套用 `corner-shape`，否则退回 1 倍标准圆角。浏览器宿主强制退回 1 倍（与 Codex 一致）。

**用户的三档圆角设置从「指定具体值」改成「Codex 刻度的缩放档」**：

| 档位 | 含义 |
|---|---|
| sharp | Codex 刻度 × 0.75 |
| soft（默认） | Codex 刻度 × 1.0 —— **等于 Codex 原值** |
| round | Codex 刻度 × 1.35 |

这样无论选哪档，阶梯的**相对关系**都保持 Codex 的形状，只是整体缩放。现在的实现（三个写死的绝对值）会让 `round` 档的整套刻度与 Codex 毫无关系。

### D6 — 字号不动

CodeMUX 的 UI 14px / 代码 13px **保持不变**，不对齐 Codex 桌面端的 13/12。理由：字号可调是可读性/无障碍功能，砍掉是大屏用户的倒退；且三宿主共用一套前端，移动端 13px 偏小。

### D7 — 内容宽度 48rem

`fixed` 档从 52rem 改为 48rem（Codex 的 `--thread-content-max-width`）。流式档不变。

### D8 — 标题栏保留自绘，改造成 Codex 形态

CodeMUX 保持 `frame: false` + 自绘标题栏（Codex 用原生 caption + 原生菜单栏）。只改外观：窗口按钮换成 Windows 原生样式方块、加入 ← →、高度和 caption 对齐、文案字号对齐系统。

标题栏承载的会话头、侧栏开关、主题切换按钮**全部保留**，只是改成与 caption 一致的低调样式。

**已实测**：CodeMUX 主窗口的 Win32 样式为 `0x15C70000`，带 `WS_CAPTION` + `WS_THICKFRAME`，尽管代码是 `frame: false`。所以自绘标题栏大概率不失去 Win11 贴靠布局——实施时需实测确认一次。

### D9 — 主内容面：token 化 clip-path，删掉 SVG 弧线 hack

用三个 token + `clip-path` 取代两个手写 inline SVG：

- `--app-shell-main-surface-clip-start-radius`
- `--app-shell-main-surface-clip-end-radius`
- `--app-shell-main-surface-clip-radius`（取前两者的 max）

配 `clip-path: inset(... round R)`。非对称状态（侧栏停靠时左圆右方 / 侧栏收起时两侧都圆）由 token 自动吃下，不再需要手写 case。

同时补上 CodeMUX 现在完全缺失的页面浮层 elevation：`--app-shell-page-surface-shadow`（0.5px 描边 + 近距小模糊 + 超大 spread 极低透明度）。

页面浮层圆角取 15px（Codex 的 `--radius-xl-base` 12px × 1.25 superellipse）。

### D10 — composer 两层化

Codex 的 composer 是**两块独立的面**：上方 context bar 回答「发到哪去」，下方输入框回答「用什么发」。CodeMUX 改成同样结构。

CodeMUX 已经有等价的草稿工作区工具条（承载项目 / 工作树 / 分支选择器，**只在草稿态渲染**），不需要新建，只需要**重画形态**：

- 从「三个各自带边框的按钮」改成「无边框 chips 共用一块底」
- 从「和输入框平铺在同一层」改成「与输入框是两块独立的面」

**行为完全不变**：分支选择器仍然只在工作树模式下出现（Codex 是常驻显示，CodeMUX 的逻辑更对——本地模式下分支对这次会话没有约束力，常驻显示一个改了也没用的选项会误导）。

**agent 选择入口位置不动**，仍在现有位置，参与对齐（按钮/弹层/选中态按 Codex 重画，只是不挪窝）。

### D11 — 组件分层

全仓有 1047 处硬编码样式、121 个文件。分三层：

**① token 层（自动覆盖）** —— 算法派生 + 圆角刻度 + superellipse + elevation + 动效曲线。所有用语义 token 的地方自动跟随。消费方零改动。

**② 骨架层（人工重画）** —— 这一层决定了「像不像」：
- 窗口外壳：导航栏、侧栏、标题栏、内容面 clip-path
- composer 与 context bar
- `ui/` 下 18 个浮层原语：button / input / dialog / dropdown-menu / popover / tooltip / select / tabs / switch / command / context-menu / hover-card / collapsible / radio-group / confirm-dialog / dialog 等
- 外观设置面板（新增对比度滑块 + diff 语义色设置）

**③ 长尾（只吃 token，不逐处重画）** —— agent 消息渲染、settings 其余 15 个分页、工作区/预览/浏览器/companion。

分层理由：Codex 那套观感约八成来自窗口外壳 + composer + 浮层；浮层是全局复用且 elevation 在浮层上最显眼。长尾逐处改看不出差别，还可能倒退——diff 增删行、语法高亮这类**有意固定色**的内容本来就允许不跟随主题。

### D12 — 外观设置收敛为 5 项驱动外观的旋钮

| 设置项 | 状态 |
|---|---|
| 主题模式（浅/深/跟随系统） | 已有 |
| 强调色（预设板 + 自定义） | 已有，派生后会自动带出 hover/focus/选中态 |
| **对比度**（0–100） | **新增** |
| **diff 新增/删除语义色** | **新增** |
| 字体（UI 字体族 + 两种字号） | 已有 |

同时保留字号、圆角、内容宽度三项（见 D5/D6/D7）。

### D13 — 动效：保留三档时长，替换四条曲线值

CodeMUX 现有三档时长（150 / 200 / 300ms）**保留**——Codex 只有单一 150ms，三档分层是更成熟的规范且与现有 `duration-*` 工具类契约一致。

四条缓动的**值**换成 Codex 的：

| CodeMUX 语义位 | Codex 对应 | 值 |
|---|---|---|
| `ease-motion-out`（进入/悬停，默认） | `--cubic-enter` | `cubic-bezier(.19, 1, .22, 1)` |
| `ease-motion-in`（退出） | `--cubic-exit` | `cubic-bezier(.8, 0, .4, 1)` |
| `ease-motion-standard`（展开折叠 / Radix） | `--cubic-exit-snappy` | `cubic-bezier(.65, 0, .4, 1)` |
| `ease-motion-in-out`（对称尺寸过渡） | `--cubic-move` | `cubic-bezier(.65, 0, .35, 1)` |

差异最大的是退出曲线：现有 `cubic-bezier(0.4, 0, 1, 1)` 加速过猛，退出动画会「顿」。

⚠️ 现有动效 token 源码契约测试**硬编码断言了当前曲线值**，必须同步更新，否则第一步就会红。

### D14 — 规范文档改写

现有外观规范会与新体系**直接冲突**（圆角派生链、三档文字、动效命名、以及最根本的「token 写在 CSS 里」vs「值由 JS 运行时注入」）。改写为「种子 + 派生」模型，同时**保留已有的高价值约束**：

- 文字对比度的实测数据与结论（两档文字的实测比值数据要升级为三档）
- `prefers-reduced-motion` 的集中处理约定
- 禁装饰性/连续动画、全部动效 ≤300ms 的纪律
- 透明度只用于表面层次（背景/描边/分隔线/滚动条）的纪律
- 缺 token 时「先加到 `@theme` + `:root` + `.dark` 再消费」的纪律

不保留旧规则与新规则并存——两套规则并存比一套错的更糟。

## Testing Decisions

### 好测试的标准

只断言**外部可观察行为**：调用外观应用函数后，文档根节点上实际被写入了什么 CSS 变量值。不测试内部函数的调用次数、参数传递方式或中间数据结构。

### 主缝：一个

**`applyAppearance(prefs, isDark)` 是全仓最高的一条缝**——它把整个外观体系一次性写到文档根节点上。在它上面断言，等于用一条测试覆盖全部颜色工作。

具体做法：
1. 调用应用函数（`light` / `dark` 各一轮）
2. 从 `document.documentElement.style` 读回完整变量表
3. 与 Codex oracle 派生结果**逐值比较**

### Oracle 形式：对拍 + 快照双层

**主断言 = 对拍。** 把 Codex 的浅色/深色派生函数（含混色原语与 `contrast` 归一化）转写成 TypeScript 参考实现，与我们的实现**运行对拍**。这能覆盖任意种子组合——包括用户拧过强调色和对比度之后的所有情形，而不只是默认预设。

**辅助断言 = 快照。** 固化一组期望值（约 40 个变量 × N 组种子，从本机 Codex 实跑导出）。它的作用是证明 oracle 本身没被转写错，以及未来有人无声改动算法时会变红。

两层缺一不可：只有对拍的话，万一 `contrast` 归一化公式转写错了，测试会一致地错；只有快照的话，用户把对比度拧到 80 就完全没覆盖。

### 其余缝（全部扩展既有测试，不新增）

- **动效 token 源码契约** —— 更新被硬编码的曲线值断言；新增「圆角不得写成字面量 px」的契约
- **布局 token 契约** —— 承载 `clip-path` 三个 token 的契约
- **主布局源码契约** —— 断言 SVG 弧线 workaround 已删除、`clip-path` 已就位、导航栏已挂载
- **草稿工作区工具条测试** —— 行为不变（分支选择仅工作树模式）+ chip 无边框的形态契约
- **导航栏测试** —— 顶层视图切换、设置置底、选中态

### 形状层：截图对照

rail 宽度、`clip-path` 圆角实际观感、composer 两层间距这些**无法数值断言**，走人工截图对照：三宿主（桌面 / PC 浏览器 / 移动）× 浅色 / 深色，逐区比对 Codex。

### 先例

仓库内已有成熟的源码契约测试模式（动效 token 源码契约测试读源码文本、断言不得出现字面量时长与手写缓动；主布局测试含源码级不变量契约），新测试沿用同一模式。

## Out of Scope

**明确不做**：

- **不换语法高亮引擎**。Codex 用 Shiki 并有一套独立的代码主题库（含导入/导出），CodeMUX 用 highlight.js。这是另一个工程，且 Codex 用 Shiki 是因为它同时要喂文件树的 token，CodeMUX 没有文件树。
- **不做主题串导入/导出**。这是新增的「分享主题」能力，与外观一致性零贡献，且与「所有人打开都是同一个样子」的目标直接对立。
- **不开放表面色 / 文字色自定义**。能锁死「统一观感」这两项恰恰因为用户可以随便改——改完就不是 Codex 了。CodeMUX 已有的强调色预设板保留。
- **不做窗口不透明开关**。只影响 Electron 毛玻璃，与「像 Codex」无关。
- **不引入 skill 语义色**。Codex 特有概念，CodeMUX 无对应。

**不改的部分**：

- 不重排信息架构、不改项目/会话的两级树、不挪 agent 选择入口
- 不逐处重画长尾内容区（消息渲染、settings 其余 15 个分页、工作区/预览/浏览器/companion）
- 不动字体族的内置清单、不动代码高亮主题

## Further Notes

### 实施顺序（单向依赖，无循环）

| 步 | 内容 | 完成后什么样 |
|---|---|---|
| **①** | token 层：算法派生 + 圆角刻度 + superellipse + elevation + 四条曲线 | **全站配色/圆角/阴影/动效已完全是 Codex**，只是组件形状是旧的。消费方 338 处零改动 |
| **①b** | 改写外观规范文档 | 后续三步有唯一规范可依 |
| **②** | `ui/` 18 个浮层原语 + 外观设置面板 | 所有浮层统一成描边式 elevation |
| **③** | 导航栏 + 侧栏 + 标题栏 + 内容面 clip-path | 外壳成型 |
| **④** | composer 两层化 + 草稿工作区工具条重画 | 收尾 |

① 完成后不是「割裂」，是换了皮——因为配色、圆角、阴影、动效都在同一步到位。

### 实施期需实测确认的三件事

1. **Win11 贴靠布局** —— 实测 CodeMUX 主窗口已带 `WS_CAPTION` + `WS_THICKFRAME`，自绘标题栏大概率不失去贴靠，需实测悬停最大化按钮确认
2. **导航栏宽度** —— 约 56px 是从截图量得的，Codex 源码里没有落地值（运行时注入），需实测校准
3. **`--sidebar-fg` 的映射档位** —— 72 处引用、全仓最高频，落到 secondary 还是 tertiary 必须用截图定夺

### 调研过程中的两处更正

- Codex 的「背景 / 前景」色值就在外观设置**主面板**上，不在高级区——它并没有把这两项藏起来
- CodeMUX 早已有完整的草稿工作区工具条（项目 / 工作树 / 分支三件齐全、只在草稿态渲染），composer context bar 不是新建而是重画

### 源码来源

Codex 前端为 Electron 打包，前端资源以明文存在于安装包内，可逐字还原。本机调研已产出逆向记录文档，含主题引擎的派生函数原文、token 取值、以及 asar 的读取方法。新增 token 时应先回查该文档确认取值，而不是凭印象填色值。