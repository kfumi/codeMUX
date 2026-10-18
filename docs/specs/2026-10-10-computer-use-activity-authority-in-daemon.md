# 电脑控制活动权威与急停上移到 Daemon

**Status:** ready-for-agent

## Problem Statement

今天「这台电脑此刻正在被驱动」（提示条 + 全局 Esc）与「急停时打断回合」都由**渲染层**决定。`src/hooks/useEmergencyStop.ts` 算武装窗口，壳只负责注册热键；Esc 触发后壳通知渲染层，由渲染层逐个 `interrupt` 在跑的会话。这套链条有三种运行形态拿不到：

1. **没有渲染层的客户端**：`useEmergencyStop` 在 `desktopBridge` 缺失时直接返回 —— PC 浏览器、手机浏览器、CLI 都不武装。
2. **无人值守的回合**：定时任务与工作任务会在没人开界面时启动回合，且拿到的工具面与来源无关（`crates/daemon/src/scheduled_tasks/runner.rs`、`work_tasks/execution.rs`、`builtin_mcp.rs`）。这种回合照样会调 `computer_*`，但没有任何界面会显示提示条，也没有 Esc。
3. **没被订阅的会话**：渲染层的 `isRunning` / `turns` 只覆盖被订阅或加载过的会话（`src/stores/agentStore.ts`），它没有「这台机器上谁在跑」的全局视图。

后果：未开壳时机器被驱动而用户看不到任何提示、也按不到急停；渲染进程死了或从未加载时，屏幕上的提示条只能靠工单 18 的壳侧看门狗**收起来**，Esc 按下去只能杀驱动、停不了回合（`apps/desktop/src/emergency-stop.ts` 的回合那一半依赖渲染层回话）。

而 daemon 侧其实全都知道：`mark_turn_active` 由运行时事件驱动（`companion/events.rs`、`companion/actions.rs`），**每一个**桌面动作都经 `/api/computer-use/execute`（`builtin_mcp.rs` 转发），审批、限时授权与步数预算都在 daemon。缺的只是「把这件事说出来」与「由 daemon 执行急停里回合那一半」。

已就位的地基（本 spec 只是接上去）：

- `POST /api/computer-use/driver/estop` 已经同时**杀驱动 + `ControlSessions::revoke_all()`**（`computer_use/routes.rs::estop_driver`）。
- `POST /api/sessions/{id}/interrupt` 已经能停一个会话的回合（`companion/actions.rs::interrupt_companion_session`）。
- 控制面 WS lane（空 `sessionId`）已有 `ui-event` 信封与壳侧解析入口（`apps/desktop/src/desktop-events.ts`、daemon 的 `UiEventSink`）。

## Solution

把「正在驱动」与「急停」的权威搬到 daemon：daemon 自己算活动状态并经控制面 lane 广播聚合事件；壳把事件映射为「武装全局 Esc + 显示提示条」；Esc 触发一次 daemon 急停（杀驱动 + 收回限时授权 + 打断所有有桌面活动的回合）。渲染层那条路径在并存一个 release 后删除。

## 设计

### 1. 活动判据搬到 daemon（`computer_use/activity.rs`）

口径与工单 15 一致，不引入新语义：**本回合出现过 `computer_*` 调用**即认为在驱动（结果是否回来都算），挂着电脑控制审批也算；`browser_*` 不算（那是内置浏览器里的网页操作，不驱动桌面）。

- **设置点**：`/api/computer-use/execute` 进入闸门处（与工单 19 的受众检查同一层，见 `computer_use/approval.rs::gate`）—— 这是所有桌面动作的唯一咽喉。
- **清除点**：回合结束（`finish_turn` / 运行时 turn 结束事件）、回合代次前移（`mark_turn_active` 自增即新一轮）、agent 进程退出、会话被用户打断。
- **对账**：daemon 启动时与中断对账同一纪律（`work_tasks::execution::reconcile_interrupted` 的先例）清空所有活动标记 —— 进程重启后不存在「上一轮还挂着」的活动。
- **不自造 TTL**：不按「多久没有新动作」自动清除（那会把模型在两次动作之间的长思考误判成结束，正是工单 15 否决过的口径）；陈旧残留由上面四条显式信号 + 进程退出对账负责。

### 2. 聚合事件（新协议面）

`computer-use-activity`，走既有 `ui-event` 信封 + 空 `sessionId` 的控制面 lane：

```json
{ "active": true,
  "sessions": [ { "sessionId": "…", "since": "…", "steps": 3, "awaitingApproval": false } ] }
```

- **只在状态变化时发**（沿用 `serve_session_socket` 里 running 标志的纪律：别每个事件都发一帧）。
- **后连上的控制面客户端先收一份当前快照**（沿用会话 `state` 帧先例），否则壳启动晚于活动开始时会漏掉整段。
- 单机只有一个聚合状态（提示条本来就只有一条），`sessions` 是明细而非多路 UI。

### 3. 急停动作上移（回合那一半）

新增 `POST /api/computer-use/estop`：杀驱动 + `ControlSessions::revoke_all()` + **打断所有「有桌面活动」的会话**（复用 `interrupt_companion_session`），返回被打断的会话 id 列表并写审计。壳的 Esc 触发点从「通知渲染层」改为这一次调用（`apps/desktop/src/emergency-stop.ts` 的注入面）。

### 4. 壳变成显示与输入适配器

`apps/desktop/src/desktop-events.ts` 收到事件 → 武装/解除全局 Esc + 提示条显隐（不再等渲染层的武装同步）。工单 18 的壳侧看门狗已随工单 04 整体退役：武装只剩 daemon 一个来源后，活性判据就是**控制面链路本身**（Ping/Pong 保活）—— 链路断了就 fail-hidden（收起提示条 + 解除 Esc）。

### 5. 迁移与被删掉的东西

- 并存期已随发布版结束（工单 04）：daemon 权威版（工单 03/05）随 v0.4.9 发布后，删掉渲染层那条路径 —— `useEmergencyStop` 的武装窗口与心跳定时器、`codemux:emergencyStopArmed` / `codemux:emergencyStopHeartbeat` 通道、心跳看门狗（`armed-heartbeat.ts`）全部退役。
- `computerUseActivity.ts` 的工具名判定经核对**没有其他用途**（只有武装窗口用它；`builtinMcp.ts` 的 server 名识别另有消费者，保留），因此与它的测试一并删除。

## 验收

- **A｜无人值守**：无任何客户端时，定时任务回合里的 `computer_click` 仍产生活动事件；控制面客户端在后连上时先收到当前快照。
- **B｜无人值守时的急停**：不加载渲染层，按 Esc → 驱动被杀、回合被中断、限时授权被收回（审计日志 + 回合状态可查）。
- **C｜渲染层崩溃后急停仍生效**：杀渲染进程，提示条按工单 18 的 fail-hidden 处理，Esc 依旧完成 B 的三件事（今天只能做到「杀驱动」）。
- **D｜无回归**：`browser_*` 不算桌面活动；审批等待算活动；审批粒度、限时授权、步数上限口径不变；浏览器/手机客户端不出现新的常驻 UI（提示条是壳专属）。
- **E｜删除后仍通过**：删掉渲染层武装路径与心跳通道后，A–D 全部仍然成立（并存期结束的验收点）。**已达成（工单 04）**：无人值守的可见可停、fail-hidden 与「一次 Esc 停三件事」都由 daemon 侧承担，壳只做显示与输入适配。
- **F｜旧版本兼容**：旧 daemon（不发新事件、没有 `/api/computer-use/estop`）由壳的 404 兜底覆盖（退回 `driver/estop` + 通知渲染层打断回合）；旧渲染层（还带武装通道）在新壳上调用已删通道只会拿到「通道不存在」并记一条日志，提示条与 Esc 仍由 daemon 活动驱动，不会出现假的武装承诺。**这两种组合没有实测**（构造性推理 + 单元覆盖）。

## 不做的事

- 不给浏览器/手机客户端加急停键：全局热键是桌面壳的能力，本 spec 不改客户端的键位语义。
- 不把提示条搬进 daemon：显示留在壳（只有本机壳能画一条置顶常驻条），daemon 只提供状态与动作。

> **后续修正（ADR 0019）：** 「不改审批口径」与「不自造 TTL / 不照搬 ZCode 30s 隐藏」两条已被 ADR 0019 取代 —— 新增可选的审批口径（`strict`/`session`/`always`，默认不变），并给活动加 30s 空闲回收（等放行期间不算空闲）。本文其余结论（权威在 daemon、壳是显示与输入适配器、fail-hidden）不变。

## 风险与开放问题

- **两个来源的并存期**是本改动最大的风险（提示条抖动 / Esc 被两个来源抢）。缓解：一个 release 的并存 + 「只能加不能减」的优先级，并在并存期结束后删除渲染层路径（本 spec 的 E 是硬验收点）。**该风险已解除**：daemon 权威版随 v0.4.9 发布后，删除动作落地（见工单 04）—— 武装只剩一个来源，不存在两个来源互相抢的状态。
- **活动标记陈旧的残留风险**：如果运行时在回合结束前崩掉且没有对账，提示条会一直挂着。缓解：进程退出对账 —— **已由工单 05 落地**（事件流关闭且回合还挂着时按终态收口：清回合真值 + 清活动 + 广播 `state: running=false`，两道守卫见那张票）；回合代次只在 daemon 内部用于剪除陈旧标记，**`turnEpoch` 没有进事件载荷**（壳今天也不需要：`active=false` 是唯一需要的信号），要暴露再单开一张票。**「活动超过 N 分钟且无任何新动作就降级提示」已定并落地（ADR 0019）**：30s 空闲即回收（判据是「最后一次驱动动作的时刻」，等放行期间不算空闲）。
- **后台任务会真的占用全局 Esc**：这是本设计的目的（机器在被人驱动就该能停），但它是一个用户可感知的行为变化，要在 CHANGELOG 与电脑控制指南里说清。
- 开放问题（仍未定，产品取舍）：多会话同时驱动时提示条文案是否要显示会话数。另一条**已定并落地**：daemon 不可达时提示条**消失**（fail-hidden，与工单 18 一致）而不是显示降级提示 —— 一个按下去停不了东西的提示不能挂（工单 03 实现、工单 04 收敛成唯一来源）。
