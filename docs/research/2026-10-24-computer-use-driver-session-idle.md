# 电脑控制后半程「失效」根因排查：cua-driver 隐式会话闲置超时与缺失的复活通路

**触发**：用户报告会话 `ses_e9410f57fffeBYmneEPvAmj9w1`（应用内 `be140efe-4585-450e-83e2-49382859e7d1`，opencode + deepseek）里，电脑控制前 40 分钟正常，中断一个半小时后继续，元素树与点击全部报 `this session has ended; call start_session explicitly to reuse its label`，只剩窗口列表与截图可用，agent 最终降级用 PowerShell + Win32 SendInput 硬操作 GUI。

## 结论

不是驱动崩溃，也不是权限问题。daemon 拉起 cua-driver 0.30.1（stdio MCP，`probe.rs` 自动探测）后**从不管理它的生命周期会话**：驱动的隐式传输会话（unnamed calls 惰性创建）有闲置上限，闲置 94 分钟后被结束（遥测 `end_reason=idle_timeout`），此后所有**会话态**工具（`get_window_state`/UIA 快照、elementIndex 寻址的动作）一律拒绝，而**无状态**工具（`list_windows`/`active_window`/截图）照常工作——表现即「半瘫」。驱动文档写明 *only `start_session` revives an ended name; ordinary actions never revive ended names*，而 codeMUX 既不调 `start_session`，也没把它暴露给 agent：报错文案指的路，工具面走不了。

修复（同日落地）：`desktop.rs` 新增 `call_driver` 包装——命中「会话已结束」回包时自动无参 `start_session` 复活（幂等）并原样重试一次，复活与重试不再过闸门（步数只记一次）；顺带接住 MCP `isError` 回包，审计不再把失败的观测记成 ok=1。

## 实机证据（2026-10-24，UTC；本地 +8）

`codemux.db` 的 `browser_automation_audit` + `session_event_snapshots`：

| 时间 | 事件 |
|---|---|
| 05:39–06:19 | 电脑控制正常，40 个输入步全部落地（审计 203–287 全 ok） |
| 06:19:22 | 第 41 步 `computer_click` 被拒「步数到顶」——codeMUX 回合步数护栏（`max_steps=40`），设计行为 |
| 06:19:56 | 回合结束（daemon 日志 `RESOLVE_TURN`），此后 **94 分钟无任何驱动调用** |
| 07:54:07 | 用户「你继续呗」开新回合（步数预算已重置） |
| 07:54:24 起 | 每次 `computer_elements` 报 `this session has ended`；`windows`/`active_window`/`screenshot` 正常 |
| 08:04 | `scroll` 报「windowId=23791422 不属于进程 37472」——agent 混用跨空档的旧窗口句柄，被 preflight 拦下（次生噪音，非缺陷） |
| 08:06–08:15 | agent 降级 PowerShell + SendInput（thinking 原文："The codemux-control session is broken…use PowerShell + Win32 SendInput"），一度输入发错窗口 |

驱动侧直接取证：与 `cua-driver 0.30.1` 做只读 stdio 握手 + `tools/list`，`start_session` 的自述为 *"Optionally create or return a lifecycle session… Use it to…revive a public name after it has ended; ordinary actions never revive ended names"*；二进制遥测枚举含 `end_reason: explicit | idle_timeout | process_exit` 与 `max_idle_ttl_seconds` 配置键（默认值不可见，实测 < 94 分钟）。`get_session` 在新传输上回 `code=session_not_started`，证实隐式会话由动作惰性创建。

## 根因分层

1. **无会话生命周期管理**（主因）：`translate()` 发出的驱动调用从不带 session 参数，daemon 不调 `start_session`，`builtin_mcp` 工具面也没有对应工具。
2. **`call_tool` 不看 MCP `isError`**（`driver.rs`）：驱动的工具失败装在 `Ok(payload)` 的 isError 回包里，daemon 拿不到机器可读的 `session_ended`，自愈钩子点不存在。副作用：`read_elements` 无条件记审计 ok=1，**审计表对观测工具失真**（07:54 后失败的 `elements` 全记 ok=1）。
3. **`ensure_ready` 只看进程活性**：驱动进程一直活着（窗口列表照常），daemon 以为一切正常。现成的 `estop` → 重拉进程通路（新进程 = 新隐式会话）无人触发。
4. **放大器**：回合步数护栏顶到即强制停手（设计行为），停手制造的空档与驱动闲置上限叠加——长 GUI 任务必然撞上。`max_steps=40`/回合对部署型任务偏紧，是正交的产品问题（未在本次处理）。

## 安全面备注

护栏体系（审批、步数、敏感控件拒读）在工具面残废时反而把 agent 推出护栏：SendInput 直接打键鼠，所有防线失效，还打错过窗口。与 `docs/research/` 中浏览器自举缺陷（无 `browser_open`/`navigate` + 排除自家窗口 = 死锁 → agent 逆向宿主）同族：**工具面缺原语，agent 就出轨**。给 agent 的工具面补齐生命周期原语（或让 daemon 全权自愈）是对这类跑偏的结构性防御。

## 修复内容

`crates/daemon/src/computer_use/desktop.rs`：

- `session_ended()`：判据 `structuredContent.code == session_ended` 优先，0.30.1 实测错误文本兜底，两道都以 isError 为前提（纯函数，单测覆盖）。
- `driver_error_text()`：提取 isError 回包首段说明文本。
- `call_driver()`：四个会话态调用点（execute 动作、paste 第二步、read_elements、wait 轮询）改走它；命中即无参 `start_session` + 原样重试一次；自愈落一笔审计 `op=desktop-revive-session`（tool 列记触发它的驱动工具名）。
- 审计修复：`finish_call` 成功分支、`read_elements`、`read_apps` 按 isError 记 ok=0 与原因文本。

`crates/daemon/src/computer_use/driver.rs`：`DriverStub` 增 `respond_seq`（同名调用顺序回包），支撑「先失败、复活后成功」的契约测试 `tests/computer_use_desktop.rs::a_dead_driver_session_is_revived_and_the_call_retried_once`（另有一条「别的驱动错误不触发自愈」的反向用例）。

## 遗留

- 驱动闲置 TTL 的确切默认值未测出（需要真实空转等待）；判据不依赖具体时长。
- `max_steps` 与闲置上限的交互（调高默认 / 任务级 override）待产品决策。
- 复活后旧的 snapshotId/elementIndex 仍会失效——重试的新 `get_window_state` 自带新快照回执，模型按回执走即可，无需额外处理。
