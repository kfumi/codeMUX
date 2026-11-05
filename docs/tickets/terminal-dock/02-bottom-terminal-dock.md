# 02 — 底部终端 Dock

**What to build:** 对话列下方新增底部终端面板：多标签、新建、关闭、折叠、高度拖拽、开合动画、按项目归属、高度与开合状态持久化。

**Blocked by:** 01

**Status:** done（代码与自动化验证完成；Windows 手工验收未执行）

- [x] `src/stores/terminalDockStore.ts`：`isOpen / heightPx / isResizing / workspaces(按项目) / sessions`；动作 `toggle / open / close / setHeight / setResizing / newTerminal / closeTerminal / setActiveSession / ensureWorkspace`。
- [x] 首次打开且项目无终端时惰性创建一个；标签序号取最小未使用整数；标题 = 项目目录名 + 序号（>1 时）。
- [x] 关闭标签释放对应终端；最后一个标签关闭 → dock 收起。折叠箭头/✕ 只隐藏，保活。
- [x] `TerminalDock.tsx`：头部（折叠 · 「终端」+ shell 标签 · 标签条 · `+` · `✕`）、常驻挂载的非活动标签 `invisible`、空态、错误边界。
- [x] 高度：默认 260px、最小 140px、最大对话列 50%；拖拽用 `clientY` + `ResizeOverlay cursor="row-resize"` + `html.cmx-panel-resizing`，拖拽期间 `transition-none`。
- [x] 开合动画：`transition-[height] duration-normal ease-motion-in-out` + 内容透明度，首次展开延一帧。
- [x] `layoutPreferences` 增加 `terminalDockHeight` / `terminalDockOpen`（读取时校验类型与范围）。
- [x] `MainLayout` 新增 `terminalDock?: ReactNode`，插在对话列 `ConversationFullViewHost` 之后；`App` 只在 app 视图且有项目时传入。
- [x] 测试：store 状态机（含序号复用、切项目、最后标签关闭）、dock 开合/标签/关闭、MainLayout 挂载位置与高度夹取。
