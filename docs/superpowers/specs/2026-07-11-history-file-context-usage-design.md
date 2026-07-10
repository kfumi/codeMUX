# 基于历史文件的上下文统计展示重构设计

## 背景

当前 Claude Code 上下文统计多次修正后仍存在实时对话和加载历史不一致的问题。根因是展示链路同时存在多种事实源：实时 result/assistant usage、`/context` 探测、`context_window` 快照、历史加载合成 result、以及 UI 端事件扫描推断。只要任一来源口径不同，发送框上下文和消息 footer 就会再次分叉。

本设计将上下文统计展示改为单一事实源：读取智能体自己的历史 JSONL 文件，取最后一条有效 token usage。实时对话成功结束后异步刷新历史文件；加载历史对话时也走同一个刷新入口。没有历史文件或没有有效 usage 时不展示上下文统计，不再使用旧逻辑估算。

## 目标

- Claude Code 和 Codex 的上下文展示均以历史文件最后一条有效 usage 为准。
- 实时成功结束和加载历史使用同一个 usage loader，保证两条链路口径一致。
- 发送框和最后一条消息 footer 使用同一份 session 级 `tokenUsageBySession` 快照。
- 删除旧的 runtime 展示兜底：不再从实时 result/assistant usage、`/context`、`context_window` 或事件扫描中推断最终展示值。
- 刷新失败或找不到历史文件时宁可不展示，也不展示估算值。

## 非目标

- 不重做聊天消息历史渲染格式。
- 不改变 Claude Code 或 Codex 的真实会话文件写入行为。
- 不引入成本统计、价格估算或多模型账单统计。
- 不处理 Gemini、OpenCode 等当前未纳入的智能体。

## 方案选择

采用后端统一 usage 查询命令。

新增一个 Tauri/Rust 层的历史 usage 快照服务，例如 `load_agent_latest_token_usage(appSessionId, agentKind)`。它负责根据 app session 查 agent session mapping，定位 Claude/Codex JSONL，按智能体策略读取最后一条有效 usage，并返回统一的 `ThreadTokenUsage` 快照。前端只把该快照写入 `tokenUsageBySession`。

不采用前端加载完整历史事件再推导 usage，因为这会继续把聊天渲染和统计逻辑耦合，也会重复解析大量不需要的消息。不采用 sidecar 直接读文件作为唯一方案，因为历史加载仍然需要 Rust 命令，职责会分散。

## 数据口径

### Claude Code

从 Claude JSONL 倒序查找最后一条满足以下条件的记录：

- `type === "assistant"`
- `message.role === "assistant"`
- `message.usage` 存在
- 非 sidechain 记录

读取字段：

- `inputTokens = message.usage.input_tokens`
- `cachedInputTokens = message.usage.cache_read_input_tokens`
- `outputTokens = message.usage.output_tokens`
- `usedTokens = inputTokens + cachedInputTokens`
- `total.totalTokens = inputTokens + cachedInputTokens`
- `last.totalTokens = inputTokens + cachedInputTokens`

`outputTokens` 只用于 tooltip/footer 明细，不参与上下文占用百分比。

### Codex

从 Codex JSONL 倒序查找最后一条满足以下条件的记录：

- `type === "event_msg"`
- `payload.type === "token_count"`
- `payload.info.last_token_usage` 存在

读取字段：

- `inputTokens = last_token_usage.input_tokens`
- `cachedInputTokens = last_token_usage.cached_input_tokens`
- `outputTokens = last_token_usage.output_tokens`
- `usedTokens = last_token_usage.total_tokens`
- `total.totalTokens = last_token_usage.total_tokens`
- `last.totalTokens = last_token_usage.total_tokens`

如果 `last_token_usage.total_tokens` 缺失，则 fallback 为 `inputTokens + outputTokens`。不关心 `reasoning_output_tokens`，不参与展示和计算。`cachedInputTokens` 作为缓存明细展示，用于对标 Claude Code 的缓存字段。

如果同一条 `token_count.info` 带有 `model_context_window`，则写入 `modelContextWindow`；否则前端可继续使用模型默认窗口作为环形百分比的分母。没有窗口且无默认值时不展示上下文环。

## 统一快照结构

前后端继续使用标准化的 session usage 快照：

```ts
type ThreadTokenUsage = {
  total: {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: 0;
  };
  last: {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: 0;
  };
  modelContextWindow: number | null;
  contextUsageSource: "history_file";
  contextUsageFreshness: "syncing" | "live_synced" | "restored" | "unavailable";
};
```

`reasoningOutputTokens` 固定为 `0` 或从 UI 展示中移除。前端上下文展示只关注输入、缓存、输出和总占用。

## 实时刷新流程

实时对话成功结束后，仅在成功 `result` 后触发刷新。取消、失败、启动失败、interrupt 不触发历史 usage 刷新。

流程：

1. store 收到成功 `result`，先结束 running 状态。
2. 调用 `refreshLatestTokenUsage(sessionId, "live_synced")`，后台异步执行，不阻塞 UI。
3. 如果当前已有 `tokenUsageBySession[sessionId]`，先保留旧数字，并把 freshness 标记为 `syncing`。
4. 如果当前没有旧数字，刷新期间不展示上下文统计。
5. 后端命令读到历史文件快照后，前端用返回快照覆盖 session usage。
6. 如果读不到或失败，不清空已有值；无旧值时保持不展示。
7. 连续多轮刷新时，使用 request id 或 timestamp，只有最后一次刷新可以覆盖状态，避免旧请求晚返回覆盖新结果。

## 历史加载流程

加载历史对话时，聊天消息仍由现有 `loadSessionMessages` 负责渲染。上下文统计不再从这些事件中推导。

流程：

1. `loadSessionMessages(sessionId)` 加载并转换历史消息。
2. 加载完成后调用同一个 `refreshLatestTokenUsage(sessionId, "restored")`。
3. 读到快照后写入 `tokenUsageBySession[sessionId]`。
4. 找不到映射、找不到文件或没有 usage 时写入 `null` 或保持无展示状态。

## UI 展示策略

- `tokenUsageBySession` 是上下文统计唯一展示来源。
- `CodeMuxComposer` 不再调用事件扫描推断函数。
- 消息 footer 中与 token/context 统计相关的展示也读同一份 session usage 快照，保证和发送框一致。
- 旧 result/synthetic result 里的 usage 不再作为 footer 或发送框的展示来源；读不到历史 usage 快照就不展示统计。
- 如果没有 session usage 快照，则发送框不展示上下文环。
- `syncing` 时不新增显眼文案，避免 UI 闪动；内部状态用于阻止旧请求覆盖和调试。

## 旧逻辑删除

以下逻辑退出最终展示链路：

- 从实时 result/assistant usage 直接更新 `tokenUsageBySession`。
- `/context` 探测结果覆盖 `tokenUsageBySession`。
- `context_window` 覆盖 `tokenUsageBySession`。
- `computeContextUsageFromEvents` 作为 runtime fallback。
- 历史加载时通过 synthetic result 推导发送框上下文。

相关 helper 可以在迁移中删除，或仅保留给聊天历史 footer 的局部兼容，但不能作为发送框上下文的兜底来源。

## 后端实现边界

Rust/Tauri agent 层新增独立模块或函数组：

- 根据 `appSessionId + agentKind` 读取 agent session mapping。
- 复用 `find_claude_session_jsonl` 和 `find_codex_session_jsonl` 定位文件。
- 提供 Claude/Codex 两个 parsing strategy。
- 返回统一 `ThreadTokenUsage` JSON 或 `null`。

文件读取应在后端异步命令中完成，必要时使用 `spawn_blocking`，避免阻塞 React 主线程。第一版可以顺序读取整个 JSONL，简单可靠；如果后续遇到超大文件性能问题，再优化为从文件尾部按块倒读。Codex 文件路径定位当前需要递归匹配 `session_meta`，第一版复用现有逻辑，后续可缓存 `appSessionId -> messagePath`。

## 前端实现边界

agent store 新增或改造：

- `refreshLatestTokenUsage(sessionId, freshness)`：调用 Tauri 命令并更新 `tokenUsageBySession`。
- `tokenUsageRefreshRequests`：记录每个 session 最新 request id，防止乱序覆盖。
- 成功 result 后异步调用 refresh。
- 历史加载完成后调用 refresh。
- 删除 result/token_usage_update 对 `tokenUsageBySession` 的直接最终写入。

`ContextDisplay` 输入改为来自 `tokenUsageBySession` 的 view model。view model 负责将 Claude 的 `input + cache`、Codex 的 `total_tokens` 映射为 `usedTokens`。

## 错误处理

- agent session mapping 不存在：返回 `null`。
- 历史文件不存在：返回 `null`。
- JSONL 中存在损坏行：跳过该行，继续查找。
- 没有有效 usage：返回 `null`。
- 后端命令异常：前端记录日志，不展示错误 toast，不清空已有 usage。
- session 已被删除或切换：忽略返回结果。

## 测试计划

### Rust/Tauri

- Claude JSONL 倒序找到最后一条 assistant usage。
- Claude 忽略 user/result/sidechain/无 usage assistant。
- Claude 使用 `input_tokens + cache_read_input_tokens` 作为 `totalTokens`。
- Codex JSONL 倒序找到最后一条 `token_count.info.last_token_usage`。
- Codex 优先使用 `last_token_usage.total_tokens`。
- Codex 缺失 `total_tokens` 时 fallback 为 `input_tokens + output_tokens`。
- Codex 不使用 `reasoning_output_tokens` 展示或计算。
- 映射不存在、文件不存在、损坏 JSON 行时返回 `null` 或跳过损坏行。

### 前端/store

- 实时成功 result 后不使用 result.usage 更新展示，只触发历史 usage refresh。
- 取消、失败 result 不触发 refresh。
- refresh 返回后更新 `tokenUsageBySession`。
- `syncing` 时已有值不清空；无旧值不展示。
- 旧 request 晚返回不会覆盖新 request。
- 历史加载后使用同一 refresh 路径更新 usage。
- 找不到历史 usage 时不展示上下文，不使用事件扫描 fallback。

### UI

- 发送框和最后一条 footer 在实时结束后展示一致。
- 重新打开并加载历史后，发送框展示和实时结束后的展示一致。
- Claude tooltip 显示输入、缓存、输出；占用为输入 + 缓存。
- Codex tooltip 显示输入、缓存、输出；占用为 `total_tokens` 或 `input + output` fallback。

## 验收标准

- 实时成功结束后，发送框上下文来自历史文件快照。
- 加载历史后，发送框上下文来自同一个历史文件快照 loader。
- Claude Code 展示口径为输入 + 缓存。
- Codex 展示口径为 `total_tokens`，缺失时为输入 + 输出。
- 没有历史文件或没有有效 usage 时不展示上下文统计。
- 旧的事件推断、`/context`、`context_window` 不再影响最终上下文展示。
