# CodeMUX 自维护 Model Provider，运行时注入 SDK

供应商配置以 CodeMUX 自有的 Model Provider 为唯一真相源，与智能体种类解耦；对话时将凭据与端点经运行时参数注入 SDK。不再通过读写智能体原生配置文件（如 Claude settings、Codex `config.toml`）来切换供应商。按智能体分档的 AgentProviderProfile 退役。

## Status

accepted

## Context

曾用 AgentProviderProfile 按 `claude_code` / `codex` / `opencode` 分档，激活时写入各智能体原生配置。这使「连哪家模型服务」与「智能体本地配置」耦合，切换供应商会改动用户本机 CLI 配置，也难以用同一家供应商（如 DeepSeek）同时服务 Claude Code 与 Codex——因为许多厂商对 Anthropic 与 OpenAI 兼容协议提供不同入口。

## Decision

1. **Model Provider** 是供应商配置主对象：共享 API Key、一份模型目录（含默认模型）、启用状态；与智能体种类无关。
2. 一家供应商可挂多个 **Protocol Endpoint**。第一版协议仅为 `anthropic` 与 `openai_compatible`；连接附属项（如 `codex_needs_proxy`）挂在端点上。端点可可选覆盖凭据。
3. **Active Provider** 为应用级新建会话默认；切换智能体不自动更换供应商。会话可另行选定供应商与模型；发送时以会话选定为准，将匹配协议端点的 URL、key 等注入 SDK。
4. **硬切断原生配置**：供应商 CRUD、激活与对话路径不读写智能体原生配置文件。空 API Key 表示未配置，不隐式回落 CLI 登录。
5. **AgentProviderProfile 退役**。智能体专属项（权限、超时、可执行文件模式等）留在 `agent_configs`。升级时不做自动迁移，旧 registry 丢弃，用户按内置模板重配。
6. 缺匹配协议端点、凭据未配置或供应商禁用时：配置仍可见，但对该智能体/会话不可用，发送前拦截；不静默改选其他供应商。
7. 第一版内置模板：Anthropic 官方、OpenAI 官方、DeepSeek、OpenRouter、硅基流动、智谱、OpenCode Go（Model Provider 模板，≠ 智能体 OpenCode），外加自定义供应商。

## Considered Options

- **继续按智能体分档并写入原生配置**——弃用：与 CLI 配置互相踩踏，无法自然表达「一家供应商、多协议入口」。
- **一个供应商只绑一个 URL/协议**——弃用：切到 Codex 后 DeepSeek 等双协议厂商不可用，违背「换智能体仍用同一家」的心智。
- **拆成 DeepSeek (Anthropic) / DeepSeek (OpenAI) 两个供应商**——弃用：用户维护两份配置，激活语义分裂。
- **空 key 表示使用 CLI 认证**——弃用：魔法语义不清晰，且与硬切断原生配置冲突。
- **从旧 profile 自动迁移**——拒绝：实现与边界成本高；接受用户按内置模板重配。
- **按智能体分别记 active provider**——弃用：容易退回「每智能体一套供应商」；与全局 Active Provider + 会话覆盖冲突。

## Consequences

- 设置 UI 以「模型服务 / 供应商」为中心（列表 + 端点 + 模型），不再以智能体配置档为中心。
- Sidecar/SDK 启动路径必须接受显式 `apiKey` / `baseUrl`（及端点附属项），不能依赖事先写好的原生配置文件。
- 删除 default-supplier「恢复原生配置备份」一类入口；本机 CLI 配置与 CodeMUX 互不干扰。
- 现有 `agent_profile_registry` 用户升级后需重新填写供应商；`CONTEXT.md` 中 Model Provider 相关术语为领域用语。
