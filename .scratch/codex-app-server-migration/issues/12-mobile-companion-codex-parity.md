# 12 — Mobile Companion Codex 全量对齐

**What to build:** Mobile Companion 首版与桌面 Codex 能力对齐：四档 Workflow Mode selector、Plan toggle、全部 Interactive Request 响应（工具审批、问答、Plan Implement/Dismiss）。任一端响应后另一端 UI 自动同步，符合 ADR 0008。

**Blocked by:** 05 — Codex 工具级 Interactive Request 审批; 06 — Workflow Mode 四档; 07 — Plan Mode 与 Plan Approval 闭环; 11 — SDK 硬切删除与配置清理

**Status:** ready-for-agent

- [ ] MobileComposer 支持 Codex 四档 Workflow Mode（替换旧两档 plan/full_access）
- [ ] MobileComposer 支持 Plan Mode toggle
- [ ] 移动端可响应 Codex 工具审批与 AskUserQuestion
- [ ] 移动端可 Implement / Dismiss Plan Approval
- [ ] 桌面响应后移动端挂起 UI 清除（及反向）
- [ ] `src-mobile` vitest 覆盖权限选择与 Plan 审批路径
