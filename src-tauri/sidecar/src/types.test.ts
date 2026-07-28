import { describe, expect, it } from 'vitest';

import type { OpenCodeSessionConfig, OpenCodeSessionMapping, SidecarCommand } from './types.js';
import { getRuntimeFlavor } from './runtimeEvents.js';

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

});
