import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig, Provider } from '../types/provider';

const setDefaultAgentKindMock = vi.fn<(agentKind: string) => Promise<void>>();
const updateAgentConfigMock = vi.fn<(agentKind: string, config: Record<string, unknown>) => Promise<void>>();
const deleteProviderMock = vi.fn<(providerId: string) => Promise<void>>();

vi.mock('../lib/tauri', () => ({
  configApi: {
    get: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: deleteProviderMock,
    setActiveProvider: vi.fn(),
    setTheme: vi.fn(),
    fetchModels: vi.fn(),
    testProvider: vi.fn(),
    setDefaultAgentKind: setDefaultAgentKindMock,
    updateAgentConfig: updateAgentConfigMock,
  },
}));

const baseConfig: AppConfig = {
  providers: [],
  active_provider_id: null,
  agent_defaults: {
    default_agent_kind: 'claude_code',
  },
  agent_configs: {
    claude_code: {
      executable_mode: 'auto',
      resume_sessions: true,
    },
    codex: {
      sdk_mode: 'responses',
      default_provider_id: null,
    },
    gemini_cli: {},
    opencode: {},
  },
  theme: 'System',
};

describe('settings store agent config actions', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { useSettingsStore } = await import('./settingsStore');
    useSettingsStore.setState({
      config: structuredClone(baseConfig),
      isLoading: false,
      error: null,
    });
  });

  it('persists default agent changes', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().setDefaultAgentKind('codex');

    expect(setDefaultAgentKindMock).toHaveBeenCalledWith('codex');
    expect(useSettingsStore.getState().config?.agent_defaults.default_agent_kind).toBe('codex');
  });

  it('persists agent-specific config updates', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().updateAgentConfig('codex', {
      sdk_mode: 'agent',
      default_provider_id: 'provider-1',
    });

    expect(updateAgentConfigMock).toHaveBeenCalledWith('codex', {
      sdk_mode: 'agent',
      default_provider_id: 'provider-1',
    });
    expect(useSettingsStore.getState().config?.agent_configs.codex).toEqual({
      sdk_mode: 'agent',
      default_provider_id: 'provider-1',
    });
  });

  it('keeps clear-to-null codex config updates in local state', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            agent_configs: {
              ...state.config.agent_configs,
              codex: {
                ...state.config.agent_configs.codex,
                default_provider_id: 'provider-1',
              },
            },
          }
        : null,
    }));

    await useSettingsStore.getState().updateAgentConfig('codex', {
      default_provider_id: null,
    });

    expect(updateAgentConfigMock).toHaveBeenCalledWith('codex', {
      default_provider_id: null,
    });
    expect(useSettingsStore.getState().config?.agent_configs.codex.default_provider_id).toBeNull();
  });

  it('clears the local codex default provider when that provider is deleted', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    const provider: Provider = {
      id: 'provider-1',
      name: 'Provider 1',
      api_key: '',
      anthropic_base_url: '',
      openai_base_url: '',
      default_model: '',
    };
    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            providers: [provider],
            active_provider_id: 'provider-1',
            agent_configs: {
              ...state.config.agent_configs,
              codex: {
                ...state.config.agent_configs.codex,
                default_provider_id: 'provider-1',
              },
            },
          }
        : null,
    }));

    await useSettingsStore.getState().deleteProvider('provider-1');

    expect(deleteProviderMock).toHaveBeenCalledWith('provider-1');
    expect(useSettingsStore.getState().config?.active_provider_id).toBeNull();
    expect(useSettingsStore.getState().config?.agent_configs.codex.default_provider_id).toBeNull();
  });
});
