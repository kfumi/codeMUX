# 终端系统重构：registry 所有权与底部 Dock

**Status:** implemented-in-workspace（自动化验证通过；Windows 手工验收清单见 plan）

**取代声明：** 本文取代 `docs/specs/2026-08-19-terminal-session-persistence.md` 中「xterm 由组件持有」「terminal tab 只属于创建它的 Session scope」两条实现口径；该 spec 的生命周期目标（可见性切换不杀 PTY、只在显式关闭时销毁、有界回放兜底）仍是本 spec 的前提，继续有效。

## Problem Statement

CodeMUX 的终端只存在于右侧面板，并且由 `TerminalPanel` 组件自己创建 xterm、在挂载 effect 里 `start/attach`。这带来四个问题：

1. **只有一个 surface**。底部没有终端；对比 ZCode，同一个窗口既能开右侧终端也能开对话列下方的底部终端。
2. **重建即丢画面**。真实重挂载时 daemon 回放的是原始输出快照（256KB 上限），超出部分、选区、滚动位置全部丢失；重挂载还要 `RIS` 清屏重画。
3. **尺寸管线脆弱**。PTY 尺寸同步靠 `aside.getAnimations()` 判断面板动画是否结束；底部 dock 没有 `aside` 祖先，直接失效。
4. **Windows 上的实际缺陷未修**：PSReadLine 光标重绘把尾巴刷成黑底（非纯黑主题下是灰块）、中文输入法在 PowerShell 里会丢字或重复、终端里的 URL 不可点击。

## Solution

按 ZCode 的方式把终端所有权移出 React，并新增底部 dock：

- **模块级 registry** 持有 xterm、可搬移的 DOM 宿主与 PTY id；组件只挂载/摘除宿主。
- **底部 dock** 按项目归属（同项目的多个会话共用一组终端），挂在对话列下方，占对话列宽度，右面板保持全高。
- 两个 surface 各自独立开 PTY，不提供「移动会话」动作（与 ZCode 一致）。
- resize 统一走 rAF fit + 尺寸稳定 120ms + 单飞行 latest-wins。
- 补齐 ZCode 已验证的 Windows/交互修复：PSReadLine 黑底归一化、IME composed input 兜底、URL 链接、复制粘贴键位与右键菜单、主题/字号跟随应用设置。
- daemon 侧对齐 shell 解析（pwsh → powershell → ComSpec → cmd；`$SHELL` → zsh → bash → sh）、环境变量与真实退出码，并在 `POST /terminals` 响应里返回 shell 路径。

## User Stories

1. 作为开发者，我希望在对话列下方直接开终端，不必先把右侧面板挤窄。
2. 作为开发者，我希望底部终端能开多个标签，并能新建、切换、关闭。
3. 作为开发者，我希望底部终端能拖动改高度，展开/收起有动画且不闪。
4. 作为开发者，我希望关掉底部终端再打开时，`npm run dev` 还在跑、输出还在、滚动位置还在。
5. 作为开发者，我希望切会话（同项目）时底部终端不换、不重启；切到别的项目时换成那个项目的终端。
6. 作为开发者，我希望切换右侧面板标签、收起面板、切换项目都不会重建 xterm。
7. 作为开发者，我希望拖动改高度或开合面板时，shell 不会因为密集 SIGWINCH 反复重画提示符。
8. 作为开发者，我希望终端里的 http(s) 链接可以点击，并在内置浏览器打开。
9. 作为 Windows 用户，我希望中文输入法在 PowerShell 里输入不丢字、不重复。
10. 作为 Windows 用户，我希望 PowerShell 的光标重绘不会在深色/浅色主题下留下灰块。
11. 作为用户，我希望用 Ctrl+` 开合底部终端，并记住上次的高度和开合状态。
12. 作为用户，我希望 shell 退出时能看到退出码，而不是标签凭空消失。
13. 作为维护者，我希望终端的 start/write/resize/close 与挂载周期彻底解耦，新增 surface 不再复制保活逻辑。

## Implementation Decisions

### 会话所有权

- `src/lib/terminal/sessionRegistry.ts` 是 xterm 与 PTY 的唯一所有者。条目包含 `key / projectPath / term / fitAddon / hostEl / terminalId / status / active / pendingOutput`。
- `acquire(key, { projectPath, container, active })`：新建 xterm → 同步 `fit()` → 用真实 cols/rows 调 `terminal.start`；条目已存在则复用。
- `mount(key, container)` / `unmount(key)`：只移动 `hostEl`（容器 ↔ `document.body` 下的 stash），不触发任何终端操作。
- `setActive(key, active)`：激活时把后台缓冲一次写入、fit、下一帧 `term.focus()`。
- `release(key)` / `releaseWhere(pred)`：唯一销毁路径；`release` 幂等。
- 后台标签不解析输出：继续用现有 128KB 缓冲（超过后按 `\r`/`\n` 行界截断并留提示），切回前台那一帧写入。这是与 ZCode 的有意差异（省主线程）。
- PTY 自然退出：保留标签并写 `[进程已退出: N]`，标记 `exited`；不自动重建、不自动删标签。
- 主题与字号：registry 用 `subscribeIsDark` 与 `appearance.subscribe` 更新 `term.options.theme / fontSize`，然后重算尺寸；不重建实例。

### 尺寸管线

- `fit` 用 rAF 合并；非活动或容器零尺寸直接返回。
- **面板开合过渡期间不 fit**：`ease-motion-in-out` 起步很慢，前 120ms 容器宽度还停在极窄区间，此时 fit 会把 xterm 重排到 1~2 列，随后防抖会把这个中间尺寸真的发给 PTY，PowerShell/PSReadLine 就在两列宽下重画 prompt 并留下永久残影（`PS` 单独一行、光标停在行首）。判定方式是检查宿主自身及所有祖先是否有 `playState === 'running'` 的 CSS 动画/过渡，每 60ms 复查一次，过渡结束后做一次干净 fit。
- PTY 尺寸在最后一次变化后 120ms 发出；同一时刻最多一个在途 `resize`，期间只保留最新尺寸，完成后补发。
- 拖动改尺寸（`transition-none`，没有 CSS 过渡）仍每帧 fit，观感实时；PTY 尺寸走防抖，不会打出一串 SIGWINCH。

### 底部 Dock

- `src/stores/terminalDockStore.ts`：`{ isOpen, heightPx, isResizing, workspaces: Record<projectPath, { sessionIds, activeSessionId }>, sessions }`。
- 首次打开且项目没有终端时惰性创建一个；标签序号取最小未使用整数；标题 = 项目目录名 + 序号（序号 > 1 时）。
- 关闭标签 = `registry.release(key)`；最后一个标签关掉 → dock 收起。顶部折叠箭头/✕ = 只隐藏，PTY 与 xterm 保活。
- 高度：默认 260px，最小 140px，最大对话列高度的 50%；持久化到 `layoutPreferences` 的 `terminalDockHeight` 与 `terminalDockOpen`。
- 开合：高度在 `0 ↔ heightPx` 间 `transition-[height] duration-normal ease-motion-in-out`，内容同步透明度；首次展开延一帧。
- 位置：`MainLayout` 的对话列内、`ConversationFullViewHost` 之后（`shrink-0`），只在 app 视图且有项目时渲染。
- 拖拽：顶部 3px 命中区 + `ResizeOverlay cursor="row-resize"` + `html.cmx-panel-resizing`，拖拽期间 `transition-none`。

### 快捷键与入口

- 新命令 `toggleTerminalDock`，默认 `Mod+Backquote`（`Mod+J` 已被右侧面板占用）。
- `TitleBar` 右侧面板按钮旁加一个同规格按钮；tooltip 与 `aria-keyshortcuts` 跟随用户改键。
- 设置页快捷键列表由命令目录自动收录。

### 终端内交互

- 主题：背景/前景/光标/选区从 `--surface` / `--ink` 派生；ANSI 16 色为模块常量。组件内不再出现 hex 字面量。
- 链接：`registerLinkProvider` 识别跨折行 http(s) URL 并去掉尾部标点；OSC 8 只放行 http(s)。点击时有 `browser.host` 能力 → 开右侧浏览器标签，否则交给系统浏览器。
- 键位：`Ctrl/Cmd+C` 有选区时复制并拦截；`Ctrl/Cmd+V` 走 `term.paste`；右键菜单提供复制/粘贴。
- IME：Windows 桌面启用 composed input 兜底（`text` 40ms / IME 提交 150ms 匹配窗口）。
- 输出：PowerShell/PSReadLine 单行光标重绘里的 `SGR 40` 改写为 `49`，四条守卫保证不误改普通输出。

### daemon

- shell 解析：Windows `pwsh.exe → powershell.exe → %ComSpec% → cmd.exe`；Unix `$SHELL → /bin/zsh → /bin/bash → /bin/sh`；逐个校验存在且可执行。
- 环境：`TERM=xterm-256color`、`COLORTERM=truecolor`；Unix 下缺失或为 `C`/`POSIX` 的 `LANG`/`LC_CTYPE` 补 UTF-8。不改进程全局 env。
- 退出码：reader 线程结束后 `child.wait()` 取真实退出码，`Exit { code }` 不再是 `None`。
- `POST /terminals` 响应增加 `shell` 字段。

## Out of Scope

- 跨应用重启恢复终端（PTY 与 xterm 仍是进程内资源）。
- 终端 scrollback 落盘、输出搜索、录制/导出。
- 多个窗口、多个桌面实例或移动伴侣同时 attach 同一条终端。
- 在底部与右侧之间移动同一条终端（两个 surface 各自独立）。
- 分屏终端、标签拖拽排序、WebGL 渲染器。
- 终端 profile 继承（读取 Windows Terminal / iTerm 配色）。

## Testing Decisions

- registry 的公开 API 是主测试接缝：可见性切换不调用 start/attach/detach/close；只在 `release` 时 close；`mount/unmount` 只搬 DOM。
- 尺寸管线用假时钟验证：一串尺寸变化只发一次 resize，且是最后一个值；在途请求期间的新尺寸在完成后补发。
- dock store 是纯状态机：标签增删、序号复用、切项目不换终端、最后标签关闭收起 dock。
- 组件测试只断言用户可见行为：dock 展开/收起、标签条、活动标签可见、关闭语义。
- Windows 专项逻辑（PS 归一化、IME 兜底、链接解析）各自纯函数单测，不依赖真实 shell。
- Rust 侧 shell 解析与退出码用可注入的候选列表/假 child 测试。

## Further Notes

- 实现在 `docs/plans/2026-11-06-terminal-dock-registry.md` 拆成 6 张票，按顺序落地。
- 与 ZCode 的三处有意差异：隐藏标签仍缓冲输出、PTY 退出保留标签、关最后一个标签真正销毁。取舍理由见 plan。
