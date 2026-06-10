import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../types/provider';

const setDefaultAgentKindMock = vi.fn<(agentKind: string) => Promise<void>>();
const updateAgentConfigMock = vi.fn<(agentKind: string, config: Record<string, unknown>) => Promise<void>>();

vi.mock('../lib/tauri', () => ({
  configApi: {
    get: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
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
});
