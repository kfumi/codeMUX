# 12 — Mobile Companion Codex 全量对齐

**What to build:** Mobile Companion 首版与桌面 Codex 能力对齐：四档 Workflow Mode selector、Plan toggle、全部 Interactive Request 响应（工具审批、问答、Plan Implement/Dismiss）。任一端响应后另一端 UI 自动同步，符合 ADR 0008。

**Blocked by:** 05 — Codex 工具级 Interactive Request 审批; 06 — Workflow Mode 四档; 07 — Plan Mode 与 Plan Approval 闭环; 11 — SDK 硬切删除与配置清理

**Status:** ready-for-agent

- [x] MobileComposer 支持 Codex 四档 Workflow Mode（替换旧两档 plan/full_access）
- [x] MobileComposer 支持 Plan Mode toggle
- [x] 移动端可响应 Codex 工具审批与 AskUserQuestion
- [x] 移动端可 Implement / Dismiss Plan Approval
- [x] 桌面响应后移动端挂起 UI 清除（及反向）
- [x] `src-mobile` vitest 覆盖权限选择与 Plan 审批路径

**实现说明（机制偏离）：** 跨端同步经 runtime 广播的 `permission_resolved` 事件实现（携带 `request_id` / `request_kind`）；桌面 `agentStore` 与移动端 `eventToMessages` 均消费该事件清除对应挂起的 permission / question 卡片。桌面 `PermissionApprovalCard`、移动端 `ChatView` / `eventToMessages` 的 plan-approval 判定统一收敛到共享谓词 `isPlanApprovalPermission`（识别 `plan_approval` / `ExitPlanMode` permission_type 与 `plan-approval` presentation）。
