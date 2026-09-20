# 方案：新增 `openai_responses` 协议端点，Codex 直连 Responses 接口

## 背景

智谱 `/api/v1` 是 Responses 专用端点（`/responses` 200，`/chat/completions` 全 403），而 OpenCode 只会说 chat completions。当前一个 `openai_compatible` 端点槽位被迫同时服务 Codex（要 responses）和 OpenCode（要 chat），导致 403。方案：协议拆槽位 —— Codex 优先直连新配置的 `openai_responses` 端点；没配的供应商一切照旧（兼容代理仍是 chat-only 网关的兜底）。

## 1. Rust — 协议与端点选择

**`src-tauri/src/model_providers/types.rs`**
- `Protocol` 枚举加变体 `OpenaiResponses`（serde 自动序列化为 `"openai_responses"`；旧配置照常反序列化，无需迁移）。`as_str()` 补新分支。
- 新增 `pub fn select_agent_endpoint(provider, agent_kind) -> Option<&ProtocolEndpoint>`：
  - `ClaudeCode` → anthropic（现行为）
  - `Opencode` → openai_compatible（现行为）
  - `Codex` → **优先** openai_responses 端点，没有则回退 openai_compatible（现行为）
- `is_provider_usable` 改用 `select_agent_endpoint`（Codex 在只有 responses 端点时也可用）。保留 `required_protocol` 供其余调用点使用。
- 补内联测试：`select_agent_endpoint` 的 Codex 优先/回退、新协议序列化字符串、Codex 仅配 responses 端点时 usable。

**`src-tauri/src/agent/session_lifecycle.rs`**（`resolve_active_runtime_config`）
- 端点选择改调 `select_agent_endpoint`。
- 选中 `openai_responses` 端点时，`codex_needs_proxy` **强制写 `Some(false)`**（忽略端点上的标志）——防止 sidecar 在 flag 为 None 时走"非 openai.com 就代理"的启发式把原生 responses 上游错包进代理；responses 端点语义上就是直连。
- 错误提示 match（187-190 行）补 `Protocol::OpenaiResponses` 分支。
- 测试（沿用现有 `mod tests` 风格，1849-2063 行附近）：Codex 会话解析到 responses 端点的 base_url 且 `codex_needs_proxy == Some(false)`；OpenCode 会话仍解析 openai_compatible；两者共存互不影响。

**`src-tauri/src/model_providers/builtins.rs`**
- `zhipu` 模板加第二个端点：`(Protocol::OpenaiResponses, "https://open.bigmodel.cn/api/v1", Some(false))`。`instantiate_template` 对 `OpenaiResponses` 端点默认盖 `codex_needs_proxy: Some(false)`。
- 测试：zhipu 模板含 responses 端点。
- 注意：模板更新不回灌已存在的供应商（现状即如此），已有用户需在 UI 里手动补配。

**其余 Rust 触点（只求不破坏，不扩功能）**
- `companion/config.rs` `sanitize_provider`：`as_str()` 自动带出新协议字符串，无需改；`provider_supports_agent`（test-only）与 `required_protocol` 保持一致即可。
- `commands/git.rs` 的 git-commit 端点选择按名字取 anthropic/openai，不动（chat completions 仍可用）。

## 2. 前端（src/）

**`src/types/provider.ts:58`** — `Protocol` 联合类型加 `'openai_responses'`。

**`src/lib/modelProviders.ts`**
- 加 `codexEndpoint(provider)`：优先 openai_responses，回退 openai_compatible（与 Rust `select_agent_endpoint` 对齐）。
- `isProviderUsable` / `providerUnusableReason`：Codex 按上述选择判断；错误文案区分"缺少 OpenAI Responses 端点"与"缺少 OpenAI 兼容端点"。
- `requiredProtocol` 保留（opencode/claude 仍用），Codex 判断走 `codexEndpoint`。

**`src/stores/settingsStore.ts` `getNeedsProxy`（267 行）** — 活跃供应商存在 openai_responses 端点时直接返回 false（Codex 直连，状态栏代理指示不再误亮）。

**`src/components/settings/ProviderConfig.tsx`** — API 地址区加第三个输入框：
- label `OpenAI Responses`，hint：`Codex 直连 Responses 接口（如智谱 /api/v1）；配置后 Codex 不再使用兼容代理`，样式沿用现有 label/hint 约定（`text-ui-meta`/语义 token）。
- `responsesUrl` 派生值 + `ensureEndpoint(endpoints, 'openai_responses', …)`，新建时 `codex_needs_proxy: false`。
- "Codex 需要兼容代理"开关保留，hint 补充"仅对 OpenAI 兼容端点生效；已配置 Responses 端点时 Codex 优先直连"。
- `resolveFetchBaseUrl`（测连接/拉模型列表）：保持优先 openai_compatible，缺失时回退 openai_responses。

**`src/components/settings/AddProviderDialog.tsx`** — `buildCustomProvider` 加可选第三个 URL 输入（`openai_responses`），校验仍是"至少一个端点"。

**移动端 `src-mobile/src/lib/api.ts` `providerSupportsAgent`（584-586 行）** — Codex 改为 `protocols` 含 `'openai_responses'` 或 `'openai_compatible'` 均算支持。改后跑 `npx vitest run`（src-mobile/）+ `npm run build:mobile`。

## 3. sidecar

不改。`codexNeedsProxy=false` 时 `resolveUpstreamRouting` 直拨上游、`wire_api=responses` 已硬编码，正好匹配原生 responses 端点。会话指纹含 baseUrl，切换供应商会正确重建连接。

## 4. 测试与验证

- 前端单测更新：`modelProviders.test.ts`（Codex 选择/回退/文案）、`settingsStore.test.ts`（getNeedsProxy）、`ProviderConfig.test.tsx` 与 `AddProviderDialog.test.tsx`（新输入框渲染与保存、端点被空 URL 过滤）。
- Rust：`cargo fmt --check`、`cargo clippy --all-targets --all-features -- -D warnings`、`cargo check`；新增测试见上。
- 全量门禁：根目录 + sidecar `npx vitest run`。
- 手动验证（用现有智谱配置）：供应商里把 `openai_compatible` 填 `https://open.bigmodel.cn/api/coding/paas/v4`、`openai_responses` 填 `https://open.bigmodel.cn/api/v1`；发起 OpenCode 会话（应走 chat completions 成功）和 Codex 会话（应直连 responses、日志无代理启动行），复测原 `ses_fad6c7232ffeBlRQtt7vD10Qc1` 场景不再报 `No permission to access model`。

## 5. 提交

Conventional Commits，建议拆两个：`feat(model-providers): add openai_responses endpoint protocol with Codex direct routing` 与 `feat(ui): configure OpenAI Responses endpoint in provider settings`（或合一个，视 diff 大小）。