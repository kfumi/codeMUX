# 12 — pi `models.json` 的思考声明与输入模态（P0-1 / P0-2）

**What to build:** 托管 `models.json` 的条目声明补全两处**静默**缺口：一是思考能力（`reasoning` + `thinkingLevelMap`），二是输入模态（`input`）。当前 `buildPiModelsJson`（`apps/sidecar/src/piRuntime.ts`）只写 `id`/`name`/`contextWindow`/`maxTokens`，而 pi 对缺省 `reasoning` 取 `false`（`dist/core/provider-composer.js`），于是可用思考档位只剩 `["off"]`，`setThinkingLevel` 把任何档位静默钳回 `off`（`pi-ai/dist/models.js`、`agent-session.js`）；同理缺省 `input` 为 `["text"]`，带视觉的模型收到图片时被 `downgradeUnsupportedImages` 替换成 `(image omitted: model does not support images)` 占位文本（`pi-ai/dist/api/transform-messages.js`）。两者都不报错，所以长期没被发现。

**Blocked by:** 04

**Status:** done

- [x] `ProviderModel` 新增能力位 `supports_reasoning: Option<bool>`（`crates/daemon/src/model_providers/types.rs`），沿用 `input_modalities` 的模式；仅 `Some(true)` 才向 pi 声明 `reasoning`，非推理模型保持 `off` 而不是发出无效 thinking 参数
- [x] `AgentKind::Pi` 的 metadata 分支（`crates/daemon/src/agent/session_lifecycle.rs`）写出 `reasoning`（仅声明支持时）、`thinkingLevelMap`（`{xhigh:"xhigh", max:"max"}`，pi 对这两档额外要求显式映射，否则被降级为 `high` / 不存在）与 `input`（由 `input_modalities` 推导，且过滤为 pi schema 接受的 `text`/`image`）
- [x] sidecar 全链路透传：`types.ts` 的 `SidecarModelLimits.reasoning/thinkingLevelMap/input` 与 `PiSessionConfig.modelReasoning/modelThinkingLevelMap/modelInputModalities`；`piRuntime.ts` 的 `PiProviderDefinition` 同名可选字段、`buildPiModelsJson` 写出、`canReuse` 比对新增字段（改声明即重建进程）；`index.ts` 从 `cmd.modelLimits` 映射
- [x] 前端提供能力位入口：`src/types/provider.ts` 的 `supports_reasoning`、`ProviderConfig.tsx` 的「支持思考（推理）」开关（关闭时写 `null`，不写 `false`，避免与「未声明」区分开）
- [x] 测试：Rust `pi_model_limits_declare_thinking_and_input_modalities`、`pi_model_limits_omit_reasoning_when_not_declared`；sidecar `piRuntime.test.ts` 的 `declares pi reasoning and input modalities only when asked`（并把原先固化「不写这些字段」的断言改为按能力位分支）；前端 `ProviderConfig.test.tsx` 两条开关用例
- [x] P0 端到端验收：真实 pi 0.87.1 + 真实 sidecar 构建产物（`buildPiModelsJson`）经 RPC `get_available_thinking_levels` / `get_state` 实测——声明后 `--thinking high` 生效为 `high`、`xhigh` 生效为 `xhigh` 且可用档位 7 档；未声明时 `thinkingLevel` 恒为 `off`（对照）
- [x] 前端提供能力位入口：`src/types/provider.ts` 的 `supports_reasoning`、`ProviderConfig.tsx` 的「支持思考（推理）」开关（关闭时写 `null` 而非 `false`，与「未设置」保持同一状态，不引入第三种取值）
## 实测证据（本机 pi 0.87.1）

| `models.json` 条目 | `get_available_thinking_levels` | `--thinking high` | `--thinking xhigh` |
|---|---|---|---|
| 修复前（无 `reasoning`/`input`） | `["off"]` | 钳回 `off` | 钳回 `off` |
| `reasoning: true` | `off,minimal,low,medium,high` | `high` | 降级 `high` |
| `reasoning: true` + `thinkingLevelMap{xhigh,max}` | 全 7 档 | `high` | `xhigh` |

同一探针同时确认 `reasoning: true` 后 pi 的状态里 `input: ["text","image"]`（由 `input_modalities` 声明）与 `reasoning: true` 一并生效；未声明时是 `["text"]` + `reasoning: false`。

## 备注

- 本 ticket 承接 `04` 的 `models.json` 注入面（原描述未列 `reasoning`/`thinkingLevelMap`/`input`，已在 04 回指本文件）。
- CodeMUX 侧 `ReasoningEffort` 只有 6 档（`none|low|medium|high|xhigh|max`），pi 词汇表里的 `minimal` 因此不可达，不需要在 UI 暴露。
- 执行记录与偏离说明见 `docs/plans/2026-09-28-pi-agent-integration-optimizations.md`。
