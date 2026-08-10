import { describe, expect, it } from 'vitest';

import {
  checkProfileModelSupports1m,
  formatModelDisplayName,
  getProfileModelContextWindow,
  stripContext1mSuffix,
  withContext1mSuffix,
} from './modelDisplay';
import type { ModelProvider } from '../../types/provider';

function providerWithModel(overrides: Partial<ModelProvider['models'][number]> = {}): ModelProvider {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    enabled: true,
    api_key: 'sk-test',
    endpoints: [],
    models: [{
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      ...overrides,
    }],
    default_model: 'deepseek-v4-flash',
  };
}

describe('modelDisplay context_1m', () => {
  it('strips and appends the Claude [1m] suffix', () => {
    expect(stripContext1mSuffix('deepseek-v4-flash[1M]')).toBe('deepseek-v4-flash');
    expect(withContext1mSuffix('deepseek-v4-flash[1m]')).toBe('deepseek-v4-flash[1m]');
  });

  it('reads context_1m from the provider model entry', () => {
    expect(checkProfileModelSupports1m(providerWithModel({ context_1m: true }), 'deepseek-v4-flash')).toBe(true);
    expect(checkProfileModelSupports1m(providerWithModel({ context_1m: true }), 'deepseek-v4-flash[1m]')).toBe(true);
    expect(checkProfileModelSupports1m(providerWithModel(), 'deepseek-v4-flash')).toBe(false);
  });

  it('reads the configured context window regardless of a Claude suffix', () => {
    expect(getProfileModelContextWindow(
      providerWithModel({ context_window: 1_000_000 }),
      'deepseek-v4-flash[1m]',
    )).toBe(1_000_000);
    expect(getProfileModelContextWindow(providerWithModel(), 'deepseek-v4-flash')).toBeNull();
  });

  it('formats Claude display names with the 1m suffix when enabled', () => {
    expect(formatModelDisplayName({
      model: 'deepseek-v4-flash',
      agentKind: 'claude_code',
      usesLargeContext: true,
    })).toBe('deepseek-v4-flash[1m]');
    expect(formatModelDisplayName({
      model: 'deepseek-v4-flash',
      agentKind: 'codex',
      usesLargeContext: true,
    })).toBe('deepseek-v4-flash');
  });
});
