// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THEME_BOOT_STORAGE_KEY } from '../lib/themeBoot';
import { ACCENTS, DEFAULT_PREFS, loadPrefs, seedsForPrefs } from '../lib/appearance';
import { deriveThemeTokens } from '../lib/colorDerivation';
import type { AppConfig } from '../types/provider';

/**
 * 默认强调色下深浅两套种子给出同一个 `--primary`（Codex 的 `#3a83f7` 明暗同值），
 * 所以「主题来源对不对」要看一个**深浅必然不同**的变量。
 */
const surfaceFor = (isDark: boolean) =>
  deriveThemeTokens(seedsForPrefs(DEFAULT_PREFS, isDark), isDark)['--background'];

// 只桩掉 settingsStore:appearanceStore 只需要它的 config 与订阅,拉真 store 会
// 把整条 daemon 客户端链拖进测试。
const { configRef, subscribeMock } = vi.hoisted(() => ({
  configRef: { current: null as AppConfig | null },
  subscribeMock: vi.fn(),
}));

vi.mock('./settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ config: configRef.current }),
    subscribe: subscribeMock,
  },
}));

describe('appearanceStore initial theme source', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    document.documentElement.removeAttribute('style');
    configRef.current = null;
    // jsdom 默认没有 matchMedia（appearanceStore 挂载时要订阅系统主题变化）。
    Object.defineProperty(window, 'matchMedia', {
      value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} }),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('style');
  });

  it('matches the pre-paint theme from the boot cache while the config is still loading', async () => {
    // 回归用例：首帧引导已按缓存把界面画成深色，强调色却按「配置未到 = 系统偏好」
    // 算成亮色，会出现深底 + 亮强调色的错配窗口。
    window.localStorage.setItem(THEME_BOOT_STORAGE_KEY, 'Dark');

    await import('./appearanceStore');

    const background = document.documentElement.style.getPropertyValue('--background');
    expect(background).toBe(surfaceFor(true));
    expect(background).not.toBe(surfaceFor(false));
  });

  it('keeps using the system preference when nothing was cached', async () => {
    await import('./appearanceStore');

    expect(document.documentElement.style.getPropertyValue('--background')).toBe(surfaceFor(false));
  });

  it('defers to the daemon config once it arrives, even if the cache disagrees', async () => {
    window.localStorage.setItem(THEME_BOOT_STORAGE_KEY, 'Light');
    await import('./appearanceStore');
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(surfaceFor(false));

    // 配置到手后重新初始化（模拟一次真实的冷启动：缓存旧了，配置才是真值）。
    vi.resetModules();
    configRef.current = { theme: 'Dark' } as AppConfig;
    await import('./appearanceStore');

    expect(document.documentElement.style.getPropertyValue('--background')).toBe(surfaceFor(true));
  });

  it('persists the contrast knob and re-derives the surface family', async () => {
    const { useAppearanceStore } = await import('./appearanceStore');
    const defaultBorder = document.documentElement.style.getPropertyValue('--border');

    useAppearanceStore.getState().setContrast(88);

    expect(loadPrefs().contrast).toBe(88);
    expect(useAppearanceStore.getState().prefs.contrast).toBe(88);
    expect(document.documentElement.style.getPropertyValue('--border')).not.toBe(defaultBorder);

    useAppearanceStore.getState().setContrast(5);
    expect(document.documentElement.style.getPropertyValue('--border')).not.toBe(defaultBorder);

    useAppearanceStore.getState().reset();
    expect(loadPrefs().contrast).toBe(DEFAULT_PREFS.contrast);
    expect(document.documentElement.style.getPropertyValue('--border')).toBe(defaultBorder);
  });

  it('exposes an accent preset per theme as plain hex', () => {
    for (const preset of Object.values(ACCENTS)) {
      expect(preset.light).toMatch(/^#[0-9a-f]{6}$/);
      expect(preset.dark).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
