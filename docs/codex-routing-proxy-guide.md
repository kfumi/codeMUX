# Codex 路由代理实现指导说明

> 基于 CC Switch 项目分析，面向已接入 Codex SDK、需要路由到国产模型的场景。

---

## 目录

- [一、整体架构](#一整体架构)
- [二、两个关键协议对比](#二两个关键协议对比)
- [三、路由判断与路由表](#三路由判断与路由表)
- [四、协议转换（Responses ↔ Chat Completions）](#四协议转换responses--chat-completions)
- [五、CodexToolContext 工具类型桥接系统](#五codextoolcontext-工具类型桥接系统)
- [六、国产模型 Reasoning 兼容处理](#六国产模型-reasoning-兼容处理)
- [七、认证信息注入](#七认证信息注入)
- [八、URL 构建与请求转发](#八url-构建与请求转发)
- [九、请求历史恢复（Chat History Store）](#九请求历史恢复chat-history-store)
- [十、错误处理与容错机制](#十错误处理与容错机制)
- [十一、完整请求处理流程](#十一完整请求处理流程)
- [十二、接入建议与参考文件清单](#十二接入建议与参考文件清单)

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
| **HTTP 代理服务器** | Axum + hyper HTTP/1.1，监听本地端口，`preserve_header_case` 保留原始请求头大小写 |
| **路由层** | `build_router()` 注册所有 API 端点（Claude/Codex/Gemini/Claude Desktop） |
| **路由判断层** | 判断上游是否需要 Chat Completions 格式，决定是否转换 |
| **CodexToolContext** | 工具类型桥接系统，处理 function/namespace/custom/tool_search 四种工具类型 |
| **协议转换层** | Responses API ↔ Chat Completions 的双向转换（含推理内容处理） |
| **认证注入层** | 移除占位 Key，注入真实 API Key（支持 Bearer/Copilot OAuth/Codex OAuth） |
| **模型映射层** | 将 Codex 请求中的模型名映射为上游实际模型名 |
| **历史缓存层** | 缓存 function_call / custom_tool_call / tool_search_call 供后续引用 |
| **熔断 / 故障转移** | Provider 不可用时自动切换到备选，含智能错误分类 |

---

## 二、两个关键协议对比

Codex SDK 使用 **OpenAI Responses API**，而绝大多数国产模型只支持 **OpenAI Chat Completions API**。

### 2.1 OpenAI Responses API（Codex 原生协议）

```json
POST /v1/responses
{
  "model": "o4-mini",
  "instructions": "You are a helpful coding assistant.",
  "input": [
    {"role": "user", "content": [{"type": "input_text", "text": "Hello"}]}
  ],
  "tools": [
    {"type": "function", "name": "read_file", "parameters": {...}},
    {"type": "namespace", "name": "my_ns", "tools": [...]},
    {"type": "custom", "name": "my_tool", "input_schema": {...}},
    {"type": "tool_search", "search_prompt": "find relevant tools"}
  ],
  "stream": true,
  "previous_response_id": "resp_xxx"
}
```

**流式响应事件类型：**

```
response.created
response.output_item.added
response.content_part.added
response.output_text.delta                   ← 文本增量
response.output_text.done
response.function_call_arguments.delta       ← 工具调用参数增量
response.function_call_arguments.done
response.custom_tool_call_input.delta        ← 自定义工具调用增量（新增）
response.custom_tool_call_input.done
response.output_item.done
response.completed                           ← 包含 usage 统计
```

### 2.2 OpenAI Chat Completions API（国产模型通用协议）

```json
POST /v1/chat/completions
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "You are a helpful coding assistant."},
    {"role": "user", "content": "Hello"}
  ],
  "tools": [
    {"type": "function", "function": {"name": "read_file", "parameters": {...}}}
  ],
  "stream": true,
  "stream_options": {"include_usage": true}
}
```

### 2.3 关键差异对照

| 维度 | Responses API | Chat Completions API |
|------|--------------|---------------------|
| 端点 | `/v1/responses` | `/v1/chat/completions` |
| 系统提示 | `instructions` 字段 | `messages[0].role = "system"` |
| 输入格式 | `input` 数组，item 有 `type` 字段 | `messages` 数组，item 有 `role` 字段 |
| 工具定义 | 4 种类型：function/namespace/custom/tool_search | 仅 function 类型 |
| 工具调用 | `function_call` output item | `assistant.tool_calls` + `tool` message |
| 多轮引用 | `previous_response_id` | 完整 `messages` 历史 |
| 推理内容 | reasoning output item | `reasoning_content` / `reasoning` 字段 |
| 压缩端点 | `/responses/compact` | 无对应 |

---

## 三、路由判断与路由表

### 3.1 完整路由表

代理服务器在 `build_router()` 中注册以下路由：

| 分类 | 路由 | 方法 | 处理器 |
|------|------|------|--------|
| 健康检查 | `/health`, `/status` | GET | `health_check`, `get_status` |
| Claude API | `/v1/messages`, `/claude/v1/messages` | POST | `handle_messages` |
| Claude Desktop | `/claude-desktop/v1/models` | GET | `handle_claude_desktop_models` |
| Claude Desktop | `/claude-desktop/v1/messages` | POST | `handle_claude_desktop_messages` |
| Chat Completions | `/chat/completions`, `/v1/chat/completions`, `/v1/v1/chat/completions`, `/codex/v1/chat/completions` | POST | `handle_chat_completions` |
| Responses | `/responses`, `/v1/responses`, `/v1/v1/responses`, `/codex/v1/responses` | POST | `handle_responses` |
| Responses Compact | `/responses/compact`, `/v1/responses/compact`, `/v1/v1/responses/compact`, `/codex/v1/responses/compact` | POST | `handle_responses_compact` |
| Gemini | `/v1beta/*path`, `/gemini/v1beta/*path`, `/gemini/v1/*path` | ANY | `handle_gemini` |

> **`/v1/v1/...` 双前缀路由**：某些客户端库会在配置的 base_url 上再拼一个 `/v1`，导致实际请求路径变成 `/v1/v1/responses`。

### 3.2 Codex 路由判断逻辑

```typescript
function shouldConvertResponsesToChat(provider: Provider, endpoint: string): boolean {
  // 1. 请求路径是 Responses API 端点
  const path = endpoint.split('?')[0];
  const isResponsesEndpoint = ['/responses', '/v1/responses'].includes(path);

  // 2. 上游 provider 只支持 Chat Completions
  const upstreamUsesChat = providerUsesChatCompletions(provider);

  return isResponsesEndpoint && upstreamUsesChat;
}
```

**判断上游 API 格式的优先级：**

```
1. provider.meta.api_format 显式声明 → "openai_chat"
2. settings_config 中的 api_format / apiFormat 字段
3. 从 Codex TOML config 中提取 wire_api 配置
4. 从 base_url 推断（URL 含 /chat/completions 则判定为 Chat 模式）
```

---

## 四、协议转换（Responses ↔ Chat Completions）

### 4.1 请求转换：Responses → Chat Completions

```typescript
function responsesToChatCompletions(body: any, toolContext: CodexToolContext): any {
  const result: any = {};

  // 1. model 字段直接透传
  result.model = body.model;

  // 2. instructions → system message
  const messages: any[] = [];
  if (body.instructions) {
    messages.push({ role: 'system', content: extractInstructionText(body.instructions) });
  }

  // 3. input 数组 → messages 数组（核心转换）
  //    - user/content → user message
  //    - assistant output → assistant message（含 tool_calls）
  //    - function_call_output → tool message
  //    - custom_tool_call_output → tool message
  //    - tool_search_output → 动态工具加载（追加到 toolContext）
  appendResponsesInputAsChatMessages(body.input, &mut messages);
  result.messages = collapseSystemMessagesToHead(messages);

  // 4. max_output_tokens → max_tokens / max_completion_tokens
  if (isOpenAIOSeries(model)) {
    result.max_completion_tokens = body.max_output_tokens;
  } else {
    result.max_tokens = body.max_output_tokens;
  }

  // 5. 推理参数处理（见第六节）
  applyReasoningOptions(result, body, model, reasoningConfig);

  // 6. tools 转换（通过 CodexToolContext 处理 4 种工具类型）
  result.tools = toolContext.chatTools();  // 见第五节

  // 7. 空工具数组保护：tools 为空时移除 tool_choice 和 parallel_tool_calls
  if (!result.tools?.length) {
    delete result.tool_choice;
    delete result.parallel_tool_calls;
  }

  // 8. 流式请求注入 stream_options
  if (result.stream) {
    result.stream_options = { include_usage: true };
  }

  return result;
}
```

### 4.2 流式响应转换：Chat SSE → Responses SSE

有状态流转换器，核心状态机新增了 `tool_context` 字段：

```typescript
interface ChatToResponsesState {
  responseStarted: boolean;
  completed: boolean;
  responseId: string;        // 默认 "resp_ccswitch"
  model: string;
  nextOutputIndex: number;

  text: TextItemState;            // 文本输出
  reasoning: ReasoningItemState;  // 推理内容
  inlineThink: InlineThinkState;  // 内联 <think> 标签检测

  tools: Map<number, ToolCallState>;  // 工具调用（按 index 索引）
  latestUsage: any;
  finishReason: string;

  toolContext: CodexToolContext;  // ★ 工具名称映射上下文
}
```

**转换逻辑：**

```
Chat Completions SSE chunk
  │
  ├─ delta.content
  │   ├─ 检测 <think> 标签 → reasoning item（Qwen 等内联推理）
  │   └─ 普通文本 → response.output_text.delta
  │
  ├─ delta.reasoning_content → reasoning item（DeepSeek/Kimi/MiniMax 等）
  │
  ├─ delta.tool_calls
  │   ├─ 新 tool_call → 根据 toolContext 判断类型
  │   │   ├─ function → response.function_call_arguments.delta
  │   │   └─ custom   → response.custom_tool_call_input.delta ★新增
  │   └─ 参数累积 → 完成后 emit done 事件
  │
  ├─ finish_reason → response.output_item.done + response.completed
  │
  └─ usage chunk → 更新 response.completed 中的 usage
```

---

## 五、CodexToolContext 工具类型桥接系统

### 5.1 问题

Codex Responses API 支持 4 种工具类型，但 Chat Completions API 只支持 function 类型。需要一个桥接层将所有工具类型统一转换为 function，并在响应中恢复原始类型。

### 5.2 四种工具类型

| Codex 工具类型 | 说明 | 转换策略 |
|---------------|------|---------|
| `function` | 标准函数工具 | 直接映射为 Chat function |
| `namespace` | 命名空间，包含子工具 | 展开为 `namespace__toolname` 格式的独立 function |
| `custom` | 自定义工具（非函数调用） | 转换为 function，参数为 `input: string` |
| `tool_search` | 动态工具搜索 | 生成代理 function `tool_search`，运行时加载工具 |

### 5.3 核心数据结构

```rust
enum CodexToolKind { Function, Namespace, Custom, ToolSearch }

struct CodexToolSpec {
    kind: CodexToolKind,
    name: String,
    namespace: Option<String>,
}

struct CodexToolContext {
    // 转换后的 Chat 格式工具列表
    chat_tools: Vec<Value>,
    // Chat 工具名 → 原始 Codex 工具规格（用于响应回写）
    chat_name_to_spec: HashMap<String, CodexToolSpec>,
    // (namespace, tool_name) → Chat 平展名
    namespace_name_to_chat_name: HashMap<(String, String), String>,
}
```

### 5.4 转换规则

```typescript
function buildCodexToolContext(tools: any[]): CodexToolContext {
  const ctx = new CodexToolContext();

  for (const tool of tools) {
    switch (tool.type) {
      case "function":
        // 直接映射，保留 name/parameters/description
        ctx.addChatTool(tool.name, {
          type: "function",
          function: { name: tool.name, parameters: tool.parameters, description: tool.description }
        }, { kind: "Function", name: tool.name });
        break;

      case "namespace":
        // 展开子工具为平展名称
        for (const sub of tool.tools) {
          const flatName = `${tool.name}__${sub.name}`;  // namespace__toolname
          // 超过 64 字符时用 SHA-256 截断
          const chatName = flatName.length > 64
            ? sha256(flatName).slice(0, 64)
            : flatName;
          ctx.addChatTool(chatName, {
            type: "function",
            function: { name: chatName, parameters: sub.parameters }
          }, { kind: "Namespace", name: sub.name, namespace: tool.name });
        }
        break;

      case "custom":
        // 转换为 function，参数为 input 字符串
        ctx.addChatTool(tool.name, {
          type: "function",
          function: {
            name: tool.name,
            parameters: { type: "object", properties: { input: { type: "string" } } }
          }
        }, { kind: "Custom", name: tool.name });
        break;

      case "tool_search":
        // 生成代理 function
        ctx.addChatTool("tool_search", {
          type: "function",
          function: {
            name: "tool_search",
            parameters: { type: "object", properties: { query: { type: "string" } } }
          }
        }, { kind: "ToolSearch", name: "tool_search" });
        break;
    }
  }

  return ctx;
}
```

### 5.5 响应中的工具名恢复

流式转换器使用 `toolContext.lookupChatName(chatName)` 将 Chat 格式的工具名恢复为原始 Codex 工具名和类型：

- **function** → emit `response.function_call_arguments.delta/done`
- **custom** → emit `response.custom_tool_call_input.delta/done` ★新增
- **namespace 子工具** → emit `response.function_call_arguments.delta/done`（恢复原始子工具名）
- **tool_search** → emit `response.function_call_arguments.delta/done`

---

## 六、国产模型 Reasoning 兼容处理

### 6.1 各模型推理参数对照表

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

### 6.2 StepFun 特殊处理（新增）

```typescript
// StepFun: 仅 step-3.5-flash-2603 支持 reasoning effort（low/high 两档）
if (haystack.includes("stepfun") || haystack.includes("step-3.5-flash-2603")) {
  return {
    supports_thinking: true,
    supports_effort: model.includes("2603"),  // 仅 2603 版本支持
    thinking_param: "none",                    // 无需显式参数
    effort_param: "reasoning_effort",
    effort_value_mode: "low_high",             // 仅 low/high 两档
    output_format: "reasoning",
  };
}
```

### 6.3 推理配置数据结构

```typescript
interface ReasoningConfig {
  supports_thinking: boolean;   // 是否支持推理模式
  supports_effort: boolean;     // 是否支持 effort 控制
  thinking_param: string;       // "thinking" / "enable_thinking" / "reasoning_split" / "none"
  effort_param: string;         // "reasoning_effort" / "none"
  effort_value_mode: string;    // "deepseek" (low/med/high) / "low_high" (仅两档)
  output_format: string;        // "reasoning_content" / "reasoning" / "reasoning_details"
}
```

### 6.4 推理配置推断逻辑

```typescript
function inferReasoningConfig(model: string, baseUrl: string, providerName: string): ReasoningConfig | null {
  const haystack = `${providerName} ${baseUrl} ${model}`.toLowerCase();

  // ── 平台优先：聚合平台的推理接口由平台框架决定 ──
  const platformConfig = inferAggregatorPlatformConfig(providerName, baseUrl);
  if (platformConfig) return platformConfig;

  // ── 模型厂商判定 ──
  if (haystack.includes("deepseek")) return DEEPSEEK_CONFIG;
  if (haystack.includes("stepfun") || haystack.includes("step-3.5-flash-2603")) return STEPFUN_CONFIG;
  if (haystack.includes("kimi") || haystack.includes("moonshot")) return KIMI_CONFIG;
  if (haystack.includes("glm") || haystack.includes("zhipu") || haystack.includes("z.ai")) return GLM_CONFIG;
  if (haystack.includes("qwen") || haystack.includes("dashscope") || haystack.includes("bailian")) return QWEN_CONFIG;
  if (haystack.includes("minimax")) return MINIMAX_CONFIG;
  if (haystack.includes("mimo")) return MIMO_CONFIG;

  return null;
}
```

### 6.5 聚合平台特殊处理

同一模型在不同平台参数可能完全不同，必须优先按平台标识判定：

| 平台 | 特征 | thinking 参数 |
|------|------|--------------|
| **SiliconFlow** | `siliconflow` / `siliconflow.cn` | `enable_thinking: true` |
| **OpenRouter** | `openrouter` | `reasoning: {effort: "medium"}` |
| NewAPI / One API | 自部署网关 | 回退到模型名推断 |

---

## 七、认证信息注入

### 7.1 认证策略

| 策略 | 头部格式 | 适用场景 |
|------|---------|---------|
| `Bearer` | `Authorization: Bearer <key>` | 国产模型通用 |
| `XApiKey` | `x-api-key: <key>` | Anthropic 原生 |
| `GitHubCopilot` | `Authorization: Bearer <copilot-token>` | 动态获取 Copilot token |
| `CodexOAuth` | `Authorization: Bearer <access_token>` | ChatGPT Plus OAuth |

### 7.2 认证头替换流程

```typescript
async function injectAuth(headers: Headers, provider: Provider): Promise<Headers> {
  // 1. 从 Provider 配置提取真实 API Key
  const auth = extractAuth(provider);

  // 2. 动态 token 刷新
  if (auth.strategy === "GitHubCopilot") {
    auth.apiKey = await copilotAuthManager.getValidToken(accountId);
  }
  if (auth.strategy === "CodexOAuth") {
    auth.apiKey = await codexOAuthManager.getAccessToken();
    headers.set("ChatGPT-Account-Id", accountId);
  }

  // 3. 移除客户端占位头 → 注入真实头
  headers.delete("authorization");
  headers.set("Authorization", `Bearer ${auth.apiKey}`);
  return headers;
}
```

### 7.3 Codex OAuth 特殊处理（新增）

Codex OAuth 需要额外注入会话头：

```typescript
// Codex OAuth 额外头部
headers.set("ChatGPT-Account-Id", accountId);
headers.set("session_id", sessionId);
headers.set("x-client-request-id", generateUUID());
headers.set("x-codex-window-id", windowId);
```

---

## 八、URL 构建与请求转发

### 8.1 URL 构建

```typescript
function buildUpstreamUrl(provider: Provider, endpoint: string, needsChatConversion: boolean): string {
  const baseUrl = extractBaseUrl(provider).replace(/\/+$/, '');
  const isFullUrl = provider.meta?.is_full_url ?? false;

  // base_url 已是完整端点 → 直接使用
  if (isFullUrl) return baseUrl;

  // base_url 已以 /chat/completions 结尾 → 直接使用
  if (needsChatConversion && baseUrl.toLowerCase().endsWith('/chat/completions')) return baseUrl;

  // 正常拼接
  const effectiveEndpoint = needsChatConversion ? '/v1/chat/completions' : endpoint;
  return `${baseUrl}${effectiveEndpoint}`;
}
```

### 8.2 请求转发流程

```typescript
async function forward(appType, method, provider, endpoint, body, headers, providers) {
  // 1. 获取适配器
  const adapter = getAdapter(appType);

  // 2. 提取 base_url
  let baseUrl = adapter.extractBaseUrl(provider);

  // 3. 模型映射
  let mappedBody = applyModelMapping(body, provider);

  // 4. 判断是否需要协议转换
  const needsConvert = shouldConvertResponsesToChat(provider, endpoint);

  // 5. 构建请求体
  let requestBody;
  if (needsConvert) {
    // 补全 function_call 历史
    codexChatHistory.enrichRequest(mappedBody);
    // 替换模型名
    applyCodexChatUpstreamModel(provider, mappedBody);
    // 推理配置
    const reasoningConfig = resolveCodexChatReasoningConfig(provider, mappedBody);
    // 构建工具上下文
    const toolContext = buildCodexToolContextFromRequest(mappedBody);
    // 转换
    requestBody = responsesToChatCompletionsWithReasoning(mappedBody, reasoningConfig, toolContext);
  } else {
    requestBody = mappedBody;
  }

  // 6. 构建 URL + 注入认证 + 转发
  const url = buildUpstreamUrl(provider, endpoint, needsConvert);
  const authHeaders = injectAuth(headers, provider);
  return await httpClient.post(url, requestBody, authHeaders);
}
```

### 8.3 超时设置

| 场景 | 超时 | 处理 |
|------|------|------|
| 非流式请求 | 120s | 等待完整响应 |
| 流式请求首字节 | 60s | 等待第一个 SSE chunk |
| 上游 5xx / 超时 | — | 故障转移到下一个 provider |
| 上游 4xx（客户端错误） | — | 直接返回，不污染熔断器 |

---

## 九、请求历史恢复（Chat History Store）

### 9.1 问题

Codex SDK 使用 `previous_response_id` 引用上一轮的工具调用结果。Chat Completions 协议没有 response ID，需要恢复完整的 assistant message（含 tool_calls）。

### 9.2 扩展的工具类型支持（新增）

历史缓存现在支持 3 种工具调用类型：

| 工具类型 | 调用 item type | 输出 item type |
|---------|---------------|---------------|
| function | `function_call` | `function_call_output` |
| custom | `custom_tool_call` | `custom_tool_call_output` |
| tool_search | `tool_search_call` | `tool_search_output` |

### 9.3 数据结构

```typescript
class ChatHistoryStore {
  // response_id → 该 response 中所有工具调用的缓存
  private responses: Map<string, CachedResponse> = new Map();
  // call_id → response_id 反向索引（fallback 查找）
  private callIndex: Map<string, string[]> = new Map();
  private maxCached = 512;
}
```

### 9.4 核心操作

```typescript
class ChatHistoryStore {
  // ── 记录：每次收到上游响应后调用 ──
  recordResponse(responseId: string, output: any[]): void {
    const calls = output.filter(item =>
      ["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)
    );
    // 缓存到 responses map 和 callIndex 反向索引
  }

  // ── 补全：发送请求前调用 ──
  enrichRequest(body: any): number {
    const previousResponseId = body.previous_response_id;
    for (const item of body.input) {
      if (isFunctionCallOutput(item.type)) {
        const call = this.lookupCall(previousResponseId, item.call_id);
        if (call) {
          // 在 output 前插入对应的工具调用
          body.input.splice(body.input.indexOf(item), 0, call);
        }
      }
    }
  }

  // ── 推理内容补全（新增）───
  enrichCallItemReasoning(body: any): void {
    // 为已存在的 call item 补全 reasoning_content 字段
    // DeepSeek 等模型要求 assistant message 中的 tool_call 携带推理内容
  }
}
```

---

## 十、错误处理与容错机制

### 10.1 智能错误分类（新增）

```typescript
enum ErrorCategory { Retryable, NonRetryable, ClientAbort }

function categorizeError(error: ProxyError): ErrorCategory {
  if (error instanceof Timeout || error instanceof ForwardFailed) return Retryable;
  if (error.status >= 500) return Retryable;

  // 客户端错误不重试，不污染熔断器
  const nonRetryableStatuses = [400, 405, 406, 413, 414, 415, 422, 501];
  if (nonRetryableStatuses.includes(error.status)) return NonRetryable;

  return Retryable;
}
```

### 10.2 媒体内容整流（新增）

当文本模型收到图片输入时：

```typescript
// 1. 发送前预防：检测模型是否支持媒体，不支持则降级（移除图片）
applyMediaPrevention(body, provider);

// 2. 发送后重试：上游返回媒体相关错误时，降级后重试同一 provider
if (mediaRetryShouldTrigger(error)) {
  body = degradeMediaContent(body);  // 移除图片，保留文本
  return retrySameProvider(body);    // 不计入故障转移
}
```

### 10.3 SSE 响应容错（新增）

处理上游 Content-Type 标注错误等边界情况：

```typescript
// 检测响应体是否实际为 SSE（即使 Content-Type 不是 text/event-stream）
function bodyLooksLikeSse(body: string): boolean {
  return body.startsWith("data: ") || body.startsWith("event: ");
}

// SSE 聚合为完整 JSON（非流式回退）
function sseToResponseValue(sseBody: string): any {
  // 处理 BOM、CRLF、截断的尾部块、空错误占位符
  // Azure content-filter 占位值
}
```

### 10.4 ActiveConnectionGuard（新增）

```typescript
// RAII 守卫：确保流式响应期间 active_connections 计数准确
class ActiveConnectionGuard {
  constructor(status: ProxyStatus) {
    status.activeConnections++;  // 构造时 +1
  }

  // 析构时 -1（流式 body 结束时才触发）
  destructor() {
    this.status.activeConnections--;
  }
}
```

---

## 十一、完整请求处理流程

```
Codex SDK → POST /v1/responses (stream=true)
  │
  ▼
┌─ 路由层 ──────────────────────────────────────────────┐
│  匹配 /v1/responses → handle_responses                │
└───────────────────────────────────────────────────────┘
  │
  ▼
┌─ 上下文初始化 ────────────────────────────────────────┐
│  RequestContext::new()                                 │
│  ├── ProviderRouter::select_providers()                │
│  │   ├── 故障转移开启 → 按优先级排序 + 熔断器检查       │
│  │   └── 故障转移关闭 → 仅当前 provider                 │
│  └── 提取 model, session_id                            │
└───────────────────────────────────────────────────────┘
  │
  ▼
┌─ 请求转发（带故障转移）────────────────────────────────┐
│  for provider in providers:                            │
│  ├── 检查熔断器                                        │
│  ├── 模型映射 (apply_model_mapping)                    │
│  ├── 媒体预防 (apply_media_prevention) ★新增           │
│  ├── 协议判断: should_convert_responses_to_chat?       │
│  │                                                     │
│  ├── [协议转换流程]                                     │
│  │   ├── enrich_request() → 补全 function_call 历史     │
│  │   ├── enrich_call_item_reasoning() → 补全推理内容 ★  │
│  │   ├── apply_codex_chat_upstream_model() → 替换模型名 │
│  │   ├── resolve_codex_chat_reasoning_config() → 推理参数│
│  │   ├── build_codex_tool_context_from_request() → 工具桥│
│  │   └── responses_to_chat_completions_with_reasoning() │
│  │                                                     │
│  ├── 构建 URL + 注入认证                                │
│  ├── HTTP POST → 上游                                  │
│  │                                                     │
│  ├── 成功 → 记录熔断器 + ActiveConnectionGuard          │
│  └── 失败 → categorize_error()                         │
│       ├── Retryable → 记录熔断器，下一个 provider        │
│       ├── NonRetryable → 直接返回客户端 ★新增           │
│       └── Media 相关 → 降级重试同一 provider ★新增      │
└───────────────────────────────────────────────────────┘
  │
  ▼
┌─ 响应处理 ────────────────────────────────────────────┐
│  [需要协议转换]                                         │
│  ├── create_responses_sse_stream_from_chat_with_context│
│  │   ├── 状态机（含 tool_context）逐 chunk 处理          │
│  │   ├── function → response.function_call_* 事件      │
│  │   ├── custom → response.custom_tool_call_input_* ★  │
│  │   ├── reasoning → reasoning output item             │
│  │   ├── 内联 <think> → 拆分 reasoning/text ★              │
│  │   └── 缓存工具调用到 ChatHistoryStore                │
│  └── 返回 Responses SSE 流给 Codex SDK                 │
│                                                        │
│  [透传模式]                                             │
│  └── 直接转发上游 Responses SSE 流                      │
└───────────────────────────────────────────────────────┘
```

---

## 十二、接入建议与参考文件清单

### 12.1 最小可行版本（MVP）

| 优先级 | 模块 | 说明 |
|--------|------|------|
| P0 | 本地 HTTP 服务器 | Express/Hono/Fastify 监听一个端口 |
| P0 | 请求转换（Responses → Chat） | 第四节 4.1，含工具类型转换 |
| P0 | 流式响应转换（Chat SSE → Responses SSE） | 第四节 4.2 状态机，最复杂 |
| P1 | CodexToolContext | 第五节，处理 function/namespace/custom/tool_search |
| P1 | 推理配置 | 第六节，按目标模型配置 |
| P1 | 认证注入 | 第七节 |
| P1 | 历史恢复 | 第九节，含 extended item types |
| P2 | 熔断 / 故障转移 | 第十节 |
| P2 | 媒体整流 | 第十节 10.2 |
| P2 | SSE 容错 | 第十节 10.3 |

### 12.2 接入步骤

```
Step 1: 启动本地 HTTP 服务器
Step 2: 配置 Codex SDK → OPENAI_BASE_URL=http://127.0.0.1:PORT
Step 3: 实现 /v1/responses 路由 + Responses→Chat 转换
Step 4: 实现流式 Chat SSE→Responses SSE 转换状态机
Step 5: 实现 CodexToolContext（4 种工具类型桥接）
Step 6: 添加推理参数支持 + ChatHistoryStore
Step 7: 添加错误分类 + 媒体整流 + SSE 容错
```

### 12.3 CC Switch 参考文件清单

**核心转换模块（必读）：**

| 文件 | 说明 |
|------|------|
| `src-tauri/src/proxy/providers/transform_codex_chat.rs` | **协议转换核心**：`CodexToolContext`, `responses_to_chat_completions_with_reasoning()`, 4 种工具类型处理 |
| `src-tauri/src/proxy/providers/streaming_codex_chat.rs` | **流式转换核心**：`ChatToResponsesState` 状态机（含 `tool_context`），custom tool 事件 |
| `src-tauri/src/proxy/providers/codex.rs` | **路由判断 + 推理配置**：`should_convert_codex_responses_to_chat()`, `infer_codex_chat_reasoning_config()`（含 StepFun） |
| `src-tauri/src/proxy/providers/codex_chat_history.rs` | **历史缓存**：扩展支持 function_call/custom_tool_call/tool_search_call |
| `src-tauri/src/proxy/providers/codex_chat_common.rs` | 公共工具函数：reasoning 解析、think 标签拆分 |

**转发与路由：**

| 文件 | 说明 |
|------|------|
| `src-tauri/src/proxy/forwarder.rs` | 请求转发 + 故障转移 + `ActiveConnectionGuard` + 媒体整流 + 错误分类 |
| `src-tauri/src/proxy/handlers.rs` | 请求处理器：`handle_responses()`, `handle_responses_compact()`, SSE 聚合回退 |
| `src-tauri/src/proxy/server.rs` | 代理服务器 + `build_router()` 路由注册 |
| `src-tauri/src/proxy/provider_router.rs` | Provider 路由选择 + 熔断器 |
| `src-tauri/src/proxy/circuit_breaker.rs` | 熔断器实现（Closed→Open→HalfOpen） |

**认证与模型：**

| 文件 | 说明 |
|------|------|
| `src-tauri/src/proxy/providers/auth.rs` | `AuthInfo`, `AuthStrategy` 枚举 |
| `src-tauri/src/proxy/providers/adapter.rs` | `ProviderAdapter` trait |
| `src-tauri/src/proxy/providers/codex_oauth_auth.rs` | Codex OAuth 认证流程 ★新增 |
| `src-tauri/src/proxy/providers/copilot_auth.rs` | GitHub Copilot 认证 ★新增 |
| `src-tauri/src/proxy/model_mapper.rs` | 模型映射（haiku/sonnet/opus） |

**文档与配置：**

| 文件 | 说明 |
|------|------|
| `docs/proxy-guide-zh.md` | 用户文档 |
| `cc-switch-main/src/config/universalProviderPresets.ts` | 国产模型预设配置 |
