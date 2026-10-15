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