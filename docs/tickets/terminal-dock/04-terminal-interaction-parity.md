# 04 — 终端内交互对齐（主题 / 链接 / 键位 / IME / PS）

**What to build:** 补齐 ZCode 已验证的终端交互细节：主题跟随应用、链接可点击、复制粘贴语义正确、Windows IME 不丢字、PowerShell 光标重绘不留灰块。

**Blocked by:** 01

**Status:** done（代码与自动化验证完成；Windows 手工验收未执行）

- [x] `src/lib/terminal/terminalTheme.ts`：背景/前景/光标/选区从 `--surface` / `--ink` 派生；ANSI 16 色为模块常量；组件内不再出现 hex 字面量。
- [x] `src/lib/terminal/terminalLinks.ts` + `registerLinkProvider`：识别跨折行 http(s) URL、去掉尾部标点、映射到 cell 坐标；OSC 8 只放行 http(s)。
- [x] `openTerminalLink()`：有 `browser.host` 能力时开右侧浏览器标签，否则走 `shellFacade.openExternal`。
- [x] `terminalDataTransform.ts`：PowerShell/PSReadLine 单行光标重绘的 `SGR 40` 改写为 `49`；四条守卫（shell 匹配、含 ESC、无换行、双模式匹配）避免误改普通输出。
- [x] `composedInputFallback.ts`：Windows 桌面的 composed input 兜底（text 40ms / IME 提交 150ms 匹配窗口；已消费输入不得重复写入）。
- [x] `attachCustomKeyEventHandler`：`Ctrl/Cmd+C` 有选区时复制并拦截；`Ctrl/Cmd+V` 走 `term.paste` 并阻止原生重复粘贴。
- [x] 右键菜单：复制 / 粘贴（无选区时复制禁用），复用 `src/components/ui/context-menu`。
- [x] xterm 选项：`scrollback` 5000、`lineHeight 1.35`、字体族跟随全局 UI/代码字体。
- [x] 测试：链接解析（含折行与尾部标点）、PS 归一化守卫、IME 去重状态机、复制粘贴拦截、主题派生不产生非法颜色串。
