# 09 — 第三方上游 compat 代理重接

**What to build:** 对 `codex_needs_proxy: true` 的 Model Provider，sidecar 启动现有 compat 代理，app-server `turn/start` 的 `model_providers.base_url` 指向本地代理地址；协议翻译仍由 compat 代理承担。官方 OpenAI 继续直连。至少一个内置第三方供应商路径可端到端验证。

**Blocked by:** 03 — 官方上游基础 Codex turn

**Status:** ready-for-agent

- [x] `codex_needs_proxy: true` 时 proxyManager 启动 compat 代理
- [x] app-server provider 配置 base_url 指向本地 proxy listening URL（非真实 upstream 直连）
- [x] 切换 Model Provider / API 配置时 proxy 与 app-server 配置同步重配
- [x] 官方 OpenAI（`codex_needs_proxy: false`）不启动 compat 代理
- [x] 集成测或分层 E2E 覆盖至少一个内置 `codex_needs_proxy: true` 模板
- [x] compat 代理不可用时 emit 可读错误
