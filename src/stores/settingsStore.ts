import { create } from 'zustand';
import type { AgentConfigMap, AgentConfigUpdateMap, AppConfig, NotificationSettings, Provider, Theme } from '../types/provider';
import type { ModelInfo } from '../lib/tauri';
import { configApi, agentApi } from '../lib/tauri';
import { useNewSessionStore } from './newSessionStore';
import { getDefaultAgentKind } from '../types/agentRegistry';
import type { AgentKind } from '../types/session';

function applyThemeLocally(theme: Theme) {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;

  if (theme === 'Dark') {
    root.classList.add('dark');
    return;
  }

  if (theme === 'Light') {
    root.classList.remove('dark');
    return;
  }

  const prefersDark = typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;

  root.classList.toggle('dark', prefersDark);
}

interface SettingsState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  proxyRunning: boolean;
  proxyUrl: string | null;
  proxyToggling: boolean;
  fetchConfig: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setCompactAiOutput: (enabled: boolean) => Promise<void>;
  setNotificationSettings: (settings: NotificationSettings) => Promise<void>;
  setActiveProvider: (providerId: string) => Promise<void>;
  updateProvider: (provider: Provider) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  fetchModels: (apiKey: string, baseUrl: string) => Promise<ModelInfo[]>;
  testProvider: (providerId: string) => Promise<string>;
  getActiveProvider: () => Provider | null;
  getNeedsProxy: () => boolean;
  getDefaultAgentKind: () => AgentKind;
  setDefaultAgentKind: (agentKind: AgentKind) => Promise<void>;
  updateAgentConfig: <T extends keyof AgentConfigMap>(agentKind: T, config: AgentConfigUpdateMap[T]) => Promise<void>;
  startProxy: () => Promise<void>;
  stopProxy: () => Promise<void>;
  setProxyRunning: (running: boolean, url?: string | null) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,
  proxyRunning: false,
  proxyUrl: null,
  proxyToggling: false,

  fetchConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      const config = await configApi.get();
      useNewSessionStore.getState().setSelectedAgentKind(config.agent_defaults.default_agent_kind);
      set({ config, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  setTheme: async (theme: Theme) => {
    const previousTheme = get().config?.theme ?? 'System';
    applyThemeLocally(theme);
    set((state) => ({
      config: state.config ? { ...state.config, theme } : state.config,
      error: null,
    }));

    try {
      await configApi.setTheme(theme);
    } catch (error) {
      applyThemeLocally(previousTheme);
      set((state) => ({
        config: state.config ? { ...state.config, theme: previousTheme } : state.config,
        error: String(error),
      }));
    }
  },

  setCompactAiOutput: async (enabled: boolean) => {
    const previousValue = get().config?.compact_ai_output ?? false;
    set((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: enabled } : state.config,
      error: null,
    }));

    try {
      await configApi.setCompactAiOutput(enabled);
    } catch (error) {
      set((state) => ({
        config: state.config ? { ...state.config, compact_ai_output: previousValue } : state.config,
        error: String(error),
      }));
    }
  },

  setNotificationSettings: async (settings: NotificationSettings) => {
    const previousValue = get().config?.notifications ?? {
      system_enabled: true,
      sound_enabled: false,
      sound: 'soft' as const,
    };
    set((state) => ({
      config: state.config ? { ...state.config, notifications: settings } : state.config,
      error: null,
    }));

    try {
      await configApi.setNotificationSettings(settings);
    } catch (error) {
      set((state) => ({
        config: state.config ? { ...state.config, notifications: previousValue } : state.config,
        error: String(error),
      }));
    }
  },

  setActiveProvider: async (providerId: string) => {
    try {
      await configApi.setActiveProvider(providerId);
      set((state) => ({
        config: state.config ? { ...state.config, active_provider_id: providerId } : null,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  updateProvider: async (provider: Provider) => {
    try {
      await configApi.updateProvider(provider);
      set((state) => {
        if (!state.config) return { config: null };
        const exists = state.config.providers.some((entry) => entry.id === provider.id);
        const providers = exists
          ? state.config.providers.map((entry) => (entry.id === provider.id ? provider : entry))
          : [...state.config.providers, provider];
        return { config: { ...state.config, providers } };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  deleteProvider: async (providerId: string) => {
    try {
      await configApi.deleteProvider(providerId);
      set((state) => {
        if (!state.config) return { config: null };
        const providers = state.config.providers.filter((entry) => entry.id !== providerId);
        const active_provider_id =
          state.config.active_provider_id === providerId
            ? providers[0]?.id ?? null
            : state.config.active_provider_id;
        return {
          config: {
            ...state.config,
            providers,
            active_provider_id,
          },
        };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  fetchModels: async (apiKey: string, baseUrl: string) => {
    return configApi.fetchModels(apiKey, baseUrl);
  },

  testProvider: async (providerId: string) => {
    return configApi.testProvider(providerId);
  },

  getActiveProvider: () => {
    const config = get().config;
    if (!config) return null;
    return config.providers.find((provider) => provider.id === config.active_provider_id) ?? null;
  },

  getNeedsProxy: () => {
    const provider = get().getActiveProvider();
    if (!provider?.openai_base_url) return false;
    if (provider.codex_needs_proxy !== undefined) {
      return provider.codex_needs_proxy;
    }
    try {
      return new URL(provider.openai_base_url).host.toLowerCase() !== 'api.openai.com';
    } catch {
      return true;
    }
  },

  getDefaultAgentKind: () => {
    const config = get().config;
    return config?.agent_defaults.default_agent_kind ?? getDefaultAgentKind();
  },

  setDefaultAgentKind: async (agentKind: AgentKind) => {
    try {
      await configApi.setDefaultAgentKind(agentKind);
      useNewSessionStore.getState().setSelectedAgentKind(agentKind);
      set((state) => ({
        config: state.config
          ? {
              ...state.config,
              agent_defaults: {
                ...state.config.agent_defaults,
                default_agent_kind: agentKind,
              },
            }
          : null,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  updateAgentConfig: async <T extends keyof AgentConfigMap>(agentKind: T, config: AgentConfigUpdateMap[T]) => {
    try {
      await configApi.updateAgentConfig(agentKind, config);
      set((state) => ({
        config: state.config
          ? {
              ...state.config,
              agent_configs: {
                ...state.config.agent_configs,
                [agentKind]: {
                  ...state.config.agent_configs[agentKind],
                  ...config,
                },
              },
            }
          : null,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  setProxyRunning: (running: boolean, url?: string | null) => {
    set({ proxyRunning: running, proxyUrl: running ? (url ?? get().proxyUrl) : null });
  },

  startProxy: async () => {
    if (get().proxyToggling) return;
    const provider = get().getActiveProvider();
    if (!provider?.api_key || !provider?.openai_base_url) {
      set({ error: 'No provider configured with api_key and openai_base_url' });
      return;
    }
    set({ proxyToggling: true });
    try {
      const port = await agentApi.startProxy(provider.api_key, provider.openai_base_url, provider.name, get().getNeedsProxy());
      set({
        proxyRunning: true,
        proxyUrl: port > 0 ? `http://127.0.0.1:${port}` : null,
      });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ proxyToggling: false });
    }
  },

  stopProxy: async () => {
    if (get().proxyToggling) return;
    set({ proxyToggling: true });
    try {
      await agentApi.stopProxy();
      set({ proxyRunning: false, proxyUrl: null });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ proxyToggling: false });
    }
  },
}));
