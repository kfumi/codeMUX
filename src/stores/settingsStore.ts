import { create } from 'zustand';
import type { AgentConfigMap, AgentConfigUpdateMap, AgentProviderProfileUpsert, AppConfig, NotificationSettings, Provider, Theme } from '../types/provider';
import { configApi, agentApi } from '../lib/tauri';
import { useNewSessionStore } from './newSessionStore';
import { getDefaultAgentKind } from '../types/agentRegistry';
import type { AgentKind } from '../types/session';
import { normalizeNotificationSettings } from '../lib/notificationSettings';
import { normalizeOpenTarget, type OpenTarget } from '../lib/openTargets';

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
  updateProvider: (provider: Provider) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  testProvider: (providerId: string) => Promise<string>;
  upsertAgentProfile: (profile: AgentProviderProfileUpsert) => Promise<void>;
  activateAgentProfile: (agentKind: 'claude_code' | 'codex' | 'opencode', profileId: string) => Promise<void>;
  activateDefaultClaudeSupplier: () => Promise<void>;
  activateDefaultCodexSupplier: () => Promise<void>;
  activateDefaultOpenCodeSupplier: () => Promise<void>;
  setActiveAgentProfileModel: (agentKind: 'claude_code' | 'codex' | 'opencode', model: string) => Promise<void>;
  deleteAgentProfile: (profileId: string) => Promise<void>;
  testAgentProfile: (agentKind: 'claude_code' | 'codex' | 'opencode', profileId: string) => Promise<string>;
  getActiveProvider: () => Provider | null;
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
      const config = {
        ...rawConfig,
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

  setDefaultOpenTarget: async (target: OpenTarget) => {
    const previousTarget = normalizeOpenTarget(get().config?.default_open_target);
    const nextTarget = normalizeOpenTarget(target);
    set((state) => ({
      config: state.config ? { ...state.config, default_open_target: nextTarget } : state.config,
      error: null,
    }));

    try {
      await configApi.setDefaultOpenTarget(nextTarget);
    } catch (error) {
      set((state) => ({
        config: state.config ? { ...state.config, default_open_target: previousTarget } : state.config,
        error: String(error),
      }));
    }
  },

  setNotificationSettings: async (settings: NotificationSettings) => {
    const previousConfig = get().config;
    const nextSettings = normalizeNotificationSettings(settings);
    const previousNotifications = normalizeNotificationSettings(previousConfig?.notifications);
    set((state) => ({
      config: state.config ? { ...state.config, notifications: nextSettings } : state.config,
      error: null,
    }));

    try {
      await configApi.setNotificationSettings(nextSettings);
    } catch (error) {
      set((state) => ({
        config: state.config ? { ...state.config, notifications: previousNotifications } : state.config,
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

  testProvider: async (providerId: string) => {
    return configApi.testProvider(providerId);
  },

  upsertAgentProfile: async (profile) => {
    try {
      await configApi.upsertAgentProfile(profile);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  activateAgentProfile: async (agentKind, profileId) => {
    try {
      await configApi.activateAgentProfile(agentKind, profileId);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
  activateDefaultClaudeSupplier: async () => {
    try {
      await configApi.activateDefaultClaudeSupplier();
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
  activateDefaultCodexSupplier: async () => {
    try {
      await configApi.activateDefaultCodexSupplier();
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  activateDefaultOpenCodeSupplier: async () => {
    try {
      await configApi.activateDefaultOpenCodeSupplier();
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  setActiveAgentProfileModel: async (agentKind, model) => {
    try {
      await configApi.setActiveAgentProfileModel(agentKind, model);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteAgentProfile: async (profileId) => {
    try {
      await configApi.deleteAgentProfile(profileId);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  testAgentProfile: async (agentKind, profileId) => {
    return configApi.testAgentProfile(agentKind, profileId);
  },

  getActiveProvider: () => {
    const config = get().config;
    if (!config) return null;
    return config.providers.find((provider) => provider.id === config.active_provider_id) ?? null;
  },

  getNeedsProxy: () => {
    const config = get().config;
    const profileId = config?.agent_profile_registry?.active_profile_ids?.codex;
    const profile = config?.agent_profile_registry?.profiles.find((entry) => entry.id === profileId);
    return profile?.native_config.type === 'codex' && Boolean(profile.native_config.codex_needs_proxy);
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
