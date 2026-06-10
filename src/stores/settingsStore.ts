import { create } from 'zustand';
import type { AppConfig, Provider, Theme } from '../types/provider';
import type { ModelInfo } from '../lib/tauri';
import { configApi } from '../lib/tauri';
import { getDefaultAgentKind } from '../types/agentRegistry';
import type { AgentKind } from '../types/session';

interface SettingsState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  fetchConfig: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setActiveProvider: (providerId: string) => Promise<void>;
  updateProvider: (provider: Provider) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  fetchModels: (apiKey: string, baseUrl: string) => Promise<ModelInfo[]>;
  testProvider: (providerId: string) => Promise<string>;
  getActiveProvider: () => Provider | null;
  getDefaultAgentKind: () => AgentKind;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  fetchConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      const config = await configApi.get();
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
        const exists = state.config.providers.some((p) => p.id === provider.id);
        const providers = exists
          ? state.config.providers.map((p) => (p.id === provider.id ? provider : p))
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
        const providers = state.config.providers.filter((p) => p.id !== providerId);
        const active_provider_id =
          state.config.active_provider_id === providerId
            ? providers[0]?.id ?? null
            : state.config.active_provider_id;
        return { config: { ...state.config, providers, active_provider_id } };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  fetchModels: async (apiKey: string, baseUrl: string) => {
    const models = await configApi.fetchModels(apiKey, baseUrl);
    return models;
  },

  testProvider: async (providerId: string) => {
    const result = await configApi.testProvider(providerId);
    return result;
  },

  getActiveProvider: () => {
    const config = get().config;
    if (!config) return null;
    return config.providers.find((p) => p.id === config.active_provider_id) ?? null;
  },

  getDefaultAgentKind: () => {
    const config = get().config;
    return config?.agent_defaults.default_agent_kind ?? getDefaultAgentKind();
  },
}));
