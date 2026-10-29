/**
 * 外观的 **React 投影** —— 只负责把模块的快照交给 React，不持有真值。
 *
 * 真值在 `lib/appearance/index.ts`（模块单例）。这个 store 曾经是真值源：
 * 自己 `loadPrefs()` 初始化、自己 `savePrefs()`、自己 `resolveIsDark()`，
 * 于是「明暗是什么」和「配置没到时用什么」各自有了一套答案。
 *
 * 现在它只剩一个职责：`useAppearanceStore(selector)` 能拿到响应式的 prefs。
 * 七个 setter 全部转发给 `setPref`，模块 apply 完再把快照推回来。
 * 「快照 ≡ 模块状态」由 `appearanceStore.test.ts` 锁住 —— 少了那条断言，
 * 它随时会重新长出状态。
 */

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
  getPrefs,
  resetPrefs,
  setPref,
  subscribe,
} from '../lib/appearance';

interface AppearanceState {
  prefs: AppearancePrefs;
  setAccent: (accent: AccentKey) => void;
  setContrast: (contrast: number) => void;
  setUiFontFamily: (uiFontFamily: string) => void;
  setUiFontSize: (uiFontSize: number) => void;
  setCodeFontSize: (codeFontSize: number) => void;
  setRadius: (radius: RadiusKey) => void;
  setContentWidth: (contentWidth: ContentWidthKey) => void;
  reset: () => void;
}

export const useAppearanceStore = create<AppearanceState>(() => ({
  prefs: getPrefs(),
  setAccent: (accent) => setPref('accent', accent),
  setContrast: (contrast) => setPref('contrast', contrast),
  setUiFontFamily: (uiFontFamily) => setPref('uiFontFamily', uiFontFamily),
  setUiFontSize: (uiFontSize) => setPref('uiFontSize', uiFontSize),
  setCodeFontSize: (codeFontSize) => setPref('codeFontSize', codeFontSize),
  setRadius: (radius) => setPref('radius', radius),
  setContentWidth: (contentWidth) => setPref('contentWidth', contentWidth),
  reset: () => resetPrefs(),
}));

// 模块 apply 后把新快照推回来。这是单向的：store 从不写回模块。
subscribe((prefs) => {
  useAppearanceStore.setState({ prefs });
});

export { ACCENTS, CONTENT_WIDTHS, RADII, DEFAULT_PREFS };
