# Codex 代理对齐 CC Switch 指导文档 — 设计方案

> 目标：将 codeMUX 的 Codex 兼容代理与 `docs/codex-routing-proxy-guide.md` 对齐，覆盖中等范围（P0+P1 + 部分 P2），支持全模型族推理参数。

---

## 1. 范围

### 包含

| 优先级 | 模块 | 内容 |
|--------|------|------|
| P0 | 流式 `<think>` 标签检测 | Qwen 等模型在 `delta.content` 中内联推理标签的实时拆分 |
| P0 | 推理参数按模型注入 | 7 个模型族 + 2 个聚合平台的 ReasoningConfig 推断与注入 |
| P0 | `stream_options` 注入 | 流式请求自动注入 `stream_options: {include_usage: true}` |
| P1 | `function_call` 输入项处理 | Responses 输入中的 `function_call` → Chat `assistant.tool_calls` |
| P1 | 流式侧历史缓存记录 | 流式转换中记录 function_call 到 HistoryStore |
| P1 | 超时控制 | 上游请求 AbortController 超时 |
| P2 | 4xx/5xx 错误分类 | 4xx 返回客户端，5xx 尝试下一 endpoint |
| P2 | `tool_choice` 格式转换 | Responses 对象格式 → Chat 对象格式 |
| P2 | `max_completion_tokens` | o-series 模型使用 `max_completion_tokens` |

### 不包含（后续迭代）

- 熔断器 / 多 Provider 故障转移
- 多认证策略（XApiKey、OAuth、Copilot）
- 模型名映射层
- 完整的 provider 配置系统（`api_format` 字段）

---

## 2. 模块拆分

```
src-tauri/sidecar/src/
├── codexCompatProxy.ts        ← 代理服务器 + 路由 + 超时 + 错误分类
├── codexRequestTransform.ts   ← Responses → Chat 请求转换（新增文件）
├── codexStreamTransform.ts    ← Chat SSE → Responses SSE 流转换（新增文件）
├── codexReasoning.ts          ← 推理配置推断 + 注入（新增文件）
├── codexHistory.ts            ← function_call 历史缓存（新增文件，增强版）
├── codexChatCompat.ts         ← 保留：类型定义 + 非流式转换（兼容）
├── sessionRuntimeHelpers.ts   ← 保留：路由判断
└── proxyManager.ts            ← 保留：代理生命周期管理（不变）
```

### 数据流

```
Codex SDK → POST /v1/responses (stream=true)
  │
  ▼
codexCompatProxy.handleRequest()
  ├── 解析请求体
  ├── codexHistory.enrichRequest()        ← 补全缺失的 function_call
  ├── codexRequestTransform.convert()     ← Responses → Chat
  │     └── codexReasoning.applyOptions() ← 注入推理参数
  │     └── 注入 stream_options
  ├── fetch / streamChatCompletion()      ← 带超时
  │
  ├── [流式] codexStreamTransform.convert()
  │     ├── <think> 标签实时检测
  │     ├── reasoning_content / reasoning 处理
  │     ├── tool_calls 累积
  │     └── codexHistory.record()         ← 流式侧记录
  │
  └── SSE 响应 → Codex SDK
```

---

## 3. codexReasoning.ts — 推理配置模块

### 3.1 数据结构

```typescript
interface ReasoningConfig {
  supports_thinking: boolean;
  supports_effort: boolean;
  thinking_param: 'thinking' | 'enable_thinking' | 'reasoning_split' | 'none';
  effort_param: string;          // 'reasoning_effort' | 'reasoning' | 'none'
  effort_value_mode: string;     // 'deepseek' | 'low_high' | 'openrouter' | ''
  output_format: string;         // 'reasoning_content' | 'reasoning' | 'reasoning_details'
}
```

### 3.2 推断逻辑

`inferReasoningConfig(model: string, baseUrl: string, providerName: string): ReasoningConfig | null`

优先级：聚合平台 → 模型厂商。

| 标识 | thinking_param | effort | output_format |
|------|---------------|--------|---------------|
| deepseek | `thinking` | reasoning_effort (deepseek) | reasoning_content |
| kimi/moonshot | `thinking` | — | reasoning_content |
| qwen/dashscope | `enable_thinking` | — | reasoning_content |
| glm/zhipu | `thinking` | — | reasoning_content |
| minimax | `reasoning_split` | — | reasoning_details |
| mimo | `thinking` | — | reasoning_content |
| stepfun | `none` | reasoning_effort (low_high) | reasoning |
| **SiliconFlow 平台** | `enable_thinking` | — | reasoning_content |
| **OpenRouter 平台** | `none` | reasoning (openrouter) | reasoning |

### 3.3 注入函数

`applyReasoningOptions(chatBody, responsesBody, model, config): void`

- 按 `thinking_param` 注入对应参数
- 按 `supports_effort` + `effort_value_mode` 注入 effort
- 无 config 时仅对 o-series 透传 `reasoning_effort`

---

## 4. codexRequestTransform.ts — 请求转换

从 `codexChatCompat.ts` 的 `convertResponsesToChatRequest()` 提取并增强。

### 4.1 新增/修复项

| 项目 | 说明 |
|------|------|
| `function_call` 输入项 | `{type:"function_call", call_id, name, arguments}` → assistant message with `tool_calls` |
| `stream_options` 注入 | `stream: true` 时自动注入 `{include_usage: true}` |
| `max_completion_tokens` | o-series 模型使用 `max_completion_tokens` 而非 `max_tokens` |
| `tool_choice` 转换 | `{type:"function", name:"xxx"}` → `{type:"function", function:{name:"xxx"}}` |
| 推理参数注入 | 调用 `codexReasoning.applyOptions()` |

### 4.2 function_call 转换规则

```
输入:
  {type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"/tmp\"}"}

输出:
  {role: "assistant", tool_calls: [{id: "call_1", type: "function", function: {name: "read_file", arguments: "{\"path\":\"/tmp\"}"}}]}
```

连续的 `function_call` 输入项合并到同一条 assistant message 的 `tool_calls` 数组中。

---

## 5. codexStreamTransform.ts — 流式转换

### 5.1 状态机

```typescript
interface StreamState {
  responseId: string;
  model: string;
  responseStarted: boolean;

  // 文本
  text: { outputIndex: number; itemId: string; added: boolean; done: boolean };

  // 推理
  reasoning: { outputIndex: number; itemId: string; text: string; added: boolean; done: boolean };

  // 内联 <think> 检测（Qwen 等）
  inlineThink: {
    mode: 'detecting' | 'reasoning' | 'text';
    buffer: string;      // 用于检测 <think> 标签的缓冲区
    reasoningText: string;
  };

  // 工具调用
  tools: Map<number, {
    outputIndex: number;
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
    added: boolean;
    done: boolean;
  }>;

  nextOutputIndex: number;
  latestUsage: any;
  finishReason: string | null;
}
```

### 5.2 <think> 标签检测逻辑

```
收到 delta.content chunk
  │
  ├─ inlineThink.mode === 'detecting'
  │   ├─ buffer + chunk 包含 <think>?
  │   │   ├─ YES → 输出 <think> 前文本为 text delta
  │   │   │        切换 mode = 'reasoning'
  │   │   │        开始 reasoning item
  │   │   └─ NO → buffer 长度 < 7 (最长标签)?
  │   │          ├─ YES → 累积到 buffer，等待更多数据
  │   │          └─ NO → 输出 buffer 为 text delta，清空 buffer
  │
  ├─ inlineThink.mode === 'reasoning'
  │   ├─ 包含 </think>?
  │   │   ├─ YES → 输出 </think> 前文本为 reasoning delta
  │   │   │        关闭 reasoning item
  │   │   │        切换 mode = 'text'
  │   │   │        输出 </think> 后文本为 text delta
  │   │   └─ NO → 输出整个 chunk 为 reasoning delta
  │
  └─ inlineThink.mode === 'text'
      └─ 输出 chunk 为 text delta
```

### 5.3 其他流式增强

- `finish_reason` 到达时立即关闭 text/reasoning items，不等到 generator 结束
- 每个 `output_item.done`（function_call）时调用 `history.record()`
- reasoning item 使用 `response.output_text.done` 关闭（与 guide 对齐）

---

## 6. codexHistory.ts — 增强历史缓存

在现有 `CodexChatHistory` 基础上增强。

### 6.1 新增数据结构

```typescript
interface CachedCall {
  callId: string;
  name: string;
  arguments: string;
  reasoningContent?: string;
}

// 在现有 Map<string, HistoryEntry> 基础上新增：
callIndex: Map<string, string[]>;  // call_id → response_ids 反向索引
```

### 6.2 新增方法

- `recordStreamingToolCall(responseId, call)`: 流式侧记录单个 function_call
- `enrichRequest(input, previousResponseId)`: 在 `function_call_output` 前补全缺失的 `function_call`
- `lookupCall(responseId, callId)`: 优先精确查找，fallback 反向索引

---

## 7. codexCompatProxy.ts — 代理增强

### 7.1 超时控制

```typescript
// 非流式：120s 总超时
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120_000);

// 流式：60s 首字节 + 120s 静默期
// 首字节超时在 fetch 时设置
// 静默期在 parseSseStream 中通过 chunk 间隔检测
```

### 7.2 错误分类

```typescript
if (response.status >= 400 && response.status < 500) {
  // 4xx: 客户端错误，直接返回
  const body = await response.text();
  throw new Error(`client error ${response.status}: ${body}`);
}
if (response.status >= 500) {
  // 5xx: 服务端错误，尝试下一 endpoint
  lastError = new Error(`server error ${response.status}`);
  continue;
}
```

### 7.3 流式历史记录集成

在 `convertChatStreamToResponsesEvents` 的回调中，当 function_call `output_item.done` 时调用 `history.recordStreamingToolCall()`。

---

## 8. 测试策略

| 模块 | 测试方式 |
|------|---------|
| codexReasoning | 单元测试：每个模型族的 config 推断 + 参数注入 |
| codexRequestTransform | 单元测试：各种输入项类型转换 + stream_options + tool_choice |
| codexStreamTransform | 单元测试：<think> 标签检测 + reasoning_content + tool_calls 累积 |
| codexHistory | 单元测试：enrichRequest + 流式记录 + 反向索引查找 |
| codexCompatProxy | 集成测试：端到端流式代理（现有测试增强） |

---

## 9. 迁移策略

1. 新建 `codexReasoning.ts`、`codexRequestTransform.ts`、`codexStreamTransform.ts`、`codexHistory.ts`
2. `codexCompatProxy.ts` 改为调用新模块
3. `codexChatCompat.ts` 保留现有函数供测试/兼容，新代码不再依赖它
4. 现有测试更新为使用新模块
5. 前端 `agentStore.ts` 中的模拟流式输出保留为防御性后备（正常流程不触发）
