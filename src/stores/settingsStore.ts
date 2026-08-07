import { create } from 'zustand';
import type {
  AgentConfigMap,
  AgentConfigUpdateMap,
  AppConfig,
  ModelProvider,
  NotificationSettings,
  Theme,
} from '../types/provider';
import { configApi, agentApi } from '../lib/tauri';
import { useNewSessionStore } from './newSessionStore';
import { getDefaultAgentKind } from '../types/agentRegistry';
import type { AgentKind } from '../types/session';
import { normalizeNotificationSettings } from '../lib/notificationSettings';
import { normalizeOpenTarget, type OpenTarget } from '../lib/openTargets';
import { getActiveModelProvider, selectEndpoint } from '../lib/modelProviders';

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
  setDefaultOpenTarget: (target: OpenTarget) => Promise<void>;
  setNotificationSettings: (settings: NotificationSettings) => Promise<void>;
  setActiveProvider: (providerId: string) => Promise<void>;
  upsertModelProvider: (provider: ModelProvider) => Promise<void>;
  deleteModelProvider: (providerId: string) => Promise<void>;
  setModelProviderEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  instantiateBuiltinTemplate: (templateId: string) => Promise<ModelProvider>;
  testModelProvider: (providerId: string) => Promise<string>;
  getActiveProvider: () => ModelProvider | null;
  getNeedsProxy: () => boolean;
  getDefaultAgentKind: () => AgentKind;
  setDefaultAgentKind: (agentKind: AgentKind) => Promise<void>;
  updateAgentConfig: <T extends keyof AgentConfigMap>(agentKind: T, config: AgentConfigUpdateMap[T]) => Promise<void>;
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
      const rawConfig = await configApi.get();
      const config: AppConfig = {
        ...rawConfig,
        model_providers: rawConfig.model_providers ?? [],
        default_open_target: normalizeOpenTarget(rawConfig.default_open_target),
        notifications: normalizeNotificationSettings(rawConfig.notifications),
      };
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
    const previous = get().config?.compact_ai_output ?? false;
    set((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: enabled } : state.config,
      error: null,
    }));
    try {
      await configApi.setCompactAiOutput(enabled);
    } catch (error) {
      set((state) => ({
        config: state.config ? { ...state.config, compact_ai_output: previous } : state.config,
        error: String(error),
      }));
    }
  },

  setDefaultOpenTarget: async (target: OpenTarget) => {
    const previous = get().config?.default_open_target ?? 'file_explorer';
    set((state) => ({
      config: state.config ? { ...state.config, default_open_target: target } : state.config,
      error: null,
    }));
    try {
      await configApi.setDefaultOpenTarget(target);
    } catch (error) {
      set((state) => ({
        config: state.config ? { ...state.config, default_open_target: previous } : state.config,
        error: String(error),
      }));
    }
  },

  setNotificationSettings: async (settings: NotificationSettings) => {
    const previousNotifications = get().config?.notifications;
    const nextSettings = normalizeNotificationSettings(settings);
    set((state) => ({
      config: state.config ? { ...state.config, notifications: nextSettings } : state.config,
      error: null,
    }));

    try {
      await configApi.setNotificationSettings(nextSettings);
    } catch (error) {
      set((state) => ({
        config: state.config && previousNotifications
          ? { ...state.config, notifications: previousNotifications }
          : state.config,
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
      throw error;
    }
  },

  upsertModelProvider: async (provider: ModelProvider) => {
    try {
      await configApi.upsertModelProvider(provider);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteModelProvider: async (providerId: string) => {
    try {
      await configApi.deleteModelProvider(providerId);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  setModelProviderEnabled: async (providerId: string, enabled: boolean) => {
    try {
      await configApi.setModelProviderEnabled(providerId, enabled);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  instantiateBuiltinTemplate: async (templateId: string) => {
    const provider = await configApi.instantiateBuiltinProviderTemplate(templateId);
    await get().fetchConfig();
    return provider;
  },

  testModelProvider: async (providerId: string) => {
    return configApi.testModelProvider(providerId);
  },

  getActiveProvider: () => {
    const config = get().config;
    if (!config) return null;
    return getActiveModelProvider(config.model_providers, config.active_provider_id);
  },

  getNeedsProxy: () => {
    const provider = get().getActiveProvider();
    if (!provider) return false;
    const endpoint = selectEndpoint(provider, 'openai_compatible');
    return Boolean(endpoint?.codex_needs_proxy);
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
