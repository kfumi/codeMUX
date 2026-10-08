# 参考插件方法面清单与 CodeMUX 差异（工单 13 附件）

**问题：** 参考实现（PI-Desktop 插件 `cn.star.computer-use` v0.4.0）到底有哪些方法，我们实现了哪些、没实现哪些？「别又漏了」要一张可核对的表，而不是印象。

**结论：** 插件的 13 个 agent 工具我们已全部对等（并多一个 `computer_wait`）；插件的非工具机制我们或已具备、或已用更严的做法替代；**驱动本身有 59 个工具，我们只接了窗口级的那 16 个（含 3 个内部使用）**，其余按「桌面级动作 / 录制回放 / 驱动自带浏览器面 / 诊断与配置」四类有意缓接，理由逐条写在下面。

**资料来源（可复核）：**

- 插件（本机已安装）：`C:\Users\94910\.pi-desktop\plugins\installed\cn.star.computer-use\`（`manifest.json` 的 `contributes.agentTools`、`runtime.js`、`policy.js`、`overlay.js`、`scripts\windows-*.ps1`、`skills\*.md`、`tests\*.js`）
- 驱动（本机已安装 0.30.1）：`cua-driver mcp` 的 `tools/list`（59 项，本文件成文时实测）
- 我们的实现：`crates/daemon/src/computer_use/{desktop,policy,guard,approval}.rs`、`crates/daemon/src/browser_mcp.rs`、`apps/sidecar/src/shellInputSynthesis.ts`

---

## 1. 插件的 13 个 agent 工具 → 我们

| 插件工具 | 插件行为要点 | 我们 | 说明 |
|---|---|---|---|
| `list_apps` | 运行中 + 已安装；`include_installed` 才列未运行的 | ✅ `computer_apps` | 过滤宿主进程与内置拒绝范围后再给模型 |
| `list_windows` | pid / window_id / title / on-screen / minimized；策略过滤 | ✅ `computer_windows`（既有） | 这票补了 `windowId`（与来源 id 的 hwnd 同值），输入寻址一次拿齐 |
| `launch_app` | name / path / launch_path；后台启动不抢焦点 | ✅ `computer_launch` | 启动前按内置拒绝 + 允许列表裁决 |
| `get_app_state` | UIA 树 + 截图 + `query` + `refresh` + `read_value` + `wait_for` + 区域裁剪；独立的 image/tree 版本与 stale 标记 | ✅ `computer_elements`（树/图/`query`/`readValue`）+ ✅ `computer_wait`（等待） | 等待独立成工具；敏感控件的值一律脱敏 |
| `click` | element_index 优先 / 像素坐标；`count`、`mouse_button`、`delivery_mode`；右键强制前台；像素命中升级到 AX | ✅ `computer_click` | 右键/双击经 `button`/`count` 表达；`delivery_mode` 透传 |
| `perform_secondary_action` | Invoke→click、SetValue→set_value、ScrollX→scroll；Select/Toggle/Expand/Collapse/ScrollIntoView/SetFocus 明确拒绝 | ✅ 由 `computer_click(elementIndex)` / `computer_set_value` / `computer_scroll` 覆盖 | 拒绝项同样不提供入口，写进描述与技能 |
| `scroll` | `direction` + `pages`，默认后台 | ✅ `computer_scroll` | 加 `by: page|line` |
| `drag` | from/to（窗口内截图坐标） | ✅ `computer_drag` | 标题栏起拖会 `background_unavailable`，描述里写明改用 foreground |
| `type_text` | WM_CHAR 逐字符；XAML/UWP 走 `ValuePattern`（需 Document/edit 索引）；不可验证时附 `focus_state` 探针 | ✅ `computer_type` | 探针未接（驱动的路由与报错已足够；focus 探针列为增量） |
| `press_key` | 单键 + 修饰符；导航键与 Office 和弦走**受保护的原生投递**（PID/前台/焦点/按键占用检查、部分插入只释放已插入前缀） | ✅ `computer_key`（无修饰键→`press_key`，带修饰键→`hotkey`） | 驱动内部同样分「现代 XAML 走 UIA 加速键 / 旧式 Win32 走 SendInput 并短暂前台」；原生守卫的细节由驱动负责，我们不再自建 |
| `paste_text` | 先写剪贴板再投一次 Ctrl+V；剪贴板写失败就**不粘贴** | ✅ `computer_paste` | 会覆盖系统剪贴板，描述里写明 |
| `set_value` | UIA `ValuePattern.SetValue` | ✅ `computer_set_value` | 网页自绘输入框可能忽略，描述里指向 `computer_type` |
| `stop_computer_use` | 杀驱动 + 拒绝后续调用 | ✅ Esc 急停（既有，工单 06/10） | 我们更强：进程级刹车 + 本次追加**收回全部限时授权** |

**插件有、我们没有的「说法」**：`wait_for` 的 `kind` 里插件还支持 `value_equals`/`value_changed` 的 `baseline`（我们有）、`read_value` 的 `automation_id` 选择器（驱动元素没有 automation_id，我们用 `name` + `role`）。

## 2. 插件的非工具机制 → 我们

| 插件机制 | 我们 | 说明 |
|---|---|---|
| 顶部横幅 + 物理 Esc 急停（`WH_KEYBOARD_LL` + `LLKHF_INJECTED` 过滤） | ✅ 已有（工单 10） | 我们的横幅跟随后端真实武装状态；注入键边界已在工单 10 如实记录 |
| 拒绝列表（密码管理器/终端/锁屏/安全中心/PI-Desktop/ChatGPT/Codex）+ 可选允许列表 | ✅ 更严 | 除名称匹配外，还按 pid/父进程/映像名/**可执行文件路径**硬拒宿主家族；输入前裁决 |
| 面板（状态/安装/允许列表/最近一帧/Start-Stop-Doctor） | ✅ 设置页 + 诊断 | 安装/更新走官方通道（工单 09），诊断改为 `driver.status` + `check-update` |
| `beginControl`/`endControl` 深度计数 + 横幅 | ⚠️ 部分 | 我们有横幅 + 回合级武装；深度计数对应「限时控制会话」（本票新增，按 `(会话, 回合)` 记账） |
| 回执行（`delivery`/`ui_change`/`goal`/`retry_safe`/`evidence`）+ 「不重放」 | ⚠️ 部分 | 我们逐工具附一句回执（投递/模式/不重放）；驱动自带的 `structuredContent` 原样透传。FNV 树签名与目标窗口关闭验证未接 |
| `snapshot_id:index` 令牌校验（服务端记账，拒绝陈旧索引） | ⚠️ 部分 | `snapshotId` 透传给驱动校验 + 技能纪律（动作后必须重新观测）；我们**没有**服务端索引记账 |
| 区域裁剪（`image-region.js` + `windows-crop.ps1`） | ❌ 未接 | 驱动有 `zoom`（原生分辨率 + `from_zoom` 坐标回译），作为下一票的增量比自建裁剪划算 |
| Office 知识技能（`office-desktop.md` 93 行、`office-workflows.md` 72 行） | ❌ 未接 | 纯知识（Excel/Word/幻灯片/WPS 的按键表、验收纪律、保存与重开流程），价值高、体积大，建议单独一票 |
| 会话生命周期（`sessionEpoch`、deadline、每 await 边界取消） | ✅ 由驱动与 daemon 承担 | 驱动有会话；daemon 的急停是进程级；我们没有逐 await 的 epoch 检查（记录为边界） |

## 3. 驱动的 59 个工具 → 我们的接入状态

图例：**✅ 已接**（模型面）｜**🔧 内部**（我们自己调用，不给模型）｜**⏸️ 缓接**（有理由，列下一票）｜**🚫 有意不接**

| 面 | 工具 | 状态 |
|---|---|---|
| 观测 | `list_apps`、`list_windows`、`get_window_state`、`debug_window_info` | ✅ `computer_apps`、✅ `computer_windows`、✅ `computer_elements`；`list_windows`/`debug_window_info` 为动作前裁决的内部依赖 |
| 观测（桌面级） | `get_screen_size`、`get_desktop_state`、`get_cursor_position`、`get_accessibility_tree` | ⏸️ 桌面级动作没有窗口身份可裁决；整屏观测已由壳侧 `computer_screenshot` 承担（带受保护窗口筛查） |
| 观测（放大） | `zoom` | ⏸️ 小字放大 + `from_zoom` 坐标回译，下一票 |
| 等待 | `verify_state` | ⏸️ 驱动版谓词更严（`satisfied/unsatisfied/unknown`），我们先用自轮询 `computer_wait` 对齐插件 |
| 输入（鼠标） | `click`、`double_click`、`right_click`、`drag`、`scroll`、`move_cursor` | ✅ `computer_click`（含 count/button）、✅ `computer_drag`、✅ `computer_scroll`；`move_cursor`（代理光标）⏸️ |
| 输入（键盘） | `press_key`、`hotkey`、`type_text`、`set_value` | ✅ `computer_key`（两种路由）、✅ `computer_type`、✅ `computer_set_value` |
| 剪辑板 | `clipboard_write`、`clipboard_read` | 🔧 `computer_paste` 内部使用；`clipboard_read` 🚫（读用户剪贴板是隐私面，没有需求不开口子） |
| 应用 | `launch_app`、`kill_app` | ✅ `computer_launch`；`kill_app` 🚫（强制结束进程不可逆，没有明确需求不给模型） |
| 窗口管理 | `bring_to_front`、`set_window_frame`、`invoke_menu` | `bring_to_front` 🚫（驱动自己在动作内处理前台，默认不打扰用户）；`set_window_frame` ⏸️；`invoke_menu` ⏸️（按菜单路径走可访问性，比点像素可靠，值得下一票） |
| 代理光标 | `set_agent_cursor_enabled`、`set_agent_cursor_motion`、`get_agent_cursor_state`、`set_agent_cursor_theme` | ⏸️ 「让用户看见 agent 在做什么」与我们的控制横幅同一个目的，可行但需设计（谁负责开关、与 Esc 的关系） |
| 诊断/配置 | `check_permissions`、`health_report`、`get_config`、`set_config` | ⏸️ 我们的诊断页已有自研 checks；`health_report` 是官方稳定契约，值得并入 |
| 会话 | `start_session`、`get_session`、`list_sessions`、`get_session_state`、`end_session`、`escalate_session` | ⏸️ 隐式会话够用；多会话/光标主题要一起设计 |
| 录制回放 | `start_recording`、`stop_recording`、`get_recording_state`、`replay_trajectory` | ⏸️ 轨迹（前后截图 + AX 状态 + 动作 json）对审计与回归极有价值，但先要定隐私边界与存放策略 |
| 驱动自带浏览器面 | `page`、`get_browser_state`、`browser_prepare`、`browser_navigate`、`browser_click`、`browser_type`、`browser_dialog`、`browser_set_input_files`、`browser_download`、`browser_pointer` | 🚫 我们有自己的一套浏览器工具（内置浏览器 + CDP），两套并存会让模型二选一犯难；除非将来替换，否则不接 |
| 更新/扩展 | `check_for_update`、`install_extension`、`install_ffmpeg`、`parse_visual_regions` | 更新 ✅（我们走 CLI `check-update --json`，工单 09）；其余 ⏸️ |

## 4. 这票之后仍开着的口子（如实记录）

1. **bash 旁路的跨智能体覆盖**：只接了 Claude 的 `canUseTool`。codex（`codexAppServerApprovals` 的命令审批）、opencode（`opencodePermissions` 的 bash 权限记录）、pi（无工具级钩子，要走扩展）尚未接同一道预检 —— 默认用别的智能体时，这道预检不生效。
2. **预检看不见的绕过**：脚本文件里的键鼠（`cscript click.vbs`）、已编译二进制、直接 syscall；`-EncodedCommand` 只是「看不清就拦」。
3. **服务端索引记账**：`element_index` 的陈旧检测目前依赖驱动缓存 + `snapshotId` 透传，我们不做自己的令牌账本。
4. **桌面级动作**：整屏坐标点击（`get_desktop_state` 坐标系）没有接 —— 需要一套不依赖窗口身份的目标裁决，没想清楚之前不开。
