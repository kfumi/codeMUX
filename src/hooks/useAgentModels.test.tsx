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

function codexProfile(models: AgentProviderProfile['models']) {
  return profile('codex', models, {
    type: 'codex',
    api_key: '',
    openai_base_url: '',
  });
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

  it('always includes Claude built-ins and merges profile models without duplicates', async () => {
    const { result } = await loadedModels('claude_code', claudeProfile([
      { id: 'sonnet', name: 'Custom Sonnet' },
      { id: 'provider/custom', name: 'Custom Model' },
    ]));

    expect(result.current.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sonnet', name: 'Sonnet 5' }),
      expect.objectContaining({ id: 'opus' }),
      expect.objectContaining({ id: 'fable' }),
      expect.objectContaining({ id: 'haiku' }),
      expect.objectContaining({ id: 'provider/custom', source: 'profile' }),
    ]));
    expect(result.current.models.filter((model) => model.id === 'sonnet')).toHaveLength(1);
  });

  it('loads Codex defaults from models_cache.json and falls back when it is missing', async () => {
    readHomeFile.mockResolvedValueOnce(JSON.stringify([
      { model: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
    ]));

    const loaded = await loadedModels('codex', null);
    expect(loaded.result.current.models).toEqual([
      expect.objectContaining({ id: 'gpt-5-codex', name: 'GPT-5 Codex', source: 'catalog' }),
    ]);
    expect(readHomeFile).toHaveBeenCalledWith('.codex/models_cache.json');

    readHomeFile.mockRejectedValueOnce(new Error('missing file'));
    const fallback = await loadedModels('codex', null);
    expect(fallback.result.current.models).toEqual([]);
  });

  it('loads Codex custom catalog, merges profile models, and deduplicates by id', async () => {
    readHomeFile.mockResolvedValueOnce(JSON.stringify([
      { model: 'profile/model', displayName: 'Catalog Duplicate' },
      { model: 'catalog/model', displayName: 'Catalog Model' },
    ]));

    const { result } = await loadedModels('codex', codexProfile([
      { id: 'profile/model', name: 'Profile Model' },
      { id: 'custom/model', name: 'Custom Model' },
    ]));

    expect(readHomeFile).toHaveBeenCalledWith('.codex/codemux-model-catalog.json');
    expect(result.current.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'profile/model', name: 'Profile Model', source: 'profile' }),
      expect.objectContaining({ id: 'custom/model', source: 'profile' }),
      expect.objectContaining({ id: 'catalog/model', source: 'catalog' }),
    ]));
    expect(result.current.models.filter((model) => model.id === 'profile/model')).toHaveLength(1);
  });

  it('keeps Codex profile models when the custom catalog is missing', async () => {
    const { result } = await loadedModels('codex', codexProfile([
      { id: 'profile/model', name: 'Profile Model' },
    ]));

    expect(result.current.models).toEqual([
      expect.objectContaining({ id: 'profile/model', source: 'profile' }),
    ]);
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
    expect(codex.result.current.models).toEqual([]);

    readHomeFile.mockResolvedValueOnce('{not valid json');
    const opencode = await loadedModels('opencode', null);
    expect(opencode.result.current.models.map((model) => model.id)).toHaveLength(5);
  });
});
