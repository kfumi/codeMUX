import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_OPTIONS,
  isReasoningEffort,
  normalizeReasoningEffort,
  reasoningEffortLabel,
} from './reasoningEffort';

describe('reasoningEffort', () => {
  it('exposes six canonical options in display order', () => {
    expect(REASONING_EFFORT_OPTIONS.map((option) => option.id)).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(REASONING_EFFORT_OPTIONS.map((option) => option.name)).toEqual([
      '关闭',
      '低',
      '中',
      '高',
      '极高',
      '最高',
    ]);
  });

  it('defaults to high', () => {
    expect(DEFAULT_REASONING_EFFORT).toBe('high');
    expect(normalizeReasoningEffort(undefined)).toBe('high');
    expect(normalizeReasoningEffort('unknown')).toBe('high');
  });

  it('accepts aliases for disabled thinking', () => {
    expect(normalizeReasoningEffort('off')).toBe('none');
    expect(normalizeReasoningEffort('disabled')).toBe('none');
    expect(normalizeReasoningEffort('minimal')).toBe('low');
  });

  it('preserves canonical values', () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(isReasoningEffort(effort)).toBe(true);
      expect(normalizeReasoningEffort(effort)).toBe(effort);
    }
  });

  it('returns the Chinese label for a canonical value', () => {
    expect(reasoningEffortLabel('none')).toBe('关闭');
    expect(reasoningEffortLabel('high')).toBe('高');
    expect(reasoningEffortLabel('xhigh')).toBe('极高');
    expect(reasoningEffortLabel('max')).toBe('最高');
  });
});
