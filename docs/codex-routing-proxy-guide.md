# Codex 路由代理实现指导说明

> 基于 CC Switch 项目分析，面向已接入 Codex SDK、需要路由到国产模型的场景。

---

## 目录

- [一、整体架构](#一整体架构)
- [二、两个关键协议对比](#二两个关键协议对比)
- [三、路由判断逻辑](#三路由判断逻辑)
- [四、协议转换（Responses ↔ Chat Completions）](#四协议转换responses--chat-completions)
- [五、国产模型 Reasoning 兼容处理](#五国产模型-reasoning-兼容处理)
- [六、认证信息注入](#六认证信息注入)
- [七、URL 构建与请求转发](#七url-构建与请求转发)
- [八、请求历史恢复（Chat History Store）](#八请求历史恢复chat-history-store)
- [九、完整请求处理流程](#九完整请求处理流程)
- [十、接入建议与参考文件清单](#十接入建议与参考文件清单)

---

## 一、整体架构

在本地启动一个 HTTP 代理服务器，拦截 Codex SDK 发出的请求，根据目标上游的 API 格式决定是否进行协议转换，注入正确的认证信息后转发到国产模型上游。

```
┌──────────────┐     HTTP/1.1      ┌─────────────────┐     HTTPS     ┌──────────────────┐
│  Codex CLI / │ ──────────────────▶│  本地代理服务器   │──────────────▶│  国产模型上游      │
│  Codex SDK   │  /v1/responses     │  127.0.0.1:PORT │  /v1/chat/   │  DeepSeek/Kimi/  │
│              │◀──────────────────│  (协议转换层)     │◀──────────────│  Qwen/MiniMax... │
└──────────────┘  Responses SSE     └─────────────────┘  Chat SSE     └──────────────────┘
```

### 核心组件

| 组件 | 职责 |
|------|------|
| **HTTP 代理服务器** | 监听本地端口，接收 Codex SDK 的请求 |
| **路由判断层** | 判断上游是否需要 Chat Completions 格式，决定是否转换 |
| **协议转换层** | Responses API ↔ Chat Completions 的双向转换 |
| **认证注入层** | 移除占位 Key，注入真实 API Key |
| **模型映射层** | 将 Codex 请求中的模型名映射为上游实际模型名 |
| **历史缓存层** | 缓存 function_call 供后续 `previous_response_id` 引用 |
| **熔断 / 故障转移** | Provider 不可用时自动切换到备选 |

---

## 二、两个关键协议对比

Codex SDK 使用 **OpenAI Responses API**，而绝大多数国产模型只支持 **OpenAI Chat Completions API**。这是路由代理需要解决的核心矛盾。

### 2.1 OpenAI Responses API（Codex 原生协议）

**请求示例：**

```json
POST /v1/responses
{
  "model": "o4-mini",
  "instructions": "You are a helpful coding assistant.",
  "input": [
    {"role": "user", "content": [{"type": "input_text", "text": "Hello"}]}
  ],
  "tools": [
    {
      "type": "function",
      "name": "read_file",
      "description": "Read a file",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {"type": "string"}
        }
      }
    }
  ],
  "stream": true,
  "previous_response_id": "resp_xxx"
}
```

**流式响应事件类型：**

```
event: response.created
event: response.output_item.added
event: response.content_part.added
event: response.output_text.delta          ← 文本增量
event: response.output_text.done
event: response.function_call_arguments.delta  ← 工具调用参数增量
event: response.function_call_arguments.done
event: response.output_item.done
event: response.completed                  ← 包含 usage 统计
```

### 2.2 OpenAI Chat Completions API（国产模型通用协议）

**请求示例：**

```json
POST /v1/chat/completions
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "You are a helpful coding assistant."},
    {"role": "user", "content": "Hello"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {"type": "string"}
          }
        }
      }
    }
  ],
  "stream": true,
  "stream_options": {"include_usage": true}
}
```

**流式响应格式：**

```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"Hello"},"index":0}]}
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"index":0}]}
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path"}}]},"index":0}]}
data: {"id":"chatcmpl-xxx","choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}
data: {"id":"chatcmpl-xxx","usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}
data: [DONE]
```

### 2.3 关键差异对照

| 维度 | Responses API | Chat Completions API |
|------|--------------|---------------------|
| 端点 | `/v1/responses` | `/v1/chat/completions` |
| 系统提示 | `instructions` 字段 | `messages[0].role = "system"` |
| 输入格式 | `input` 数组，item 有 `type` 字段 | `messages` 数组，item 有 `role` 字段 |
| 工具定义 | `{"type":"function","name":"xxx","parameters":{...}}` | `{"type":"function","function":{"name":"xxx","parameters":{...}}}` |
| 工具调用 | `function_call` output item | `assistant.tool_calls` + `tool` message |
| 多轮引用 | `previous_response_id` | 完整 `messages` 历史 |
| 推理内容 | reasoning output item | `reasoning_content` / `reasoning` 字段 |

---

## 三、路由判断逻辑

### 3.1 核心判断函数

```typescript
function shouldConvertResponsesToChat(
  provider: Provider,
  endpoint: string
): boolean {
  // 1. 请求路径是 Responses API 端点
  const path = endpoint.split('?')[0];
  const isResponsesEndpoint = ['/responses', '/v1/responses'].includes(path);

  // 2. 上游 provider 只支持 Chat Completions
  const upstreamUsesChat = providerUsesChatCompletions(provider);

  return isResponsesEndpoint && upstreamUsesChat;
}
```

### 3.2 判断上游 API 格式的优先级

```typescript
function providerUsesChatCompletions(provider: Provider): boolean {
  // 优先级 1：显式声明 api_format
  const apiFormat = provider.meta?.api_format
    ?? provider.settings_config?.api_format
    ?? provider.settings_config?.apiFormat;
  if (apiFormat) {
    return apiFormat === 'openai_chat';
  }

  // 优先级 2：从 Codex TOML config 中提取 wire_api
  const wireApi = extractWireApiFromConfig(provider.settings_config?.config);
  if (wireApi) {
    return wireApi === 'chat_completions';
  }

  // 优先级 3：从 base_url 推断
  const baseUrl = provider.settings_config?.base_url ?? '';
  return baseUrl.toLowerCase().includes('/chat/completions');
}
```

**建议**：为每个 provider 配置显式的 `api_format` 字段，取值为 `"openai_chat"` 或 `"openai_responses"`，避免依赖 URL 推断导致误判。

---

## 四、协议转换（Responses ↔ Chat Completions）

### 4.1 请求转换：Responses → Chat Completions

这是将 Codex SDK 发出的 Responses API 请求转换为 Chat Completions 格式的过程。

```typescript
function responsesToChatCompletions(body: any, reasoningConfig?: ReasoningConfig): any {
  const result: any = {};

  // ─── 1. model 字段直接透传 ───
  result.model = body.model;

  // ─── 2. instructions → system message ───
  const messages: any[] = [];
  if (body.instructions) {
    messages.push({
      role: 'system',
      content: extractInstructionText(body.instructions)
    });
  }

  // ─── 3. input 数组 → messages 数组（核心转换）───
  appendResponsesInputAsChatMessages(body.input, messages);
  // 转换规则：
  //   input item {type:"message", role:"user", content:[{type:"input_text", text:"..."}]}
  //     → {role: "user", content: "..."}
  //   input item {type:"message", role:"assistant", content:[{type:"output_text", text:"..."}]}
  //     → {role: "assistant", content: "..."}
  //   input item {type:"function_call", call_id:"call_1", name:"read_file", arguments:"{...}"}
  //     → assistant message 中的 tool_calls
  //   input item {type:"function_call_output", call_id:"call_1", output:"..."}
  //     → {role: "tool", tool_call_id: "call_1", content: "..."}

  // 合并连续的 system messages 到消息头部
  result.messages = collapseSystemMessagesToHead(messages);

  // ─── 4. max_output_tokens → max_tokens / max_completion_tokens ───
  const model = body.model ?? '';
  if (body.max_output_tokens) {
    if (isOpenAIOSeries(model)) {
      result.max_completion_tokens = body.max_output_tokens;
    } else {
      result.max_tokens = body.max_output_tokens;
    }
  }

  // ─── 5. 基础参数透传 ───
  for (const key of ['temperature', 'top_p', 'stream']) {
    if (body[key] !== undefined) {
      result[key] = body[key];
    }
  }

  // ─── 6. 推理参数处理（见第五节）───
  applyReasoningOptions(result, body, model, reasoningConfig);

  // ─── 7. tools 转换 ───
  //   Responses: {type:"function", name:"xxx", parameters:{...}, description:"..."}
  //   Chat:      {type:"function", function:{name:"xxx", parameters:{...}, description:"..."}}
  if (body.tools?.length) {
    result.tools = body.tools
      .map(responseToolToChatTool)
      .filter(Boolean);
  }

  // ─── 8. tool_choice 转换 ───
  if (body.tool_choice) {
    result.tool_choice = responsesToolChoiceToChat(body.tool_choice);
    // Responses: {type: "function", name: "xxx"} 或 "auto" / "required"
    // Chat:      "auto" / "required" / {"type":"function","function":{"name":"xxx"}}
  }

  // ─── 9. 流式请求必须注入 stream_options ───
  //    不注入的话，很多国产模型的流式响应不返回 usage 统计
  if (result.stream) {
    result.stream_options = {
      ...(result.stream_options ?? {}),
      include_usage: true
    };
  }

  // ─── 10. 额外透传字段 ───
  for (const key of [
    'frequency_penalty', 'logit_bias', 'logprobs', 'metadata',
    'n', 'parallel_tool_calls', 'presence_penalty', 'response_format',
    'seed', 'service_tier', 'stop', 'stream_options', 'top_logprobs', 'user'
  ]) {
    if (body[key] !== undefined) {
      result[key] = body[key];
    }
  }

  return result;
}
```

### 4.2 流式响应转换：Chat SSE → Responses SSE

这是一个**有状态**的流转换器，逐 chunk 将 Chat Completions SSE 事件转换为 Responses API SSE 事件。

#### 状态机定义

```typescript
interface ChatToResponsesState {
  responseStarted: boolean;
  completed: boolean;
  responseId: string;
  model: string;
  createdAt: number;
  nextOutputIndex: number;

  // 文本输出状态
  text: {
    outputIndex: number | null;
    itemId: string;
    text: string;
    added: boolean;   // 是否已 emit output_item.added
    done: boolean;
  };

  // 推理内容状态
  reasoning: {
    outputIndex: number | null;
    itemId: string;
    text: string;
    added: boolean;
    done: boolean;
  };

  // 内联 think 标签检测（处理 Qwen 等模型在 content 中塞 <think> 标签的情况）
  inlineThink: {
    mode: 'detecting' | 'reasoning' | 'text';
    buffer: string;
  };

  // 工具调用状态（按 tool_call index 索引）
  tools: Map<number, {
    outputIndex: number | null;
    itemId: string;
    callId: string;
    name: string;
    arguments: string;     // 累积的参数 JSON 字符串
    reasoningContent: string;
    added: boolean;
    done: boolean;
  }>;

  latestUsage: any | null;
  finishReason: string | null;
}
```

#### 转换逻辑

```
收到 Chat Completions SSE chunk
  │
  ├─ delta.content 存在
  │   ├─ 检测 <think> 标签（Qwen 等内联推理格式）
  │   │   ├─ <think> 开始 → 切换到 reasoning 模式，emit reasoning item
  │   │   ├─  内容 → response.output_text.delta (reasoning item)
  │   │   └─  结束 → 切换到 text 模式
  │   └─ 普通文本 → response.output_text.delta (text item)
  │
  ├─ delta.reasoning_content 存在（DeepSeek/Kimi/MiniMax 等）
  │   └─ → response.output_text.delta (reasoning item)
  │
  ├─ delta.tool_calls 存在
  │   ├─ 新 tool_call (有 id 和 name)
  │   │   └─ 初始化工具调用状态，emit response.output_item.added
  │   ├─ 工具参数增量 (function.arguments)
  │   │   └─ 累积到 state.tools[index].arguments
  │   │       → response.function_call_arguments.delta
  │   └─ 工具调用完成
  │       └─ emit response.function_call_arguments.done
  │           + response.output_item.done
  │
  ├─ finish_reason 存在
  │   └─ emit response.output_item.done (text/reasoning)
  │       + response.completed
  │
  └─ usage chunk（最后到达）
      └─ 更新 response.completed 中的 usage 字段
```

#### 关键转换示例

**文本输出：**

```
Chat:     data: {"choices":[{"delta":{"content":"Hello world"}}]}
  ↓
Responses:
  event: response.output_item.added      ← 首次出现时触发
  data: {"type":"message","id":"msg_xxx","role":"assistant","content":[]}

  event: response.content_part.added
  data: {"type":"output_text","text":""}

  event: response.output_text.delta
  data: {"type":"output_text_delta","delta":"Hello world"}
```

**工具调用：**

```
Chat:     data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}
Chat:     data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}
Chat:     data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"/tmp/test.txt\"}"}}]}}]}
  ↓
Responses:
  event: response.output_item.added
  data: {"type":"function_call","id":"fc_xxx","call_id":"call_1","name":"read_file","arguments":""}

  event: response.function_call_arguments.delta
  data: {"type":"function_call_arguments_delta","delta":"{\"path\":"}

  event: response.function_call_arguments.delta
  data: {"type":"function_call_arguments_delta","delta":"\"/tmp/test.txt\"}"}

  event: response.function_call_arguments.done
  data: {"type":"function_call_arguments","arguments":"{\"path\":\"/tmp/test.txt\"}"}

  event: response.output_item.done
  data: {"type":"function_call","id":"fc_xxx","call_id":"call_1","name":"read_file","arguments":"{\"path\":\"/tmp/test.txt\"}"}
```

**推理内容（reasoning_content 字段）：**

```
Chat:     data: {"choices":[{"delta":{"reasoning_content":"Let me think..."}}]}
  ↓
Responses:
  event: response.output_item.added
  data: {"type":"reasoning","id":"reasoning_xxx","summary":[]}

  event: response.output_text.delta
  data: {"type":"reasoning_text_delta","delta":"Let me think..."}

  event: response.output_text.done
  data: {"type":"reasoning_text","text":"Let me think..."}
```

**内联 <think> 标签（Qwen 等模型）：**

```
Chat:     data: {"choices":[{"delta":{"content":"<think>\nLet me analyze...\n</think>\nHere is the answer"}}]}
  ↓
Responses: 拆分为两部分
  先输出 reasoning item: "Let me analyze..."
  再输出 text item: "Here is the answer"
```

---

## 五、国产模型 Reasoning 兼容处理

这是接入国产模型最容易踩坑的地方。**每个模型族的推理参数完全不同**。

### 5.1 各模型推理参数对照表

| 模型 | thinking 参数 | effort 参数 | 输出中的推理字段 |
|------|--------------|------------|----------------|
| **DeepSeek** | `thinking: {type: "enabled"}` | `reasoning_effort` (low/medium/high) | `reasoning_content` |
| **Kimi / Moonshot** | `thinking: {type: "enabled"}` | ❌ 不支持 | `reasoning_content` |
| **Qwen / 通义** | `enable_thinking: true` | ❌ 不支持 | `reasoning_content` |
| **GLM / 智谱** | `thinking: {type: "enabled"}` | ❌ 不支持 | `reasoning_content` |
| **MiniMax** | `reasoning_split: true` | ❌ 不支持 | `reasoning_details` |
| **MiMo (小米)** | `thinking: {type: "enabled"}` | ❌ 不支持 | `reasoning_content` |
| **阶跃 StepFun** | ❌ 无显式参数 | `reasoning_effort` (low/high) | `reasoning` |
| **OpenAI o-series** | ❌ 自动启用 | `reasoning_effort` (low/medium/high) | `reasoning` (Responses) |

### 5.2 推理配置数据结构

```typescript
interface ReasoningConfig {
  supports_thinking: boolean;   // 是否支持推理模式
  supports_effort: boolean;     // 是否支持 effort 控制
  thinking_param: string;       // 启用推理的参数名
                                //   "thinking" → {thinking: {type: "enabled"}}
                                //   "enable_thinking" → {enable_thinking: true}
                                //   "reasoning_split" → {reasoning_split: true}
                                //   "none" → 无需显式参数
  effort_param: string;         // effort 参数名（"reasoning_effort" / "none"）
  effort_value_mode: string;    // effort 值映射模式
                                //   "deepseek" → low/medium/high 直传
                                //   "low_high" → 仅支持 low/high 两档
  output_format: string;        // 响应中推理内容的字段名
                                //   "reasoning_content" → delta.reasoning_content
                                //   "reasoning" → delta.reasoning
                                //   "reasoning_details" → delta.reasoning_details
}
```

### 5.3 推理配置推断逻辑

```typescript
function inferReasoningConfig(
  model: string,
  baseUrl: string,
  providerName: string
): ReasoningConfig | null {
  const haystack = `${providerName} ${baseUrl} ${model}`.toLowerCase();

  // ── 平台优先：聚合平台的推理接口由平台框架决定 ──
  //    同一模型在不同平台参数可能完全不同，必须先按平台判定
  const platformConfig = inferAggregatorPlatformConfig(providerName, baseUrl);
  if (platformConfig) return platformConfig;

  // ── 模型厂商判定 ──
  if (haystack.includes('deepseek')) {
    return {
      supports_thinking: true,
      supports_effort: true,
      thinking_param: 'thinking',
      effort_param: 'reasoning_effort',
      effort_value_mode: 'deepseek',
      output_format: 'reasoning_content',
    };
  }

  if (haystack.includes('kimi') || haystack.includes('moonshot')) {
    return {
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    };
  }

  if (haystack.includes('qwen') || haystack.includes('dashscope')) {
    return {
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'enable_thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    };
  }

  if (haystack.includes('glm') || haystack.includes('zhipu')) {
    return {
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    };
  }

  if (haystack.includes('minimax')) {
    return {
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'reasoning_split',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_details',
    };
  }

  if (haystack.includes('mimo')) {
    return {
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    };
  }

  if (haystack.includes('stepfun') || haystack.includes('step-3.5-flash-2603')) {
    return {
      supports_thinking: true,
      supports_effort: model.includes('2603'),
      thinking_param: 'none',
      effort_param: 'reasoning_effort',
      effort_value_mode: 'low_high',
      output_format: 'reasoning',
    };
  }

  return null;
}
```

### 5.4 将推理配置应用到请求体

```typescript
function applyReasoningOptions(
  result: any,          // 目标 Chat 请求体
  body: any,            // 原始 Responses 请求体
  model: string,
  config?: ReasoningConfig
): void {
  if (!config) {
    // 无推理配置：仅对 OpenAI o-series 透传 effort
    if (supportsReasoningEffort(model)) {
      const effort = body.reasoning?.effort;
      if (effort) result.reasoning_effort = effort;
    }
    return;
  }

  // 1. 注入 thinking 参数
  switch (config.thinking_param) {
    case 'thinking':
      result.thinking = { type: 'enabled' };
      break;
    case 'enable_thinking':
      result.enable_thinking = true;
      break;
    case 'reasoning_split':
      result.reasoning_split = true;
      break;
    case 'none':
    default:
      // 不需要显式参数
      break;
  }

  // 2. 注入 effort 参数（如果上游支持）
  if (config.supports_effort && config.effort_param !== 'none') {
    const effort = body.reasoning?.effort ?? 'medium'; // 默认 medium
    switch (config.effort_value_mode) {
      case 'deepseek':
        result[config.effort_param] = effort; // low/medium/high 直传
        break;
      case 'low_high':
        result[config.effort_param] = effort === 'high' ? 'high' : 'low';
        break;
      default:
        result[config.effort_param] = effort;
    }
  }
}
```

### 5.5 聚合平台特殊处理

**问题**：同一个模型在不同平台参数可能完全不同。

| 模型 | 官方平台 | SiliconFlow | OpenRouter |
|------|---------|-------------|------------|
| DeepSeek | `thinking: {type:"enabled"}` | `enable_thinking: true` | `reasoning: {effort:"medium"}` |

**解决**：优先按平台标识（`base_url` / `provider_name`）判定，不掺入模型名。

```typescript
function inferAggregatorPlatformConfig(
  name: string,
  baseUrl: string
): ReasoningConfig | null {
  const identifier = `${name} ${baseUrl}`.toLowerCase();

  // SiliconFlow 平台
  if (identifier.includes('siliconflow') || identifier.includes('siliconflow.cn')) {
    return {
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'enable_thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    };
  }

  // OpenRouter 平台
  if (identifier.includes('openrouter')) {
    return {
      supports_thinking: true,
      supports_effort: true,
      thinking_param: 'none',
      effort_param: 'reasoning',
      effort_value_mode: 'openrouter',
      output_format: 'reasoning',
    };
  }

  // NewAPI / One API 等自部署网关（通常透传模型原生参数）
  // 此处返回 null，回退到模型名推断
  return null;
}
```

---

## 六、认证信息注入

### 6.1 认证策略

```typescript
enum AuthStrategy {
  Bearer,           // Authorization: Bearer <key>（国产模型通用）
  XApiKey,          // x-api-key: <key>（Anthropic 原生）
  GoogleOAuth,      // OAuth access_token
  GitHubCopilot,    // Copilot token（动态获取）
  CodexOAuth,       // ChatGPT Plus OAuth（动态获取）
}
```

### 6.2 认证头替换流程

```typescript
async function injectAuth(
  requestHeaders: Headers,
  provider: Provider
): Promise<Headers> {
  // 1. 从 Provider 配置提取真实 API Key
  const auth = extractAuth(provider);
  // → { api_key: "sk-xxx", strategy: AuthStrategy.Bearer }

  // 2. 动态 token 刷新（如果需要）
  if (auth.strategy === AuthStrategy.GitHubCopilot) {
    auth.api_key = await copilotAuthManager.getValidToken();
  }

  // 3. 移除客户端发来的占位认证头
  requestHeaders.delete('authorization');
  requestHeaders.delete('x-api-key');
  requestHeaders.delete('anthropic-version');

  // 4. 注入真实认证头
  switch (auth.strategy) {
    case AuthStrategy.Bearer:
      requestHeaders.set('Authorization', `Bearer ${auth.api_key}`);
      break;
    case AuthStrategy.XApiKey:
      requestHeaders.set('x-api-key', auth.api_key);
      break;
    // ...
  }

  return requestHeaders;
}
```

### 6.3 Provider 配置中的 API Key 存储

```typescript
interface ProviderSettingsConfig {
  // 方式一：直接字段
  base_url?: string;
  api_key?: string;

  // 方式二：Codex TOML config（兼容 Codex CLI 的 config.toml）
  config?: string;  // TOML 格式的配置字符串
  auth?: {
    OPENAI_API_KEY?: string;
  };

  // 方式三：环境变量风格
  env?: {
    OPENAI_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
  };
}
```

---

## 七、URL 构建与请求转发

### 7.1 URL 构建

```typescript
function buildUpstreamUrl(
  provider: Provider,
  endpoint: string,
  needsChatConversion: boolean
): string {
  const baseUrl = extractBaseUrl(provider).replace(/\/+$/, '');

  // 如果 base_url 本身已包含完整端点（如 https://api.example.com/v1/chat/completions）
  const isFullUrl = provider.meta?.is_full_url ?? false;
  if (isFullUrl) {
    return baseUrl;
  }

  // 上游是 Chat Completions 且 base_url 已以 /chat/completions 结尾
  if (needsChatConversion && baseUrl.toLowerCase().endsWith('/chat/completions')) {
    return baseUrl;
  }

  // 上游是 Chat Completions：改写 endpoint
  const effectiveEndpoint = needsChatConversion
    ? '/v1/chat/completions'
    : endpoint;

  return `${baseUrl}${effectiveEndpoint}`;
}
```

### 7.2 请求转发

```typescript
async function forwardRequest(
  url: string,
  method: string,
  headers: Headers,
  body: any,
  isStreaming: boolean,
  timeoutSeconds: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    timeoutSeconds * 1000
  );

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
```

### 7.3 超时与错误处理

| 场景 | 超时设置 | 处理方式 |
|------|---------|---------|
| 非流式请求 | 120s | 等待完整响应 |
| 流式请求首字节 | 60s | 等待第一个 SSE chunk |
| 流式请求静默期 | 120s | chunk 间隔超时 |
| 上游 5xx 错误 | — | 故障转移到下一个 provider |
| 上游 4xx 错误 | — | 直接返回客户端（客户端问题） |
| 网络超时 | — | 故障转移到下一个 provider |

---

## 八、请求历史恢复（Chat History Store）

### 8.1 问题描述

Codex SDK 使用 `previous_response_id` 引用上一轮的 function call 结果：

```json
{
  "previous_response_id": "resp_abc123",
  "input": [
    {"type": "function_call_output", "call_id": "call_456", "output": "file content..."}
  ]
}
```

但 Chat Completions 协议没有 response ID 概念，需要恢复完整的 assistant message（含 tool_calls）才能构建合法的 messages 数组：

```json
// 需要恢复出的 messages 序列：
[
  {"role": "assistant", "tool_calls": [{"id": "call_456", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":\"/tmp/test.txt\"}"}}]},
  {"role": "tool", "tool_call_id": "call_456", "content": "file content..."}
]
```

### 8.2 数据结构

```typescript
interface CachedResponse {
  // call_id → 该 function_call 的完整数据
  callsById: Map<string, {
    callId: string;
    name: string;
    arguments: string;
    reasoningContent?: string;
  }>;
  callOrder: string[];  // 保持原始顺序
}

class ChatHistoryStore {
  // response_id → 该 response 中所有 function_call 的缓存
  private responses: Map<string, CachedResponse> = new Map();
  // call_id → response_id 反向索引（用于 fallback 查找）
  private callIndex: Map<string, string[]> = new Map();
  // LRU 淘汰
  private responseOrder: string[] = [];
  private maxCached = 512;
}
```

### 8.3 核心操作

```typescript
class ChatHistoryStore {

  // ── 记录：每次收到上游 Responses 响应后调用 ──
  recordResponse(responseId: string, output: any[]): void {
    const calls = output
      .filter(item => item.type === 'function_call')
      .map(item => ({
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
        reasoningContent: item.reasoning_content,
      }));

    if (calls.length === 0) return;

    const cached: CachedResponse = { callsById: new Map(), callOrder: [] };
    for (const call of calls) {
      cached.callsById.set(call.callId, call);
      cached.callOrder.push(call.callId);

      // 反向索引
      if (!this.callIndex.has(call.callId)) {
        this.callIndex.set(call.callId, []);
      }
      this.callIndex.get(call.callId)!.push(responseId);
    }

    this.responses.set(responseId, cached);
    this.responseOrder.push(responseId);
    this.evict();
  }

  // ── 补全：发送请求前调用，补全缺失的 function_call ──
  enrichRequest(body: any): number {
    const previousResponseId = body.previous_response_id;
    const input = body.input;
    if (!input || !Array.isArray(input)) return 0;

    let restored = 0;
    const enrichedInput: any[] = [];

    for (const item of input) {
      if (item.type === 'function_call_output') {
        // 查找对应的 function_call
        const call = this.lookupCall(previousResponseId, item.call_id);
        if (call) {
          // 在 output 前插入 assistant message with tool_calls
          enrichedInput.push({
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments,
          });
          restored++;
        }
      }
      enrichedInput.push(item);
    }

    if (restored > 0) {
      body.input = enrichedInput;
    }
    return restored;
  }

  // ── 查找：优先 previous_response_id，fallback 到 call_id 反向索引 ──
  private lookupCall(responseId?: string, callId?: string): CachedCall | null {
    // 1. 按 response_id 精确查找
    if (responseId) {
      const cached = this.responses.get(responseId);
      if (cached?.callsById.has(callId!)) {
        return cached.callsById.get(callId!)!;
      }
    }

    // 2. Fallback：按 call_id 反向索引
    if (callId) {
      const responseIds = this.callIndex.get(callId);
      if (responseIds) {
        for (const rid of responseIds) {
          const cached = this.responses.get(rid);
          if (cached?.callsById.has(callId)) {
            return cached.callsById.get(callId)!;
          }
        }
      }
    }

    return null;
  }
}
```

### 8.4 流式响应的记录时机

在流式场景下，function_call 的信息在多个 chunk 中分批到达，需要在流转换过程中累积，**在 `response.output_item.done` 事件发出时记录到 HistoryStore**。

```typescript
// 在流式转换器中
function onOutputItemDone(state: ChatToResponsesState, historyStore: ChatHistoryStore): void {
  // 记录所有已完成的 function_call 到历史缓存
  for (const [index, toolState] of state.tools) {
    if (toolState.done && toolState.callId) {
      historyStore.recordFunctionCall(state.responseId, {
        callId: toolState.callId,
        name: toolState.name,
        arguments: toolState.arguments,
        reasoningContent: toolState.reasoningContent || undefined,
      });
    }
  }
}
```

---

## 九、完整请求处理流程

```
Codex SDK → POST /v1/responses (stream=true)
  │
  ▼
┌─ 路由层 ──────────────────────────────────────────────┐
│  匹配 /v1/responses → handle_responses handler        │
└───────────────────────────────────────────────────────┘
  │
  ▼
┌─ 上下文初始化 ────────────────────────────────────────┐
│  RequestContext::new()                                 │
│  ├── 从数据库/配置读取 provider 列表                     │
│  ├── ProviderRouter::select_providers()                │
│  │   ├── 故障转移开启 → 按优先级排序 (P1 → P2 → ...)    │
│  │   └── 故障转移关闭 → 仅当前 provider                 │
│  ├── 提取 model、session_id                            │
│  └── 读取应用级代理配置（重试次数、超时等）                 │
└───────────────────────────────────────────────────────┘
  │
  ▼
┌─ 请求转发（带故障转移）────────────────────────────────┐
│  for provider in providers:                            │
│  │                                                     │
│  ├── 检查熔断器（circuit breaker）                       │
│  │   └── 熔断中 → skip，尝试下一个 provider              │
│  │                                                     │
│  ├── 模型映射                                           │
│  │   └── apply_model_mapping()                         │
│  │       将 Codex 请求中的模型名替换为上游实际模型名        │
│  │                                                     │
│  ├── 协议判断                                           │
│  │   └── should_convert_codex_responses_to_chat()?      │
│  │       ├── YES → 协议转换流程 ↓                        │
│  │       └── NO  → 透传流程（上游支持 Responses API）     │
│  │                                                     │
│  ├── [协议转换流程]                                      │
│  │   ├── ChatHistoryStore.enrich_request()              │
│  │   │   └── 根据 previous_response_id 补全 function_call│
│  │   ├── apply_codex_chat_upstream_model()              │
│  │   │   └── 替换模型名为上游配置的模型                    │
│  │   ├── resolve_codex_chat_reasoning_config()          │
│  │   │   └── 推断目标模型的推理参数配置                    │
│  │   └── responses_to_chat_completions_with_reasoning() │
│  │       └── 完成 Responses → Chat 格式转换               │
│  │                                                     │
│  ├── URL 构建                                           │
│  │   └── base_url + effective_endpoint                  │
│  │                                                     │
│  ├── 认证注入                                           │
│  │   ├── 移除客户端占位头（Authorization / x-api-key）    │
│  │   └── 注入真实 API Key（Bearer token）                │
│  │                                                     │
│  ├── HTTP POST → 上游                                   │
│  │                                                     │
│  ├── 成功 → 记录熔断器成功，返回响应                       │
│  └── 失败 → 记录熔断器失败，continue 到下一个 provider    │
└───────────────────────────────────────────────────────┘
  │
  ▼
┌─ 响应处理 ────────────────────────────────────────────┐
│                                                        │
│  [需要协议转换]                                         │
│  ├── 上游返回 Chat Completions SSE                     │
│  ├── create_responses_sse_stream_from_chat()           │
│  │   ├── 状态机逐 chunk 处理                            │
│  │   ├── 推理内容 → reasoning output item               │
│  │   ├── 文本内容 → text output item                    │
│  │   ├── tool_calls → function_call output item         │
│  │   ├── usage → response.completed 事件               │
│  │   └── 同时缓存 function_call 到 ChatHistoryStore     │
│  └── 返回 Responses SSE 流给 Codex SDK                 │
│                                                        │
│  [透传模式]                                             │
│  └── 直接转发上游 Responses SSE 流                      │
└───────────────────────────────────────────────────────┘
```

---

## 十、接入建议与参考文件清单

### 10.1 最小可行版本（MVP）

如果你用 **Node.js / TypeScript** 实现，最小可行版本只需要关注以下 5 个模块：

| 优先级 | 模块 | 工作量 | 说明 |
|--------|------|--------|------|
| P0 | 本地 HTTP 服务器 | 小 | Express/Hono/Fastify 监听一个端口 |
| P0 | 请求转换（Responses → Chat） | 中 | 第四节 4.1 的逻辑 |
| P0 | 流式响应转换（Chat SSE → Responses SSE） | **大** | 第四节 4.2 的状态机，最复杂的部分 |
| P1 | 推理配置 | 中 | 第五节，按目标模型配置 |
| P1 | 认证注入 | 小 | 第六节，简单替换 Header |
| P1 | 历史恢复 | 中 | 第八节，处理 `previous_response_id` |
| P2 | 熔断 / 故障转移 | 中 | 可后续迭代 |
| P2 | 模型映射 | 小 | 可后续迭代 |

### 10.2 接入步骤

```
Step 1: 启动本地 HTTP 服务器，监听 127.0.0.1:15721

Step 2: 配置 Codex SDK 环境变量
        OPENAI_BASE_URL=http://127.0.0.1:15721
        OPENAI_API_KEY=PROXY_MANAGED  (占位符，真实 Key 在代理中注入)

Step 3: 实现 /v1/responses 路由
        ├── 解析请求体
        ├── 判断是否需要转换为 Chat Completions
        ├── [需要转换] 执行请求协议转换
        ├── 替换认证头
        ├── POST 到上游
        ├── [需要转换] 流式转换 Chat SSE → Responses SSE
        └── 返回给客户端

Step 4: 添加推理参数支持（按目标模型配置）

Step 5: 实现 ChatHistoryStore（处理多轮 function_call）

Step 6: 添加错误处理和超时控制
```

### 10.3 CC Switch 项目参考文件清单

按重要程度排序：

| 文件 | 说明 | 关注重点 |
|------|------|---------|
| `src-tauri/src/proxy/providers/transform_codex_chat.rs` | Responses → Chat 请求转换 | `responses_to_chat_completions_with_reasoning()` 完整转换逻辑 |
| `src-tauri/src/proxy/providers/streaming_codex_chat.rs` | Chat SSE → Responses SSE 流转换 | `ChatToResponsesState` 状态机，最复杂的模块 |
| `src-tauri/src/proxy/providers/codex.rs` | 路由判断 + 推理配置推断 | `should_convert_codex_responses_to_chat()`, `infer_codex_chat_reasoning_config()` |
| `src-tauri/src/proxy/providers/codex_chat_history.rs` | function_call 历史缓存 | `enrich_request()`, `record_response()` |
| `src-tauri/src/proxy/providers/codex_chat_common.rs` | 公共工具函数 | reasoning 解析、think 标签拆分、tool_call 辅助 |
| `src-tauri/src/proxy/forwarder.rs` | 请求转发 + 故障转移 | `forward_with_retry()`, `forward()` 中的 URL 构建和认证注入 |
| `src-tauri/src/proxy/handlers.rs` | 请求处理器入口 | `handle_responses()` 的完整请求生命周期 |
| `src-tauri/src/proxy/server.rs` | 代理服务器 + 路由注册 | `build_router()` 中 Codex 相关路由 |
| `src-tauri/src/proxy/providers/auth.rs` | 认证策略定义 | `AuthInfo`, `AuthStrategy` 枚举 |
| `src-tauri/src/proxy/providers/adapter.rs` | Provider 适配器 trait | `ProviderAdapter` 统一接口定义 |
| `src-tauri/src/proxy/provider_router.rs` | Provider 路由选择 | `select_providers()` 故障转移队列 |
| `cc-switch-main/src/config/universalProviderPresets.ts` | 国产模型预设配置 | NewAPI / n1n.ai 等聚合平台预设 |
| `docs/proxy-guide-zh.md` | 用户文档 | 代理配置的用户视角说明 |
