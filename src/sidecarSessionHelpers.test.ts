import { describe, expect, it } from 'vitest';

import {
  buildMcpInstructions,
  getProviderMode,
  shouldUseCodexChatCompatProxy,
} from '../src-tauri/sidecar/src/sessionRuntimeHelpers';
import {
  buildCodexResultEvent,
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
  it('includes server instructions without forcing WaitForMcpServers first', () => {
    const text = buildMcpInstructions(
      { context7: {}, filesystem: {} },
      { context7: 'Use for docs lookups.' },
      false,
    );

    expect(text).toContain('## context7');
    expect(text).toContain('Use for docs lookups.');
    expect(text).toContain('MCP servers available: context7, filesystem.');
    expect(text).not.toContain('Before using any MCP tool, call WaitForMcpServers first.');
  });

  it('mentions limited provider mode when deferred tool search is unavailable', () => {
    const text = buildMcpInstructions(
      { context7: {} },
      {},
      true,
    );

    expect(text).toContain('Tool discovery may be limited on this provider.');
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
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 12,
        cache_read_input_tokens: 3,
      },
    });
  });
});
