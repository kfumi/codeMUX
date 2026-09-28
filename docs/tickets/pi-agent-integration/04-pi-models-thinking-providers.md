# 04 — pi 模型目录、切换、思考等级与供应商全量映射

**What to build:** pi 会话的模型体验补全：模型目录沿用 CodeMUX Model Provider 自有配置（ADR 0005 主线，pi 的 `get_available_models` 不接入 UI；模型 id 不在 pi 目录时错误原样透传）；模型/思考等级变更在下次 ensure 会话重建时生效（与 OpenCode 的 canReuse 重建机制一致，`set_model` RPC 不接入）；思考等级由会话 reasoningEffort 映射（CodeMUX 侧为 6 档 `none|low|medium|high|xhigh|max`，`none→off`，缺省交给 pi 默认 medium；pi 自身词汇表另含 `minimal`，但我们的档位枚举里不存在、故不可达），经 `--thinking` 启动参数生效并随会话记忆；openai_compatible 端点凭据注入补全（勘误 2026-09-03：pi 不读取端点环境变量，实际经 `PI_CODING_AGENT_DIR` 托管目录 `models.json` 注入，api 类型按端点协议映射为 `anthropic-messages`/`openai-completions`，供应商命名空间固定 `codemux`），不可映射供应商发送前拦截。

**Blocked by:** 03

**Status:** ready-for-agent

- [x] 模型下拉沿用 CodeMUX Model Provider 配置并按 pi 可用端点（anthropic/openai 兼容）过滤
- [x] 模型/思考等级变更经 canReuse 比对触发 pi 进程重建，新选型下一轮生效；pi 校验失败错误原样透传
- [x] 思考等级经 `--thinking` 生效（reasoningEffort 映射，none→off），随会话记忆
- [x] openai_compatible 端点凭据注入生效（经托管 `models.json`，非环境变量）；不可映射供应商发送前拦截
- [x] 空 Key 不回落 `~/.pi` 自身认证（ADR 0005，护栏测试覆盖）
- [x] fake-pi 测试覆盖凭据护栏与模型/思考等级启动参数；受影响测试通过
- [x] 托管 `models.json` 条目字段清单（2026-09-28 补全）：除 `id`/`name`/`contextWindow`/`maxTokens` 外还写 `reasoning`（仅当该模型声明支持思考）、`thinkingLevelMap`（`xhigh`/`max`）与 `input`（`["text","image"]`，取自 `input_modalities`）。缺 `reasoning` 会让 pi 把任何档位静默钳回 `off`，缺 `input` 会让图片被降级成 `(image omitted: ...)` 占位文本；两处缺口、根因与本机实测证据见 `12-pi-models-json-thinking-and-modality.md`（对应本次优化计划 P0-1/P0-2）。
