// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ModelProvider } from '../types/provider';
import { useAgentModels } from './useAgentModels';

function provider(partial?: Partial<ModelProvider>): ModelProvider {
  return {
    id: 'p1',
    name: 'DeepSeek',
    enabled: true,
    api_key: 'sk-test',
    endpoints: [
      { protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic' },
      { protocol: 'openai_compatible', base_url: 'https://api.deepseek.com', codex_needs_proxy: true },
    ],
    models: [
      { id: 'deepseek-v4-flash', name: 'Flash' },
      { id: 'deepseek-v4-pro', name: 'Pro' },
    ],
    default_model: 'deepseek-v4-flash',
    ...partial,
  };
}

describe('useAgentModels', () => {
  it('returns provider models when usable for the agent', () => {
    const { result } = renderHook(() => useAgentModels('claude_code', provider(), 'p1'));
    expect(result.current.models.map((model) => model.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
    expect(result.current.isLoading).toBe(false);
  });

  it('returns empty list when provider lacks matching endpoint', () => {
    const { result } = renderHook(() =>
      useAgentModels(
        'codex',
        provider({
          endpoints: [{ protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic' }],
        }),
        'p1',
      ),
    );
    expect(result.current.models).toEqual([]);
  });

  it('returns empty list when api key is missing', () => {
    const { result } = renderHook(() =>
      useAgentModels('claude_code', provider({ api_key: '' }), 'p1'),
    );
    expect(result.current.models).toEqual([]);
  });
});
