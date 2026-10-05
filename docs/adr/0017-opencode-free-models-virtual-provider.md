# OpenCode 免费模型以虚拟供应商进入选择器，发送走原生 opencode provider

opencode 智能体的模型选择列表在配置的供应商模型之外，默认追加 OpenCode Zen 免费模型；免费模型绑定一个不对应 ModelProvider 记录的虚拟供应商 `opencode-free`，发送链路由 daemon 专门识别后落到 opencode 原生 `opencode` provider。不动供应商管理（CRUD/模板/设置）。

## Status

accepted

## Context

- OpenCode Zen 目录（`https://opencode.ai/zen/v1/models`，公开无需鉴权）列出全部模型，免费模型以 `-free` 后缀或 `big-pickle` 等特殊 id 标记。daemon 已有 `GET /providers/opencode-free-models` 路由抓取并过滤（ADR 0005 落地时该链路从选择器默认路径摘除，前端消费端降级为 no-op）。
- 实测：从 CodeMUX 托管 Runtime 起的 opencode server，以原生 `opencode` provider（无 CodeMUX key 注入）发送 `big-pickle` 正常返回；Zen 免费层有「仅限 OpenCode 内使用」的客户端门禁（`FreeTierError`），直连 OpenAI 兼容端点会被拒，因此免费模型只对 opencode 智能体可用，且只有经 opencode 运行时发出的请求才能过门禁。
- sidecar 的 `buildOpenCodeServerConfig` 已有 `provider === 'opencode'` 分支：保留用户本机 opencode 原生配置、设 `model: opencode/<model>`、不注入 CodeMUX 凭据（`credentialSource: 'opencode'`）。

## Decision

1. 选择器数据仍以 ModelProvider 为唯一真相源；免费模型由 `useAgentModels` 在 `agentKind === 'opencode'` 时经既有 daemon 路由拉取，以虚拟供应商 `opencode-free` 的条目**追加**在所有供应商模型之后（失败静默降级，模块级短缓存去重）。
2. daemon `resolve_active_runtime_config` 识别 `provider_id == "opencode-free"` 且智能体为 opencode 时短路：产出 `provider: "opencode"`、`credential_source: "opencode"`、不注入 key/baseUrl 的运行时配置；不回退到 active provider。未选模型时明确报错。
3. 免费模型条目不提供 reasoning 档位选择（目录无声明，保守处理）。
4. 不为免费模型建立 ModelProvider 记录、不进设置 UI、不写供应商原生配置。

## Considered Options

- **内置供应商模板 + 一键填充免费模型**——弃用：需要动供应商管理与设置 UI，超出本次边界，且静态模型列表需要额外的刷新语义。
- **运行时经 SDK `provider.list()` 拉取**——弃用：必须起一个 opencode server（进程上百 MB、秒级冷启动）才可调用，且返回 models.dev 全量目录、无免费标记。
- **绕过供应商体系向选择器塞特批条目、发送时伪造成某供应商**——弃用：免费层门禁要求请求发自 opencode 运行时的原生 `opencode` provider，伪造 providerID 过不了门禁。

## Consequences

- 免费模型仅对 opencode 智能体可见/可用；其他智能体的选择器不含该分组。
- 未做过 `opencode auth login` 的机器能否使用免费层未验证；若 Zen 要求登录态，错误会作为轮次错误自然暴露，不阻塞本功能。
- Zen 免费目录动态变化；列表每次进入选择器时按短缓存刷新，daemon 侧 15s 超时。
- 会话的 `provider_id` 快照可能出现 `opencode-free`：消费 provider_id 找名字/能力的地方需按虚拟供应商兜底（AgentPanel 发送门禁与上下文窗口查询已兜底）。
