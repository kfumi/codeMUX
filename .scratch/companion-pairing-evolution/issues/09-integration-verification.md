# 09 — 集成验证与 ADR 更新

**What to build:** 端到端验证四阶段能力，更新架构文档，确保 CONTEXT/ADR 与实现一致。

**Blocked by:** 02, 03, 04, 07, 08（全部前置工单）

**Status:** ready-for-agent

- [ ] Axum 路由集成测试：`pair/claim`、token 401/200、offer 端点（若有）。
- [ ] 全链路手动测试计划：LAN 扫码自动配对、粘贴链接、Relay 跨网（需 Relay）、Tailscale 直连、撤销 Token、关闭 Companion。
- [ ] 新增或修订 ADR：记录混合模型（Pairing Token + E2EE + Relay + 多传输）。
- [ ] 更新 CONTEXT.md：Mobile Companion out of scope 移除「公网中继」；补充 Connection Offer、desktopId、Relay 术语。
- [ ] `npm run build`（根 + src-mobile）、`npx vitest run`（相关包）、`cargo test` companion 相关用例通过。
