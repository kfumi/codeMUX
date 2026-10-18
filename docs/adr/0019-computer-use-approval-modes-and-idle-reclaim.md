# ADR 0019: Computer Use Approval Modes and Idle Activity Reclaim

## Status

Accepted

## Context

两个使用痛点，与 ZCode 的对照设计有关：

1. **审批摩擦过高。** CodeMUX 的闸门（`crates/daemon/src/computer_use/guard.rs`）对输入动作「一次一放行」，或给一次**限时授权**（`CONTROL_SESSION_TTL = 180s`，只在当前回合作数）。桌面任务动一次鼠标就是一步，逐次弹窗没人受得了；而限时授权随回合边界失效，长任务里要反复给。ZCode 的口径相反：权限窗批准一次即写入**项目级 allow 规则**，之后该项目内的电脑控制调用短路放行（`apps/zcode-cli/packages/core/src/permission/service.ts`）。
2. **提示条不会空闲收起。** 提示条与全局 Esc 由 daemon 的活动真值驱动（ADR 0018）。清除点只有「回合结束 / 代次前移 / 急停 / 进程退出」：一个回合里 CUA 调完之后模型继续做别的事，标记会一直挂着，提示条与 Esc 就一直在。ZCode 的 Windows 顶部浮窗有 30s 空闲兜底（`windowsCuaOperationIndicator.ts` 的 `AUTO_HIDE_MS`），每个 cell 上报刷新计时。

ADR 0018 与其配套 spec 明确写过「不自造 TTL」「不照搬 ZCode 的 30s 自动隐藏」（因为无法区分「两次动作之间的长思考」与「真的结束了」）。本 ADR 修正该结论：**用「最后一次驱动动作的时刻」而不是「回合是否在跑」来判空闲**，长思考与结束都表现为「一段时间没有新的驱动动作」，此时收起提示条是安全的 —— 它只是不再声称「此刻正在被驱动」，并没有结束回合或改动审批口径。

## Decision

1. **审批口径降摩擦（可在设置里选，默认不变）**。`ComputerUseConfig` 增加 `approval_mode: strict | session | always`（`#[serde(default)]` = `strict`）：
   - `strict`（默认）= `ADR 0018` 时期的口径：只读按会话记住，输入动作逐次确认或给限时授权；
   - `session` = 只读免问；非敏感输入「本会话记住」（首次问一次）；
   - `always` = 只读免问；非敏感输入持久放行（设置本身即用户同意，保存前再确认一次）。
   三条不变量在任何档位下不变：**敏感场景**（登录/支付/验证码/密码/删除/关闭防护）逐步确认、**受保护目标**硬拒、**步数上限**照常。这仍然是 **CodeMUX 闸门自己的口径**，不是智能体的权限档位 —— 输入动作在智能体任何权限模式下都不豁免（`decide_with_grant` 只收闸门口径）。
2. **活动空闲回收，30s，权威仍在 daemon**。`ActivityMark` 增加 `last_ms`（每次驱动动作 / 审批状态变化都刷新）；活动快照把「超过 `ACTIVITY_IDLE`(30s) 没有新动作」的标记视为不活动并回收。**等待放行期间不算空闲**（审批卡最长挂 120s，那是用户正在决定）。标记活动时预约一次 `now + ACTIVITY_IDLE` 的一次性发布（带代次守卫），到点若仍空闲就把 `active:false` 推给控制面 —— 提示条收起、全局 Esc 解除；下一次 CUA 动作重新点亮。
3. **不做全局定时器**。空闲回收用「标记时预约一次 + 代次作废」，不引入周期性 sweeper；发布仍遵守「只在状态变化时发帧」。

本 ADR **部分取代** `docs/specs/2026-10-10-computer-use-activity-authority-in-daemon.md` 中「不自造 TTL」与「不照搬 ZCode 的 30s 自动隐藏」两条结论，以及 ADR 0018 中未写入 TTL 的隐含前提；其余结论（权威在 daemon、壳是显示与输入适配器、fail-hidden）不变。

## Consequences

- 高频桌面任务的弹窗大幅减少：用户在 `session` / `always` 档下，非敏感输入不再逐步问；需要严格管控的用户保持默认 `strict`，行为与升级前一致。
- 提示条与全局 Esc 在「CUA 调完、回合仍在跑」时会在 30s 后自动收起，不再长期占用全局 Esc。代价：单个桌面动作若超过 30s 无任何新动作上报，提示条可能在动作执行中熄灭（当前每个 `execute` 入口都会 `mark`，动作之间通常远短于 30s）。
- 新增一个配置字段（向后兼容：旧 config 缺字段即 `strict`）与一个协议字段 `rememberScope`（向后兼容：旧壳忽略未知字段）。
- 详细行为见电脑控制指南；契约测试覆盖 `guard.rs`（mode × 风险 × 敏感矩阵）、`activity.rs`（`last_ms` / 空闲回收 / 等审批豁免）、`companion/state.rs`（空闲转 inactive + 只发布一次）与前端审批选项。
