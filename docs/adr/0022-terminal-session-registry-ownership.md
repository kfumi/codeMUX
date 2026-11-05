# ADR 0022: 终端会话与 xterm 实例由模块级 registry 持有

## Status

Accepted

## Context

终端的「丝滑」来自两件事：切换 surface / 标签 / 会话时**不重建**终端，以及尺寸变化不会变成一串 PTY `resize`。今天的实现把 xterm 实例放在 `TerminalPanel` 的挂载 effect 里（`src/components/workspace/terminal/TerminalPanel.tsx`），靠「面板永不卸载 + 非活动标签只做 CSS 隐藏」来避开重建，靠 daemon 侧 256KB 回放缓冲兜住真实重挂载（`docs/specs/2026-08-19-terminal-session-persistence.md`）。

这个模型有三个结构性限制：

1. **ownership 在 React 里**。组件一卸载就必须决定「杀还是留」，于是每个新 surface（底部 dock）、每次布局重组都要重新证明「不会误杀 PTY」；`isTabPresent` 这种跨 scope 反查就是补丁的痕迹。
2. **视图重建就丢滚动内容**。daemon 回放的是原始输出快照，重挂载后要 `RIS` 清屏重画；超出 256KB 的历史、选区、滚动位置都回不来。
3. **尺寸管线与宿主耦合**。PTY 尺寸同步靠 120ms 防抖 + 轮询 `aside.getAnimations()` 判断「面板动画是否结束」（`TerminalPanel.tsx:420-455`）；底部 dock 的祖先不是 `aside`，这条判断直接失效。

## Decision

1. **xterm 与 PTY 的所有权移出 React**：新增 `src/lib/terminal/sessionRegistry.ts`，以稳定 key 持有 `{ term, fitAddon, hostEl, terminalId, status }`。React 组件（`TerminalView`）只负责把 `hostEl` 挂进容器、离开时摘回 stash div；挂载/卸载**不**触发 start/attach/detach/dispose。
2. **唯一销毁路径是显式关闭**：`release(key)` 才 `terminal.close()` + `term.dispose()`。标签仍在、面板收起、会话切换、项目切换都只改可见性与活动态。
3. **尺寸管线进 registry**：fit 用 rAF 合并，且**面板开合过渡期间不 fit**（过渡结束后做一次干净 fit）；PTY resize 在尺寸稳定 120ms 后发出，且单飞行 + latest-wins。过渡检测不绑定具体面板类型，改为检查宿主的所有祖先是否有运行中的 CSS 动画——侧面板宽度过渡与底部 dock 高度过渡共用同一套规则。
4. **主题/字号订阅进 registry**：切主题、改代码字号只改 xterm 视图选项，永不重建实例。
5. **daemon 协议不变**：仍是 `start / write / resize / close + WS 事件 + 回放`。`attach` 保留为「实例丢失后的兜底」，不是常规路径。

## Consequences

- 新增 surface（底部 dock）不再需要复制一套保活逻辑：它只提供容器和一个 key。
- 滚动位置、选区、超长 scrollback 在 surface 切换与标签切换后保持原样；daemon 回放只用于进程级恢复（渲染层 reload）。
- 一个终端实例的生命周期不再与任何组件的挂载周期相关，测试边界变成 registry 的公开 API（可脱离 React 单测）。
- `docs/specs/2026-08-19-terminal-session-persistence.md` 中「xterm 由组件持有」「tab 只属于创建它的 Session scope」两条被本 ADR 与 `docs/specs/2026-11-06-terminal-dock-registry.md` 取代；保活口径（可见性切换不杀进程、显式关闭才销毁）不变。
- 代价：registry 是模块级单例，测试之间必须显式 `releaseAll()`；xterm `open()` 只能调用一次，宿主 DOM 必须由 registry 持有，组件不得重建它。

## References

- `docs/specs/2026-11-06-terminal-dock-registry.md`
- `docs/plans/2026-11-06-terminal-dock-registry.md`
- `docs/tickets/terminal-dock/`
