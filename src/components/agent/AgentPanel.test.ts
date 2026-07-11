import { describe, expect, it } from 'vitest';

import { buildFooterStatsFromTokenUsage } from './assistant-ui/CodeMuxThread';
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
      model_context_window: 258_400,
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
      modelContextWindow: 258_400,
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
      totalTokens: 258_400,
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
      model_context_window: 258_400,
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
  it('builds footer stats from session token usage without reasoning', () => {
    const tokenUsage: ThreadTokenUsage = {
      total: {
        totalTokens: 156_061,
        inputTokens: 154_933,
        cachedInputTokens: 148_864,
        outputTokens: 1_128,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 156_061,
        inputTokens: 154_933,
        cachedInputTokens: 148_864,
        outputTokens: 1_128,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'live_synced',
    };

    expect(buildFooterStatsFromTokenUsage(tokenUsage)).toEqual({
      inputTokens: 154_933,
      outputTokens: 1_128,
      cacheReadTokens: 148_864,
      cacheCreationTokens: 0,
    });
  });
});
