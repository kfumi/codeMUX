import { create } from 'zustand';
import type { AppConfig, ProviderConfig, Theme } from '../types/provider';
import { configApi } from '../lib/tauri';

interface SettingsState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  fetchConfig: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setActiveProvider: (providerId: string) => Promise<void>;
  updateProvider: (provider: ProviderConfig) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
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
  updateProvider: async (provider: ProviderConfig) => {
    try {
      await configApi.updateProvider(provider);
      set((state) => {
        if (!state.config) return { config: null };
        const providers = state.config.providers.map((p) =>
          p.id === provider.id ? provider : p
        );
        return { config: { ...state.config, providers } };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },
}));
