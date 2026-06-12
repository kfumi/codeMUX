import { create } from 'zustand';
import type { AgentConfigMap, AgentConfigUpdateMap, AppConfig, Provider, Theme } from '../types/provider';
import type { ModelInfo } from '../lib/tauri';
import { configApi, agentApi } from '../lib/tauri';
import { useNewSessionStore } from './newSessionStore';
import { getDefaultAgentKind } from '../types/agentRegistry';
import type { AgentKind } from '../types/session';

interface SettingsState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  proxyRunning: boolean;
  proxyUrl: string | null;
  fetchConfig: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setActiveProvider: (providerId: string) => Promise<void>;
  updateProvider: (provider: Provider) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  fetchModels: (apiKey: string, baseUrl: string) => Promise<ModelInfo[]>;
  testProvider: (providerId: string) => Promise<string>;
  getActiveProvider: () => Provider | null;
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
    try {
      await configApi.setTheme(theme);
      set((state) => ({
        config: state.config ? { ...state.config, theme } : null,
      }));
    } catch (error) {
      set({ error: String(error) });
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
    const provider = get().getActiveProvider();
    if (!provider?.api_key || !provider?.openai_base_url) {
      set({ error: 'No provider configured with api_key and openai_base_url' });
      return;
    }
    try {
      const port = await agentApi.startProxy(provider.api_key, provider.openai_base_url);
      set({
        proxyRunning: true,
        proxyUrl: port > 0 ? `http://127.0.0.1:${port}` : null,
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  stopProxy: async () => {
    try {
      await agentApi.stopProxy();
      set({ proxyRunning: false, proxyUrl: null });
    } catch (error) {
      set({ error: String(error) });
    }
  },
}));
