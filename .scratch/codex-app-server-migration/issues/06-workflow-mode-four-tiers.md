# 06 — Workflow Mode 四档

**What to build:** Codex Permission Snapshot 扩展为四档 Workflow Mode（read-only / auto / auto-review / full-access）。桌面 composer 可选择档位；选择结果映射到 `turn/start` 的 approvalPolicy、sandboxPolicy、approvalsReviewer。进行中的 turn 变更档位时下一 turn 生效并可有可读提示。

**Blocked by:** 03 — 官方上游基础 Codex turn

**Status:** ready-for-agent

- [ ] 桌面 AgentPermissionSelector（或等价）展示 Codex 四档 Workflow Mode，移除旧两档 plan/full_access 专属路径
- [ ] 四档映射符合 spec Implementation Decisions 表格（read-only / auto / auto-review / full-access）
- [ ] Workflow Mode 持久化在 Session Permission Snapshot；Agent Kind Switch 进入 Codex 时按 ADR 0007 重置
- [ ] `update_permissions` 在 turn 进行中返回「下一 turn 生效」语义（若 applicable）
- [ ] 单测或集成测验证至少两档 policy 差异传入 turn/start
