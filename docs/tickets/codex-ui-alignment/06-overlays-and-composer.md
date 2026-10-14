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