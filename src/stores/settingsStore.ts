import { create } from 'zustand';
import type {
  AgentConfigMap,
  AgentConfigUpdateMap,
  AppConfig,
  GitSettings,
  ImageRecognitionConfig,
  ModelProvider,
  NotificationSettings,
  Theme,
  BrowserControlSettings,
  ImmediateRunMode,
} from '../types/provider';
import { daemonFacade } from '../lib/facades/daemon-facade';
import { useNewSessionStore } from './newSessionStore';
import { getDefaultAgentKind } from '../types/agentRegistry';
import type { AgentKind } from '../types/session';
import { normalizeNotificationSettings } from '../lib/notificationSettings';
import { normalizeGitSettings } from '../lib/gitSettings';
import { normalizeBrowserControl } from '../lib/browserControl';
import { normalizeOpenTarget, type OpenTarget } from '../lib/openTargets';
import { normalizeImmediateRunMode } from '../lib/agentSteer';
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
  setImmediateRunMode: (mode: ImmediateRunMode) => Promise<void>;
  setAttachmentEnrichment: (enrichment: ImageRecognitionConfig) => Promise<void>;
  setDefaultOpenTarget: (target: OpenTarget) => Promise<void>;
  setNotificationSettings: (settings: NotificationSettings) => Promise<void>;
  setGitSettings: (settings: GitSettings) => Promise<void>;
  setBrowserControl: (settings: BrowserControlSettings) => Promise<void>;
  setActiveProvider: (providerId: string) => Promise<void>;
  upsertModelProvider: (provider: ModelProvider) => Promise<void>;
  deleteModelProvider: (providerId: string) => Promise<void>;
  setModelProviderEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  instantiateBuiltinTemplate: (templateId: string) => Promise<ModelProvider>;
  testModelProvider: (apiKey: string, baseUrl: string) => Promise<string>;
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
      const rawConfig = await daemonFacade.getConfig();
      const config: AppConfig = {
        ...rawConfig,
        model_providers: rawConfig.model_providers ?? [],
        default_open_target: normalizeOpenTarget(rawConfig.default_open_target),
        immediate_run_mode: normalizeImmediateRunMode(rawConfig.immediate_run_mode),
        notifications: normalizeNotificationSettings(rawConfig.notifications),
        git: normalizeGitSettings(rawConfig.git),
        browser: normalizeBrowserControl(rawConfig.browser),
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
      await daemonFacade.setTheme(theme);
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
      await daemonFacade.setCompactAiOutput(enabled);
    } catch (error) {
      set((state) => ({
        config: state.config ? { ...state.config, compact_ai_output: previous } : state.config,
        error: String(error),
      }));
    }
  },

  setImmediateRunMode: async (mode: ImmediateRunMode) => {
    const previous = normalizeImmediateRunMode(get().config?.immediate_run_mode);
    const next = normalizeImmediateRunMode(mode);
    set((state) => ({
      config: state.config ? { ...state.config, immediate_run_mode: next } : state.config,
      error: null,
    }));
    try {
      await daemonFacade.setImmediateRunMode(next);
    } catch (error) {
      set((state) => ({
        config: state.config ? { ...state.config, immediate_run_mode: previous } : state.config,
        error: String(error),
      }));
    }
  },

  setAttachmentEnrichment: async (enrichment: ImageRecognitionConfig) => {
    const previous = get().config?.attachment_enrichment;
    set((state) => ({
      config: state.config ? { ...state.config, attachment_enrichment: enrichment } : state.config,
      error: null,
    }));
    try {
      await daemonFacade.setAttachmentEnrichment(enrichment);
    } catch (error) {
      set((state) => ({
        config: state.config ? { ...state.config, attachment_enrichment: previous } : state.config,
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
      await daemonFacade.setDefaultOpenTarget(target);
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
      await daemonFacade.setNotificationSettings(nextSettings);
    } catch (error) {
      set((state) => ({
        config: state.config && previousNotifications
          ? { ...state.config, notifications: previousNotifications }
          : state.config,
        error: String(error),
      }));
    }
  },

  setGitSettings: async (settings: GitSettings) => {
    const previousGit = get().config?.git;
    const nextSettings = normalizeGitSettings(settings);
    set((state) => ({
      config: state.config ? { ...state.config, git: nextSettings } : state.config,
      error: null,
    }));

    try {
      await daemonFacade.setGitSettings(nextSettings);
    } catch (error) {
      set((state) => ({
        config: state.config && previousGit
          ? { ...state.config, git: previousGit }
          : state.config,
        error: String(error),
      }));
    }
  },

  setBrowserControl: async (settings: BrowserControlSettings) => {
    const previous = get().config?.browser;
    const nextSettings = normalizeBrowserControl(settings);
    set((state) => ({
      config: state.config ? { ...state.config, browser: nextSettings } : state.config,
      error: null,
    }));
    try {
      await daemonFacade.setBrowserControl(nextSettings);
    } catch (error) {
      set((state) => ({
        config: state.config
          ? { ...state.config, browser: previous }
          : state.config,
        error: String(error),
      }));
    }
  },

  setActiveProvider: async (providerId: string) => {
    try {
      await daemonFacade.setActiveProvider(providerId);
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
      await daemonFacade.upsertModelProvider(provider);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteModelProvider: async (providerId: string) => {
    try {
      await daemonFacade.deleteModelProvider(providerId);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  setModelProviderEnabled: async (providerId: string, enabled: boolean) => {
    try {
      await daemonFacade.setModelProviderEnabled(providerId, enabled);
      await get().fetchConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  instantiateBuiltinTemplate: async (templateId: string) => {
    const provider = await daemonFacade.instantiateBuiltinProviderTemplate(templateId);
    await get().fetchConfig();
    return provider as ModelProvider;
  },

  testModelProvider: async (apiKey: string, baseUrl: string) => {
    return daemonFacade.testModelProvider(apiKey, baseUrl);
  },

  getActiveProvider: () => {
    const config = get().config;
    if (!config) return null;
    return getActiveModelProvider(config.model_providers, config.active_provider_id);
  },

  getNeedsProxy: () => {
    const provider = get().getActiveProvider();
    if (!provider) return false;
    // Codex dials a native Responses endpoint directly; the compat proxy only
    // applies to the chat-completions fallback.
    if (selectEndpoint(provider, 'openai_responses')) return false;
    const endpoint = selectEndpoint(provider, 'openai_compatible');
    return Boolean(endpoint?.codex_needs_proxy);
  },

  getDefaultAgentKind: () => {
    const config = get().config;
    return config?.agent_defaults.default_agent_kind ?? getDefaultAgentKind();
  },

  setDefaultAgentKind: async (agentKind: AgentKind) => {
    try {
      await daemonFacade.setDefaultAgentKind(agentKind);
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
      await daemonFacade.updateAgentConfig(agentKind, config);
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
      // 工单 09:stop_codex_proxy 壳命令随 Tauri 退役,代理生命周期由 daemon
      // 自管;此处仅复位本地状态(此前 UI 也无该入口,保持签名兼容)。
      set({ proxyRunning: false, proxyUrl: null });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ proxyToggling: false });
    }
  },
}));
