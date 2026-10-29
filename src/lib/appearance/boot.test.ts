// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  THEME_BOOT_SCRIPT,
  THEME_BOOT_STORAGE_KEY,
  cacheBootTheme,
  isTheme,
  readBootTheme,
  surfaceFor,
  syncThemeChrome,
} from './boot';
import { CODEX_DARK_SEEDS, CODEX_LIGHT_SEEDS } from '../colorDerivation';

const indexHtml = readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');

/** jsdom 把内联 background-color 归一成 `rgb(r, g, b)`，比对时用同一种写法。 */
function hexToRgbTriplet(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

function stubPrefersDark(prefersDark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: prefersDark,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    writable: true,
    configurable: true,
  });
}

/** 执行 index.html 里那段内联脚本(与首帧同一条路径)。 */
function runBootScript(): void {
  // eslint-disable-next-line no-new-func
  new Function(THEME_BOOT_SCRIPT)();
}

describe('themeBoot', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    stubPrefersDark(false);
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  it('round-trips the cached theme and ignores garbage values', () => {
    cacheBootTheme('Dark');
    expect(window.localStorage.getItem(THEME_BOOT_STORAGE_KEY)).toBe('Dark');
    expect(readBootTheme()).toBe('Dark');

    window.localStorage.setItem(THEME_BOOT_STORAGE_KEY, '深色');
    expect(readBootTheme()).toBeNull();
    expect(isTheme('System')).toBe(true);
    expect(isTheme(null)).toBe(false);
  });

  it('paints the first frame dark when the user chose a dark theme', () => {
    cacheBootTheme('Dark');
    stubPrefersDark(false);

    runBootScript();

    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
    expect(root.style.backgroundColor).toBeTruthy();
    expect(root.style.getPropertyValue('--boot-bg')).toBe(CODEX_DARK_SEEDS.surface);
  });

  it('honors an explicit light theme even when the OS prefers dark', () => {
    cacheBootTheme('Light');
    stubPrefersDark(true);

    runBootScript();

    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.style.colorScheme).toBe('light');
    expect(root.style.getPropertyValue('--boot-bg')).toBe(CODEX_LIGHT_SEEDS.surface);
  });

  it('falls back to the OS preference when no theme was cached yet', () => {
    stubPrefersDark(true);

    runBootScript();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('survives a missing matchMedia and an unavailable localStorage', () => {
    Object.defineProperty(window, 'matchMedia', { value: undefined, writable: true, configurable: true });
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(() => runBootScript()).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    getItem.mockRestore();
  });

  it('keeps the html chrome in sync when the theme changes at runtime', () => {
    syncThemeChrome(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--boot-bg')).toBe(CODEX_DARK_SEEDS.surface);
    // jsdom 会把内联 background-color 归一成 rgb()，所以按归一形式比。
    expect(document.documentElement.style.backgroundColor).toBe(hexToRgbTriplet(CODEX_DARK_SEEDS.surface));

    syncThemeChrome(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--boot-bg')).toBe(CODEX_LIGHT_SEEDS.surface);
  });

  it('sources the pre-CSS frame colour from the surface seed, not a copy of it', () => {
    // 首帧底色必须等于 colorDerivation 的 surface 种子，否则滚动回弹会露出一帧异色。
    // 曾经这里有两个常量逐位复制种子，靠注释提醒人别改错；现在直接取种子本身。
    expect(surfaceFor(false)).toBe(CODEX_LIGHT_SEEDS.surface);
    expect(surfaceFor(true)).toBe(CODEX_DARK_SEEDS.surface);
    // 内联脚本跑不了派生引擎，只能插值字面量 —— 所以必须断言它插的就是种子。
    expect(THEME_BOOT_SCRIPT).toContain(`'${CODEX_DARK_SEEDS.surface}'`);
    expect(THEME_BOOT_SCRIPT).toContain(`'${CODEX_LIGHT_SEEDS.surface}'`);
  });
});

describe('index.html pre-paint theme bootstrap', () => {
  // 内联脚本与 themeBoot.ts 是同一份源码(脚本没法 import 模块)。任何一侧改动
  // 而另一侧忘了跟,这条断言就会失败 —— 这是防漂移的唯一保障。
  it('embeds the exact script generated by themeBoot', () => {
    expect(indexHtml).toContain(`<script>${THEME_BOOT_SCRIPT}</script>`);
  });

  it('runs as the first, classic script in the document', () => {
    // module 脚本会被 defer 到解析之后,那时首帧可能已经画完 —— 所以必须是经典脚本。
    expect(indexHtml.indexOf('<script>')).toBeGreaterThan(-1);
    expect(indexHtml.indexOf('<script>')).toBeLessThan(indexHtml.indexOf('<script type="module"'));
    expect(indexHtml.indexOf('<script>')).toBeLessThan(indexHtml.indexOf('/src/main.tsx'));
  });

  it('paints the boot screen with the theme-aware background', () => {
    expect(indexHtml).toContain('background: var(--boot-bg, #111111)');
  });
});
