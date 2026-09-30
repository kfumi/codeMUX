// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THEME_BOOT_STORAGE_KEY } from '../lib/themeBoot';
import { ACCENTS } from '../lib/appearance';
import type { AppConfig } from '../types/provider';

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

    const primary = document.documentElement.style.getPropertyValue('--primary');
    expect(primary).toBe(ACCENTS.graphite.dark);
    expect(primary).not.toBe(ACCENTS.graphite.light);
  });

  it('keeps using the system preference when nothing was cached', async () => {
    await import('./appearanceStore');

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe(ACCENTS.graphite.light);
  });

  it('defers to the daemon config once it arrives, even if the cache disagrees', async () => {
    window.localStorage.setItem(THEME_BOOT_STORAGE_KEY, 'Light');
    await import('./appearanceStore');
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe(ACCENTS.graphite.light);

    // 配置到手后重新初始化（模拟一次真实的冷启动：缓存旧了，配置才是真值）。
    vi.resetModules();
    configRef.current = { theme: 'Dark' } as AppConfig;
    await import('./appearanceStore');

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe(ACCENTS.graphite.dark);
  });
});
