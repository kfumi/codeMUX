# 13 — Compat 代理职责收窄

**What to build:** Compat 代理仅保留 Responses↔Chat 协议翻译职责；移除 plan block、interactive tool 拦截、plan 强制走 proxy 等与 app-server 重复的 enforcement 逻辑。第三方上游仍通过 compat 代理工作（ADR 0010 Decision 6）。

**Blocked by:** 07 — Plan Mode 与 Plan Approval 闭环; 09 — 第三方上游 compat 代理重接; 11 — SDK 硬切删除与配置清理

**Status:** ready-for-agent

- [ ] compat 代理内 plan mode block 逻辑移除
- [ ] compat 代理内 interactive tool / request_user_input 侧car 拦截移除（已由 app-server approval 接管）
- [ ] 协议转换、健康检查、shutdown 核心路径保留且测试通过
- [ ] 至少一个 `codex_needs_proxy: true` 供应商 regression 测试仍绿
- [ ] 无功能回退：第三方 Codex turn + 审批 + Plan 在 slimdown 后仍可用
