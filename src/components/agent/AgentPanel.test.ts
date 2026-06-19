import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../stores/agentStore';
import { computeContextUsageFromEvents } from './contextUsage';

describe('computeContextUsageFromEvents', () => {
  it('uses Codex last_token_usage fields for context stats', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Codex reply' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'result-1',
          session_id: 'session-1',
          duration_ms: 10,
          duration_api_ms: 10,
          num_turns: 1,
          result: '',
          total_cost_usd: 0,
          usage: {
            input_tokens: 1000,
            output_tokens: 2000,
            cache_read_input_tokens: 3000,
          },
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 5,
            output_tokens: 20,
            total_tokens: 42,
          },
          model_context_window: 258400,
        },
      },
    ];

    expect(computeContextUsageFromEvents(events, {
      model: 'gpt-5-codex',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
    })).toEqual({
      usedTokens: 42,
      totalTokens: 258400,
      inputTokens: 10,
      cachedTokens: 5,
      outputTokens: 20,
    });
  });

  it('uses the Claude 1M runtime model suffix for the fallback context limit', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Claude reply' }],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
            },
          },
          parent_tool_use_id: null,
        },
      },
    ];

    expect(computeContextUsageFromEvents(events, {
      model: 'claude-sonnet-4-20250514[1m]',
      sessionProviderUsesLargeContext: true,
      activeProviderUsesLargeContext: true,
    })).toMatchObject({
      usedTokens: 150,
      totalTokens: 1_000_000,
    });
  });
});
