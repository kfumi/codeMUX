import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig, Provider } from '../types/provider';

const setDefaultAgentKindMock = vi.fn<(agentKind: string) => Promise<void>>();
const updateAgentConfigMock = vi.fn<(agentKind: string, config: Record<string, unknown>) => Promise<void>>();
const deleteProviderMock = vi.fn<(providerId: string) => Promise<void>>();
const setCompactAiOutputMock = vi.fn<(enabled: boolean) => Promise<void>>();

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
    setCompactAiOutput: setCompactAiOutputMock,
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
    },
    gemini_cli: {},
    opencode: {},
  },
  theme: 'System',
  compact_ai_output: false,
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

  it('persists codex sdk mode updates', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().updateAgentConfig('codex', {
      sdk_mode: 'agent',
    });

    expect(updateAgentConfigMock).toHaveBeenCalledWith('codex', {
      sdk_mode: 'agent',
    });
    expect(useSettingsStore.getState().config?.agent_configs.codex).toEqual({
      sdk_mode: 'agent',
    });
  });

  it('persists compact AI output preference', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().setCompactAiOutput(true);

    expect(setCompactAiOutputMock).toHaveBeenCalledWith(true);
    expect(useSettingsStore.getState().config?.compact_ai_output).toBe(true);
  });

  it('keeps the active provider consistent when the active provider is deleted', async () => {
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
          }
        : null,
    }));

    await useSettingsStore.getState().deleteProvider('provider-1');

    expect(deleteProviderMock).toHaveBeenCalledWith('provider-1');
    expect(useSettingsStore.getState().config?.active_provider_id).toBeNull();
  });

  it('uses provider Codex proxy override when deciding if proxy is needed', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    const provider: Provider = {
      id: 'provider-1',
      name: 'Provider 1',
      api_key: 'key',
      anthropic_base_url: '',
      openai_base_url: 'https://openrouter.ai/api/v1',
      default_model: 'gpt-5',
      codex_needs_proxy: false,
    };

    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            providers: [provider],
            active_provider_id: 'provider-1',
          }
        : null,
    }));

    expect(useSettingsStore.getState().getNeedsProxy()).toBe(false);
  });
});
