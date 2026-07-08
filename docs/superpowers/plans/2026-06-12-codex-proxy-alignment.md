# Codex 代理对齐 CC Switch 指导文档 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CodeMUX 的 Codex 兼容代理模块化重构，对齐 CC Switch 指导文档，支持全模型族推理参数和流式 `<think>` 标签检测。

**Architecture:** 将现有单体 `codexChatCompat.ts` 拆分为 4 个职责单一的新模块（推理配置、请求转换、流式转换、历史缓存），增强 `codexCompatProxy.ts` 的超时和错误处理。数据流：SDK Request → proxy routing → request transform（含推理注入）→ upstream fetch → stream transform（含 <think> 检测）→ SSE to SDK。

**Tech Stack:** TypeScript, Node.js HTTP server, Vitest, @openai/codex-sdk types

**设计文档:** `docs/superpowers/specs/2026-06-12-codex-proxy-alignment-design.md`

**指导文档:** `docs/codex-routing-proxy-guide.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src-tauri/sidecar/src/codexReasoning.ts` | 推理配置推断 + 请求参数注入 |
| `src-tauri/sidecar/src/codexReasoning.test.ts` | 推理模块单元测试 |
| `src-tauri/sidecar/src/codexRequestTransform.ts` | Responses → Chat 请求转换（增强版） |
| `src-tauri/sidecar/src/codexRequestTransform.test.ts` | 请求转换单元测试 |
| `src-tauri/sidecar/src/codexStreamTransform.ts` | Chat SSE → Responses SSE 流转换（含 <think> 检测） |
| `src-tauri/sidecar/src/codexStreamTransform.test.ts` | 流式转换单元测试 |
| `src-tauri/sidecar/src/codexHistory.ts` | function_call 历史缓存（增强版） |
| `src-tauri/sidecar/src/codexHistory.test.ts` | 历史缓存单元测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src-tauri/sidecar/src/codexCompatProxy.ts` | 改为调用新模块，增加超时和错误分类 |
| `src-tauri/sidecar/src/codexCompatProxy.test.ts` | 更新集成测试 |

### 保留不变

| 文件 | 说明 |
|------|------|
| `src-tauri/sidecar/src/codexChatCompat.ts` | 保留现有函数供兼容，新代码不依赖它 |
| `src-tauri/sidecar/src/sessionRuntimeHelpers.ts` | 路由判断不变 |
| `src-tauri/sidecar/src/proxyManager.ts` | 代理生命周期管理不变 |

---

## Task 1: codexReasoning.ts — 推理配置模块

**Files:**
- Create: `src-tauri/sidecar/src/codexReasoning.ts`
- Test: `src-tauri/sidecar/src/codexReasoning.test.ts`

- [ ] **Step 1: Write tests for reasoning config inference**

```typescript
// src-tauri/sidecar/src/codexReasoning.test.ts
import { describe, expect, it } from 'vitest';
import { inferReasoningConfig, applyReasoningOptions } from './codexReasoning.js';

describe('inferReasoningConfig', () => {
  it('returns DeepSeek config for deepseek model', () => {
    const config = inferReasoningConfig('deepseek-chat', 'https://api.deepseek.com/v1', '');
    expect(config).toEqual({
      supports_thinking: true,
      supports_effort: true,
      thinking_param: 'thinking',
      effort_param: 'reasoning_effort',
      effort_value_mode: 'deepseek',
      output_format: 'reasoning_content',
    });
  });

  it('returns MiMo config for mimo model', () => {
    const config = inferReasoningConfig('mimo-v2.5-pro', 'https://api.example.com/v1', '');
    expect(config).toEqual({
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    });
  });

  it('returns Qwen config for qwen model', () => {
    const config = inferReasoningConfig('qwen-plus', 'https://dashscope.aliyuncs.com/v1', '');
    expect(config).toEqual({
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'enable_thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    });
  });

  it('returns Kimi config for moonshot model', () => {
    const config = inferReasoningConfig('moonshot-v1-auto', 'https://api.moonshot.cn/v1', '');
    expect(config?.thinking_param).toBe('thinking');
    expect(config?.output_format).toBe('reasoning_content');
  });

  it('returns MiniMax config with reasoning_split', () => {
    const config = inferReasoningConfig('MiniMax-Text-01', 'https://api.minimax.chat/v1', '');
    expect(config?.thinking_param).toBe('reasoning_split');
    expect(config?.output_format).toBe('reasoning_details');
  });

  it('returns GLM config for zhipu model', () => {
    const config = inferReasoningConfig('glm-4-plus', 'https://open.bigmodel.cn/api/paas/v4', '');
    expect(config?.thinking_param).toBe('thinking');
    expect(config?.output_format).toBe('reasoning_content');
  });

  it('returns StepFun config with effort support', () => {
    const config = inferReasoningConfig('step-3.5-flash-2603', 'https://api.stepfun.com/v1', '');
    expect(config?.thinking_param).toBe('none');
    expect(config?.supports_effort).toBe(true);
    expect(config?.effort_value_mode).toBe('low_high');
    expect(config?.output_format).toBe('reasoning');
  });

  it('returns SiliconFlow platform config overriding model name', () => {
    const config = inferReasoningConfig('deepseek-ai/DeepSeek-R1', 'https://api.siliconflow.cn/v1', '');
    expect(config?.thinking_param).toBe('enable_thinking');
    expect(config?.output_format).toBe('reasoning_content');
  });

  it('returns OpenRouter platform config', () => {
    const config = inferReasoningConfig('deepseek/deepseek-r1', 'https://openrouter.ai/api/v1', '');
    expect(config?.thinking_param).toBe('none');
    expect(config?.effort_param).toBe('reasoning');
    expect(config?.output_format).toBe('reasoning');
  });

  it('returns null for unknown model', () => {
    const config = inferReasoningConfig('gpt-4o', 'https://api.openai.com/v1', '');
    expect(config).toBeNull();
  });

  it('matches model name case-insensitively', () => {
    const config = inferReasoningConfig('DeepSeek-R1', 'https://api.deepseek.com/v1', '');
    expect(config?.thinking_param).toBe('thinking');
  });
});

describe('applyReasoningOptions', () => {
  it('injects thinking: {type: "enabled"} for DeepSeek', () => {
    const chatBody: Record<string, unknown> = {};
    const config = inferReasoningConfig('deepseek-chat', 'https://api.deepseek.com/v1', '')!;
    applyReasoningOptions(chatBody, {}, 'deepseek-chat', config);
    expect(chatBody.thinking).toEqual({ type: 'enabled' });
    expect(chatBody.reasoning_effort).toBeUndefined();
  });

  it('injects enable_thinking: true for Qwen', () => {
    const chatBody: Record<string, unknown> = {};
    const config = inferReasoningConfig('qwen-plus', 'https://dashscope.aliyuncs.com/v1', '')!;
    applyReasoningOptions(chatBody, {}, 'qwen-plus', config);
    expect(chatBody.enable_thinking).toBe(true);
  });

  it('injects reasoning_split: true for MiniMax', () => {
    const chatBody: Record<string, unknown> = {};
    const config = inferReasoningConfig('MiniMax-Text-01', 'https://api.minimax.chat/v1', '')!;
    applyReasoningOptions(chatBody, {}, 'MiniMax-Text-01', config);
    expect(chatBody.reasoning_split).toBe(true);
  });

  it('passes through reasoning_effort for DeepSeek when Responses body has effort', () => {
    const chatBody: Record<string, unknown> = {};
    const responsesBody = { reasoning: { effort: 'high' } };
    const config = inferReasoningConfig('deepseek-chat', 'https://api.deepseek.com/v1', '')!;
    applyReasoningOptions(chatBody, responsesBody, 'deepseek-chat', config);
    expect(chatBody.thinking).toEqual({ type: 'enabled' });
    expect(chatBody.reasoning_effort).toBe('high');
  });

  it('maps effort to low/high for StepFun', () => {
    const chatBody: Record<string, unknown> = {};
    const responsesBody = { reasoning: { effort: 'medium' } };
    const config = inferReasoningConfig('step-3.5-flash-2603', 'https://api.stepfun.com/v1', '')!;
    applyReasoningOptions(chatBody, responsesBody, 'step-3.5-flash-2603', config);
    expect(chatBody.reasoning_effort).toBe('low');
  });

  it('passes reasoning_effort through for OpenRouter', () => {
    const chatBody: Record<string, unknown> = {};
    const responsesBody = { reasoning: { effort: 'medium' } };
    const config = inferReasoningConfig('deepseek/deepseek-r1', 'https://openrouter.ai/api/v1', '')!;
    applyReasoningOptions(chatBody, responsesBody, 'deepseek/deepseek-r1', config);
    expect(chatBody.reasoning).toEqual({ effort: 'medium' });
  });

  it('only passes reasoning_effort for o-series when no config', () => {
    const chatBody: Record<string, unknown> = {};
    const responsesBody = { reasoning: { effort: 'high' } };
    applyReasoningOptions(chatBody, responsesBody, 'o4-mini', null);
    expect(chatBody.reasoning_effort).toBe('high');
  });

  it('does nothing for unknown model with no config and no effort', () => {
    const chatBody: Record<string, unknown> = {};
    applyReasoningOptions(chatBody, {}, 'gpt-4o', null);
    expect(Object.keys(chatBody)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri/sidecar && npx vitest run src/codexReasoning.test.ts`
Expected: FAIL — `Cannot find module './codexReasoning.js'`

- [ ] **Step 3: Implement codexReasoning.ts**

```typescript
// src-tauri/sidecar/src/codexReasoning.ts

export interface ReasoningConfig {
  supports_thinking: boolean;
  supports_effort: boolean;
  thinking_param: 'thinking' | 'enable_thinking' | 'reasoning_split' | 'none';
  effort_param: string;       // 'reasoning_effort' | 'reasoning' | 'none'
  effort_value_mode: string;  // 'deepseek' | 'low_high' | 'openrouter' | ''
  output_format: string;      // 'reasoning_content' | 'reasoning' | 'reasoning_details'
}

const CONFIGS: Record<string, ReasoningConfig> = {
  deepseek: {
    supports_thinking: true,
    supports_effort: true,
    thinking_param: 'thinking',
    effort_param: 'reasoning_effort',
    effort_value_mode: 'deepseek',
    output_format: 'reasoning_content',
  },
  kimi: {
    supports_thinking: true,
    supports_effort: false,
    thinking_param: 'thinking',
    effort_param: 'none',
    effort_value_mode: '',
    output_format: 'reasoning_content',
  },
  qwen: {
    supports_thinking: true,
    supports_effort: false,
    thinking_param: 'enable_thinking',
    effort_param: 'none',
    effort_value_mode: '',
    output_format: 'reasoning_content',
  },
  glm: {
    supports_thinking: true,
    supports_effort: false,
    thinking_param: 'thinking',
    effort_param: 'none',
    effort_value_mode: '',
    output_format: 'reasoning_content',
  },
  minimax: {
    supports_thinking: true,
    supports_effort: false,
    thinking_param: 'reasoning_split',
    effort_param: 'none',
    effort_value_mode: '',
    output_format: 'reasoning_details',
  },
  mimo: {
    supports_thinking: true,
    supports_effort: false,
    thinking_param: 'thinking',
    effort_param: 'none',
    effort_value_mode: '',
    output_format: 'reasoning_content',
  },
  stepfun: {
    supports_thinking: true,
    supports_effort: true,
    thinking_param: 'none',
    effort_param: 'reasoning_effort',
    effort_value_mode: 'low_high',
    output_format: 'reasoning',
  },
};

const PLATFORM_CONFIGS: Array<{ match: (name: string, url: string) => boolean; config: ReasoningConfig }> = [
  {
    match: (name, url) => {
      const id = `${name} ${url}`.toLowerCase();
      return id.includes('siliconflow') || id.includes('siliconflow.cn');
    },
    config: {
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'enable_thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    },
  },
  {
    match: (name, url) => {
      const id = `${name} ${url}`.toLowerCase();
      return id.includes('openrouter');
    },
    config: {
      supports_thinking: true,
      supports_effort: true,
      thinking_param: 'none',
      effort_param: 'reasoning',
      effort_value_mode: 'openrouter',
      output_format: 'reasoning',
    },
  },
];

const MODEL_IDENTIFIERS: Array<{ keywords: string[]; key: string }> = [
  { keywords: ['deepseek'], key: 'deepseek' },
  { keywords: ['kimi', 'moonshot'], key: 'kimi' },
  { keywords: ['qwen', 'dashscope'], key: 'qwen' },
  { keywords: ['glm', 'zhipu'], key: 'glm' },
  { keywords: ['minimax'], key: 'minimax' },
  { keywords: ['mimo'], key: 'mimo' },
  { keywords: ['stepfun', 'step-3.5-flash-2603'], key: 'stepfun' },
];

export function inferReasoningConfig(
  model: string,
  baseUrl: string,
  providerName: string,
): ReasoningConfig | null {
  // Platform-level override takes priority.
  for (const entry of PLATFORM_CONFIGS) {
    if (entry.match(providerName, baseUrl)) {
      return entry.config;
    }
  }

  // Model-family matching.
  const haystack = `${providerName} ${baseUrl} ${model}`.toLowerCase();
  for (const { keywords, key } of MODEL_IDENTIFIERS) {
    if (keywords.some((kw) => haystack.includes(kw))) {
      return CONFIGS[key];
    }
  }

  return null;
}

export function applyReasoningOptions(
  chatBody: Record<string, unknown>,
  responsesBody: Record<string, unknown>,
  model: string,
  config: ReasoningConfig | null,
): void {
  if (!config) {
    // No config — only pass through reasoning_effort for OpenAI o-series.
    if (model.toLowerCase().startsWith('o')) {
      const effort = (responsesBody.reasoning as Record<string, unknown> | undefined)?.effort;
      if (typeof effort === 'string') {
        chatBody.reasoning_effort = effort;
      }
    }
    return;
  }

  // 1. Inject thinking parameter.
  switch (config.thinking_param) {
    case 'thinking':
      chatBody.thinking = { type: 'enabled' };
      break;
    case 'enable_thinking':
      chatBody.enable_thinking = true;
      break;
    case 'reasoning_split':
      chatBody.reasoning_split = true;
      break;
    case 'none':
    default:
      break;
  }

  // 2. Inject effort parameter if supported.
  if (config.supports_effort && config.effort_param !== 'none') {
    const effort = (responsesBody.reasoning as Record<string, unknown> | undefined)?.effort as string | undefined ?? 'medium';
    switch (config.effort_value_mode) {
      case 'deepseek':
        chatBody[config.effort_param] = effort;
        break;
      case 'low_high':
        chatBody[config.effort_param] = effort === 'high' ? 'high' : 'low';
        break;
      case 'openrouter':
        chatBody[config.effort_param] = { effort };
        break;
      default:
        chatBody[config.effort_param] = effort;
        break;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri/sidecar && npx vitest run src/codexReasoning.test.ts`
Expected: All 19 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/codexReasoning.ts src-tauri/sidecar/src/codexReasoning.test.ts
git commit -m "feat(codex): add reasoning config inference for 7 model families + 2 platforms"
```

---

## Task 2: codexHistory.ts — 增强历史缓存

**Files:**
- Create: `src-tauri/sidecar/src/codexHistory.ts`
- Test: `src-tauri/sidecar/src/codexHistory.test.ts`

- [ ] **Step 1: Write tests for enhanced history store**

```typescript
// src-tauri/sidecar/src/codexHistory.test.ts
import { describe, expect, it } from 'vitest';
import { CodexHistoryStore } from './codexHistory.js';

describe('CodexHistoryStore', () => {
  it('stores and retrieves messages by responseId', () => {
    const store = new CodexHistoryStore();
    store.recordResponse('resp_1', [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"/tmp"}' },
    ]);
    const cached = store.lookupCall('resp_1', 'call_1');
    expect(cached).toEqual({
      callId: 'call_1',
      name: 'read_file',
      arguments: '{"path":"/tmp"}',
    });
  });

  it('falls back to callIndex when responseId lookup fails', () => {
    const store = new CodexHistoryStore();
    store.recordResponse('resp_1', [
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
    ]);
    // Lookup with wrong responseId but correct callId
    const cached = store.lookupCall('resp_wrong', 'call_1');
    expect(cached?.name).toBe('shell');
  });

  it('returns null for unknown callId', () => {
    const store = new CodexHistoryStore();
    expect(store.lookupCall('resp_1', 'call_unknown')).toBeNull();
  });

  it('enrichRequest inserts missing function_call before function_call_output', () => {
    const store = new CodexHistoryStore();
    store.recordResponse('resp_1', [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"/tmp"}' },
    ]);

    const input = [
      { type: 'function_call_output', call_id: 'call_1', output: 'file content' },
    ];
    const restored = store.enrichRequest(input, 'resp_1');
    expect(restored).toBe(1);
    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"/tmp"}',
    });
    expect(input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_1',
    });
  });

  it('enrichRequest does not duplicate existing function_call', () => {
    const store = new CodexHistoryStore();
    store.recordResponse('resp_1', [
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
    ]);

    const input = [
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ];
    const restored = store.enrichRequest(input, 'resp_1');
    expect(restored).toBe(0);
    expect(input).toHaveLength(2);
  });

  it('recordStreamingToolCall stores individual tool calls', () => {
    const store = new CodexHistoryStore();
    store.recordStreamingToolCall('resp_1', {
      callId: 'call_1',
      name: 'read_file',
      arguments: '{"path":"/tmp"}',
    });
    const cached = store.lookupCall('resp_1', 'call_1');
    expect(cached?.name).toBe('read_file');
  });

  it('evicts oldest entries when maxEntries exceeded', () => {
    const store = new CodexHistoryStore(2);
    store.recordResponse('resp_1', [{ type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' }]);
    store.recordResponse('resp_2', [{ type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' }]);
    store.recordResponse('resp_3', [{ type: 'function_call', call_id: 'c3', name: 'c', arguments: '{}' }]);

    // resp_1 should be evicted
    expect(store.lookupCall('resp_1', 'c1')).toBeNull();
    // resp_2 and resp_3 should still be there
    expect(store.lookupCall('resp_2', 'c2')).toBeTruthy();
    expect(store.lookupCall('resp_3', 'c3')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri/sidecar && npx vitest run src/codexHistory.test.ts`
Expected: FAIL — `Cannot find module './codexHistory.js'`

- [ ] **Step 3: Implement codexHistory.ts**

```typescript
// src-tauri/sidecar/src/codexHistory.ts

export interface CachedCall {
  callId: string;
  name: string;
  arguments: string;
  reasoningContent?: string;
}

interface CachedResponse {
  callsById: Map<string, CachedCall>;
  callOrder: string[];
}

export class CodexHistoryStore {
  private readonly maxEntries: number;
  private readonly responses = new Map<string, CachedResponse>();
  private readonly callIndex = new Map<string, string[]>();
  private readonly responseOrder: string[] = [];

  constructor(maxEntries = 512) {
    this.maxEntries = maxEntries;
  }

  recordResponse(
    responseId: string,
    items: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>,
  ): void {
    const calls = items
      .filter((item) => item.type === 'function_call' && item.call_id)
      .map((item) => ({
        callId: item.call_id!,
        name: item.name ?? '',
        arguments: item.arguments ?? '',
      }));

    if (calls.length === 0) return;

    const cached: CachedResponse = { callsById: new Map(), callOrder: [] };
    for (const call of calls) {
      cached.callsById.set(call.callId, call);
      cached.callOrder.push(call.callId);

      if (!this.callIndex.has(call.callId)) {
        this.callIndex.set(call.callId, []);
      }
      this.callIndex.get(call.callId)!.push(responseId);
    }

    this.responses.set(responseId, cached);
    this.responseOrder.push(responseId);
    this.evict();
  }

  recordStreamingToolCall(responseId: string, call: CachedCall): void {
    let cached = this.responses.get(responseId);
    if (!cached) {
      cached = { callsById: new Map(), callOrder: [] };
      this.responses.set(responseId, cached);
      this.responseOrder.push(responseId);
    }

    cached.callsById.set(call.callId, call);
    if (!cached.callOrder.includes(call.callId)) {
      cached.callOrder.push(call.callId);
    }

    if (!this.callIndex.has(call.callId)) {
      this.callIndex.set(call.callId, []);
    }
    const index = this.callIndex.get(call.callId)!;
    if (!index.includes(responseId)) {
      index.push(responseId);
    }

    this.evict();
  }

  lookupCall(responseId: string | undefined, callId: string): CachedCall | null {
    // 1. Exact lookup by responseId.
    if (responseId) {
      const cached = this.responses.get(responseId);
      const call = cached?.callsById.get(callId);
      if (call) return call;
    }

    // 2. Fallback: reverse index by callId.
    const responseIds = this.callIndex.get(callId);
    if (responseIds) {
      for (const rid of responseIds) {
        const cached = this.responses.get(rid);
        const call = cached?.callsById.get(callId);
        if (call) return call;
      }
    }

    return null;
  }

  enrichRequest(
    input: Array<Record<string, unknown>>,
    previousResponseId: string | undefined,
  ): number {
    let restored = 0;
    let i = 0;
    while (i < input.length) {
      const item = input[i];
      if (item?.type === 'function_call_output' && typeof item.call_id === 'string') {
        // Check if a function_call already exists right before this output.
        const prev = i > 0 ? input[i - 1] : null;
        const alreadyHasCall = prev?.type === 'function_call' && prev.call_id === item.call_id;

        if (!alreadyHasCall) {
          const call = this.lookupCall(previousResponseId, item.call_id);
          if (call) {
            input.splice(i, 0, {
              type: 'function_call',
              call_id: call.callId,
              name: call.name,
              arguments: call.arguments,
            });
            restored++;
            i++; // Skip the inserted item.
          }
        }
      }
      i++;
    }
    return restored;
  }

  private evict(): void {
    while (this.responseOrder.length > this.maxEntries) {
      const oldest = this.responseOrder.shift()!;
      const cached = this.responses.get(oldest);
      if (cached) {
        for (const callId of cached.callOrder) {
          const index = this.callIndex.get(callId);
          if (index) {
            const idx = index.indexOf(oldest);
            if (idx !== -1) index.splice(idx, 1);
            if (index.length === 0) this.callIndex.delete(callId);
          }
        }
      }
      this.responses.delete(oldest);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri/sidecar && npx vitest run src/codexHistory.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/codexHistory.ts src-tauri/sidecar/src/codexHistory.test.ts
git commit -m "feat(codex): add enhanced history store with per-call caching and enrichRequest"
```

---

## Task 3: codexRequestTransform.ts — 请求转换模块

**Files:**
- Create: `src-tauri/sidecar/src/codexRequestTransform.ts`
- Test: `src-tauri/sidecar/src/codexRequestTransform.test.ts`

- [ ] **Step 1: Write tests for request transform**

```typescript
// src-tauri/sidecar/src/codexRequestTransform.test.ts
import { describe, expect, it } from 'vitest';
import { convertResponsesToChatRequest } from './codexRequestTransform.js';
import { CodexHistoryStore } from './codexHistory.js';
import { inferReasoningConfig } from './codexReasoning.js';

describe('convertResponsesToChatRequest', () => {
  const history = new CodexHistoryStore();

  it('converts basic user message', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      stream: false,
    }, history, null);
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('injects instructions as system message', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      instructions: 'You are helpful.',
      input: [{ role: 'user', content: 'Hi' }],
      stream: false,
    }, history, null);
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('converts function_call input to assistant tool_calls', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"/tmp"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'content' },
      ],
      stream: false,
    }, history, null);
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/tmp"}' },
      }],
    });
    expect(result.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'content',
    });
  });

  it('merges consecutive function_call items into one assistant message', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
        { type: 'function_call', call_id: 'call_2', name: 'write_file', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a' },
        { type: 'function_call_output', call_id: 'call_2', output: 'b' },
      ],
      stream: false,
    }, history, null);
    expect(result.messages[0].tool_calls).toHaveLength(2);
  });

  it('injects stream_options when stream is true', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      stream: true,
    }, history, null);
    expect(result.stream_options).toEqual({ include_usage: true });
  });

  it('does not inject stream_options when stream is false', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      stream: false,
    }, history, null);
    expect(result.stream_options).toBeUndefined();
  });

  it('uses max_completion_tokens for o-series models', () => {
    const result = convertResponsesToChatRequest({
      model: 'o4-mini',
      input: [{ role: 'user', content: 'Hi' }],
      max_output_tokens: 1000,
      stream: false,
    }, history, null);
    expect(result.max_completion_tokens).toBe(1000);
    expect(result.max_tokens).toBeUndefined();
  });

  it('uses max_tokens for non-o-series models', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      max_output_tokens: 1000,
      stream: false,
    }, history, null);
    expect(result.max_tokens).toBe(1000);
    expect(result.max_completion_tokens).toBeUndefined();
  });

  it('converts tool_choice object format', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      tool_choice: { type: 'function', name: 'read_file' },
      stream: false,
    }, history, null);
    expect(result.tool_choice).toEqual({
      type: 'function',
      function: { name: 'read_file' },
    });
  });

  it('passes through string tool_choice as-is', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      tool_choice: 'auto',
      stream: false,
    }, history, null);
    expect(result.tool_choice).toBe('auto');
  });

  it('injects reasoning options for MiMo model', () => {
    const config = inferReasoningConfig('mimo-v2.5-pro', '', '');
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      stream: true,
    }, history, config);
    expect(result.thinking).toEqual({ type: 'enabled' });
  });

  it('converts tools from Responses format to Chat format', () => {
    const result = convertResponsesToChatRequest({
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: 'Hi' }],
      tools: [{
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      stream: false,
    }, history, null);
    expect(result.tools).toEqual([{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri/sidecar && npx vitest run src/codexRequestTransform.test.ts`
Expected: FAIL — `Cannot find module './codexRequestTransform.js'`

- [ ] **Step 3: Implement codexRequestTransform.ts**

```typescript
// src-tauri/sidecar/src/codexRequestTransform.ts
import { applyReasoningOptions, type ReasoningConfig } from './codexReasoning.js';
import type { CodexHistoryStore } from './codexHistory.js';

type JsonRecord = Record<string, unknown>;

type ResponsesInputItem =
  | string
  | {
      type?: string;
      role?: string;
      content?: unknown;
      call_id?: string;
      name?: string;
      arguments?: string;
      output?: unknown;
    };

type ResponsesFunctionTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters?: JsonRecord;
};

type ResponsesRequest = {
  model: string;
  input: ResponsesInputItem | ResponsesInputItem[];
  previous_response_id?: string | null;
  instructions?: string;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  user?: string;
  metadata?: JsonRecord;
  reasoning?: { effort?: string };
  tools?: ResponsesFunctionTool[];
  tool_choice?: string | { type: string; name: string };
};

type ChatToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
};

export type ChatCompletionsRequest = {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  user?: string;
  metadata?: JsonRecord;
  reasoning_effort?: string;
  stream_options?: { include_usage: boolean };
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: JsonRecord } }>;
  tool_choice?: string | { type: string; function: { name: string } };
  thinking?: { type: string };
  enable_thinking?: boolean;
  reasoning_split?: boolean;
  [key: string]: unknown;
};

export function convertResponsesToChatRequest(
  request: ResponsesRequest,
  history: CodexHistoryStore,
  reasoningConfig: ReasoningConfig | null,
): ChatCompletionsRequest {
  // Enrich input with missing function_call items.
  const inputArray = Array.isArray(request.input) ? request.input : [request.input];
  history.enrichRequest(inputArray as Array<Record<string, unknown>>, request.previous_response_id ?? undefined);

  const messages = buildChatMessages(request);

  const tools = request.tools
    ? flattenResponsesTools(request.tools).map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    : undefined;

  const result: ChatCompletionsRequest = {
    model: request.model,
    messages,
    stream: request.stream ?? false,
    temperature: request.temperature,
    top_p: request.top_p,
    user: request.user,
    metadata: request.metadata,
    tools,
  };

  // max_output_tokens → max_tokens or max_completion_tokens.
  if (request.max_output_tokens) {
    if (isOpenAOSeries(request.model)) {
      result.max_completion_tokens = request.max_output_tokens;
    } else {
      result.max_tokens = request.max_output_tokens;
    }
  }

  // tool_choice format conversion.
  if (request.tool_choice) {
    result.tool_choice = convertToolChoice(request.tool_choice);
  }

  // stream_options injection.
  if (result.stream) {
    result.stream_options = { include_usage: true };
  }

  // Reasoning parameter injection.
  applyReasoningOptions(result, request as unknown as JsonRecord, request.model, reasoningConfig);

  return result;
}

function isOpenAOSeries(model: string): boolean {
  return /^o\d/i.test(model);
}

function convertToolChoice(
  toolChoice: string | { type: string; name: string },
): string | { type: string; function: { name: string } } {
  if (typeof toolChoice === 'string') return toolChoice;
  if (toolChoice.type === 'function' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return toolChoice as unknown as string;
}

function buildChatMessages(
  request: Pick<ResponsesRequest, 'input' | 'instructions'>,
): ChatMessage[] {
  const inputItems = Array.isArray(request.input) ? request.input : [request.input];
  const messages = inputItems.flatMap((item) => convertInputItemToChatMessages(item as ResponsesInputItem));

  if (request.instructions && !startsWithSystemMessage(messages)) {
    return [{ role: 'system', content: request.instructions }, ...messages];
  }

  return messages;
}

function convertInputItemToChatMessages(item: ResponsesInputItem): ChatMessage[] {
  if (typeof item === 'string') {
    return [{ role: 'user', content: item }];
  }

  // function_call → assistant message with tool_calls.
  if (item.type === 'function_call' && item.call_id) {
    return [{
      role: 'assistant',
      tool_calls: [{
        id: item.call_id,
        type: 'function',
        function: {
          name: item.name ?? '',
          arguments: item.arguments ?? '',
        },
      }],
    }];
  }

  // function_call_output → tool message.
  if (item.type === 'function_call_output') {
    return [{
      role: 'tool',
      tool_call_id: item.call_id ?? '',
      content: stringifyContent(item.output),
    }];
  }

  // MCP tool result.
  if ((item as any).type === 'mcp_tool_call_output') {
    const rec = item as any;
    return [{
      role: 'tool',
      tool_call_id: rec.call_id ?? '',
      content: stringifyContent(rec.output ?? rec.result),
    }];
  }

  // Command execution result.
  if ((item as any).type === 'command_execution_output') {
    const rec = item as any;
    return [{
      role: 'tool',
      tool_call_id: rec.call_id ?? '',
      content: stringifyContent(rec.output ?? rec.aggregated_output),
    }];
  }

  const role = item.role ?? 'user';
  const content = normalizeContent(item.content);
  return [{ role, content }];
}

function startsWithSystemMessage(messages: ChatMessage[]): boolean {
  const firstRole = messages[0]?.role;
  return firstRole === 'system' || firstRole === 'developer';
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const typed = entry as { type?: string; text?: string; content?: string };
        if (typed.type === 'input_text' || typed.type === 'output_text' || typed.type === 'text') {
          return typed.text ? [typed.text] : [];
        }
        if (typed.type === 'function_call_output') return [];
        return typed.content ? [typed.content] : [];
      })
      .join('');
  }
  if (content == null) return '';
  return String(content);
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  return JSON.stringify(content);
}

function flattenResponsesTools(tools: unknown[]): ResponsesFunctionTool[] {
  const result: ResponsesFunctionTool[] = [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) continue;
    const record = tool as Record<string, unknown>;

    if (record.type === 'namespace' && typeof record.name === 'string' && Array.isArray(record.tools)) {
      for (const child of record.tools) {
        if (typeof child !== 'object' || child === null) continue;
        const childRecord = child as Record<string, unknown>;
        if (childRecord.type === 'function' && typeof childRecord.name === 'string') {
          result.push({
            type: 'function',
            name: `${record.name}__${childRecord.name}`,
            description: typeof childRecord.description === 'string' ? childRecord.description : undefined,
            parameters: typeof childRecord.parameters === 'object' ? childRecord.parameters as JsonRecord : undefined,
          });
        }
      }
    } else if (record.type === 'function' && typeof record.name === 'string') {
      result.push(tool as ResponsesFunctionTool);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri/sidecar && npx vitest run src/codexRequestTransform.test.ts`
Expected: All 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/codexRequestTransform.ts src-tauri/sidecar/src/codexRequestTransform.test.ts
git commit -m "feat(codex): add enhanced request transform with function_call, stream_options, tool_choice"
```

---

## Task 4: codexStreamTransform.ts — 流式转换模块（含 <think> 检测）

**Files:**
- Create: `src-tauri/sidecar/src/codexStreamTransform.ts`
- Test: `src-tauri/sidecar/src/codexStreamTransform.test.ts`

- [ ] **Step 1: Write tests for stream transform with <think> detection**

```typescript
// src-tauri/sidecar/src/codexStreamTransform.test.ts
import { describe, expect, it } from 'vitest';
import { convertChatStreamToResponsesEvents } from './codexStreamTransform.js';

async function collectEvents(chunks: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of chunks) {
    events.push(event);
  }
  return events;
}

async function* makeChunks(items: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const item of items) yield item;
}

const IDS = { responseId: 'resp_1', model: 'test', reasoningId: 'rs_1', messageId: 'msg_1' };

describe('convertChatStreamToResponsesEvents', () => {
  it('emits response.created and response.in_progress', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] },
    ]), IDS));
    expect(events[0].type).toBe('response.created');
    expect(events[1].type).toBe('response.in_progress');
  });

  it('converts text deltas to output_text.delta', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
    ]), IDS));
    const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].delta).toBe('hello');
    expect(textDeltas[1].delta).toBe(' world');
  });

  it('converts reasoning_content deltas', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { reasoning_content: 'let me think...' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ]), IDS));
    const reasoningDeltas = events.filter((e) => e.type === 'response.reasoning_delta');
    expect(reasoningDeltas).toHaveLength(1);
    expect(reasoningDeltas[0].delta).toEqual({ type: 'reasoning_summary_text_delta', text: 'let me think...' });
  });

  it('detects inline <think> tags in content and splits to reasoning + text', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: '<think>plan' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' details</think>answer' }, finish_reason: 'stop' }] },
    ]), IDS));

    const reasoningDeltas = events.filter((e) => e.type === 'response.reasoning_delta');
    const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');

    // Reasoning content: "plan details"
    expect(reasoningDeltas.length).toBeGreaterThanOrEqual(1);
    const reasoningText = reasoningDeltas.map((e) => (e.delta as any).text).join('');
    expect(reasoningText).toContain('plan');
    expect(reasoningText).toContain('details');

    // Text content: "answer"
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    const textContent = textDeltas.map((e) => e.delta).join('');
    expect(textContent).toContain('answer');
  });

  it('handles <think> split across multiple chunks', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: '<think>rea' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'soning</th' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'ink>text' }, finish_reason: 'stop' }] },
    ]), IDS));

    const reasoningDeltas = events.filter((e) => e.type === 'response.reasoning_delta');
    const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(reasoningDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
  });

  it('accumulates tool_calls across chunks', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp"}' } }] }, finish_reason: 'stop' }] },
    ]), IDS));

    const functionCallDone = events.filter((e) => e.type === 'response.function_call_arguments.done');
    expect(functionCallDone).toHaveLength(1);
    expect(functionCallDone[0].arguments).toBe('{"path":"/tmp"}');
  });

  it('emits response.completed with usage', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]), IDS));

    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed).toBeTruthy();
    const response = completed!.response as any;
    expect(response.usage.input_tokens).toBe(10);
    expect(response.usage.output_tokens).toBe(5);
  });

  it('closes items on finish_reason, not just at generator end', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: 'text' }, finish_reason: 'stop' }] },
    ]), IDS));

    // output_item.done for text should exist
    const itemDone = events.filter((e) => e.type === 'response.output_item.done');
    expect(itemDone.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri/sidecar && npx vitest run src/codexStreamTransform.test.ts`
Expected: FAIL — `Cannot find module './codexStreamTransform.js'`

- [ ] **Step 3: Implement codexStreamTransform.ts**

```typescript
// src-tauri/sidecar/src/codexStreamTransform.ts

export type ChatCompletionChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
};

export type ChatStreamToolCall = {
  id: string;
  name: string;
  arguments: string;
};

/**
 * Parse an SSE byte stream into individual ChatCompletionChunk objects.
 */
export async function* parseChatCompletionSseStream(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  let buffer = '';
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try { yield JSON.parse(payload) as ChatCompletionChunk; } catch { /* skip */ }
    }
  }
}

// --- Inline <think> tag detection ---

type ThinkMode = 'detecting' | 'reasoning' | 'text';

interface ThinkState {
  mode: ThinkMode;
  buffer: string;
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
const MAX_TAG_LEN = 7; // length of </think>

function processContentChunk(
  chunk: string,
  state: ThinkState,
): Array<{ type: 'text' | 'reasoning' | 'startReasoning' | 'endReasoning'; text?: string }> {
  const events: Array<{ type: 'text' | 'reasoning' | 'startReasoning' | 'endReasoning'; text?: string }> = [];
  let remaining = chunk;

  while (remaining.length > 0) {
    if (state.mode === 'detecting') {
      state.buffer += remaining;
      remaining = '';

      const thinkIdx = state.buffer.indexOf(THINK_OPEN);
      if (thinkIdx !== -1) {
        const before = state.buffer.slice(0, thinkIdx);
        if (before) events.push({ type: 'text', text: before });
        events.push({ type: 'startReasoning' });
        state.mode = 'reasoning';
        remaining = state.buffer.slice(thinkIdx + THINK_OPEN.length);
        state.buffer = '';
      } else if (state.buffer.length >= MAX_TAG_LEN) {
        const safeLen = state.buffer.length - MAX_TAG_LEN + 1;
        events.push({ type: 'text', text: state.buffer.slice(0, safeLen) });
        state.buffer = state.buffer.slice(safeLen);
      }
    } else if (state.mode === 'reasoning') {
      state.buffer += remaining;
      remaining = '';

      const closeIdx = state.buffer.indexOf(THINK_CLOSE);
      if (closeIdx !== -1) {
        const before = state.buffer.slice(0, closeIdx);
        if (before) events.push({ type: 'reasoning', text: before });
        events.push({ type: 'endReasoning' });
        state.mode = 'text';
        remaining = state.buffer.slice(closeIdx + THINK_CLOSE.length);
        state.buffer = '';
      } else if (state.buffer.length >= MAX_TAG_LEN) {
        const safeLen = state.buffer.length - MAX_TAG_LEN + 1;
        events.push({ type: 'reasoning', text: state.buffer.slice(0, safeLen) });
        state.buffer = state.buffer.slice(safeLen);
      }
    } else {
      if (remaining) events.push({ type: 'text', text: remaining });
      remaining = '';
    }
  }
  return events;
}

/**
 * Convert an upstream Chat Completions SSE stream into Responses API SSE events.
 */
export async function* convertChatStreamToResponsesEvents(
  chunks: AsyncIterable<ChatCompletionChunk>,
  opts: { responseId: string; model: string; reasoningId: string; messageId: string },
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const { responseId, model, reasoningId, messageId } = opts;

  const baseResponse = {
    id: responseId, object: 'response' as const,
    created_at: Math.floor(Date.now() / 1000), model,
    status: 'in_progress' as const, output: [] as unknown[],
  };
  yield { type: 'response.created', response: baseResponse };
  yield { type: 'response.in_progress', response: baseResponse };

  let startedReasoning = false;
  let startedText = false;
  let textContentIndex = 0;
  const toolCalls = new Map<number, ChatStreamToolCall & { reasoningContent: string }>();
  let finishReason: string | null = null;
  let lastUsage: ChatCompletionChunk['usage'] = null;

  const thinkState: ThinkState = { mode: 'detecting', buffer: '' };

  function ensureTextStarted() {
    if (!startedText) {
      startedText = true;
      textContentIndex = startedReasoning ? 1 : 0;
    }
  }

  for await (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    if (!choice) {
      if (chunk.usage) lastUsage = chunk.usage;
      continue;
    }

    const delta = choice.delta;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) lastUsage = chunk.usage;

    // --- Reasoning content (explicit field) ---
    const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? null;
    if (reasoningDelta) {
      if (!startedReasoning) {
        startedReasoning = true;
        yield { type: 'response.output_item.added', output_index: 0,
          item: { type: 'reasoning', id: reasoningId, status: 'in_progress', summary: [] } };
      }
      yield { type: 'response.reasoning_delta', item_id: reasoningId, output_index: 0,
        delta: { type: 'reasoning_summary_text_delta', text: reasoningDelta } };
    }

    // --- Text content (with inline <think> detection) ---
    if (delta.content) {
      const thinkEvents = processContentChunk(delta.content, thinkState);
      for (const evt of thinkEvents) {
        if (evt.type === 'text') {
          ensureTextStarted();
          yield {
            type: 'response.output_text.delta', item_id: messageId,
            output_index: textContentIndex, content_index: 0, delta: evt.text,
          };
        } else if (evt.type === 'reasoning') {
          if (!startedReasoning) {
            startedReasoning = true;
            yield { type: 'response.output_item.added', output_index: 0,
              item: { type: 'reasoning', id: reasoningId, status: 'in_progress', summary: [] } };
          }
          yield { type: 'response.reasoning_delta', item_id: reasoningId, output_index: 0,
            delta: { type: 'reasoning_summary_text_delta', text: evt.text } };
        } else if (evt.type === 'startReasoning') {
          if (!startedReasoning) {
            startedReasoning = true;
            yield { type: 'response.output_item.added', output_index: 0,
              item: { type: 'reasoning', id: reasoningId, status: 'in_progress', summary: [] } };
          }
        }
        // 'endReasoning' — no-op here, handled by close logic below
      }
    }

    // --- Tool call deltas ---
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolCalls.get(idx);
        if (!entry) {
          entry = { id: tc.id ?? `call_${idx}`, name: '', arguments: '', reasoningContent: '' };
          toolCalls.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
      }
    }

    // --- On finish_reason, close open items immediately ---
    if (finishReason) {
      // Flush any remaining think buffer
      if (thinkState.buffer) {
        if (thinkState.mode === 'reasoning') {
          if (!startedReasoning) {
            startedReasoning = true;
            yield { type: 'response.output_item.added', output_index: 0,
              item: { type: 'reasoning', id: reasoningId, status: 'in_progress', summary: [] } };
          }
          yield { type: 'response.reasoning_delta', item_id: reasoningId, output_index: 0,
            delta: { type: 'reasoning_summary_text_delta', text: thinkState.buffer } };
        } else if (thinkState.mode === 'text' || thinkState.mode === 'detecting') {
          ensureTextStarted();
          yield { type: 'response.output_text.delta', item_id: messageId,
            output_index: textContentIndex, content_index: 0, delta: thinkState.buffer };
        }
        thinkState.buffer = '';
      }

      // Close reasoning
      if (startedReasoning) {
        yield { type: 'response.output_text.done', item_id: reasoningId, output_index: 0,
          content_index: 0, text: '' };
        yield { type: 'response.output_item.done', output_index: 0,
          item: { type: 'reasoning', id: reasoningId, status: 'completed', summary: [] } };
      }

      // Close text
      if (startedText) {
        yield { type: 'response.output_text.done', item_id: messageId,
          output_index: textContentIndex, content_index: 0, text: '' };
        yield { type: 'response.content_part.done', item_id: messageId,
          output_index: textContentIndex, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] } };
        yield { type: 'response.output_item.done', output_index: textContentIndex,
          item: { type: 'message', id: messageId, status: 'completed', role: 'assistant', content: [] } };
      }
    }
  }

  // If no finish_reason was received, close items at generator end.
  if (!finishReason) {
    if (thinkState.buffer) {
      if (thinkState.mode === 'reasoning') {
        if (!startedReasoning) {
          startedReasoning = true;
          yield { type: 'response.output_item.added', output_index: 0,
            item: { type: 'reasoning', id: reasoningId, status: 'in_progress', summary: [] } };
        }
        yield { type: 'response.reasoning_delta', item_id: reasoningId, output_index: 0,
          delta: { type: 'reasoning_summary_text_delta', text: thinkState.buffer } };
      } else {
        ensureTextStarted();
        yield { type: 'response.output_text.delta', item_id: messageId,
          output_index: textContentIndex, content_index: 0, delta: thinkState.buffer };
      }
    }

    if (startedReasoning) {
      yield { type: 'response.output_text.done', item_id: reasoningId, output_index: 0,
        content_index: 0, text: '' };
      yield { type: 'response.output_item.done', output_index: 0,
        item: { type: 'reasoning', id: reasoningId, status: 'completed', summary: [] } };
    }

    if (startedText) {
      yield { type: 'response.output_text.done', item_id: messageId,
        output_index: textContentIndex, content_index: 0, text: '' };
      yield { type: 'response.content_part.done', item_id: messageId,
        output_index: textContentIndex, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } };
      yield { type: 'response.output_item.done', output_index: textContentIndex,
        item: { type: 'message', id: messageId, status: 'completed', role: 'assistant', content: [] } };
    }
  }

  // Emit tool call items.
  const baseOutputIndex = startedText ? textContentIndex + 1 : startedReasoning ? 1 : 0;
  for (const [idx, tc] of toolCalls) {
    const outputIndex = baseOutputIndex + idx;
    yield { type: 'response.output_item.added', output_index: outputIndex,
      item: { type: 'function_call', id: tc.id, status: 'in_progress',
        call_id: tc.id, name: tc.name, arguments: '' } };
    yield { type: 'response.function_call_arguments.delta', item_id: tc.id,
      output_index: outputIndex, content_index: 0, delta: tc.arguments };
    yield { type: 'response.function_call_arguments.done', item_id: tc.id,
      output_index: outputIndex, content_index: 0, arguments: tc.arguments };
    yield { type: 'response.output_item.done', output_index: outputIndex,
      item: { type: 'function_call', id: tc.id, status: 'completed',
        call_id: tc.id, name: tc.name, arguments: tc.arguments } };
  }

  // Final completed response.
  const output: unknown[] = [];
  if (startedReasoning) output.push({ type: 'reasoning', id: reasoningId, summary: [] });
  if (startedText) output.push({ type: 'message', id: messageId, status: 'completed', role: 'assistant', content: [] });
  for (const tc of toolCalls.values()) {
    output.push({ type: 'function_call', id: tc.id, status: 'completed',
      call_id: tc.id, name: tc.name, arguments: tc.arguments });
  }

  const finalStatus = toolCalls.size > 0 ? 'requires_action' : 'completed';
  const usage = lastUsage ? {
    input_tokens: lastUsage.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: lastUsage.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: lastUsage.total_tokens ?? 0,
  } : undefined;

  yield { type: 'response.completed',
    response: { ...baseResponse, status: finalStatus, output, ...(usage ? { usage } : {}) } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri/sidecar && npx vitest run src/codexStreamTransform.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/codexStreamTransform.ts src-tauri/sidecar/src/codexStreamTransform.test.ts
git commit -m "feat(codex): add stream transform with inline <think> detection and state machine"
```

---

## Task 5: codexCompatProxy.ts — 重构代理使用新模块

**Files:**
- Modify: `src-tauri/sidecar/src/codexCompatProxy.ts`
- Modify: `src-tauri/sidecar/src/codexCompatProxy.test.ts`

- [ ] **Step 1: Update imports to use new modules**

Replace imports in `codexCompatProxy.ts`:

```typescript
// Old:
import {
  CodexChatHistory,
  buildResponsesSseEvents,
  convertChatCompletionToResponses,
  convertChatStreamToResponsesEvents,
  convertResponsesToChatRequest,
  parseChatCompletionSseStream,
  type ChatStreamToolCall,
} from './codexChatCompat.js';

// New:
import { convertResponsesToChatRequest } from './codexRequestTransform.js';
import { convertChatStreamToResponsesEvents, parseChatCompletionSseStream, type ChatCompletionChunk } from './codexStreamTransform.js';
import { CodexHistoryStore } from './codexHistory.js';
import { inferReasoningConfig } from './codexReasoning.js';
import { CodexChatHistory, convertChatCompletionToResponses, buildResponsesSseEvents } from './codexChatCompat.js';
```

- [ ] **Step 2: Replace CodexChatHistory with CodexHistoryStore in server creation**

```typescript
// Old:
const history = new CodexChatHistory();

// New:
const historyStore = new CodexHistoryStore();
const legacyHistory = new CodexChatHistory(); // Keep for non-streaming path
```

- [ ] **Step 3: Update handleRequest to use new request transform**

```typescript
// Old:
const chatRequest = convertResponsesToChatRequest(requestBody, history);

// New:
const reasoningConfig = inferReasoningConfig(requestBody.model, config.baseUrl, '');
const chatRequest = convertResponsesToChatRequest(requestBody, historyStore, reasoningConfig);
```

- [ ] **Step 4: Add AbortController timeout to fetchChatCompletion**

```typescript
// Add timeout to fetchChatCompletion:
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120_000);
try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify({ ...requestBody, stream: false }),
    signal: controller.signal,
  });
  // ... existing logic
} finally {
  clearTimeout(timeout);
}
```

- [ ] **Step 5: Add timeout to streamChatCompletion**

```typescript
// Add AbortController with 60s first-byte timeout:
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);
const response = await fetch(endpoint, { ..., signal: controller.signal });
clearTimeout(timeout);
// Continue with existing streaming logic...
```

- [ ] **Step 6: Add 4xx/5xx error classification**

```typescript
// In fetchChatCompletion and streamChatCompletion:
if (response.status >= 400 && response.status < 500) {
  const body = await response.text();
  throw new Error(`client error ${response.status}: ${body}`);
}
if (response.status >= 500) {
  lastError = new Error(`server error ${response.status}`);
  continue; // Try next endpoint
}
```

- [ ] **Step 7: Update streaming path to use new stream transform and history**

```typescript
// Replace convertChatStreamToResponsesEvents call with new module:
const responsesEvents = convertChatStreamToResponsesEvents(chunks, {
  responseId, model, reasoningId, messageId,
});

// In the event loop, record tool calls to history:
if (event.type === 'response.output_item.done') {
  const item = event.item as Record<string, unknown> | undefined;
  if (item?.type === 'function_call' && typeof item.call_id === 'string') {
    historyStore.recordStreamingToolCall(responseId, {
      callId: item.call_id as string,
      name: (item.name ?? '') as string,
      arguments: (item.arguments ?? '') as string,
    });
    // Also emit as assistant event (existing logic)
    // ...
  }
}
```

- [ ] **Step 8: Update non-streaming path to use legacy history for compatibility**

The non-streaming path still uses `convertChatCompletionToResponses` from `codexChatCompat.ts` which requires `CodexChatHistory`. Keep using `legacyHistory` for this path.

- [ ] **Step 9: Run all proxy tests**

Run: `cd src-tauri/sidecar && npx vitest run src/codexCompatProxy.test.ts src/codexReasoning.test.ts src/codexHistory.test.ts src/codexRequestTransform.test.ts src/codexStreamTransform.test.ts`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add src-tauri/sidecar/src/codexCompatProxy.ts src-tauri/sidecar/src/codexCompatProxy.test.ts
git commit -m "refactor(codex): proxy uses new modular components with timeouts and error classification"
```

---

## Task 6: 更新集成测试验证 <think> 流式输出

**Files:**
- Modify: `src-tauri/sidecar/src/codexCompatProxy.test.ts`

- [ ] **Step 1: Add integration test for <think> streaming through the proxy**

```typescript
it('splits inline think tags into reasoning and text during streaming', async () => {
  const upstream = createServer(async (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    const send = (data: Record<string, unknown>) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({ id: 'c1', model: 'qwen-plus', choices: [{ delta: { content: '<think>analysis...' }, finish_reason: null }] });
    send({ id: 'c2', model: 'qwen-plus', choices: [{ delta: { content: '</think>here is the answer' }, finish_reason: 'stop' }] });
    send({ id: 'c3', model: 'qwen-plus', choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } });
    res.end('data: [DONE]\n\n');
  });

  const upstreamPort = await listen(upstream);
  cleanups.push(() => closeServer(upstream));

  const proxy = await createCodexCompatProxyServer({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
  }, 0);
  cleanups.push(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen-plus', stream: true, input: [{ role: 'user', content: 'test' }] }),
  });

  const body = await response.text();

  // Should contain reasoning deltas (from <think> content)
  expect(body).toContain('"type":"response.reasoning_delta"');
  // Should contain text deltas (from content after </think>)
  expect(body).toContain('"type":"response.output_text.delta"');
  // Should complete normally
  expect(body).toContain('"type":"response.completed"');
});
```

- [ ] **Step 2: Add test verifying stream_options is injected**

```typescript
it('injects stream_options for upstream requests', async () => {
  let receivedBody: any = null;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('content-type', 'text/event-stream');
    res.end('data: [DONE]\n\n');
  });

  const upstreamPort = await listen(upstream);
  cleanups.push(() => closeServer(upstream));

  const proxy = await createCodexCompatProxyServer({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
  }, 0);
  cleanups.push(() => proxy.close());

  await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mimo-v2.5-pro', stream: true, input: [{ role: 'user', content: 'Hi' }] }),
  });

  expect(receivedBody.stream_options).toEqual({ include_usage: true });
});
```

- [ ] **Step 3: Run all tests**

Run: `cd src-tauri/sidecar && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/sidecar/src/codexCompatProxy.test.ts
git commit -m "test(codex): add integration tests for think tag streaming and stream_options"
```

---

## Task 7: 端到端验证

- [ ] **Step 1: Run full test suite**

Run: `cd D:/project/ai-code/codeMUX && npx vitest run src-tauri/sidecar/src/`
Expected: All sidecar tests PASS

- [ ] **Step 2: Run frontend tests to ensure no regressions**

Run: `cd D:/project/ai-code/codeMUX && npx vitest run src/`
Expected: All frontend tests PASS (excluding pre-existing failures in sidecarSessionHelpers and codexCompatProxy cached artifacts)

- [ ] **Step 3: Final commit with all changes**

```bash
git add -A src-tauri/sidecar/src/codexReasoning* src-tauri/sidecar/src/codexHistory* src-tauri/sidecar/src/codexRequestTransform* src-tauri/sidecar/src/codexStreamTransform* src-tauri/sidecar/src/codexCompatProxy*
git commit -m "feat(codex): modular proxy aligned with CC Switch guide - reasoning, history, stream transform"
```
