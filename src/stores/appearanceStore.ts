import { create } from 'zustand';

import {
  type AccentKey,
  type AppearancePrefs,
  type ContentWidthKey,
  type RadiusKey,
  ACCENTS,
  CONTENT_WIDTHS,
  DEFAULT_PREFS,
  RADII,
  clampCodeFontSize,
  applyAppearance,
  clampUiFontSize,
  loadPrefs,
  resolveIsDark,
  savePrefs,
} from '../lib/appearance';
import { useSettingsStore } from './settingsStore';
import { readBootTheme } from '../lib/themeBoot';

function apply(prefs: AppearancePrefs): void {
  // 配置还没到手时用首帧引导脚本缓存的主题：否则 index.html 已经按深色把首帧画出来了，
  // 而强调色/指令 chip 却按系统偏好算成亮色，出现「深底 + 亮强调色」的错配窗口。
  const theme = useSettingsStore.getState().config?.theme ?? readBootTheme() ?? undefined;
  applyAppearance(prefs, resolveIsDark(theme));
}

interface AppearanceState {
  prefs: AppearancePrefs;
  setAccent: (accent: AccentKey) => void;
  setUiFontFamily: (uiFontFamily: string) => void;
  setUiFontSize: (uiFontSize: number) => void;
  setCodeFontSize: (codeFontSize: number) => void;
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
  setUiFontFamily: (uiFontFamily) => {
    const prefs = { ...useAppearanceStore.getState().prefs, uiFontFamily };
    savePrefs(prefs);
    apply(prefs);
    set({ prefs });
  },
  setUiFontSize: (uiFontSize) => {
    const prefs = { ...useAppearanceStore.getState().prefs, uiFontSize: clampUiFontSize(uiFontSize) };
    savePrefs(prefs);
    apply(prefs);
    set({ prefs });
  },
  setCodeFontSize: (codeFontSize) => {
    const prefs = { ...useAppearanceStore.getState().prefs, codeFontSize: clampCodeFontSize(codeFontSize) };
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

export { ACCENTS, CONTENT_WIDTHS, RADII, DEFAULT_PREFS };
