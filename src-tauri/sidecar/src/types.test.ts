import { describe, expect, it } from 'vitest';

import type {
  OpenCodeSessionConfig,
  OpenCodeSessionMapping,
  RuntimeEventContext,
  SidecarCommand,
} from './types.js';
import { buildOpenCodeResultEvent, getRuntimeFlavor } from './runtimeEvents.js';

describe('OpenCode runtime contract', () => {
  it('exposes the formal OpenCode permission response command', () => {
    const command: SidecarCommand = { type: 'respond_to_permission', requestId: 'permission-1', sessionId: 'session-1', response: { approved: true } };
    expect(command).toBeDefined();
  });

  it('recognizes the OpenCode runtime flavor', () => {
    expect(getRuntimeFlavor('opencode')).toBe('opencode');
  });

  it('models the OpenCode startup configuration and session mapping', () => {
    const config = {
      cwd: 'D:\\workspace',
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-session-1',
      runtimeGeneration: 1,
      provider: 'openai-compatible',
      model: 'gpt-5',
      credentialSource: 'codemux',
    } satisfies OpenCodeSessionConfig;

    const mapping = {
      sessionId: config.sessionId,
      agentSessionId: config.agentSessionId,
      runtimeGeneration: config.runtimeGeneration,
    } satisfies OpenCodeSessionMapping;

    expect(config).toMatchObject({
      cwd: 'D:\\workspace',
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-session-1',
      runtimeGeneration: 1,
      provider: 'openai-compatible',
      model: 'gpt-5',
      credentialSource: 'codemux',
    });
    expect(mapping).toEqual({
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-session-1',
      runtimeGeneration: 1,
    });
  });

  it('allows startup configuration without an existing OpenCode session', () => {
    const config = {
      cwd: 'D:\\workspace',
      sessionId: 'codemux-session-2',
      runtimeGeneration: 1,
      provider: 'openai-compatible',
      model: 'gpt-5',
      credentialSource: 'codemux',
    } satisfies OpenCodeSessionConfig;

    expect(config.agentSessionId).toBeUndefined();
  });

  it('keeps unified OpenCode result metadata independent from SDK types', () => {
    const context: RuntimeEventContext = {
      agentId: 'opencode',
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-session-1',
      sequence: 7,
    };

    expect(buildOpenCodeResultEvent({
      context,
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cached_input_tokens: 3,
        cache_write_input_tokens: 2,
        reasoning_output_tokens: 5,
      },
      durationMs: 42,
    })).toMatchObject({
      type: 'result',
      agent_id: 'opencode',
      session_id: 'codemux-session-1',
      agent_session_id: 'opencode-session-1',
      sequence: 7,
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_read_input_tokens: 3,
        cache_write_input_tokens: 2,
        reasoning_output_tokens: 5,
      },
      last_token_usage: {
        cached_input_tokens: 3,
        cache_write_input_tokens: 2,
        reasoning_output_tokens: 5,
      },
    });
  });

  it('omits OpenCode session metadata when no session exists yet', () => {
    const event = buildOpenCodeResultEvent({
      context: {
        agentId: 'opencode',
        sessionId: 'codemux-session-2',
        sequence: 1,
      },
      usage: { input_tokens: 1, output_tokens: 2 },
      durationMs: 10,
    });

    expect(event).not.toHaveProperty('agent_session_id');
  });

  it('supports explicit error and interrupted result states', () => {
    const base = {
      context: {
        agentId: 'opencode',
        sessionId: 'codemux-session-3',
        sequence: 2,
      },
      usage: { input_tokens: 1, output_tokens: 2 },
      durationMs: 10,
    };

    expect(buildOpenCodeResultEvent({ ...base, status: 'error' })).toMatchObject({
      subtype: 'error',
      is_error: true,
      result: 'error',
    });
    expect(buildOpenCodeResultEvent({ ...base, status: 'interrupted' })).toMatchObject({
      subtype: 'interrupted',
      is_error: false,
      result: 'interrupted',
    });
  });
});
