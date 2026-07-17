// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProviderProfile } from '../types/provider';

const { readHomeFile } = vi.hoisted(() => ({ readHomeFile: vi.fn() }));

vi.mock('../lib/tauri', () => ({
  fileApi: { readHomeFile },
}));

import { useAgentModels } from './useAgentModels';

function profile(
  agentKind: AgentProviderProfile['agent_kind'],
  models: AgentProviderProfile['models'],
  nativeConfig: AgentProviderProfile['native_config'],
  id = `${agentKind}-profile`,
): AgentProviderProfile {
  return {
    id,
    agent_kind: agentKind,
    name: `${agentKind} profile`,
    note: '',
    models,
    default_model: models[0]?.id ?? '',
    native_config: nativeConfig,
  };
}

function claudeProfile(models: AgentProviderProfile['models']) {
  return profile('claude_code', models, { type: 'claude_code', settings: {} });
}

function codexProfile(
  models: AgentProviderProfile['models'],
  nativeOverrides?: { model_catalog?: unknown[]; default_model?: string },
) {
  const { default_model, ...rest } = nativeOverrides ?? {};
  return {
    ...profile('codex', models, {
      type: 'codex',
      api_key: '',
      openai_base_url: '',
      ...rest,
    }),
    ...(default_model !== undefined ? { default_model } : {}),
  };
}

function openCodeProfile(
  providerKey: string,
  models: AgentProviderProfile['models'] = [{ id: 'profile/model', name: 'Profile Model' }],
) {
  return profile('opencode', models, {
    type: 'opencode',
    api_key: '',
    openai_base_url: '',
    provider_key: providerKey,
  });
}

async function loadedModels(
  agentKind: AgentProviderProfile['agent_kind'],
  activeProfile: AgentProviderProfile | null,
  activeProfileId: string | null = activeProfile?.id ?? null,
) {
  const hook = renderHook(() => useAgentModels(agentKind, activeProfile, activeProfileId));
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe('useAgentModels', () => {
  beforeEach(() => {
    readHomeFile.mockReset();
    readHomeFile.mockRejectedValue(new Error('missing file'));
  });

  it('returns Claude built-ins in the default order without a profile', async () => {
    const { result } = await loadedModels('claude_code', null, null);

    expect(result.current.models.map((model) => model.id)).toEqual([
      'sonnet',
      'opus',
      'fable',
      'haiku',
    ]);
  });

  it('always includes Claude built-ins and merges profile models without duplicates', async () => {
    const { result } = await loadedModels('claude_code', claudeProfile([
      { id: 'sonnet', name: 'Custom Sonnet' },
      { id: 'provider/custom', name: 'Custom Model' },
    ]));

    expect(result.current.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sonnet', name: 'Custom Sonnet', source: 'profile' }),
      expect.objectContaining({ id: 'opus' }),
      expect.objectContaining({ id: 'fable' }),
      expect.objectContaining({ id: 'haiku' }),
      expect.objectContaining({ id: 'provider/custom', source: 'profile' }),
    ]));
    expect(result.current.models.filter((model) => model.id === 'sonnet')).toHaveLength(1);
  });

  it('returns Codex default models when no profile', async () => {
    const { result } = await loadedModels('codex', null);
    expect(result.current.models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2']);
  });

  it('loads Codex models from model_catalog and includes built-ins', async () => {
    const catalog = [{ model: 'custom/model-a', displayName: 'Custom A' }, { model: 'custom/model-b', displayName: 'Custom B' }];
    const { result } = await loadedModels('codex', codexProfile([], { model_catalog: catalog }));

    expect(result.current.models.map((m) => m.id)).toEqual([
      'custom/model-a',
      'custom/model-b',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.2',
    ]);
  });

  it('prepends default_model and includes built-ins for Codex', async () => {
    const { result } = await loadedModels('codex', codexProfile([], { model_catalog: [], default_model: 'gpt-5.6' }));
    expect(result.current.models.map((m) => m.id)).toEqual([
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.2',
    ]);
  });

  it('returns Codex built-ins when model_catalog and default_model are both empty', async () => {
    const { result } = await loadedModels('codex', codexProfile([], { model_catalog: [] }));
    expect(result.current.models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2']);
  });

  it('prepends default_model to Codex list and appends built-ins', async () => {
    const catalog = [{ model: 'custom-a', displayName: 'A' }];
    const { result } = await loadedModels('codex', codexProfile([], { model_catalog: catalog, default_model: 'my-custom-model' }));

    expect(result.current.models.map((m) => m.id)).toEqual([
      'my-custom-model',
      'custom-a',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.2',
    ]);
  });

  it('does not duplicate default_model if it already exists in catalog', async () => {
    const catalog = [{ model: '5.5', displayName: '5.5' }];
    const { result } = await loadedModels('codex', codexProfile([], { model_catalog: catalog, default_model: '5.5' }));

    expect(result.current.models.filter((m) => m.id === '5.5')).toHaveLength(1);
  });

  it('includes OpenCode free models, active provider config, and profile models only', async () => {
    readHomeFile.mockResolvedValueOnce(JSON.stringify({
      provider: {
        active: { models: { 'config/model': { name: 'Config Model' } } },
        inactive: { models: { 'inactive/model': { name: 'Inactive Model' } } },
      },
    }));

    const { result } = await loadedModels('opencode', openCodeProfile('active'));

    expect(result.current.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'config/model', name: 'Config Model', source: 'config' }),
      expect.objectContaining({ id: 'profile/model', source: 'profile' }),
    ]));
    expect(result.current.models.find((model) => model.id === 'opencode/big-pickle')).toEqual(
      expect.objectContaining({ id: 'opencode/big-pickle' }),
    );
    expect(result.current.models.find((model) => model.id === 'opencode/big-pickle')?.source).toBeUndefined();
    expect(result.current.models.find((model) => model.id === 'inactive/model')).toBeUndefined();
  });

  it('falls back to free OpenCode models when the config file is missing', async () => {
    const { result } = await loadedModels('opencode', null);

    expect(result.current.models.map((model) => model.id)).toEqual([
      'opencode/nemotron-3-ultra-free',
      'opencode/north-mini-code-free',
      'opencode/deepseek-v4-flash-free',
      'opencode/mimo-v2.5-free',
      'opencode/big-pickle',
    ]);
  });

  it('reloads models and provider config when the same profile id changes content', async () => {
    readHomeFile.mockResolvedValue(JSON.stringify({
      provider: {
        first: { models: { 'first/config-model': {} } },
        second: { models: { 'second/config-model': {} } },
      },
    }));
    const activeProfile = openCodeProfile('first', [{ id: 'first/profile-model' }]);
    const hook = await loadedModels('opencode', activeProfile, 'same-profile-id');

    activeProfile.models = [{ id: 'second/profile-model' }];
    activeProfile.native_config = { ...activeProfile.native_config, provider_key: 'second' };
    hook.rerender();

    await waitFor(() => expect(hook.result.current.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'second/config-model' }),
      expect.objectContaining({ id: 'second/profile-model' }),
    ])));
    expect(hook.result.current.models.find((model) => model.id === 'first/config-model')).toBeUndefined();
    expect(hook.result.current.models.find((model) => model.id === 'first/profile-model')).toBeUndefined();
  });

  it('falls back without throwing when model JSON is malformed', async () => {
    readHomeFile.mockResolvedValueOnce('{not valid json');
    const codex = await loadedModels('codex', null);
    expect(codex.result.current.models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2']);

    readHomeFile.mockResolvedValueOnce('{not valid json');
    const opencode = await loadedModels('opencode', null);
    expect(opencode.result.current.models.map((model) => model.id)).toHaveLength(5);
  });
});
