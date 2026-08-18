import { describe, expect, it } from 'vitest';

import { buildMobileContextUsage, formatMobileTokens, type MobileTokenUsage } from './contextUsage';

const usage: MobileTokenUsage = {
  total: {
    totalTokens: 1_000,
    inputTokens: 700,
    cachedInputTokens: 200,
    outputTokens: 100,
    reasoningOutputTokens: 0,
  },
  last: {
    totalTokens: 1_000,
    inputTokens: 700,
    cachedInputTokens: 200,
    outputTokens: 100,
    reasoningOutputTokens: 0,
  },
  modelContextWindow: 200_000,
  contextUsageSource: 'history_file',
  contextUsageFreshness: 'restored',
};

describe('buildMobileContextUsage', () => {
  it('maps desktop token usage into input, cache, output, and total values', () => {
    expect(buildMobileContextUsage(usage)).toEqual({
      usedTokens: 1_000,
      totalTokens: 200_000,
      inputTokens: 700,
      cachedTokens: 200,
      outputTokens: 100,
      percentage: 0.005,
    });
  });

  it('returns no usage model when the snapshot has no tokens', () => {
    expect(buildMobileContextUsage({
      ...usage,
      total: { ...usage.total, totalTokens: 0 },
      last: { ...usage.last, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    })).toBeNull();
  });
});

describe('formatMobileTokens', () => {
  it('uses the same compact notation as the desktop context display', () => {
    expect(formatMobileTokens(1_234)).toBe('1.2k');
    expect(formatMobileTokens(1_234_567)).toBe('1.2M');
  });
});
