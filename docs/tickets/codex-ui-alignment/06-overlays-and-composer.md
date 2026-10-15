# 06 浮层原语与 composer 两层化

**What to build:** 所有浮层——对话框、下拉、气泡、提示、命令面板、右键菜单——统一成 Codex 的描边式投影，一眼看去是同一套模具。输入区拆成两层：上方一条独立的上下文条回答「发到哪个项目、哪个工作树、哪个分支」，下方输入框回答「用什么权限、什么模型」。上下文条在**新建对话时**出现，打开已有会话后消失。

**Blocked by:** 02

**Status:** done

- [x] 浮层原语（按钮、输入框、对话框、下拉、气泡、提示、选择器、标签页、开关、命令面板、右键菜单、悬浮卡、可折叠、单选组、确认对话框等）统一消费描边式 elevation
- [x] 浮层的圆角、内边距、字号、图标尺寸对齐 Codex
- [x] 输入区拆成两块**独立的面**：上下文条在上、输入框在下，各自圆角、底色不同
- [x] 上下文条承载已有的草稿工作区三件选择器（项目 / 工作树 / 分支），从「三个各自带边框的按钮」重画为「无边框 chips 共用一块底」
- [x] 上下文条**只在草稿态渲染**：打开已有会话后消失，工作区归属改由内容区顶部表示
- [x] 分支选择器仍然只在工作树模式下出现（Codex 是常驻显示，此处保留 CodeMUX 现有语义——本地模式下分支对本次会话没有约束力）
- [x] agent 选择入口**位置不动**，照常参与对齐（按钮、浮层、选中态按 Codex 重画，只是不挪窝）
- [x] 输入框内部底部的附件 / 权限 / 计划模式 / 模型 / 发送保持现有排布
- [x] 就近测试：草稿工作区工具条行为不变（分支仅工作树模式）+ chip 无边框的形态契约

## Comments

实现完成。

**浮层原语**：`src/components/ui/` 下 10 个文件（dialog / dropdown-menu / context-menu / popover / select / tooltip / hover-card / tabs / switch / command）统一消费 `shadow-elevation` 三档，取代原先的 `shadow-[0_10px_32px_-12px_rgba(0,0,0,.18)]` 这类手写任意值。

**feature 层浮层**同样换掉：composer 的四个浮层、AgentSelector 的卡片与浮层、权限选择器、SlashCommandMenu、两个右键菜单、BrowserElementPills、三个 Git popover、两个对话框、QueuedMessages、会话头预览。**故意没换**的：抽屉与右侧面板的方向性投影（语义不同）、`inset 0 1px 0 …` 内高光（不是阴影）。

**composer 两层化**：上下文条（发到哪个项目 / 工作树 / 分支）在上、输入框在下，各自是独立的一块面，中间 2px 的缝。间距统一由 `NewSessionPanel` 的 `gap-0.5` 表达，两个组件都不再自带外边距。

**上下文条重画**：三个 chip 从「各自带边框的按钮」变成「无边框 chip 共用一块底」，靠悬停才浮出底。行为零变化：分支选择器仍然只在工作树模式下出现 —— 本地模式下分支对本次会话没有约束力，Codex 是常驻显示，这里保留 CodeMUX 现有语义。

**agent 选择入口位置不动**，照常参与对齐（按钮、浮层、选中态按 Codex 重画，只是不挪窝）。

## 代码评审修复

- 浮层表面的任意值阴影**没有清干净**：上一轮只手工改了 `ui/` 与几个点名的文件，ChatSearchDialog / ImportSessionsDialog / QueuedMessages / SessionHeader / AgentPermissionSelector / SlashCommandMenu / BrowserElementPills / ProjectExplorerContextMenu / GitActionPopover / SessionItem 等仍在用 `shadow-[…]`。已按「对话框尺度 → prominent / 菜单与卡片 → elevation / 小面积 → subtle」分档统一换掉。方向性面板投影（抽屉、右侧面板）与 `inset 0 1px 0 …` 内高光按 AGENTS.md 的例外条款保留。
- `AgentSelector` 的卡片上原本同时挂着 `shadow-elevation hover:shadow-elevation hover:shadow-elevation-prominent`（两份写同一个 `--tw-shadow`，谁赢取决于 Tailwind 内部排序而非作者意图），删掉重复的那份。
- `hover-card` 上残留的 `shadow-elevation dark:shadow-elevation` 同类重复，一并清掉。

## 后续变更（2026-10-14）：两段式输入区的两个档位与 Codex 对上号

结构早就拆成两层了，但**两层的底色一直没对上 Codex 的档位**：输入框和内容面同色（都是 `--surface-1`），上下文条和输入框又只差 1 级，深色下整块输入区糊成一片。按 Codex 的映射表校准后：

| 面 | Codex 的 token | 深色实测 | CodeMUX 现在 |
|---|---|---|---|
| 上下文条 | `--color-background-composer-action-bar` = 深色 `elevatedSecondaryOpaque` | 33 | `--surface-2` = 32 |
| 输入框 | `--color-surface-elevated` = `elevatedPrimary` | 47 | `--surface-1` = 45 |
| 底（内容面） | `--color-surface` | 17 | `--background` = 17 |

组件**一行没改** —— 上下文条本来就用 `--surface-2`、输入框本来就用 `--surface-1`；错的是内容面占了 `--surface-1`（见 05），以及深色种子压在纯黑上（见 04）。三处一起改完，输入框才第一次真正「浮」在内容面之上。

顺带核对：Codex 输入框内部**没有**再分一条操作条 —— 底部的 `＋ / 权限 / 模型 / 发送` 与输入区同色（实测都是 47），分色的是上方那条上下文条。所以 CodeMUX 输入框内部的排布不需要加底色。

## 后续变更（2026-10-15）：输入框的三处复核修复

对着 Codex 截图复核输入框，实测出三处（数值取自 Codex 窗口的无损抓图与它的 CSS）：

1. **边框有重影、比 Codex 粗一倍。** 输入框同时挂了 `border border-border`（画在盒内）和 `shadow-elevation-prominent`（它自带 1px 描边，画在盒外），两条线叠着。Codex 的输入框只有**一条发丝线**（浅色实测：内容面 253 → 线 241 → 输入框 255）。删掉 `border`，描边交给 elevation —— 与 AGENTS.md 的「stroke-first，浮起面不要自己再画边框」一致。改后实机量到的是单线（253 → 233 → 253）。

2. **顶部多一行空行。** 附件条是无条件渲染的：没有附件时它高度为 0，但父级 `gap-2` 照样给它一份间距，加上它自己的 `mb-1.5`，输入框上方就空出约 14px。改成 `attachmentCount > 0` 才渲染（`mb-1.5` 一并删掉，间距由 `gap-2` 表达）。改后输入框整体矮了 16px，占位符紧贴顶边。

3. **底排控件是一排「带边框的小方块」，Codex 是一排裸按钮。** `+`、权限选择器、自动接受开关三个各自挂着 `border border-border/40 bg-[hsl(var(--surface-2))]/70`，而 Codex 这一排平时只剩图标与文字，悬停或展开时才浮出一层 ink。抽了一个共用外形 `COMPOSER_BAR_CONTROL_CLASS`（`src/lib/composerTokens.ts`）给这三处用，并把计划模式 chip 一起收编（状态靠 `text-primary` 表达，不再靠边框）。

   - 悬停用 **ink 的 alpha**（`bg-foreground/8`）而不是某个固定表面色：控件压在**抬高档**（`--surface-1`）上，而 `--muted` / `--surface-3` 是相对**表面种子**算的，深色下比输入框还暗，悬停会变成「按下去」。
   - 顺带清掉同一排另外两处写死的中性灰（`model-selector` 的 ghost/outline 变体、`ReasoningEffortSelector` 的触发按钮用的是 `hover:bg-neutral-100 dark:hover:bg-neutral-800`）—— 那套绕过了主题 token，换强调色/对比度时不跟着动。

   实测（浅色，无损抓图）：底排从左到右扫描，`+`、`构建模式`、盾牌三处**全部落在输入框底色 253 上**，没有任何边框或底块；盾牌仍是橙色图标（255,124,32）。

测试：`CodeMuxComposer.test.tsx` 新增「没有附件时不渲染附件条」；附件相关的两条用例原先的桩自相矛盾（`Attachments` 原语永远渲染一张图，而 `useAuiState` 报 `attachments: []`），改成受控的 `composerAttachments` 夹具。

## 后续变更（2026-10-15）：首页改建会话页，去掉准备清单与建议提示词

用户对着 Codex 首页截图提了两处（图注）：

1. **一进软件应落在新建会话页。** 之前冷启动（没有活动会话）渲染的是一个「开始新对话」空白占位页，要先点侧栏按钮才能开始。`App.tsx` 的 app 视图分支改成 `activeSessionId ? 会话 : 新建会话页`，且**与草稿开合状态解耦** —— 冷启动、侧栏「新对话」、从自动化/工单经导航栏点回会话，任何路径落到 app 视图且没有会话时，看到的都是同一页。
2. **首页构图与干净度对齐 Codex。** 问候区（agent 选择 + 标题）占满上半屏居中，两段式输入区贴底。旧版是「准备清单 + 建议提示词 + 输入区」作为一个整体居中，输入区被顶在页面中段；Codex 的输入区落在底部、与标题之间留大片空白。「开始前检查」chip 行与三条建议提示词按用户反馈整块移除，`AgentSetupChecklist` 组件随之删除（无其他引用）。

未动：agent 选择入口位置、模型/权限选择行为。（「两段式输入区结构不变」这条在同日的下两节被进一步修正，最终形态以最后一节为准。）

## 后续变更（2026-10-15，续）：composer 几何对齐会话页

对着 Codex 本机截图复核首页，改了三处：

1. **composer 的宽度与离底高度和真实对话页不一致。** 新建会话页的列是 `max-w-2xl`(42rem) / `py-10`，而会话页的 composer 走 `--content-width`(48rem)、底部 `pb-3`（`CodeMuxThread` 的 thread-content-shell 与 ViewportFooter）。发第一条消息时输入框会跳宽跳位。首页列改为逐值复用会话页那一组：`--content-width` / `px-5` / `pb-3` / `pt-4`。
2. **上下文条与输入区收进同一块外壳**（`rounded-xl` + `--surface-1` + elevation），输入区新增 `embedded` 模式只画内容、不重复描边。（这一版的排布在下一节被编译产物复核后修正。）
3. **供应商提示启动时闪一下。** 冷启动模型目录在途时 `hasUsableProvider` 短暂为 false，无条件渲染让「请先在设置 → 模型配置……」闪一帧。改为目录落定（`!areModelsLoading && !waitingForConfiguredModel`）仍无可用供应商时才提示。

## 后续变更（2026-10-15，再续）：从 Codex 编译产物复核发送框，修正两处

`app.asar`（Store 版 26.1007.9446.0，`app/webview/assets/` 下 `app-shared-*.css` 与 `app-initial-*.js`）逐字复核，发现前两节有两处是按截图猜的，都不对：

| | 按截图猜的 | 编译产物里的真实值 |
|---|---|---|
| 上下文条底色 | 与输入区同色 | **独立 token** `--color-background-composer-action-bar`（`.bg-background-composer-action-bar`）：浅色 `--color-surface-secondary` / 深色 `elevatedSecondaryOpaque`，比输入区（`surface-elevated`）**更退一档**（实机深色 33 vs 输入框 47） |
| 发送框宽度 | 与正文栏等宽 | **宽出一截**：`--composer-inline-overhang` = 24px/边，`--composer-adjacent-max-width = thread-content-max-width + overhang×2 − inset×2` |

按取证结果落成（**以此节为准**）：

1. `DraftWorkspaceToolbar` 改为 composer **外壳里的通栏顶行**：`w-full` + `rounded-t-xl` + `bg-[hsl(var(--surface-2))]`（退档表面色），底端不切，读作一块面的上半段。
2. `CodeMuxComposer` 的 `maxWidth` 由 `var(--content-width, 52rem)` 改为 `calc(var(--content-width, 52rem) + 48px)`（24px/边）。改在共享组件上，首页与会话页两边同时生效，宽度因此天生一致。
3. `embedded` 模式保留：外壳（`rounded-xl` + `--surface-1` + elevation）同时罩住上下文条与输入区，输入区只画内容不重复描边。

> 教训记在这里：**Codex 的观感细节一律回查编译产物**，不拿截图推。asar 读取方式：头 4 字节后是 12 字节尺寸前缀，JSON 头从第 16 字节起（括号匹配找结尾），条目 `offset` 是字符串需 `Number()`，数据起点 = 头结尾。

### 第三轮：只搜 token 不够，要定位到渲染它的组件

上表只查了 CSS token，「上下文条长什么样」仍是推的，于是又错了一轮（做成了发送框外壳里的通栏顶行）。正确做法是顺着 class 名反查使用它的 JSX——`grep -abo` 直接在 asar 原文里定位 `.bg-background-composer-action-bar`，命中 `OV` 组件：

```js
l = !(s && o) && 'bg-background-composer-action-bar'   // 常态自带底色
u = Sg('px-1', l)                                       // 外框 px-1
f = jsxs(gPe, { className: 'flex min-w-0 items-center justify-between gap-2 py-1.5 ...' })
p = jsx(uR.Item, { className: u, concealed: a, 'data-composer-placement': 'home', variant: 'controls', children: f })
```

再由其宿主 `z4e`（composer 包装组件）定方位：

```js
d = u || quickChatComposerPresentation != null ? 'above' : s   // actionBarPosition 默认 'above'
x = !u && d === 'above' && f && 'mt-10'                         // 间距 40px
T = d === 'above' ? [g, v] : [v, g]                            // 上下文条在前、输入框在后
```

结论（**以此为准**）：上下文条是**发送框上方独立的一排**，间距 40px（`mt-10`），四角全圆、自有底色 `--color-background-composer-action-bar`（比输入区退一档），**不与发送框同面、不共用外壳**。落地为 `NewSessionPanel` 里 `<div className="mb-10"><DraftWorkspaceToolbar /></div>` + composer 自身不变；`embedded` 变体随之删除（它是误判期间的产物）。

最终形态复盘：为上下文条试过四个版本——独立面板 + 2px 缝（原始）、外壳通栏顶行、外壳内嵌行、上方独立一排。只有最后一个有编译产物依据。**先取证再动手，一个版本能省掉三次返工。**

### 第四轮：上一轮的 `mt-10` 是「动作条不在 rail 里」的分支，形态仍然错

用户对着两边截图指出「效果明显不好」。把两张图逐像素量了一遍，问题不在间距，在**形态**：

| | 我们的（改前） | Codex（同一张截图实测） |
|---|---|---|
| 位置 | 发送框上方 40px，悬空 | **压着发送框顶边**，中间 0 缝 |
| 宽度 | 与发送框同宽 | 比发送框**左右各窄 12px** |
| 圆角 | 四角全圆 | **只圆上面两角**，下边是直角 |
| 底色实测 | 251（= 页面底色，浅色下**整条隐形**） | 242 / 页面 246–249 / 输入框 255 |

前两轮漏掉的东西：

1. **`mt-10` 那条分支不是这个场景。** 它出自 `V4e`/`z4e`：`p = aboveActionBarInRail && position === 'above'` —— 为真时动作条渲染进 `uR`（rail）里，为假时才作为独立一排挂 `mt-10`。本机 Codex 首页走的是**进 rail** 那条：`Q4e` 里 `<div data-codex-composer-root data-composer-placement="home"><uR><$4e/></uR>{composer}</div>`。只看 token、只看截图都会漏，得把宿主组件的两个分支一起读完。
2. **rail 的真实几何在 CSS module `1hrlq` 里**（`_rail_/ _attached_ / _item_ / _embedded_`）：`._attached[placement=above]` = `padding-bottom: var(--radius-2xl)` + `margin-bottom: -(...)` + 上两角 `var(--radius-2xl)` + `:after` 只画上边与左右（`border-width: 1px 1px 0`，再 `clip-path: inset(0 0 var(--radius-2xl))` 裁掉下半）。`--home-composer-inline-inset` 与 composer 圆角同为 12px —— **左右内缩量 = 输入框圆角半径**，rail 的两条竖边正好接在输入框顶角弧线的终点上，外轮廓连成一条。这是「贴合」的成因，不是随手写的内边距。
3. **底色一个值套两套主题会隐形。** Codex 的公式是 `--color-background-composer-action-bar: light ? surfaceUnder : elevatedSecondaryOpaque`；我们之前两套都用 `--surface-2`(= `elevatedSecondaryOpaque`)，浅色下它落在 98.82% —— 与 `--background` 同值，整条在页面上看不见（截图里只剩孤零零一个标签）。

落地（**以此为准**）：

- 新增派生 token `--composer-action-bar-bg`（`colorDerivation` 的 `composerActionBarBackground`），浅色取 `surfaceUnder`（= 已有的 `chromeBackground`，实测 242），深色取 `elevatedSecondaryOpaque`（32）。两个 `@theme` 映射与 `:root`/`.dark` 静态镜像同步补齐。
- `DraftWorkspaceToolbar` 改为 rail：`mx-[var(--radius-xl)]`（内缩量锁在输入框圆角同一个变量上，用户换圆角档位也跟着走）+ `rounded-t-xl` + `bg-[hsl(var(--composer-action-bar-bg))]` + `relative z-10`（压住输入框那条画在盒外的 `shadow-elevation-prominent` 描边，接缝才不会有横线）。
- `NewSessionPanel` 去掉 `mb-10` 包裹：rail 与 composer 同列相邻，0 缝。
- chip 顺带对齐：字号 `text-ui-caption` → `text-sm`、图标 14 → 16px、悬停从 `--surface-3` 换成 ink alpha（`--surface-3` 与 rail 底色同档，浮不出来）；`text-muted-foreground/70` 的箭头改成第三档 `text-foreground-tertiary`（AGENTS.md 禁用文字透明度后缀）。

实机复核（1200×800，`data-host=desktop`）：rail 宽 696 / 输入框 728 → **每边内缩 16px = `--radius-xl`**；rail 上圆角 16px、下圆角 0；两盒接缝 `bottom - composer.y = 0`；rail 底色 `rgb(242,242,242)`（Codex 实测 241）。接缝像素逐行扫描 242 → 249 → 253，**没有多出来的线**。深色下 rail 32 / 输入框 45 / 页面 17，与 Codex 同序。

测试：`colorDerivation.test.ts` 冻结表补两个值 + 新增一条「上下文条必须同时离开页面底色与输入框」的契约（浅色下同值隐形的回归防线）；`DraftWorkspaceToolbar.test.tsx` 与 `NewSessionPanel.test.tsx` 的形态契约改成 rail 口径。

> 这一轮的教训：前两轮把「哪一行 JSX 渲染它」当成终点，其实还要问一句「**这个组件在什么条件下走哪条分支**」。判断依据取错了分支，取证再细也是白取。