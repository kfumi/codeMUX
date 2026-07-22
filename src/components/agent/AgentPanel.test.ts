import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../stores/agentStore';
import { buildAssistantResultStatsMap } from './assistant-ui/CodeMuxThread';
import {
  buildContextUsageViewModel,
  normalizeThreadTokenUsage,
  type ThreadTokenUsage,
} from './contextUsage';

describe('history-file context usage view model', () => {
  it('normalizes Claude cache-read usage as input plus cache for context used tokens', () => {
    const tokenUsage = normalizeThreadTokenUsage({
      input_tokens: 352,
      cache_read_input_tokens: 25_088,
      output_tokens: 152,
      model_context_window: 200_000,
      context_usage_source: 'history_file',
      context_usage_freshness: 'restored',
    });

    expect(tokenUsage).toMatchObject({
      last: {
        totalTokens: 25_440,
        inputTokens: 352,
        cachedInputTokens: 25_088,
        outputTokens: 152,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200_000,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'restored',
    });

    expect(buildContextUsageViewModel({
      tokenUsage,
      model: 'claude-sonnet',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
    })).toEqual({
      usedTokens: 25_440,
      totalTokens: 200_000,
      inputTokens: 352,
      cachedTokens: 25_088,
      outputTokens: 152,
    });
  });

  it('normalizes Codex total_tokens as the context used value and ignores reasoning', () => {
    const tokenUsage = normalizeThreadTokenUsage({
      total: {
        total_tokens: 156_061,
        input_tokens: 154_933,
        cached_input_tokens: 148_864,
        output_tokens: 1_128,
        reasoning_output_tokens: 666,
      },
      last: {
        total_tokens: 156_061,
        input_tokens: 154_933,
        cached_input_tokens: 148_864,
        output_tokens: 1_128,
        reasoning_output_tokens: 666,
      },
      model_context_window: 200_000,
      context_usage_source: 'history_file',
      context_usage_freshness: 'live_synced',
    });

    expect(tokenUsage).toMatchObject({
      last: {
        totalTokens: 156_061,
        inputTokens: 154_933,
        cachedInputTokens: 148_864,
        outputTokens: 1_128,
        reasoningOutputTokens: 0,
      },
    });

    expect(buildContextUsageViewModel({
      tokenUsage,
      model: 'gpt-5-codex',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
    })?.usedTokens).toBe(156_061);
  });

  it('falls back Codex-like usage without total_tokens to input plus output', () => {
    const tokenUsage = normalizeThreadTokenUsage({
      input_tokens: 20,
      cached_input_tokens: 7,
      output_tokens: 5,
      reasoning_output_tokens: 999,
    });

    expect(tokenUsage?.last).toMatchObject({
      totalTokens: 25,
      inputTokens: 20,
      cachedInputTokens: 7,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    });
  });

  it('returns null when no history usage snapshot exists', () => {
    expect(buildContextUsageViewModel({
      tokenUsage: null,
      model: 'claude-sonnet',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
    })).toBeNull();
  });
});

describe('message footer stats', () => {
  it('maps Claude and Codex result stats back to every assistant turn', () => {
    const events: AgentMessage[] = [
      {
        kind: 'user',
        data: {
          type: 'user',
          uuid: 'user-claude',
          session_id: 'session-1',
          message: { role: 'user', content: [{ type: 'text', text: 'Claude' }] },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-claude',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Claude reply' }] },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'result-claude',
          session_id: 'session-1',
          duration_ms: 1_200,
          duration_api_ms: 1_000,
          num_turns: 1,
          result: 'Claude result',
          usage: {
            input_tokens: 352,
            output_tokens: 152,
            cache_read_input_tokens: 25_088,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        kind: 'user',
        data: {
          type: 'user',
          uuid: 'user-codex',
          session_id: 'session-1',
          message: { role: 'user', content: [{ type: 'text', text: 'Codex' }] },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-codex',
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Codex reply' }] },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'result-codex',
          session_id: 'session-1',
          duration_ms: 2_300,
          duration_api_ms: 2_000,
          num_turns: 1,
          result: 'Codex result',
          usage: {
            input_tokens: 154_933,
            output_tokens: 1_128,
            cache_read_input_tokens: 148_864,
          },
          last_token_usage: {
            input_tokens: 154_933,
            cached_input_tokens: 148_864,
            output_tokens: 1_128,
            total_tokens: 156_061,
          },
        },
      },
    ];

    expect(buildAssistantResultStatsMap(events)).toEqual({
      1: {
        durationMs: 1_200,
        numTurns: 1,
        inputTokens: 352,
        outputTokens: 152,
        cacheReadTokens: 25_088,
        cacheCreationTokens: 0,
      },
      4: {
        durationMs: 2_300,
        numTurns: 1,
        inputTokens: 154_933,
        outputTokens: 1_128,
        cacheReadTokens: 148_864,
        cacheCreationTokens: 0,
      },
    });
  });
});
