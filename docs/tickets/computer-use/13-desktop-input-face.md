# 13 桌面输入面与「shell 合成键鼠」旁路

**What to build:** 补齐桌面**输入**工具面（点、输入、按键、滚动、拖拽、设值、启动），让模型没有理由再用 shell 合成键鼠；并把那条绕开审批闸门的旁路用预检挡住。参考实现是 PI-Desktop 的 `cn.star.computer-use` 插件（v0.4.0），差异全表见 [research/2026-10-09-reference-plugin-method-inventory.md](../research/2026-10-09-reference-plugin-method-inventory.md)。

**Blocked by:** 03 审批闸门、04 桌面只读观测、05 驱动托管、11 宿主身份硬拒、12 观测回执与坐标

**Status:** done

## Decisions

- **网关化，而不是自己合成键鼠。** 驱动（trycua/cua）已经有整套窗口面：UIA 树、背景投递、像素命中升级、`verify_state`、`zoom`、剪贴板、会话生命周期（本机 v0.30.1 共 59 个工具）。自己用 PowerShell + `SendInput` 重写等于把「后台优先、不重放、目标必须显式」这些语义再踩一遍。daemon 的 `driver::call_tool` 本来就在，缺的只是一层「闸门 + 目标裁决 + 审计」。
- **闸门不因为换通道而松一格。** 桌面工具与浏览器工具共用 `approval::gate`：输入动作一次一放行、敏感场景逐次确认、步数上限照旧；新增的只读三件套（`computer_apps`/`computer_elements`/`computer_wait`）进 `READ_ONLY_OPS`，可按会话记住。
- **限时控制会话取代「整轮免问」。** 逐次弹窗没人受得了，整轮免问又掏空「输入一次一放行」。折中：审批卡给一个「允许 3 分钟」，键是 `(会话, 回合代次)` —— 回合一变即失效，到期即失效，Esc 急停立刻收回；敏感场景不给这个选项，受保护目标（内置拒绝 + 宿主身份 + 允许列表）在授权内也照样硬拒。
- **动作前裁决，不是事后筛查。** 观测可以事后筛查截图，输入动作事后筛查等于没筛。输入前先向驱动要目标窗口事实（`list_windows`），再叠加可执行文件路径比对（`debug_window_info`）——比 exe 路径是唯一既能挡住开发模式 `electron.exe` 渲染进程、又不误伤别的 Electron 应用的做法。允许列表与内置拒绝同一份规则（`policy.rs`）。
- **驱动拒绝原文直达模型。** 成功与驱动侧拒绝都回 `ok:true`（后者带 `isError`），我们自己的拒绝才走 4xx —— 免得把 `background_unavailable` 这类「写给模型的下一步」压成一句话。
- **bash 旁路按「明显的那一类」拦。** `apps/sidecar/src/shellInputSynthesis.ts`：只看**引号外**切片后以解释器起手的片段（`grep mouse_event` 不算），命中 `mouse_event`/`SendInput`/`keybd_event`/… 或 `-EncodedCommand` 即拒绝，并把模型指回 `computer_*`。

## Checklist

- [x] daemon `computer_use/desktop.rs`：11 个桌面工具的参数翻译（纯函数）、动作前裁决、结果整形（敏感值脱敏、`readValue`、等待谓词、回执）、审计
- [x] 新端点 `POST /api/computer-use/execute`（回环 + Local Daemon Token），MCP server 转发
- [x] `guard::READ_ONLY_OPS` 扩到 10 项；`ControlSessions` + `decide_with_grant`；`CONTROL_SESSION_TTL = 180s`
- [x] 审批卡：输入动作多一个「允许 3 分钟」（`grant` 字段驱动，敏感场景不给）
- [x] Esc 急停同时收回全部授权（`revokedControlSessions`）
- [x] `computer_windows` 条目补 `windowId`（与来源 id 的 hwnd 同值），输入寻址一次拿齐
- [x] 内置技能重写：寻址阶梯、后台优先、不重放、限时授权的边界、敏感控件脱敏
- [x] sidecar 预检：Claude 的 `canUseTool` 在**一切自动放行之前**拦 shell 合成键鼠，拒绝文案给替代路径
- [x] 工单 12 的坐标纪律与新的窗口内像素坐标写清区别（两套坐标系不许混用）
- [x] 测试：daemon +20（翻译矩阵、身份裁决、脱敏、读值、等待谓词、回执、op 分类）、MCP 工具面 3 例、sidecar 预检 8 例、前端授权选项 4 例

## Comments

- **现场**（会话 `0e7ea7dc` 第二轮）：模型用 bash 写 C# P/Invoke `mouse_event` 完成点击，审批与审计全程没参与；同轮还因为坐标换算浪费了一次点击。第一轮则是「能力面缺失 + 失败理由被吞」导致绕道。三件事同源：**桌面只有眼睛没有手**。
- **插件的真实方法面**：13 个工具（`list_apps`/`list_windows`/`launch_app`/`get_app_state`/`click`/`perform_secondary_action`/`scroll`/`drag`/`type_text`/`press_key`/`paste_text`/`set_value`/`stop_computer_use`）。我们这票做到 13/13 对等 + 多一个 `computer_wait`（插件的 wait_for 藏在 `get_app_state` 参数里），另外 `Esc 急停` 本身就是 `stop_computer_use` 的加强版（进程级刹车 + 撤销授权）。逐条对照见研究文档。
- **驱动比插件暴露的还多**（59 工具）：`invoke_menu`（按菜单路径走可访问性，不点像素）、`zoom`（小字放大 + `from_zoom` 坐标回译）、`kill_app`、`set_window_frame`、桌面级动作（`get_desktop_state`/`get_screen_size`/`get_cursor_position`）、代理光标（`move_cursor`/`set_agent_cursor_*`）、剪辑板读、轨迹录制与回放（`start_recording`/`replay_trajectory`）、`health_report`。这些**有意先不接**：桌面级动作需要另一套目标裁决（没有窗口身份可查），录制/回放要单独设计隐私边界，`invoke_menu`/`zoom` 等留作下一票的增量。
- **`perform_secondary_action` 的处理**：插件把 `Invoke`/`SetValue`/`Scroll` 路由到 click/set_value/scroll，并明确拒绝 `Select`/`Toggle`/`Expand`/`Collapse`/`ScrollIntoView`/`SetFocus`（「Select 绝不会被当成 Invoke」）。我们同样只提供三条正路，拒绝项写进描述与技能 —— 不给模型一个「看起来能做但语义不明」的入口。
- **预检的边界（如实记录）**：脚本文件里的键鼠（`cscript click.vbs`）、已编译二进制、直接 syscall 拦不住；`-EncodedCommand` 被拦是因为**看不清**，不是因为解析出了键鼠。其余三个智能体（codex/opencode/pi）尚未接同一道预检：codex 的入口在 `codexAppServerApprovals` 的命令审批、opencode 在 `opencodePermissions` 的 bash 权限记录、pi 没有工具级钩子（要走扩展）—— 列为下一票。
- **未接的插件机制**：Office 知识技能（`office-desktop.md` 93 行 + `office-workflows.md` 72 行：Excel/Word/WPS 的按键与验收纪律）——纯知识，价值高但体积大，建议单独一票；插件的区域裁剪（`image-region.js`）我们用驱动的 `zoom` 对应（未接）；插件的 `snapshot_id:index` 服务端记账我们靠驱动透传 `snapshotId` + 技能纪律（未做服务端校验）。
