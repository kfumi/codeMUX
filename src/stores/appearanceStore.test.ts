// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetForTests, getPrefs, setPref, setTheme } from '../lib/appearance';
import { DEFAULT_PREFS } from '../lib/appearance/presets';
import { useAppearanceStore } from './appearanceStore';

/**
 * 这个 store 是**只读投影**，不是真值源。真值在 `lib/appearance/index.ts`。
 *
 * 它曾经自己 `loadPrefs()` / `savePrefs()` / `resolveIsDark()`，是第二个真值源；
 * 下面这条「快照 ≡ 模块状态」的断言就是防止它重新长出状态的锁 —— 少了它，
 * 有人往 store 里加个 `set` 分支也不会有测试变红。
 */
function stubMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    writable: true,
    configurable: true,
  });
}

describe('appearanceStore projection', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('style');
    document.documentElement.className = '';
    stubMatchMedia();
    __resetForTests();
    useAppearanceStore.setState({ prefs: getPrefs() });
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('style');
    document.documentElement.className = '';
  });

  it('keeps the store snapshot identical to the module state after every setter', () => {
    // 逐条覆盖七个 setter：任何一个自己改状态而不走模块，这条就会红。
    useAppearanceStore.getState().setAccent('emerald');
    expect(useAppearanceStore.getState().prefs).toEqual(getPrefs());

    useAppearanceStore.getState().setContrast(70);
    expect(useAppearanceStore.getState().prefs).toEqual(getPrefs());

    useAppearanceStore.getState().setUiFontFamily('Inter');
    expect(useAppearanceStore.getState().prefs).toEqual(getPrefs());

    useAppearanceStore.getState().setUiFontSize(16);
    expect(useAppearanceStore.getState().prefs).toEqual(getPrefs());

    useAppearanceStore.getState().setCodeFontSize(15);
    expect(useAppearanceStore.getState().prefs).toEqual(getPrefs());

    useAppearanceStore.getState().setRadius('round');
    expect(useAppearanceStore.getState().prefs).toEqual(getPrefs());

    useAppearanceStore.getState().setContentWidth('stream');
    expect(useAppearanceStore.getState().prefs).toEqual(getPrefs());
  });

  it('picks up writes made directly on the module, not just through the store', () => {
    // 模块是唯一写入口：别的调用方（比如将来的 CLI/测试）直接 setPref 也要反映到 UI。
    setPref('accent', 'rose');
    expect(useAppearanceStore.getState().prefs.accent).toBe('rose');
  });

  it('resets back to the module defaults', () => {
    useAppearanceStore.getState().setAccent('amber');
    useAppearanceStore.getState().reset();

    expect(useAppearanceStore.getState().prefs).toEqual(DEFAULT_PREFS);
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('does not hold theme state — theme belongs to the module', () => {
    // 投影层里不该出现 theme / isDark：它们是模块的事，store 只管 prefs。
    setTheme('Dark');
    const state = useAppearanceStore.getState() as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(expect.arrayContaining(['prefs']));
    expect(state.theme).toBeUndefined();
    expect(state.isDark).toBeUndefined();
  });
});
