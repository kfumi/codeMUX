# 06 — Workflow Mode 四档

**What to build:** Codex Permission Snapshot 扩展为四档 Workflow Mode（read-only / auto / auto-review / full-access）。桌面 composer 可选择档位；选择结果映射到 `turn/start` 的 approvalPolicy、sandboxPolicy、approvalsReviewer。进行中的 turn 变更档位时下一 turn 生效并可有可读提示。

**Blocked by:** 03 — 官方上游基础 Codex turn

**Status:** ready-for-agent

- [x] 桌面 AgentPermissionSelector（或等价）展示 Codex 四档 Workflow Mode，移除旧两档 plan/full_access 专属路径
- [x] 四档映射符合 spec Implementation Decisions 表格（read-only / auto / auto-review / full-access）
- [x] Workflow Mode 持久化在 Session Permission Snapshot；Agent Kind Switch 进入 Codex 时按 ADR 0007 重置
- [x] `update_permissions` 在 turn 进行中返回「下一 turn 生效」语义（若 applicable）
- [x] 单测或集成测验证至少两档 policy 差异传入 turn/start

**实现说明（修订，2026-08-22）：** 对齐官方 ChatGPT Codex App 三档审批选择器——auto-review 档 `approvalsReviewer` 由 `auto_review` 改为官方 `guardian_subagent`（低风险由守护子代理自动放行、检测到风险才询问），默认档由 `full-access` 收紧为 `auto`，桌面选择器收敛为官方三档入口并采用官方文案（请求批准 / 帮我批准 / 完全访问），read-only 不再常驻、仅存量 read-only 会话保留退出口；计划模式入口移入 composer「+」菜单，开启后在权限下拉右侧显示激活 chip。枚举 id 与存量 permission snapshot 迁移映射不变；详见 ADR 0010 修订节与 spec.md 映射表修订注。移动端 `MobileComposer` / `CreateSessionSheet` 的档位列表暂未同步（仍为四项旧文案，后续跟进）。
