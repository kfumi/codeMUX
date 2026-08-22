# 11 — SDK 硬切删除与配置清理

**What to build:** 合并前删除全部 Codex SDK 路径：`@openai/codex-sdk` 加载链、SDK runtime 主模块、SDK 专用 turn 归一化、`sdk_mode` 配置与设置 UI、`codexCollaborationPolicy` 事后 block 逻辑。Codex Agent Kind 仅余 app-server transport。无用户可见 SDK/app-server 回退开关。

**Blocked by:** 04 — Native Session resume 与 rebuild 降级; 05 — Codex 工具级 Interactive Request 审批; 06 — Workflow Mode 四档; 07 — Plan Mode 与 Plan Approval 闭环; 08 — 手动上下文压缩; 09 — 第三方上游 compat 代理重接; 10 — Fork 并入长连接 app-server

**Status:** ready-for-agent

- [ ] 移除 `@openai/codex-sdk` 依赖与 sidecar SDK loader 的 Codex 分支
- [ ] 移除 SDK runtime 模块及仅 SDK 使用的测试/fixtures
- [ ] 移除 `sdk_mode`（responses/agent）配置项与相关 UI/API
- [ ] 移除 `codexCollaborationPolicy` 事后 block 与 plan 强制走 proxy 逻辑
- [ ] sidecar dispatcher 中 Codex 仅路由至 app-server runtime
- [ ] 全量相关 vitest 通过；无残留 SDK import
- [ ] README / 文档中 Codex 集成描述更新为 app-server
