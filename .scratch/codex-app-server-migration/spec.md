# Codex 完全迁移至 App Server

**Status:** ready-for-agent

## Problem Statement

CodeMUX 当前通过 `@openai/codex-sdk` 驱动 Codex Agent Kind。该路径在以下方面无法达到与 Claude Code、OpenCode 同等的产品体验，且已接近 sidecar workaround 的上限：

1. **工具级 Interactive Request 审批缺失**：app-server 提供的 server-initiated approval RPC（命令执行、文件变更、用户问答）在 SDK 路径上无稳定事件；`respond_to_permission` 未覆盖 Codex，用户无法在 UI 中批准或拒绝具体工具操作。
2. **Plan Mode 无法闭环**：现有实现依赖 sidecar 注入指令与事后 block，而非 Codex 原生 `collaborationMode`；turn 完成后没有 Plan Approval（Implement / Dismiss），也无法自动进入 implementation turn。
3. **手动压缩不可靠**：`/compact` 作为文本 prompt 发给 SDK，缺少 Claude/OpenCode 式的原生 compact API；无 compaction timeline 与双通道完成去重。
4. **架构分裂**：fork 已临时 spawn app-server，主 turn 仍走 SDK，形成双轨维护；托管 Runtime 安装 SDK 包而非 CLI，完整性检查不校验 `codex` 二进制。
5. **未来能力阻塞**：`thread/inject_items`、`turn/steer` 等仅 app-server 暴露的能力无法在 SDK 路径落地。

用户要求激进重构：完全移除 SDK，统一使用 App Server，硬切发布，无 transport 回退开关。

## Solution

将 Codex Agent Kind 的全部 turn 控制迁移至 `codex app-server` 子进程（stdio JSON-RPC）。每个 Codex Native Session 在 `ensure_session` 时 spawn 一个长期存活的 app-server 进程，在 `delete_session` 时 dispose。托管 Runtime 改为安装 `@openai/codex` CLI 并校验 binary。

**上游路由：**
- 官方 OpenAI Protocol Endpoint：app-server 直连，不经 compat 代理。
- 标记需 compat 的第三方 Model Provider：sidecar 启动现有 compat 代理，`turn/start` 的 `model_providers.base_url` 指向本地代理地址；代理职责收窄为 Responses↔Chat 协议翻译，逐步退役其中的 plan block 与 interactive 逻辑。

**Permission Snapshot 模型（Codex）：**
- **Workflow Mode** 四档（read-only / auto / auto-review / full-access）写入 Permission Snapshot。
- **Plan Mode** 为与 Workflow Mode 正交的 composer toggle；开启时经 `collaborationMode` 运行，turn 完成后经 **Plan Approval** Interactive Request 等待 Implement 或 Dismiss，Implement 后自动开 implementation turn 并关闭 Plan Mode。

**Session 连续性：** 优先 `thread/resume` 已有 Native Session mapping；失败则 mint 新 thread、替换 mapping，emit System Event（`native_session_rebuilt`）；CodeMUX Event 时间线保持权威。

**Mobile Companion：** 首版全量对齐桌面——四档 Workflow、Plan toggle、全部 Interactive Request 类型（含 Plan Approval）。

合并即删除 SDK；不做用户可见 feature flag。详见 ADR 0010。

## User Stories

### 基础对话与 Runtime

1. As a Codex 用户，我希望发送 User Message 后 agent 正常流式回复，以便继续编码对话。
2. As a Codex 用户，我希望中断正在运行的 turn，以便在 agent 跑偏时及时停止。
3. As a Codex 用户，我希望 CodeMUX 托管 Runtime 自动安装正确版本的 Codex CLI，以便无需手动配置 PATH。
4. As a 系统维护者，我希望 Runtime 完整性检查包含 `codex` / `codex.exe` binary，以便 fork 与主 turn 不会因缺失 CLI 而 silent fail。
5. As a Codex 用户，我希望升级 CodeMUX 后现有 Session 的对话历史仍完整可见，以便不丢失工作上下文。
6. As a Codex 用户，我希望升级后已有 Codex Native Session 在可能时自动 resume，以便继续同一 thread 上的原生上下文。
7. As a Codex 用户，当 Native Session resume 失败时，我希望看到明确 System Event 说明 thread 已重建，以便理解为何 native id 变化而对话气泡未丢。
8. As a Codex 用户，我希望每个 Session 仅对应一个 app-server 进程，以便 approval 与 turn 状态一致。
9. As a Codex 用户，我希望关闭 Session 或退出应用时 app-server 子进程被正确清理，以便不泄漏后台进程。
10. As a Codex 用户，当 app-server 进程崩溃时，我希望看到可读错误并能在重试后恢复对话，以便不必重启整个应用。

### 上游与 Compat 代理

11. As a 使用 OpenAI 官方 Model Provider 的 Codex 用户，我希望请求直连 OpenAI 而不经本地 compat 代理，以便降低延迟与复杂度。
12. As a 使用 OpenRouter / 国内网关等第三方 Model Provider 的 Codex 用户，我希望 Codex 仍可通过 compat 代理正常工作，以便不因迁移而失去供应商选择。
13. As a 系统维护者，我希望 compat 代理仅承担协议翻译，plan block 与 interactive 逻辑由 app-server 接管，以便避免双轨 enforcement。
14. As a Codex 用户，我希望切换 Model Provider 或 API 配置时 upstream 与代理自动重配，以便不必手动重启 Session。
15. As a 系统维护者，我希望 `Protocol Endpoint` 上 `codex_needs_proxy` 标记继续有效，以便供应商模板表达 compat 需求。

### Workflow Mode（Permission Snapshot）

16. As a Codex 用户，我希望在 composer 选择 read-only Workflow Mode，以便 agent 默认只读探索代码库。
17. As a Codex 用户，我希望选择 auto Workflow Mode，以便 agent 在工作区内读写但危险操作仍可审批。
18. As a Codex 用户，我希望选择 auto-review Workflow Mode（自动批准），以便低风险操作由守护子代理自动放行、仅检测到的风险操作询问我。
19. As a Codex 用户，我希望选择 full-access Workflow Mode，以便在信任环境下跳过审批（并理解风险）。
20. As a Codex 用户，我希望 Workflow Mode 变更在下一 turn 生效（若 turn 进行中），以便行为可预期。
21. As a Codex 用户，我希望 Workflow Mode 映射到正确的 sandbox 与 approvalPolicy，以便与 Codex 原生语义一致。
22. As a Mobile Companion 用户，我希望在手机上切换 Codex Workflow Mode，以便离开桌面时仍能调整权限档位。
23. As a Mobile Companion 用户，我希望在手机上看到当前 Session 的 Workflow Mode，以便知晓 agent 权限级别。

### Plan Mode 与 Plan Approval

24. As a Codex 用户，我希望通过独立 Plan toggle 开启 Plan Mode，以便与 Workflow Mode 分开控制（例如 full-access 下仍可先规划）。
25. As a Codex 用户，我希望 Plan Mode 开启时 agent 以 plan collaboration 运行，以便产出结构化计划而非直接改代码。
26. As a Codex 用户，我希望 Plan Mode turn 正常完成后看到 Plan Approval 卡片（Implement / Dismiss），以便确认后再执行。
27. As a Codex 用户，我希望点击 Implement 后 agent 自动进入 implementation turn 并关闭 Plan Mode，以便无需手动再发「请执行计划」。
28. As a Codex 用户，我希望点击 Dismiss 后计划被放弃且 turn 正常结束，以便不强制执行不想要的方案。
29. As a Codex 用户，我希望 Plan Approval 期间 turn 处于 Interactive Request 挂起状态，以便空闲守卫不会误判超时。
30. As a Mobile Companion 用户，我希望在手机上 Implement 或 Dismiss Plan Approval，以便 ADR 0008 的审批约束在 Plan 场景仍成立。
31. As a Codex 用户，我希望 Plan Mode 关闭后后续 turn 回到 code collaboration，以便正常编码。
32. As a Agent Kind Switch 用户，我希望切换到 Codex 时 Plan Mode 按 Permission Snapshot 重置规则处理，以便不携带上一种类的 plan 意图。

### 工具级 Interactive Request（审批与问答）

33. As a Codex 用户，我希望 agent 请求执行 shell 命令时看到审批卡片，以便决定是否允许。
34. As a Codex 用户，我希望 agent 请求修改文件时看到审批卡片，以便审查变更范围。
35. As a Codex 用户，我希望 agent 通过 AskUserQuestion 提问时看到问答卡片，以便结构化回答。
36. As a Codex 用户，我希望批准或拒绝后 agent 在同一 turn 内继续或中止，以便流程不中断。
37. As a Codex 用户，我希望 `respond_to_permission` 对 Codex 生效，以便与 Claude/OpenCode 审批通路一致。
38. As a Mobile Companion 用户，我希望在手机上响应 Codex 工具审批与问答，以便离开桌面时仍能解挂 turn。
39. As a Mobile Companion 用户，我希望任一端响应 Interactive Request 后另一端 UI 自动同步，以便符合 ADR 0008。
40. As a Codex 用户，我希望 MCP elicitation 请求有明确处理策略（可表单则响应，不可则 decline），以便不卡在未知请求类型。

### 手动压缩与上下文

41. As a Codex 用户，我希望输入 `/compact` 触发原生上下文压缩，以便主动释放 context window。
42. As a Codex 用户，我希望手动压缩期间看到 compaction loading 状态，以便知道操作进行中。
43. As a Codex 用户，我希望压缩完成后看到 compaction completed 标记，以便理解上下文边界。
44. As a Codex 用户，我希望自动压缩与手动压缩在 UI 上有区分（trigger），以便审计压缩来源。
45. As a Codex 用户，我希望 `thread/compacted` notification 与 `contextCompaction` item 双通道完成被正确去重，以便不出现重复边界标记。
46. As a Codex 用户，我希望压缩 summary 不重复渲染为普通助手消息，以便时间线清晰。

### Fork 与会话管理

47. As a Codex 用户，我希望 Fork Session 仍正常工作，以便从某条助手消息切开新 Session。
48. As a Codex 用户，我希望 fork 走同一 app-server 长连接的 `thread/fork` RPC，以便不再临时 spawn 独立 app-server 进程。
49. As a Codex 用户，我希望 fork 后子 Session 获得新 Native Session id，以便与父 Session 原生隔离。

### 历史、事件与 UI

50. As a Codex 用户，我希望助手消息、推理、工具调用在时间线上正确渲染，以便阅读体验与迁移前一致或更好。
51. As a Codex 用户，我希望 Token 用量更新仍出现在 Session 中，以便监控 context 消耗。
52. As a Codex 用户，我希望从 `~/.codex` JSONL 加载的历史 Session 仍可导入或浏览，以便兼容 Codex 原生存档。
53. As a Codex 用户，我希望 slash commands（除已废弃 SDK 路径外）仍可用，以便习惯不被打断。
54. As a 系统维护者，我希望所有 Codex 行为仍归一化为 CodeMUX Event 协议，以便前端、Companion、DB 快照无需感知 app-server 细节。

### Agent Kind Switch 与多 Agent（首版边界内）

55. As a Agent Kind Switch 用户，我希望切换到 Codex 时仍通过 Switch Briefing 注入摘要，以便首版不依赖 `inject_items` 也能继续工作。
56. As a Codex 用户，我希望切换进 Codex 时 Permission Snapshot 重置为默认 Workflow Mode 且 Plan Mode 关闭，以便符合 ADR 0007。

### 配置清理

57. As a 系统维护者，我希望移除 `sdk_mode`（responses/agent）配置项，以便不再暴露已无意义的 SDK 选项。
58. As a 系统维护者，我希望设置页 Codex 安装指引与托管 Runtime 使用同一 npm 包名（`@openai/codex`），以便文档与行为一致。
59. As a 系统维护者，我希望删除 SDK 加载链与 `@openai/codex-sdk` 依赖，以便减少安装体积与混淆。

### 错误处理与诊断

60. As a Codex 用户，我希望 app-server 启动失败时看到明确 sidecar 错误，以便排查 CLI 或配置问题。
61. As a 系统维护者，我希望 stderr 与结构化日志仍带 Session / message 上下文，以便符合 ADR 0002。
62. As a Codex 用户，我希望 compat 代理不可用时第三方 Provider 给出可读错误而非 silent hang，以便切换 Provider 或检查网络。

## Implementation Decisions

### 架构与边界

- **单一 Sidecar Codex Runtime 边界**：Rust ↔ sidecar 命令契约（`ensure_session`、`send_input`、`respond_to_permission`、`update_permissions`、`delete_session`、`fork_session` 等）保持不变；Codex 实现从 SDK `CodexSessionRuntime` 替换为 `CodexAppServerRuntime`，对外 emit 相同形状的 CodeMUX 侧事件流。这是本特性的**主 seam**——测试与集成均优先在此边界验证。
- **App-server 传输层**：newline-delimited JSON-RPC over stdio；支持 client request/notify、server notification、**server-initiated request**（approval 必须双向响应）。参考 Paseo 的 transport 与 session adapter 模式，适配 CodeMUX 事件归一化管道。
- **进程生命周期**：每个 Codex Native Session 一个长期 `codex app-server` 子进程；initialize → initialized → collaborationMode/list → thread/start 或 thread/resume；dispose 于 delete_session / runtime teardown。
- **硬切**：无用户可见 SDK/app-server 开关；合并删除 SDK 路径、`sdk_mode` 配置、SDK 类型依赖、事后 plan block 模块。

### 托管 Runtime

- npm 安装目标由 `@openai/codex-sdk` 改为 `@openai/codex@<version>`。
- Runtime 完整性 `candidate_binaries` 校验 CLI（npm alias 提升/嵌套/vendor 多候选布局，任一存在即完整）；spawn 时将 Runtime `node_modules/.bin` 前置到 PATH。
- Rust Runtime 管理模块同步更新 primary package 名称与校验规则。

### 上游路由

- 官方 OpenAI：`turn/start` 的 model provider 配置直连 upstream base URL。
- `codex_needs_proxy: true`：sidecar `proxyManager` 启动 compat 代理；app-server `model_providers.base_url` 指向本地代理 listening URL。
- compat 代理内 plan block、interactive tool 拦截逻辑逐步移除，保留 Responses↔Chat 转换与健康检查。

### Permission Snapshot 与 turn 参数

- **Workflow Mode → turn policy 映射**（四档，已对齐官方 App 三档审批选择器）：

| Workflow Mode | approvalPolicy | sandbox | approvalsReviewer |
|---------------|----------------|---------|-------------------|
| read-only | on-request | read-only | — |
| auto | on-request | workspace-write | — |
| auto-review | on-request | workspace-write | guardian_subagent |
| full-access | never | danger-full-access | — |

> **修订（2026-08-22，对齐官方 ChatGPT Codex App）**：auto-review 档 `approvalsReviewer` 由 `auto_review` 改为官方值 `guardian_subagent`（对应官方「仅对检测到的风险操作请求批准」——低风险由守护子代理自动放行，检测到风险才询问）；默认档由 `full-access` 收紧为 `auto`（官方「请求批准」语义）；桌面选择器文案改为 请求批准 / 自动批准 / 完全访问，read-only 保留为 CodeMUX 额外入口。枚举 id 与存量快照迁移映射均不变。

- **Plan Mode toggle**：独立 persisted 状态；开启时 `turn/start` 传 plan `collaborationMode`（自 `collaborationMode/list` 解析）；关闭时传 code/auto collaboration mode。
- Plan turn 成功完成且 plan 文本存在 → emit 合成 **Plan Approval** Interactive Request（kind 区分于 tool approval）。
- Implement → 关闭 Plan Mode、组装 implementation follow-up prompt、自动 `turn/start`（replace running turn 语义与 Paseo 一致）；Dismiss → 结束挂起、不跟 implementation turn。

### Interactive Request 桥接

- 注册 app-server server-initiated handlers：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`（及别名）、MCP elicitation（form/url 策略）。
- 映射为 CodeMUX `permission_requested` / 问答事件；用户响应经 sidecar `respond_to_permission` → resolve 等待中的 app-server request Promise。
- **跨端同步机制（ADR 0008）**：runtime resolve 任一 pending 审批/问答后广播 `permission_resolved` 事件（携带 `request_id` 与 `request_kind: permission | question`）；桌面 `agentStore` 与移动端 `eventToMessages` 消费该事件清除对应挂起卡片，实现任一端响应、双端解挂。
- MCP elicitation form 能力经 initialize handshake 的 `mcpServerOpenaiFormElicitation` capability 声明（`mcpServerElicitation` 选项按需开启）。
- Claude/OpenCode 现有 handler 不受影响；Codex 新增分支。

### 压缩

- `/compact` slash command → `thread/compact/start` RPC（非文本 prompt）。
- Timeline compaction item：loading → completed；维护 manual vs auto trigger。
- 双通道去重（互补语义）：`thread/compacted` notification 与 `contextCompaction` item started/completed 二者取先到者收敛为单一边界标记；turn 结束前 flush 未配对 completion。
- **Token 计数来源**：app-server 协议两通道均不携带压缩后 token 数；`pre_tokens` 取当回合最近已知上下文用量（turn usage 的 `input_tokens + cached_input_tokens`），`post_tokens` 恒为 0（UI 按节省量展示）。

### Native Session resume 降级

```
attempt thread/resume(existingThreadId)
  → success: continue
  → failure: thread/start (new)
              replace agent_session_mapping
              emit system_event subtype=native_session_rebuilt
              CodeMUX Event timeline unchanged
```

### Fork

- 将现有 fork 专用临时 app-server 逻辑并入主 runtime 长连接上的 `thread/fork`（及 turns/list 若需 lastTurnId）。
- Fork 仍创建新 Session + 新 mapping；语义符合 ADR 0007 Fork 定义。

### 前端与 Mobile

- 桌面 `AgentPermissionSelector`：Codex 四档 Workflow Mode；Plan toggle 迁至 composer（与 Reasoning Effort 同级控件区）。
- 扩展 `PermissionApprovalCard`（或等价）支持 Plan Approval（markdown plan + Implement/Dismiss）。
- Mobile Companion：`MobileComposer` 四档 Workflow + Plan toggle；审批 UI 支持 Plan 与工具类型。
- `agentPermissions` 映射模块扩展 Workflow Mode；移除 Codex 两档 plan/full_access 专属路径。

### 删除与退役

- 删除 SDK runtime 主模块、SDK loader 对 Codex 的分支、SDK 专用 turn event normalizer 路径。
- 删除 `codexCollaborationPolicy` 事后 block 与 plan 强制走 proxy 逻辑。
- 删除 `sdk_mode` 自 agent config 与设置 UI。
- 保留：`codex_history` JSONL 加载、MCP/skills 同步 adapter、compat 代理（收窄职责）。

### Initialize 参数

- `clientInfo` 使用 non-originating client name（避免 usage 归属污染）；`capabilities.experimentalApi = true`；MCP elicitation capability 按需开启。

## Testing Decisions

### 什么是好测试

- **只测边界行为，不测内部 RPC 序列细节**：给定 sidecar 命令与 fake app-server 响应/notification，断言 emit 的 CodeMUX 事件序列、Interactive Request 挂起/解挂、Turn Outcome——而非断言私有方法调用顺序。
- **Deterministic fake app-server**：内存或 fixture 子进程模拟 newline JSON-RPC，覆盖 notification 与 server-initiated request；参考 Paseo fake-app-server 模式。
- **分层 E2E**：官方 OpenAI 路径与至少一个 `codex_needs_proxy` 第三方路径分开验收；real e2e 可选 CI nightly。

### 主 Seam（请确认是否符合预期）

**Sidecar Codex Session Runtime 边界** — 输入：现有 sidecar 命令；输出：stderr/stdout CodeMUX 事件流与 Interactive Request 生命周期。

理由：Rust↔sidecar 契约已是全栈最高稳定 seam；UI/Companion/DB 均消费归一化事件，无需为 app-server 新增 Rust 层测试 seam。JSON-RPC transport 单元测试作为 fake-app-server 基础设施，不单独作为产品 seam。

### 测试模块与 prior art

| 区域 | 测什么 | Prior art |
|------|--------|-----------|
| Fake app-server + transport | 握手、request/response、server-initiated request、进程退出 | Paseo fake-app-server；现有 sidecar dispatcher tests |
| CodexAppServerRuntime | ensure/send/permission/compact/fork/resume 降级 | 现有 `codexRuntime.test.ts` 行为用例迁移 |
| Workflow + Plan | 四档映射、Plan Approval 合成、Implement follow-up | Paseo codex-app-server-agent plan tests |
| Compaction | manual `/compact`、双通道 dedup | Paseo compact tests |
| Compat 重接 | 第三方 base_url → 本地 proxy → turn 成功 | 现有 `proxyManager.test.ts`、`codexCompatProxy.test.ts` 缩小范围 |
| Mobile | Workflow/Plan UI + respond | 现有 `src-mobile` composer/approval tests 扩展 |
| Runtime npm | `@openai/codex` 安装与 candidate_binaries | 现有 `runtime/npm.rs` tests |

### 非目标测试

- 不逐行快照 app-server 全量 notification schema（仅覆盖 CodeMUX 消费子集）。
- 不要求首版 CI 跑真实 OpenAI 计费 turn（可选手动/nightly）。

## Out of Scope

- `turn/steer`（turn 中途注入 User Message）
- `thread/inject_items`（含 Agent Kind Switch 原生历史注入增强）
- `thread/rollback`
- Codex goals feature（`--enable goals`）
- 用户可见 SDK / app-server transport 开关或回退路径
- 删除 compat 代理链（第三方供应商长期保留）
- 删除 `Protocol Endpoint.codex_needs_proxy` 领域概念
- 扩展 Codex Workflow Mode  beyond 四档（如自定义 granular approval object UI）
- `gemini_cli` 或 Agent Kind Switch 规则变更（ADR 0007 不变）
- 公网 Companion Relay（ADR 0008/0009 不变）

## Further Notes

- **ADR**： [ADR 0010](../../docs/adr/0010-codex-app-server-transport.md) 记录架构决策；本 spec 为实现展开。
- **参考实现**：Paseo `codex-app-server-agent` + transport（外部仓库，非 vendoring）；移植时适配 CodeMUX sidecar 命令与 CodeMUX Event 协议，非复制粘贴。
- **术语**：Workflow Mode、Plan Mode、Plan Approval 见根目录 `CONTEXT.md`。
- **工作量粗估**：4–5 人月（含 UI、Mobile、compat 重接、测试）；硬切 PR 建议按垂直切片（transport → turn → approval → plan → compact → fork → UI）仍在一个 release  train 内合并。
- **Seam 确认**：若你期望在 Rust session_lifecycle 层增加集成测试 seam，或更低层 transport 作为主 seam，请在实施前修订本节。
