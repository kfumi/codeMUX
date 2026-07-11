import { describe, expect, it } from 'vitest';

import type {
  OpenCodeSessionConfig,
  OpenCodeSessionMapping,
  RuntimeEventContext,
} from './types.js';
import { buildOpenCodeResultEvent, getRuntimeFlavor } from './runtimeEvents.js';

describe('OpenCode runtime contract', () => {
  it('recognizes the OpenCode runtime flavor', () => {
    expect(getRuntimeFlavor('opencode')).toBe('opencode');
  });

  it('models the OpenCode startup configuration and session mapping', () => {
    const config = {
      cwd: 'D:\\workspace',
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-session-1',
      provider: 'openai-compatible',
      model: 'gpt-5',
      credentialSource: 'codemux',
    } satisfies OpenCodeSessionConfig;

    const mapping = {
      sessionId: config.sessionId,
      agentSessionId: config.agentSessionId,
    } satisfies OpenCodeSessionMapping;

    expect(config).toMatchObject({
      cwd: 'D:\\workspace',
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-session-1',
      provider: 'openai-compatible',
      model: 'gpt-5',
      credentialSource: 'codemux',
    });
    expect(mapping).toEqual({
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-session-1',
    });
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
      usage: { input_tokens: 12, output_tokens: 8 },
      durationMs: 42,
    })).toMatchObject({
      type: 'result',
      agent_id: 'opencode',
      session_id: 'codemux-session-1',
      agent_session_id: 'opencode-session-1',
      sequence: 7,
      usage: { input_tokens: 12, output_tokens: 8 },
    });
  });
});
