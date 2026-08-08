# 非 Vision 模型通过 Attachment Enrichment 理解图片附件

当会话所选模型不具备 Vision Capability 且 User Message 含图片 Attachment 时，在发送前由应用级 Enrichment Provider（独立 Model Provider + 模型）将 Attachment 转为 Enriched Context Block，合并进 User Message 文本后再交给主 Agent。UI 仍展示原始 Attachment；支持 Vision 的模型完全 bypass 此路径。编排在前端 `agentStore`，Enrichment API 调用在 Sidecar 的 Attachment Processor Registry 中按类型分发；首版仅实现 image Processor。

## Status

accepted

## Context

CodeMUX 已支持用户在 Composer  attach 图片，经 `AgentInputPayload` 送至 Claude / Codex / OpenCode 等 runtime。当前对不支持 vision 的模型（如 DeepSeek）会在 `agentStore.startQuery` 静默剥离图片，仅发文本；Sidecar 对 Claude/Codex 另有 `vision_unsupported` 运行时重试，最终也是丢弃图片语义。Coding Agent 场景中用户常粘贴终端报错、IDE 截图、UI  mockup——图片信息丢失会直接导致 Agent 无法有效排障。

Enrichment Provider（如智谱 GLM-4.6V-Flash）与会话 coding 模型通常跨厂商，不宜绑定到单个 Model Provider 或 ProviderModel 条目。图片内容类型不可预测，固定 JSON Schema 难以覆盖所有场景，vision API 本身返回自由文本更合适。

## Decision

1. **注入方式**：Enrichment 产出包裹在 `<attachment_context>` 边界内的自由 Markdown（按 Attachment 文件名分节），合并进发给 Agent 的 User Message 文本；UI 历史中的 User Message 仍保留原始 Attachment 预览，与 payload 分叉（延续现有 strip-images 模式）。

2. **分层**：前端 `agentStore.startQuery` 负责 capability 判断、触发 Enrichment、loading/错误 UX、merge 结果；新增 Tauri command `enrich_attachments` 转发至 Sidecar；Sidecar `AttachmentEnrichmentService` 并行调用 `AttachmentProcessor` Registry，首版注册 `ImageAttachmentProcessor`。

3. **Enrichment Provider 配置**：应用级全局 `AttachmentEnrichmentConfig`（`enabled`、`provider_id`、`model`），指向已有 Model Provider 目录中的模型；未配置或禁用时回退为 strip attachments + 明确提示，不阻断纯文本发送。

4. **Vision Capability 判断**（优先级从高到低）：
   - 运行时学习：`markModelVisionUnsupported()`（来自 `vision_unsupported` 事件）
   - 显式配置：`ProviderModel.supports_vision?: boolean | null`
   - 未知默认：Enrichment 已配置 → 视为不支持（保守走 Enrichment）；未配置 → 乐观发图 + 保留 Sidecar 安全网

   静态 denylist（如 `deepseek-v4-flash`）迁移至内置模板 `supports_vision: false`，逐步废弃 hardcode Set。

5. **失败降级**：多 Attachment 并行 Enrichment；部分失败时成功项正常注入、失败项标注 `⚠️ Attachment Enrichment failed`，继续发送；全部失败时降级为纯文本 + toast，与今日 strip 行为一致但不 silent。

6. **Payload 泛化**：`AgentInputPayload.images` 演进为 `attachments[]`（含 `type` 字段）；首版 `type` 仅 `'image'`。非 enrichable 的文本文件继续走路径 `@path` 引用 + Agent Read 工具，不进入 Enrichment 管线。

7. **Vision 模型零影响**：`resolveVisionCapability() === true` 时 payload 原样发送（含 attachments），不进入 Enrichment 模块，无额外 API 调用与延迟。

## Considered Options

- **注入为 System / Environment Context**——弃用：各 runtime 对 system context 注入方式不一致，改动面大；Coding Agent 需要将图片描述与用户意图置于同一 turn 推理。
- **模拟 Tool Result（synthetic read_attachment）**——弃用：污染 event 流，影响 resume/rewind，对首版过度设计。
- **Rust 层直接调用 Enrichment API**——弃用：Rust 无现有 LLM HTTP 基础设施，与 Sidecar provider 调用逻辑重复。
- **Sidecar 全自动（前端无感知）**——弃用：Enrichment 耗时 2–5s，Coding 流需要 Composer 级 loading 与失败交互；且 `startQuery` 已是 payload 变换 seam。
- **Enrichment Provider 绑定到 Model Provider 或 ProviderModel**——弃用：coding 模型与 vision 模型常跨厂商；应用级全局更符合「基础设施」定位。
- **未知模型保持乐观发图**——弃用（当 Enrichment 已配置时）：会先触发 API 报错再丢失图片，与 Enrichment 功能目标冲突；改为 Enrichment 已配置时保守 enrich。
- **JSON Schema 约束 Enrichment 输出**——弃用：图片类型不可预测，有限字段无法表达 vision 模型能识别的全部信息；改用 prompt 引导 + 自由 Markdown + 固定边界包裹。
- **Enrichment 失败阻断发送**——弃用：Coding 流摩擦过大；部分成功继续更符合「3 张成 2 张好过 0 张」。
- **首版保持 `images[]` 不做泛化**——弃用：第二种 Attachment 类型来时需重构编排层；`attachments[]` + Processor Registry 增量成本可控。

## Consequences

- 新增 `AttachmentEnrichmentConfig` 设置 UI；`ProviderModel` 增加 `supports_vision`；内置模板需补全常见模型的 vision 声明。
- Sidecar 新增 `attachmentEnrichment/` 模块与 `enrich_attachments` 命令处理；Enrichment 在 `ensure_session` 之后调用，复用 session sidecar。
- `agentStore.startQuery` 增加异步 Enrichment 分支与 Composer loading 状态；队列消息（`QueuedAgentQuery`）在 dequeue 时按当时 capability 决定是否 enrich。
- Sidecar 现有 `vision_unsupported` → 纯文本重试保留为安全网；后续可升级为 retry with enrichment 而非 strip。
- 扩展 PDF 等新类型时：注册新 `AttachmentProcessor`、扩展 `type` 枚举、加 Composer adapter；编排层与 Enriched Context Block 格式不变。
- 领域术语见根目录 `CONTEXT.md`：Attachment、Vision Capability、Attachment Enrichment、Enrichment Provider、Enriched Context Block、Attachment Processor。
