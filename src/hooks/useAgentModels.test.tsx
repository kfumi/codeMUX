// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProviderProfile } from '../types/provider';

const { readHomeFile } = vi.hoisted(() => ({ readHomeFile: vi.fn() }));

vi.mock('../lib/tauri', () => ({
  fileApi: { readHomeFile },
}));

import { useAgentModels } from './useAgentModels';

function openCodeProfile(providerKey: string): AgentProviderProfile {
  return {
    id: 'opencode-profile',
    agent_kind: 'opencode',
    name: 'OpenCode',
    note: '',
    models: [{ id: 'active/profile-model', name: 'Profile Model' }],
    default_model: 'active/profile-model',
    native_config: {
      type: 'opencode',
      api_key: '',
      openai_base_url: '',
      provider_key: providerKey,
    },
  };
}

describe('useAgentModels OpenCode models', () => {
  beforeEach(() => {
    readHomeFile.mockResolvedValue(JSON.stringify({
      provider: {
        'active-provider': {
          models: {
            'active/config-model': { name: 'Active Config Model' },
          },
        },
        'inactive-provider': {
          models: {
            'inactive/config-model': { name: 'Inactive Config Model' },
          },
        },
      },
    }));
  });

  it('only exposes models from the active provider key and marks profile models', async () => {
    const { result } = renderHook(() => useAgentModels(
      'opencode',
      openCodeProfile('active-provider'),
      'opencode-profile',
    ));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'active/config-model', source: 'config' }),
      expect.objectContaining({ id: 'active/profile-model', source: 'profile' }),
    ]));
    expect(result.current.models.find((model) => model.id === 'inactive/config-model')).toBeUndefined();
  });

  it('refreshes when the active profile contents change in place', async () => {
    const profile = openCodeProfile('active-provider');

    const { result, rerender } = renderHook(() => useAgentModels(
      'opencode',
      profile,
      'opencode-profile',
    ));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'active/config-model' }),
      expect.objectContaining({ id: 'active/profile-model' }),
    ]));

    profile.models = [{ id: 'updated/profile-model', name: 'Updated Profile Model' }];
    profile.native_config = {
      ...profile.native_config,
      provider_key: 'inactive-provider',
    };
    rerender();

    await waitFor(() => expect(result.current.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'inactive/config-model' }),
      expect.objectContaining({ id: 'updated/profile-model', name: 'Updated Profile Model' }),
    ])));
    expect(result.current.models.find((model) => model.id === 'active/config-model')).toBeUndefined();
    expect(result.current.models.find((model) => model.id === 'active/profile-model')).toBeUndefined();
  });
});
