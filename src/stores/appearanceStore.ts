import { create } from 'zustand';

import {
  type AccentKey,
  type AppearancePrefs,
  type ContentWidthKey,
  type FontSizeKey,
  type RadiusKey,
  ACCENTS,
  CONTENT_WIDTHS,
  DEFAULT_PREFS,
  FONT_SIZES,
  RADII,
  applyAppearance,
  loadPrefs,
  resolveIsDark,
  savePrefs,
} from '../lib/appearance';
import { useSettingsStore } from './settingsStore';

function apply(prefs: AppearancePrefs): void {
  applyAppearance(prefs, resolveIsDark(useSettingsStore.getState().config?.theme));
}

interface AppearanceState {
  prefs: AppearancePrefs;
  setAccent: (accent: AccentKey) => void;
  setFontSize: (fontSize: FontSizeKey) => void;
  setRadius: (radius: RadiusKey) => void;
  setContentWidth: (contentWidth: ContentWidthKey) => void;
  reset: () => void;
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  prefs: loadPrefs(),
  setAccent: (accent) => {
    const prefs = { ...useAppearanceStore.getState().prefs, accent };
    savePrefs(prefs);
    apply(prefs);
    set({ prefs });
  },
  setFontSize: (fontSize) => {
    const prefs = { ...useAppearanceStore.getState().prefs, fontSize };
    savePrefs(prefs);
    apply(prefs);
    set({ prefs });
  },
  setRadius: (radius) => {
    const prefs = { ...useAppearanceStore.getState().prefs, radius };
    savePrefs(prefs);
    apply(prefs);
    set({ prefs });
  },
  setContentWidth: (contentWidth) => {
    const prefs = { ...useAppearanceStore.getState().prefs, contentWidth };
    savePrefs(prefs);
    apply(prefs);
    set({ prefs });
  },
  reset: () => {
    savePrefs(DEFAULT_PREFS);
    apply(DEFAULT_PREFS);
    set({ prefs: DEFAULT_PREFS });
  },
}));

useSettingsStore.subscribe((state, prevState) => {
  if (state.config?.theme !== prevState.config?.theme) {
    apply(useAppearanceStore.getState().prefs);
  }
});

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const theme = useSettingsStore.getState().config?.theme;
    if (theme === 'System' || !theme) {
      apply(useAppearanceStore.getState().prefs);
    }
  });
}

apply(useAppearanceStore.getState().prefs);

export { ACCENTS, CONTENT_WIDTHS, FONT_SIZES, RADII, DEFAULT_PREFS };
