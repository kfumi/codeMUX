# 01 — 终端会话 registry 与 TerminalView

**What to build:** 把 xterm 与 PTY 的所有权从 `TerminalPanel` 组件移到模块级 `sessionRegistry`，右侧面板改为只挂载/摘除 DOM 宿主。行为目标与今天一致：切会话、切标签、收起面板都不重建终端。

**Blocked by:** —

**Status:** done（代码与自动化验证完成；Windows 手工验收未执行）

- [x] `src/lib/terminal/sessionRegistry.ts` 提供 `acquire / mount / unmount / setActive / release / releaseWhere / releaseAll`；全部幂等。
- [x] `acquire` 先同步 `fit()` 再带真实 cols/rows 调 `terminal.start`；已有条目直接复用。
- [x] `mount/unmount` 只搬 `hostEl`（容器 ↔ `document.body` 下的 stash），不调用 start/attach/detach/close/dispose。
- [x] 后台标签继续缓冲输出（128KB 上限、按 `\r`/`\n` 行界截断、带省略提示）；激活那一帧一次性写入。
- [x] `replay: true` 输出仍先写 `RIS` 再写快照；后台期间的回放覆盖而不是追加。
- [x] 主题与字号订阅在 registry 内完成：切主题/改 `codeFontSize` 只改 `term.options` 并重算尺寸，不重建实例。
- [x] `src/components/workspace/terminal/TerminalView.tsx` + `TerminalScrollbar.tsx` 取代 `TerminalPanel`；容器元素稳定，不得因 props 变化重建。
- [x] `SidePanel` 的终端标签改用 `TerminalView`，关闭标签时调用 `release(sessionKey)`。
- [x] `sidePanelStore` 不再暴露 `setTerminalId` / `tab.terminalId`（PTY id 只在 registry 内流转）。
- [x] 测试：`sessionRegistry.test.ts` 覆盖 start 一次、可见性切换无终端操作、mount/unmount 不 dispose、release 才 close、缓冲与截断、回放 RIS、字号不重建；`SidePanel.test.tsx` 迁移到新边界。

## Comments

- **面板过渡期间必须停掉 fit，而不只是停 PTY resize。** `9fdabc2` 的修复口径是「宽度过渡结束后才 fit/同步」；重构成 registry 时如果只做 120ms 防抖，`ease-motion-in-out` 前 120ms 宽度仍停在极窄区间，防抖会把 1~2 列的中间尺寸真的发给 PTY，PSReadLine 在两列宽下重画 prompt，屏幕上留下 `PS` 单独一行的残影。判定用「宿主自身及所有祖先是否有 `playState === 'running'` 的动画」，每 60ms 复查，过渡结束后一次干净 fit（回归测试：`defers fitting and the PTY resize until the surface transition finishes`）。
