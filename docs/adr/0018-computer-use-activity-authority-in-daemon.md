# ADR 0018: Computer Use Activity and Emergency Stop Authority in the Daemon

## Status

Accepted

## Context

「这台电脑此刻正在被驱动」这个判断今天由渲染层算出（`src/hooks/useEmergencyStop.ts`）：壳只注册全局 Esc，Esc 触发后通知渲染层，由渲染层逐个 `interrupt` 在跑的会话。工单 18 只在壳侧补了一层看门狗，让提示条在渲染层失联时**自己收起来** —— 那是「别撒谎」，不是「改判据」。

这条链在三种形态下不成立：没有渲染层的客户端（PC / 手机浏览器、CLI，`desktopBridge` 缺失即返回）；无人值守的回合（定时任务、工作任务，工具面与来源无关）；没被订阅的会话（渲染层没有全局「谁在跑」视图）。后果是机器可能在没有任何提示、也没有任何急停入口的情况下被驱动。

daemon 侧具备全部原材料：`mark_turn_active` 由运行时事件驱动（`companion/events.rs`、`companion/actions.rs`）；每个桌面动作都经 `/api/computer-use/execute`（`builtin_mcp.rs` 转发）；审批、限时授权与步数预算都在 daemon；`POST /api/computer-use/driver/estop` 已经同时杀驱动并 `ControlSessions::revoke_all()`；`POST /api/sessions/{id}/interrupt` 已经能停一个回合；控制面 lane（空 `sessionId`）已有 `ui-event` 信封。这与 ADR 0011 的方向一致：daemon 为权威，壳很薄。

## Decision

1. **活动判据在 daemon**：以「本回合出现过 `computer_*` 调用（含等审批）」为口径（沿用工单 15），在 `/api/computer-use/execute` 咽喉处标记，由回合结束 / 代次前移 / 进程退出 / 会话被打断清除，进程重启时对账清空。
2. **活动状态经控制面 lane 广播**：新 `ui-event` 名为 `computer-use-activity`（空 `sessionId` 的既有信封），只在状态变化时发，后连上的控制面客户端先收一份当前快照。单机一个聚合状态，明细带会话列表。
3. **急停由 daemon 执行**：新增 `POST /api/computer-use/estop` = 杀驱动 + 收回限时授权 + 打断所有有桌面活动的回合（复用 `interrupt_companion_session`），写审计并返回被打断的会话。壳的 Esc 只做这一次调用，不再依赖渲染层回话。
4. **壳是显示与输入适配器**：控制面事件 → 武装/解除全局 Esc + 提示条显隐；工单 18 的看门狗从「渲染层心跳」改为「daemon 链路心跳」，链路断了 fail-hidden（收起提示条 + 解除 Esc）。
5. **一个 release 的并存期后删除渲染层路径**：并存期以 daemon 为权威，渲染层只能「加」不能「减」（不丢 Esc）；随后删除 `useEmergencyStop` 的武装路径与 `codemux:emergencyStopArmed` / `emergencyStopHeartbeat` 通道，禁止长期保留两个真来源。

## Consequences

- 无人值守（定时任务 / 工作任务）与无渲染层客户端下的驱动变成**可见且可急停**的 —— 后台任务会真的占用本机全局 Esc，这是刻意取舍，需要在 CHANGELOG 与电脑控制指南里写明。
- 提示条与 Esc 的失效模式从「渲染层活着」变为「daemon 链路活着」，与「daemon 才是权威」一致；daemon 不可达时按 fail-hidden 处理（与工单 18 的语义连续）。
- 新增一个控制面协议事件（向后兼容：旧壳忽略未知事件，旧 daemon 不发事件）。协议面变更的先决条件（spec + ADR）由此满足，实现按 spec 拆工单。
- 详细设计与验收见 `docs/specs/2026-10-10-computer-use-activity-authority-in-daemon.md`。
