# 会话终端保活与视图持久化

**Status:** implemented-in-workspace

## Problem Statement

CodeMUX 原实现的右侧终端面板按 Session 保存 tab，但 `TerminalPanel` 卸载时会直接关闭对应的 PTY 子进程。用户从当前 Session 切换到其他 Session 时，右侧面板会切换 scope，旧终端组件因此卸载；切回原 Session 后，面板虽然恢复了终端 tab，却只能重新启动一个新的终端。本 spec 的目标是让普通 Session 切换不再卸载终端视图。

这会导致正在运行的 `npm run dev`、开发服务器、构建任务、文件监听器或其他长期任务被意外终止。终端的当前目录、环境、进程状态、滚动输出和交互上下文也会丢失。用户期望切换 Session 只是离开终端视图，而不是终止该 Session 的终端进程。

## Solution

终端 tab 存续期间，终端视图和 PTY 都保持存活；Session 切换只改变可见性：

- `SidePanel` 为当前和非当前 scope 保持所有终端 `TerminalPanel` 挂载。
- 非当前终端仅使用 CSS 隐藏并禁用鼠标交互，不执行 `detach`、`attach`、`fit`、`refresh`、`resize` 或 `blur`。
- xterm 实例继续接收 PTY 输出，因此屏幕缓冲、光标、滚动位置、当前目录、环境、运行中的子进程和交互上下文都保持原状。
- PTY 和 xterm 只在用户明确关闭终端 tab，或终端 tab 被真正移除时销毁。
- `attach`/`detach` 仅作为真实组件重挂载或异常恢复的后备能力，不是普通 Session 切换流程。
- 应用退出时统一清理仍存活的 PTY，避免后台进程泄漏。

## User Stories

1. 作为桌面开发者，我希望切换到其他 Session 不会终止当前 Session 的终端进程，以便 `npm run dev` 等长期任务继续运行。
2. 作为桌面开发者，我希望切回原 Session 后仍连接到原来的终端，而不是重新启动一个新的 PowerShell 或 shell。
3. 作为桌面开发者，我希望切换期间产生的终端输出在切回后可见，以便了解后台任务发生了什么。
4. 作为桌面开发者，我希望切回终端后仍处于原来的工作目录，以便继续执行上下文相关的命令。
5. 作为桌面开发者，我希望切回终端后环境变量、当前 shell 状态和已启动的子进程保持不变，以便继续使用原来的开发环境。
6. 作为桌面开发者，我希望在终端中启动文件监听器后可以自由查看其他 Session，而不必担心监听器被杀死。
7. 作为桌面开发者，我希望在终端中启动开发服务器后可以切换 Session，回到终端时服务器仍在监听原端口。
8. 作为桌面开发者，我希望终端在发生真实重挂载时产生的 ANSI 控制序列和日志文本仍能以可用的终端输出形式恢复。
9. 作为桌面开发者，我希望切回终端后仍可输入命令，并且输入发送到原来的 PTY，而不是发送到新建进程。
10. 作为桌面开发者，我希望终端 tab 的显式关闭操作仍会终止对应的 PTY，以便主动回收不再需要的任务。
11. 作为桌面开发者，我希望关闭终端 tab 后该 tab 不会在返回 Session 时复活，以便关闭操作语义明确。
12. 作为桌面开发者，我希望多个 Session 的终端彼此隔离，以便切换 Session 不会把命令或输入发送到错误的项目目录。
13. 作为桌面开发者，我希望同一 Session 的终端 tab 在面板折叠、展开或切换其他右侧 tab 后仍保持运行，以便面板显示状态不影响后台任务。
14. 作为桌面开发者，我希望终端进程退出后，切回终端能看到进程已退出的状态，而不是误以为应用重新启动了它。
15. 作为桌面开发者，我希望终端已经退出或其 `terminalId` 无效时，界面能明确提示并安全创建新终端，而不是静默丢失输入。
16. 作为桌面开发者，我希望终端输出缓存有明确上限，以便长期运行任务不会因无限积累输出耗尽内存。
17. 作为桌面开发者，我希望终端真实重连接时先恢复缓存输出，再接收新的实时输出，以便日志顺序不倒置。
18. 作为桌面开发者，我希望只有当前可见终端的实际窗口尺寸变化才影响 PTY 尺寸，不会因切换 Session 意外重绘终端。
19. 作为桌面开发者，我希望应用退出时所有仍存活的终端进程被清理，以便不会留下孤儿开发服务器或 shell。
20. 作为维护者，我希望终端的 start、attach、detach、write、resize、close 与 visible/hidden 生命周期语义清晰，以便前端 UI 生命周期变化不会再误杀后台进程。
21. 作为维护者，我希望无效或已关闭的 `terminalId` 返回可区分的错误，以便前端能够决定重新创建终端，而不是重复 attach。
22. 作为维护者，我希望同一终端的新连接会替换旧的输出通道，以便组件重新挂载后不会同时向旧 UI 和新 UI 推送不一致的事件。
23. 作为维护者，我希望终端生命周期的回归测试覆盖“切换 Session 后切回”的完整行为，以便未来修改导航或面板 scope 时不会重新引入该问题。
24. 作为维护者，我希望终端的生命周期状态和对话 CodeMUX Event 分离，以便终端控制面不会污染 Session 的对话历史。

## Implementation Decisions

### 生命周期模型

- 终端 PTY 和 xterm 实例都是桌面应用进程内的短期资源，不属于某次 Session 切换产生的临时 React effect。
- 每个打开的终端 tab 都有唯一的 tab instance ID，并持有对应的 `terminalId`；同一 Session 中重复打开仍复用尚未关闭的 tab，关闭后重新打开必须生成新的 instance ID。
- 终端支持 `running`、`attached`、`detached`、`exited` 和 `closed` 状态；`detached` 只用于真实重挂载或异常恢复，不代表普通 Session 切换。
- Session 切换、切换右侧 tab、折叠面板只改变可见性，不改变终端生命周期。
- 明确关闭 tab 对应 `close`；PTY 自然退出对应 `exited`。
- `close` 是幂等操作。对已退出、已关闭或已不存在的终端 ID 重复 close 不应导致前端异常。

### 前后端接口

- 保留创建终端的 start 能力。
- 增加 attach 能力：接收已有 `terminalId`、当前尺寸和新的事件通道，成功后恢复输出并继续推送实时事件。
- 增加 detach 能力：解除当前事件通道绑定，但保留 PTY、子进程、writer 和生命周期状态。
- write、resize 和 close 继续按 `terminalId` 操作；未 attach 的终端不接受来自 UI 的输入。
- attach 到不存在或已经关闭的 ID 时返回可识别错误，前端回退到 start 并更新 tab 的 terminal ID。
- 同一终端只保留一个活动事件通道；新的 attach 会替换旧通道，避免重复推送。
- 普通 Session 切换不调用 attach/detach；可见性切换不会改变事件通道。

### 输出恢复

- 后端为每个终端保存有上限的原始输出缓存，缓存大小按字节限制，而不是按事件数量无限增长。
- reader 线程始终继续读取 PTY；有活动通道时发送实时输出，同时维护有界缓存，确保真实重挂载时仍有恢复材料。
- 普通 Session 切换不依赖输出回放，因为原 xterm 实例持续接收并保存输出。
- 真实 attach 时先发送缓存内容，再切换到实时事件发送，保证恢复输出不晚于后续输出。
- 缓存只用于异常恢复，不承诺跨应用重启持久化，也不替代终端完整 scrollback 数据库。
- 输出缓存和事件通道只在桌面进程内使用，不进入 Session 的持久化消息或 CodeMUX Event 历史。

### 前端终端面板

- `SidePanel` 收集当前及非当前 scope 的 terminal tabs，并为每个 tab 挂载一个稳定的 `TerminalPanel`。
- `TerminalPanel` 首次挂载且 tab 没有有效 `terminalId` 时调用 start；tab 已有 `terminalId` 时优先调用 attach。
- `isActive` 只控制 CSS 可见性和鼠标命中；切换 Session、切换右侧 tab、折叠面板不会触发终端操作。
- `ResizeObserver` 只为当前可见终端处理实际尺寸变化；隐藏终端不执行 fit 或 resize。
- `setTerminalId` 只在 start 成功或 attach 回退创建成功后更新 tab。
- 显式关闭 tab 的路径负责移除 tab；随后由终端面板 cleanup 调用 close。关闭后重新打开不能复用已关闭的 tab instance ID 或旧的退出事件。
- `TerminalPanel` 只有在 tab 真正被移除时才释放 xterm 并关闭对应 PTY。

### 资源与错误处理

- 隐藏不 kill 子进程，因此长期运行任务在 UI 不可见期间继续执行。
- 普通 Session 切换不产生 detached 状态，也不应出现“恢复终端”的中间状态。
- PTY 自然退出后保留退出状态和必要的最后输出；重新 attach 时展示退出提示，不自动重启用户任务。
- start、attach、detach、write、resize 和 close 的失败都应进入现有终端错误展示路径，并避免未处理的 Promise rejection。
- 应用退出时由 Rust 侧统一关闭所有仍存活的终端会话。
- 不引入新的跨 Session 共享终端语义；每个 terminal tab 仍只属于创建它的 Session scope。

### 测试接缝

- 最高测试接缝是终端视图宿主与生命周期适配层：使用真实的 `SidePanel`/`TerminalPanel` 与假的终端传输实现，模拟 Session scope 可见性切换，验证 xterm 不卸载且不会调用 attach/detach/refresh/resize。
- Rust 侧将 PTY 注册表、事件通道绑定和有界输出缓存拆成可测试边界；命令测试验证 attach 后输出恢复、detach 后子进程仍可写入、close 后资源不可继续使用。
- Session scope store 测试验证 terminal tab instance ID 和 terminal ID 在 Session 切换、面板 tab 切换、显式关闭、关闭后重新打开之间的状态变化。
- 测试不依赖真实 PowerShell、真实项目路径或无限运行的开发服务器；使用假的 PTY/传输和确定性输出。

## Testing Decisions

### 什么是好测试

- 只断言用户可观察的行为：Session 切换后后台任务仍存活，切回后使用相同终端身份，离开期间输出可见，显式关闭才终止进程。
- 不把 React effect 的调用次数或具体 mutex 排布当作产品行为；终端视图的存活、可见性切换是否触发终端操作，以及 start/attach/detach/close 的传输边界才是生命周期契约。
- 测试必须区分三种场景：可见性切换、tab 显式关闭、真实 UI 卸载和 PTY 自然退出，避免用一个 cleanup 测试覆盖所有语义。
- 回归测试应在修复前对当前实现失败，失败原因必须是 Session 切换卸载了 xterm、触发了终端操作，或关闭后重开复用了旧实例；修复后再通过。
- 所有测试使用确定性 terminal ID、输出顺序和缓冲上限，避免依赖时间窗口或本机 shell。

### 测试范围

- 前端终端面板集成测试：验证首次 start、Session 切换只隐藏不卸载、可见性切换不触发 attach/detach/refresh/resize、attach 失败后 start 回退、输入/resize 只作用于已连接终端。
- 侧边栏状态测试：验证不同 Session 的 tab 隔离、terminal ID 保留、显式关闭后实例移除、关闭后重新打开生成新实例，以及 panel/tab 切换不误触发 close。
- Rust 终端会话单元测试：验证终端注册、通道替换、detach 保活、输出缓存回放、有界裁剪、自然退出和幂等 close。
- 前后端边界测试：验证无效 ID 的错误分类，以及前端只对资源不存在错误执行新建回退。
- 手工验收：在 Windows 上启动 `npm run dev` 或等价长期任务，执行“打开终端 → 启动任务 → 切换 Session → 等待输出 → 切回”的完整流程，并确认进程、端口和输出均保持。

### 测试先例

- 前端使用现有 Vitest 与 Testing Library 的 jsdom 组件测试模式，并对 Tauri API 和 xterm 适配层使用确定性 mock。
- store 行为沿用现有 side panel store 测试的状态快照断言方式。
- Rust 测试沿用命令模块的单元测试方式；需要 PTY 的部分使用假的会话资源或可注入的传输实现，不启动真实 shell。

## Out of Scope

- 应用重启、崩溃或系统注销后继续运行并恢复终端；本 spec 只保证同一桌面进程内的 Session 切换。
- 将终端进程或终端 scrollback 持久化到 SQLite 或磁盘。
- 多个窗口、多个桌面实例或 Mobile Companion 同时 attach 同一终端。
- 让不同 Session 共享同一个终端 tab 或自动迁移终端所属项目。
- 无限 scrollback、完整终端录制、终端输出搜索和日志导出。
- 修改 CodeMUX Event 协议或把终端控制事件写入对话历史。
- 自动重启自然退出的开发服务器或 shell。

## Further Notes

- 原始 bug 的直接原因是把 UI cleanup 误当成 PTY 生命周期；正确修复不是让 cleanup 更复杂，而是让普通 Session 切换根本不卸载终端视图。
- `terminalId` 仍是 PTY 连接契约；tab instance ID 负责区分“当前仍存活的终端 tab”和“关闭后重新打开的新终端”。
- 输出缓存应设置保守上限，并在实现中记录缓存裁剪行为，避免把长期运行开发服务器的无限日志留在内存中；它是异常恢复兜底，不是普通切换的状态恢复机制。
- 实现顺序应为：先建立持久化终端视图宿主；再实现显式关闭和新实例 ID；随后保留 attach/输出缓存作为真实重挂载兜底；最后进行 Windows 手工验收。
- 该 spec 已从“detach/attach 恢复状态”更新为“隐藏但保持原终端实例”，是当前终端生命周期行为的唯一需求来源。
