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
      agentKind: 'codex',
    })).toEqual({
      usedTokens: 30,
      totalTokens: 258400,
      inputTokens: 10,
      cachedTokens: 5,
      outputTokens: 20,
    });
  });

  it('excludes Claude cache tokens and upstream total_tokens from context total', () => {
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
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 50,
              output_tokens: 25,
              total_tokens: 475,
            },
          },
          parent_tool_use_id: null,
        },
      },
    ];

    expect(computeContextUsageFromEvents(events, {
      model: 'claude-sonnet-4-20250514',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
      agentKind: 'claude_code',
    })).toMatchObject({
      usedTokens: 100,
      inputTokens: 100,
      cachedTokens: 300,
      outputTokens: 25,
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
      agentKind: 'claude_code',
    })).toMatchObject({
      usedTokens: 100,
      totalTokens: 1_000_000,
    });
  });

  it('uses type: "message" usage for Claude Code historical sessions', () => {
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
          },
          messages: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'message 1' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'message 2' }],
              usage: {
                input_tokens: 100,
                cache_read_input_tokens: 50,
                output_tokens: 25,
              },
            },
          ],
          parent_tool_use_id: null,
        },
      },
    ];

    expect(computeContextUsageFromEvents(events, {
      model: 'claude-sonnet-4-20250514',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
      agentKind: 'claude_code',
    })).toMatchObject({
      usedTokens: 100,
      inputTokens: 100,
      cachedTokens: 50,
      outputTokens: 25,
    });
  });

  it('uses data.type: "message" usage for Claude Code', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Claude reply' }],
          usage: {
            input_tokens: 200,
            cache_read_input_tokens: 100,
            output_tokens: 75,
          },
        },
      },
    ];

    expect(computeContextUsageFromEvents(events, {
      model: 'claude-sonnet-4-20250514',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
      agentKind: 'claude_code',
    })).toMatchObject({
      usedTokens: 200,
      inputTokens: 200,
      cachedTokens: 100,
      outputTokens: 75,
    });
  });

  it('does not use type: "message" for Codex', () => {
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
          messages: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'message 1' }],
              usage: {
                input_tokens: 100,
                cache_read_input_tokens: 50,
                output_tokens: 25,
              },
            },
          ],
          parent_tool_use_id: null,
        },
      },
    ];

    expect(computeContextUsageFromEvents(events, {
      model: 'gpt-5-codex',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
      agentKind: 'codex',
    })).toMatchObject({
      usedTokens: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
    });
  });

  it('excludes cache_read_input_tokens from total for Claude Code synthetic result events', () => {
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
          uuid: 'synthetic-turn-1',
          session_id: 'session-1',
          duration_ms: 1000,
          duration_api_ms: 0,
          num_turns: 1,
          result: '',
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 50,
          },
          last_token_usage: {
            input_tokens: 100,
            output_tokens: 25,
            cached_input_tokens: 50,
            total_tokens: 175,
          },
        },
      },
    ];

    expect(computeContextUsageFromEvents(events, {
      model: 'claude-sonnet-4-20250514',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
      agentKind: 'claude_code',
    })).toMatchObject({
      usedTokens: 100,
      inputTokens: 100,
      cachedTokens: 50,
      outputTokens: 25,
    });
  });

  it('treats a Claude Code result without usage as a boundary instead of reusing older usage', () => {
    const events: AgentMessage[] = [
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'result-old',
          session_id: 'session-1',
          duration_ms: 1000,
          duration_api_ms: 0,
          num_turns: 1,
          result: '',
          usage: {
            input_tokens: 22_000,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 3_000,
          },
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-old',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Old Claude reply' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 11_464,
              cache_read_input_tokens: 49_537,
              output_tokens: 607,
            },
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
          uuid: 'result-empty',
          session_id: 'session-1',
          duration_ms: 1000,
          duration_api_ms: 0,
          num_turns: 1,
          result: '',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ];

    expect(computeContextUsageFromEvents(events, {
      model: 'glm-4.7-flash',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
      agentKind: 'claude_code',
    })).toMatchObject({
      usedTokens: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
    });
  });

  it('does not include cache_read_input_tokens in total for Codex result events', () => {
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
          duration_ms: 1000,
          duration_api_ms: 0,
          num_turns: 1,
          result: '',
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_read_input_tokens: 50,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 50,
            output_tokens: 25,
            total_tokens: 125,
          },
        },
      },
    ];

    expect(computeContextUsageFromEvents(events, {
      model: 'gpt-5-codex',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
      agentKind: 'codex',
    })).toMatchObject({
      usedTokens: 125,
      inputTokens: 100,
      cachedTokens: 50,
      outputTokens: 25,
    });
  });
});
