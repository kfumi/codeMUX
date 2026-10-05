// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelProvider } from '../types/provider';
import {
  OPENCODE_FREE_GROUP,
  OPENCODE_FREE_PROVIDER_ID,
  isOpenCodeFreeProviderId,
  resetOpenCodeFreeModelsCacheForTests,
  useAgentModels,
} from './useAgentModels';

const { fetchOpenCodeFreeModelsMock } = vi.hoisted(() => ({
  fetchOpenCodeFreeModelsMock: vi.fn(),
}));

vi.mock('@/lib/facades/daemon-facade', () => ({
  daemonFacade: {
    fetchOpenCodeFreeModels: fetchOpenCodeFreeModelsMock,
  },
}));

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
  beforeEach(() => {
    fetchOpenCodeFreeModelsMock.mockReset();
    resetOpenCodeFreeModelsCacheForTests();
  });

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
    const { result } = renderHook(() => useAgentModels('claude_code', [provider({ api_key: '' })], 'p1'));
    expect(result.current.models).toEqual([]);
  });

  it('appends opencode free models after provider models for opencode sessions', async () => {
    fetchOpenCodeFreeModelsMock.mockResolvedValue([
      { id: 'big-pickle', owned_by: 'opencode' },
      { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)' },
      { id: 42 },
      { id: '   ' },
    ]);
    const { result } = renderHook(() => useAgentModels('opencode', [provider()], 'p1'));

    await waitFor(() => {
      expect(result.current.models.some((model) => model.providerId === OPENCODE_FREE_PROVIDER_ID)).toBe(true);
    });
    expect(result.current.models.map((model) => model.id)).toEqual([
      'p1::deepseek-v4-flash',
      'p1::deepseek-v4-pro',
      `${OPENCODE_FREE_PROVIDER_ID}::big-pickle`,
      `${OPENCODE_FREE_PROVIDER_ID}::deepseek-v4-flash-free`,
    ]);
    const freeEntries = result.current.models.filter((model) => model.providerId === OPENCODE_FREE_PROVIDER_ID);
    expect(freeEntries.map((model) => model.group)).toEqual([OPENCODE_FREE_GROUP, OPENCODE_FREE_GROUP]);
    expect(freeEntries.map((model) => model.providerTemplateId)).toEqual(['opencode', 'opencode']);
    expect(freeEntries.map((model) => model.efforts)).toEqual([false, false]);
    expect(freeEntries.map((model) => model.source)).toEqual(['catalog', 'catalog']);
  });

  it('does not fetch free models for non-opencode agents', async () => {
    fetchOpenCodeFreeModelsMock.mockResolvedValue([{ id: 'big-pickle' }]);
    const { result } = renderHook(() => useAgentModels('claude_code', [provider()], 'p1'));

    expect(result.current.models.map((model) => model.id)).toEqual([
      'p1::deepseek-v4-flash',
      'p1::deepseek-v4-pro',
    ]);
    // 让微任务沉降后确认未触发拉取。
    await waitFor(() => expect(result.current.models.length).toBe(2));
    expect(fetchOpenCodeFreeModelsMock).not.toHaveBeenCalled();
  });

  it('degrades silently to provider models when the free catalog fails', async () => {
    fetchOpenCodeFreeModelsMock.mockRejectedValue(new Error('catalog unreachable'));
    const { result } = renderHook(() => useAgentModels('opencode', [provider()], 'p1'));

    await waitFor(() => expect(fetchOpenCodeFreeModelsMock).toHaveBeenCalled());
    expect(result.current.models.map((model) => model.id)).toEqual([
      'p1::deepseek-v4-flash',
      'p1::deepseek-v4-pro',
    ]);
  });

  it('isOpenCodeFreeProviderId matches only the virtual provider id', () => {
    expect(isOpenCodeFreeProviderId(OPENCODE_FREE_PROVIDER_ID)).toBe(true);
    expect(isOpenCodeFreeProviderId('opencode')).toBe(false);
    expect(isOpenCodeFreeProviderId(null)).toBe(false);
    expect(isOpenCodeFreeProviderId(undefined)).toBe(false);
  });
});
