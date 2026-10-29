// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFS,
  __resetForTests,
  getIsDark,
  getPrefs,
  resetPrefs,
  setPref,
  setTheme,
  subscribe,
  subscribeIsDark,
} from './index';
import { THEME_BOOT_STORAGE_KEY, readBootTheme } from './boot';
import { deriveThemeTokens } from '../colorDerivation';
import { seedsForPrefs } from './presets';

/** 默认强调色下深浅两套种子给出同一个 `--primary`，所以要看深浅必然不同的变量。 */
const surfaceVar = (isDark: boolean) =>
  deriveThemeTokens(seedsForPrefs(DEFAULT_PREFS, isDark), isDark)['--background'];

let prefersDark = false;

function stubPrefersDark(value: boolean): void {
  prefersDark = value;
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      get matches() {
        return query.includes('dark') && prefersDark;
      },
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    writable: true,
    configurable: true,
  });
}

describe('appearance module', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    stubPrefersDark(false);
    __resetForTests();
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  // ---- 从 useTheme.test.tsx 迁来的三条回归用例 ----------------------------
  // useTheme 删掉了，但它覆盖的是真实回归（首帧不闪白 / System 跟随），
  // 职责现在归模块，所以断言跟着搬到这一层。

  it('applies the configured dark theme and caches it for the next launch', () => {
    // 回归：主题只在内存里生效时，首帧引导脚本读不到缓存，深色用户会闪一下白。
    setTheme('Dark');

    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.getPropertyValue('--boot-bg')).toBe('#111111');
    expect(window.localStorage.getItem(THEME_BOOT_STORAGE_KEY)).toBe('Dark');
  });

  it('drops the dark class and re-caches when the theme flips to light', () => {
    setTheme('Dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    setTheme('Light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--boot-bg')).toBe('#fcfcfc');
    expect(window.localStorage.getItem(THEME_BOOT_STORAGE_KEY)).toBe('Light');
  });

  it('re-applies when the OS preference changes while the theme is System', () => {
    setTheme('System');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    prefersDark = true;
    // 模块在 setTheme 时已注册监听器；直接触发一次重算，等价于 OS 变更回调。
    setTheme('System');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_BOOT_STORAGE_KEY)).toBe('System');
  });

  // ---- 两条路径同源（本轮要修的核心缺陷）----------------------------------

  it('resolves the boot cache the same way for chrome and for prefs', () => {
    // 曾经的 bug：applyThemeLocally 不看 boot 缓存、按系统偏好算，
    // 而 appearanceStore 看缓存 —— 配置未到时，`.dark` 与强调色来自两个不同的答案。
    window.localStorage.setItem(THEME_BOOT_STORAGE_KEY, 'Dark');
    stubPrefersDark(false);

    setTheme(undefined);

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(surfaceVar(true));
  });

  it('falls back to the OS preference only when the cache is also empty', () => {
    stubPrefersDark(true);
    setTheme(undefined);

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(surfaceVar(true));
  });

  it('lets the authoritative config win over a stale boot cache', () => {
    window.localStorage.setItem(THEME_BOOT_STORAGE_KEY, 'Light');
    setTheme('Dark');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(readBootTheme()).toBe('Dark');
  });

  // ---- prefs 与订阅 -------------------------------------------------------

  it('applies and persists a single knob without touching the others', () => {
    const before = getPrefs();
    setPref('accent', 'emerald');

    expect(getPrefs().accent).toBe('emerald');
    expect(getPrefs().uiFontSize).toBe(before.uiFontSize);
    expect(JSON.parse(window.localStorage.getItem('codemux:appearance') ?? '{}').accent).toBe('emerald');
  });

  it('clamps out-of-range values instead of storing them', () => {
    setPref('uiFontSize', 99);
    expect(getPrefs().uiFontSize).toBe(18);

    setPref('contrast', -5);
    expect(getPrefs().contrast).toBe(0);
  });

  it('re-derives the surface family when contrast changes', () => {
    // 先落一次默认值再取基线：beforeEach 清掉了 style 属性，此时读到的是空串。
    resetPrefs();
    const defaultBorder = document.documentElement.style.getPropertyValue('--border');

    setPref('contrast', 88);
    expect(document.documentElement.style.getPropertyValue('--border')).not.toBe(defaultBorder);

    resetPrefs();
    expect(document.documentElement.style.getPropertyValue('--border')).toBe(defaultBorder);
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('notifies prefs subscribers and isDark subscribers', () => {
    const seen: string[] = [];
    const darkSeen: boolean[] = [];
    const offPrefs = subscribe((prefs) => seen.push(prefs.accent));
    const offDark = subscribeIsDark((isDark) => darkSeen.push(isDark));

    setPref('accent', 'rose');
    setTheme('Dark');
    setTheme('Dark'); // 重复设置不应重复通知明暗订阅者
    setPref('accent', 'cyan');

    expect(seen).toEqual(['rose', 'cyan']);
    expect(darkSeen).toEqual([true]);
    expect(getIsDark()).toBe(true);

    offPrefs();
    offDark();
    setPref('accent', 'amber');
    expect(seen).toEqual(['rose', 'cyan']);
  });

  it('rejects unknown accent/radius values instead of writing them through', () => {
    setPref('accent', 'nope' as never);
    setPref('radius', 'square' as never);

    expect(getPrefs().accent).toBe(DEFAULT_PREFS.accent);
    expect(getPrefs().radius).toBe(DEFAULT_PREFS.radius);
  });
});
