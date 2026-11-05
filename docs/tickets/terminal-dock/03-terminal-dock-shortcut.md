# 03 — 底部终端快捷键与标题栏入口

**What to build:** `Ctrl/⌘ + \`` 开合底部终端，并在标题栏右侧面板按钮旁提供同规格开关按钮。

**Blocked by:** 02

**Status:** done（代码与自动化验证完成；Windows 手工验收未执行）

- [x] `keyboardShortcuts.ts` 新增命令 `toggleTerminalDock`（layout 组，标签「开合底部终端」，默认 `Mod+Backquote`）。
- [x] `keyboardShortcuts.test.ts` 的命令计数断言从 13 改为 14，并确认默认键位通过「可绑定/非保留/无冲突」检查。
- [x] `App.tsx` 的 dispatch 接线：有项目时切换；无项目时不动作。
- [x] `TitleBar` 在与右侧面板按钮同组位置加按钮，tooltip 与 `aria-keyshortcuts` 跟随用户改键。
- [x] 设置页快捷键列表自动出现该命令（补一条渲染断言）。
- [x] 测试：快捷键解析命中、`Mod+Backquote` 未与现有命令冲突、按钮 aria-label 与开合状态一致。
