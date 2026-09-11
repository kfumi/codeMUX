import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig, ModelProvider } from '../types/provider';

const setDefaultAgentKindMock = vi.fn<(agentKind: string) => Promise<void>>();
const updateAgentConfigMock = vi.fn<(agentKind: string, config: Record<string, unknown>) => Promise<void>>();
const deleteModelProviderMock = vi.fn<(providerId: string) => Promise<void>>();
const setCompactAiOutputMock = vi.fn<(enabled: boolean) => Promise<void>>();
const setNotificationSettingsMock = vi.fn<(settings: Record<string, unknown>) => Promise<void>>();
const setDefaultOpenTargetMock = vi.fn<(target: string) => Promise<void>>();
const setImmediateRunModeMock = vi.fn<(mode: string) => Promise<void>>();
const setBrowserControlMock = vi.fn<(settings: Record<string, unknown>) => Promise<void>>();
const getConfigMock = vi.fn(async () => structuredClone(baseConfig));

vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    getConfig: (...args: unknown[]) => getConfigMock(...args),
    deleteModelProvider: deleteModelProviderMock,
    upsertModelProvider: vi.fn(),
    setActiveProvider: vi.fn(),
    setModelProviderEnabled: vi.fn(),
    instantiateBuiltinProviderTemplate: vi.fn(),
    testModelProvider: vi.fn(),
    setDefaultAgentKind: setDefaultAgentKindMock,
    updateAgentConfig: updateAgentConfigMock,
    setCompactAiOutput: setCompactAiOutputMock,
    setNotificationSettings: setNotificationSettingsMock,
    setDefaultOpenTarget: setDefaultOpenTargetMock,
    setImmediateRunMode: setImmediateRunModeMock,
    setBrowserControl: setBrowserControlMock,
  },
}));

vi.mock('../lib/tauri', () => ({
  agentApi: {
    stopProxy: vi.fn(),
  },
}));

const sampleProvider = (id: string): ModelProvider => ({
  id,
  name: `Provider ${id}`,
  enabled: true,
  api_key: 'sk-test',
  endpoints: [
    {
      protocol: 'openai_compatible',
      base_url: 'https://openrouter.ai/api/v1',
      api_key_override: null,
      codex_needs_proxy: false,
    },
  ],
  models: [{ id: 'gpt-5', name: 'GPT-5' }],
  default_model: 'gpt-5',
});

const baseConfig: AppConfig = {
  model_providers: [],
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
    },
    gemini_cli: {},
    opencode: {},
  },
  theme: 'System',
  compact_ai_output: false,
  default_open_target: 'file_explorer',
  notifications: {
    system_enabled: true,
    sound_enabled: false,
    sound: 'ding',
  },
};

describe('settings store agent config actions', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    getConfigMock.mockResolvedValue(structuredClone(baseConfig));
    deleteModelProviderMock.mockImplementation(async () => undefined);
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

  it('persists compact AI output preference', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().setCompactAiOutput(true);

    expect(setCompactAiOutputMock).toHaveBeenCalledWith(true);
    expect(useSettingsStore.getState().config?.compact_ai_output).toBe(true);
  });

  it('persists the default project open target', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().setDefaultOpenTarget('vscode');

    expect(setDefaultOpenTargetMock).toHaveBeenCalledWith('vscode');
    expect(useSettingsStore.getState().config?.default_open_target).toBe('vscode');
  });

  it('persists the immediate-run preference', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().setImmediateRunMode('interrupt');

    expect(setImmediateRunModeMock).toHaveBeenCalledWith('interrupt');
    expect(useSettingsStore.getState().config?.immediate_run_mode).toBe('interrupt');
  });

  it('keeps the active provider consistent when the active provider is deleted', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    const provider = sampleProvider('provider-1');

    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            model_providers: [provider],
            active_provider_id: 'provider-1',
          }
        : null,
    }));
    getConfigMock.mockResolvedValue({
      ...structuredClone(baseConfig),
      model_providers: [],
      active_provider_id: null,
    });

    await useSettingsStore.getState().deleteModelProvider('provider-1');

    expect(deleteModelProviderMock).toHaveBeenCalledWith('provider-1');
    expect(useSettingsStore.getState().config?.active_provider_id).toBeNull();
  });

  it('uses provider Codex proxy override when deciding if proxy is needed', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    const provider = sampleProvider('provider-1');

    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            model_providers: [provider],
            active_provider_id: 'provider-1',
          }
        : null,
    }));

    expect(useSettingsStore.getState().getNeedsProxy()).toBe(false);
  });

  it('reports no proxy needed when a responses endpoint exists on the active provider', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    const provider = sampleProvider('provider-1');
    provider.endpoints.push({
      protocol: 'openai_responses',
      base_url: 'https://open.bigmodel.cn/api/v1',
      api_key_override: null,
      codex_needs_proxy: false,
    });
    provider.endpoints[0].codex_needs_proxy = true;

    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            model_providers: [provider],
            active_provider_id: 'provider-1',
          }
        : null,
    }));

    expect(useSettingsStore.getState().getNeedsProxy()).toBe(false);
  });

  it('still reports proxy needed for chat-only providers that request it', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    const provider = sampleProvider('provider-1');
    provider.endpoints[0].codex_needs_proxy = true;

    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            model_providers: [provider],
            active_provider_id: 'provider-1',
          }
        : null,
    }));

    expect(useSettingsStore.getState().getNeedsProxy()).toBe(true);
  });

  it('persists notification settings updates', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().setNotificationSettings({
      system_enabled: true,
      sound_enabled: true,
      sound: 'chime',
    });

    expect(setNotificationSettingsMock).toHaveBeenCalledWith({
      system_enabled: true,
      sound_enabled: true,
      sound: 'chime',
    });
    expect(useSettingsStore.getState().config?.notifications).toEqual({
      system_enabled: true,
      sound_enabled: true,
      sound: 'chime',
    });
  });

  it('rolls notification settings back when persistence fails', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    setNotificationSettingsMock.mockRejectedValueOnce(new Error('write failed'));

    await useSettingsStore.getState().setNotificationSettings({
      system_enabled: false,
      sound_enabled: true,
      sound: 'alert',
    });

    expect(useSettingsStore.getState().config?.notifications).toEqual({
      system_enabled: true,
      sound_enabled: false,
      sound: 'ding',
    });
    expect(useSettingsStore.getState().error).toContain('write failed');
  });

  it('normalizes legacy notification sound values before saving', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().setNotificationSettings({
      system_enabled: true,
      sound_enabled: true,
      sound: 'soft' as never,
    });

    expect(setNotificationSettingsMock).toHaveBeenCalledWith({
      system_enabled: true,
      sound_enabled: true,
      sound: 'ding',
    });
    expect(useSettingsStore.getState().config?.notifications).toEqual({
      system_enabled: true,
      sound_enabled: true,
      sound: 'ding',
    });
  });

  it('persists reserved browser control settings', async () => {
    const { useSettingsStore } = await import('./settingsStore');

    await useSettingsStore.getState().setBrowserControl({
      enabled: true,
      ignore_certificate_errors: true,
    });

    expect(setBrowserControlMock).toHaveBeenCalledWith({
      enabled: true,
      ignore_certificate_errors: true,
    });
    expect(useSettingsStore.getState().config?.browser).toEqual({
      enabled: true,
      ignore_certificate_errors: true,
    });
  });

  it('fills browser control defaults when the saved config omitted the field', async () => {
    const { useSettingsStore } = await import('./settingsStore');
    getConfigMock.mockResolvedValueOnce({
      ...structuredClone(baseConfig),
      browser: undefined,
    });

    await useSettingsStore.getState().fetchConfig();

    expect(useSettingsStore.getState().config?.browser).toEqual({
      enabled: false,
      ignore_certificate_errors: false,
    });
  });
});
