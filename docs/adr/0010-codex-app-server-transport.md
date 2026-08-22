# 0010 — Codex 完全迁移至 App Server

CodeMUX 删除 `@openai/codex-sdk`，Codex 的全部 turn 控制改经 `codex app-server` 子进程（stdio JSON-RPC）。托管 Runtime 安装 `@openai/codex` CLI 而非 SDK。每个 Codex Native Session 持有一个长期存活的 app-server 进程。官方 OpenAI endpoint 直连；标记 `codex_needs_proxy` 的第三方供应商仍通过本地 compat 代理做 Responses↔Chat 协议翻译，app-server 的 `model_providers.base_url` 指向该代理。

## Status

accepted

## Context

Codex SDK 路径无法实现工具级 Interactive Request 审批、Plan Mode 闭环与可靠的手动 `/compact`。CodeMUX 已在 fork 场景使用过 app-server（`codexFork.ts`）。Paseo 项目提供了完整的 app-server 适配参考。2026-07 Plan 模式设计曾将 SDK 保留为 Non-Goal，现改为全面迁移。

## Decision

1. **硬切，无 feature flag。** 合并即删除 SDK 加载链、`codexRuntime.ts`、`sdk_mode` 配置；不做用户可见的 transport 回退。
2. **Runtime 包替换。** `@openai/codex-sdk` → `@openai/codex@<version>`，`key_binaries` 校验 `codex` / `codex.exe`。
3. **Session resume 尽力而为。** 优先 `thread/resume` 已有 `thr_*` mapping；失败则 mint 新 thread、替换 mapping，写 `system_event`（`native_session_rebuilt`）；CodeMUX Event 时间线不变。
4. **Plan Mode 正交于 Workflow Mode。** Workflow Mode 四档（read-only / auto / auto-review / full-access）写入 Permission Snapshot；Plan Mode 为独立 composer toggle，经 `collaborationMode` + turn 完成后 Plan Approval（Implement / Dismiss）+ 自动 implementation turn。
5. **首版能力范围。** 包含：turn、工具/问答/Plan 审批、`thread/compact/start`、fork（合并入主 runtime）、四档 Workflow、Plan toggle、Mobile Companion 全量对齐。不包含：`turn/steer`、`thread/inject_items`、`thread/rollback`、goals。
6. **Compat 代理长期保留（第三方）。** 官方 OpenAI 不经代理；`codex_needs_proxy: true` 的供应商仍启动 `proxyManager`，app-server 配置 `base_url = http://127.0.0.1:15722`。逐步退役 compat 内的 plan block / interactive 逻辑，仅保留协议转换。
7. **进程模型。** `ensure_session` spawn app-server，`delete_session` dispose；崩溃后按 Decision 3 恢复。

## Considered Options

- **保留 SDK + 逐步补 app-server 能力**——弃用：Plan/审批/compact 在 SDK 上无好解法，双轨维护成本高于一次性迁移。
- **删除 compat 代理，全部直连 model_providers**——弃用：第三方 Responses 网关兼容性未验通前会中断用户；官方路径仍值得去掉 proxy。
- **开发期 feature flag 灰度**——弃用：用户选择硬切；双倍维护与「激进重构」目标不一致。
- **每 turn 临时 spawn app-server**——拒绝：无法承载 server-initiated approval 与 steer；spawn 开销大。

## Consequences

- Sidecar 新增 ~3,000–5,000 行 app-server 适配（参考 Paseo `codex-app-server-agent.ts` + transport），删除 ~1,200 行 `codexRuntime.ts` 及 SDK 加载链；compat 代理 ~3,500 行保留但职责收窄。
- `codexCollaborationPolicy.ts` 的事后 block 逻辑删除，由 app-server `collaborationMode` 与 approval RPC 取代。
- `respond_to_permission` 必须新增 Codex handler；Mobile Companion 同步四档 Workflow 与 Plan toggle（ADR 0008 审批约束不变）。
- Agent Kind Switch 仍用 Switch Briefing 文本注入，首版不依赖 `thread/inject_items`（ADR 0007 不变）。
- 估算工作量 4–5 人月（单人）；硬切 PR 体积大，需 fake-app-server 单测 + 官方/第三方 upstream 分层 E2E。
