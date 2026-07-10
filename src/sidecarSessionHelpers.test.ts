import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildMcpInstructions,
  getProviderMode,
  shouldUseCodexChatCompatProxy,
} from '../src-tauri/sidecar/src/sessionRuntimeHelpers';
import {
  buildCodexResultEvent,
  normalizeClaudeResultEvent,
  getRuntimeFlavor,
} from '../src-tauri/sidecar/src/runtimeEvents';

describe('getProviderMode', () => {
  it('treats the default Anthropic endpoint as deferred-capable', () => {
    expect(getProviderMode(undefined)).toEqual({
      providerMode: 'anthropic',
      supportsDeferredToolSearch: true,
    });

    expect(getProviderMode('https://api.anthropic.com')).toEqual({
      providerMode: 'anthropic',
      supportsDeferredToolSearch: true,
    });
  });

  it('treats custom base urls as limited-provider mode', () => {
    expect(getProviderMode('https://example-proxy.internal/anthropic')).toEqual({
      providerMode: 'custom',
      supportsDeferredToolSearch: false,
    });
  });
});

describe('buildMcpInstructions', () => {
  it('returns undefined — probe-derived MCP instructions are no longer injected', () => {
    expect(buildMcpInstructions()).toBeUndefined();
  });
});

describe('shouldUseCodexChatCompatProxy', () => {
  it('uses the local chat-compat proxy for non-OpenAI providers', () => {
    expect(shouldUseCodexChatCompatProxy('https://api.deepseek.com')).toBe(true);
    expect(shouldUseCodexChatCompatProxy('https://token-plan-cn.xiaomimimo.com/v1')).toBe(true);
    expect(shouldUseCodexChatCompatProxy('https://openrouter.ai/api/v1')).toBe(true);
  });

  it('keeps direct Responses mode for the official OpenAI endpoint', () => {
    expect(shouldUseCodexChatCompatProxy(undefined)).toBe(false);
    expect(shouldUseCodexChatCompatProxy('https://api.openai.com/v1')).toBe(false);
    expect(shouldUseCodexChatCompatProxy('https://api.openai.com')).toBe(false);
  });

  it('honors an explicit provider proxy override', () => {
    expect(shouldUseCodexChatCompatProxy('https://openrouter.ai/api/v1', false)).toBe(false);
    expect(shouldUseCodexChatCompatProxy('https://api.openai.com/v1', true)).toBe(true);
  });
});

describe('getRuntimeFlavor', () => {
  it('routes Claude and Codex to different runtime flavors', () => {
    expect(getRuntimeFlavor('claude_code')).toBe('claude');
    expect(getRuntimeFlavor('codex')).toBe('codex');
  });

  it('defaults to Claude for unknown or missing agent kinds', () => {
    expect(getRuntimeFlavor(undefined)).toBe('claude');
    expect(getRuntimeFlavor('gemini_cli')).toBe('claude');
    expect(getRuntimeFlavor('')).toBe('claude');
  });
});

describe('buildCodexResultEvent', () => {
  it('maps Codex usage fields into the existing result event shape', () => {
    expect(
      buildCodexResultEvent({
        sessionId: 'session-1',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 3,
          output_tokens: 5,
          reasoning_output_tokens: 7,
        },
        durationMs: 42,
      }),
    ).toEqual({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'session-1',
      uuid: expect.any(String),
      duration_ms: 42,
      duration_api_ms: 42,
      num_turns: 1,
      result: 'ok',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
      },
      last_token_usage: {
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 3,
        total_tokens: 15,
      },
    });
  });

  it('uses explicit last token usage when SDK usage is cumulative', () => {
    expect(
      buildCodexResultEvent({
        sessionId: 'session-1',
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 300,
          output_tokens: 500,
          reasoning_output_tokens: 70,
        },
        lastTokenUsage: {
          input_tokens: 10,
          cached_input_tokens: 3,
          output_tokens: 5,
          reasoning_output_tokens: 7,
          total_tokens: 25,
        },
        durationMs: 42,
      }),
    ).toEqual({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'session-1',
      uuid: expect.any(String),
      duration_ms: 42,
      duration_api_ms: 42,
      num_turns: 1,
      result: 'ok',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 300,
      },
      last_token_usage: {
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 3,
        total_tokens: 25,
      },
    });
  });
});

describe('normalizeClaudeResultEvent', () => {
  it('keeps SDK result usage when it is already present', () => {
    expect(normalizeClaudeResultEvent({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 61_541,
        output_tokens: 58,
        cache_read_input_tokens: 71,
        cache_creation_input_tokens: 0,
      },
    })).toMatchObject({
      usage: {
        input_tokens: 61_541,
        output_tokens: 58,
        cache_read_input_tokens: 71,
        cache_creation_input_tokens: 0,
      },
    });
  });

  it('normalizes SDK result modelUsage into the existing usage shape without treating it as context usage', () => {
    const normalized = normalizeClaudeResultEvent({
      type: 'result',
      subtype: 'success',
      usage: null,
      modelUsage: {
        'glm-4.7-flash': {
          inputTokens: 61_541,
          outputTokens: 58,
          cacheReadInputTokens: 71,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 258_400,
          maxOutputTokens: 8_192,
        },
      },
    });

    expect(normalized).toMatchObject({
      usage: {
        input_tokens: 61_541,
        output_tokens: 58,
        cache_read_input_tokens: 71,
        cache_creation_input_tokens: 0,
      },
    });
    expect(normalized).not.toHaveProperty('token_usage');
    expect(normalized).not.toHaveProperty('model_context_window');
  });

  it('does not create a context snapshot from SDK modelUsage alone', () => {
    const normalized = normalizeClaudeResultEvent({
      type: 'result',
      subtype: 'success',
      usage: null,
      modelUsage: {
        'glm-4.7-flash': {
          inputTokens: 61_541,
          outputTokens: 58,
          cacheReadInputTokens: 71,
          cacheCreationInputTokens: 0,
          contextWindow: 258_400,
        },
      },
    });

    expect(normalized).toMatchObject({
      usage: {
        input_tokens: 61_541,
        output_tokens: 58,
        cache_read_input_tokens: 71,
      },
    });
    expect(normalized).not.toHaveProperty('token_usage');
  });

  it('keeps aggregate result usage and does not emit token_usage from assistant fallback', () => {
    const normalized = normalizeClaudeResultEvent({
      type: 'result',
      subtype: 'success',
      usage: null,
      modelUsage: {
        'glm-4.7-flash': {
          inputTokens: 150_000,
          outputTokens: 2_000,
          cacheReadInputTokens: 10_000,
          cacheCreationInputTokens: 0,
          contextWindow: 258_400,
        },
      },
    }, {
      input_tokens: 11_464,
      output_tokens: 607,
      cache_read_input_tokens: 49_537,
      cache_creation_input_tokens: 0,
    });

    expect(normalized).toMatchObject({
      usage: {
        input_tokens: 150_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 10_000,
      },
    });
    expect(normalized).not.toHaveProperty('token_usage');
    expect(normalized).not.toHaveProperty('model_context_window');
  });

  it('falls back to the last non-zero assistant usage when result usage is absent', () => {
    expect(normalizeClaudeResultEvent({
      type: 'result',
      subtype: 'success',
    }, {
      input_tokens: 11_464,
      output_tokens: 607,
      cache_read_input_tokens: 49_537,
      cache_creation_input_tokens: 0,
    })).toMatchObject({
      usage: {
        input_tokens: 11_464,
        output_tokens: 607,
        cache_read_input_tokens: 49_537,
        cache_creation_input_tokens: 0,
      },
    });
  });
});

describe('legacy Claude context display channel', () => {
  it('does not keep legacy Claude context display probes in sidecar runtime', () => {
    const sidecarDir = join(process.cwd(), 'src-tauri', 'sidecar', 'src');
    const index = readFileSync(join(sidecarDir, 'index.ts'), 'utf8');
    const runtimeEvents = readFileSync(join(sidecarDir, 'runtimeEvents.ts'), 'utf8');

    expect(index).not.toContain('fetchClaudeContextCommandUsageSnapshot');
    expect(index).not.toContain('buildClaudeTokenUsageUpdateEvent');
    expect(runtimeEvents).not.toContain('buildClaudeTokenUsageUpdateEvent');
    expect(runtimeEvents).not.toContain('extractClaudeContextUsageSnapshot');
  });
});
