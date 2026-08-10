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
      { protocol: 'openai_compatible', base_url: 'https://api.deepseek.com', codex_needs_proxy: false },
    ],
    models: [
      { id: 'deepseek-v4-flash', name: 'Flash' },
      { id: 'deepseek-v4-pro', name: 'Pro' },
    ],
    default_model: 'deepseek-v4-flash',
    builtin_template_id: 'deepseek',
    ...partial,
  };
}

describe('useAgentModels', () => {
  it('returns usable provider models grouped by provider', () => {
    const { result } = renderHook(() =>
      useAgentModels(
        'claude_code',
        [
          provider(),
          provider({
            id: 'p2',
            name: 'Anthropic',
            builtin_template_id: 'anthropic',
            models: [{ id: 'claude-sonnet-4', name: 'Sonnet' }],
            default_model: 'claude-sonnet-4',
            endpoints: [{ protocol: 'anthropic', base_url: 'https://api.anthropic.com' }],
          }),
          provider({
            id: 'disabled',
            enabled: false,
            models: [{ id: 'x', name: 'X' }],
            default_model: 'x',
          }),
        ],
        'p1',
      ),
    );

    expect(result.current.models.map((model) => model.id)).toEqual([
      'p1::deepseek-v4-flash',
      'p1::deepseek-v4-pro',
      'p2::claude-sonnet-4',
    ]);
    expect(result.current.models.map((model) => model.group)).toEqual([
      '深度求索',
      '深度求索',
      'Anthropic',
    ]);
    expect(result.current.isLoading).toBe(false);
  });

  it('skips providers that lack a matching endpoint', () => {
    const { result } = renderHook(() =>
      useAgentModels(
        'codex',
        [
          provider({
            endpoints: [{ protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic' }],
          }),
        ],
        'p1',
      ),
    );
    expect(result.current.models).toEqual([]);
  });

  it('skips providers without an api key', () => {
    const { result } = renderHook(() =>
      useAgentModels('claude_code', [provider({ api_key: '' })], 'p1'),
    );
    expect(result.current.models).toEqual([]);
  });
});
