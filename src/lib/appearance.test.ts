// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ACCENTS,
  CONTRAST_DEFAULT,
  CONTRAST_MAX,
  CONTRAST_MIN,
  DEFAULT_PREFS,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  DARK_CONTRAST_OFFSET,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  applyAppearance,
  buildUiFontFamily,
  clampCodeFontSize,
  clampContrast,
  clampUiFontSize,
  formatFontFamilyForCss,
  isHexColor,
  loadPrefs,
  sanitizeDiffColors,
  seedsForPrefs,
  semanticOverridesForPrefs,
} from './appearance';
import {
  CODEX_DARK_SEEDS,
  CODEX_LIGHT_SEEDS,
  SEMANTIC_SEEDS,
  deriveThemeTokens,
  hexToRgb,
  rgbToHslTriplet,
} from './colorDerivation';

describe('appearance preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('style');
  });

  it('loads valid preferences and migrates the legacy font size', () => {
    window.localStorage.setItem(
      'codemux:appearance',
      JSON.stringify({ accent: 'cyan', fontSize: 'comfortable', radius: 'sharp', contentWidth: 'stream' }),
    );

    expect(loadPrefs()).toEqual({
      ...DEFAULT_PREFS,
      accent: 'cyan',
      uiFontSize: 16,
      radius: 'sharp',
      contentWidth: 'stream',
    });
  });

  it('defaults the contrast knob and clamps stored values', () => {
    window.localStorage.setItem('codemux:appearance', JSON.stringify({ contrast: 'high' }));
    expect(loadPrefs().contrast).toBe(CONTRAST_DEFAULT);

    window.localStorage.setItem('codemux:appearance', JSON.stringify({ contrast: 240 }));
    expect(loadPrefs().contrast).toBe(CONTRAST_MAX);

    window.localStorage.setItem('codemux:appearance', JSON.stringify({ contrast: -20 }));
    expect(loadPrefs().contrast).toBe(CONTRAST_MIN);

    expect(clampContrast(Number.NaN)).toBe(CONTRAST_DEFAULT);
    expect(clampContrast(100)).toBe(CONTRAST_MAX);
    expect(clampContrast(0)).toBe(CONTRAST_MIN);
  });

  it('migrates legacy preset font keys to system font family names', () => {
    window.localStorage.setItem(
      'codemux:appearance',
      JSON.stringify({ uiFont: 'ibm-plex-sans' }),
    );

    expect(loadPrefs().uiFontFamily).toBe('IBM Plex Sans');
  });

  it('falls back from invalid values and clamps numeric sizes', () => {
    window.localStorage.setItem(
      'codemux:appearance',
      JSON.stringify({ accent: 'unknown', uiFontFamily: 1, uiFontSize: 99, radius: null, contentWidth: 1 }),
    );

    expect(loadPrefs()).toEqual({ ...DEFAULT_PREFS, uiFontSize: UI_FONT_SIZE_MAX });
    expect(clampUiFontSize(Number.NaN)).toBe(DEFAULT_PREFS.uiFontSize);
    expect(clampUiFontSize(UI_FONT_SIZE_MIN - 4.4)).toBe(UI_FONT_SIZE_MIN);
    expect(clampUiFontSize(UI_FONT_SIZE_MAX + 4.4)).toBe(UI_FONT_SIZE_MAX);
    expect(clampUiFontSize(15.6)).toBe(16);
    expect(clampCodeFontSize(Number.NaN)).toBe(DEFAULT_PREFS.codeFontSize);
    expect(clampCodeFontSize(CODE_FONT_SIZE_MIN - 4.4)).toBe(CODE_FONT_SIZE_MIN);
    expect(clampCodeFontSize(CODE_FONT_SIZE_MAX + 4.4)).toBe(CODE_FONT_SIZE_MAX);
  });

  it('builds ui font stacks with chinese fallbacks', () => {
    expect(buildUiFontFamily('')).toContain('system-ui');
    expect(buildUiFontFamily('Microsoft YaHei UI')).toContain("'Microsoft YaHei UI'");
    expect(buildUiFontFamily('Microsoft YaHei UI')).toContain('PingFang SC');
    // 内置字体映射到打包的 @font-face 字体族(src/styles/fonts.css)。
    expect(buildUiFontFamily('Inter')).toContain("'Inter'");
    expect(buildUiFontFamily('LXGW WenKai')).toContain("'LXGW WenKai'");
    expect(buildUiFontFamily('Noto Sans SC')).toContain("'Noto Sans SC'");
    expect(formatFontFamilyForCss('Geist')).toContain("'Geist'");
  });

  it('folds prefs into the four Codex seeds', () => {
    expect(seedsForPrefs(DEFAULT_PREFS, false)).toEqual({
      ...CODEX_LIGHT_SEEDS,
      accent: '#3a83f7',
      contrast: CONTRAST_DEFAULT,
    });
    // 深色比浅色高 15 档（Codex 的 45 / 60 关系）；Codex 的强调色明暗同值。
    expect(seedsForPrefs(DEFAULT_PREFS, true)).toEqual({
      ...CODEX_DARK_SEEDS,
      accent: '#3a83f7',
      contrast: CONTRAST_DEFAULT + DARK_CONTRAST_OFFSET,
    });
    // 深色侧的加成不会越过上限。
    expect(seedsForPrefs({ ...DEFAULT_PREFS, contrast: 95 }, true).contrast).toBe(CONTRAST_MAX);
    // 换个强调色时，深浅取各自的种子值。
    expect(seedsForPrefs({ ...DEFAULT_PREFS, accent: 'azure' }, false).accent).toBe('#0169cb');
    expect(seedsForPrefs({ ...DEFAULT_PREFS, accent: 'azure' }, true).accent).toBe('#3197f6');
  });

  it('defaults the accent to the Codex seed so the app looks like Codex out of the box', () => {
    expect(DEFAULT_PREFS.accent).toBe('codex');
    expect(ACCENTS.codex.light).toBe(CODEX_LIGHT_SEEDS.accent);
    expect(ACCENTS.codex.dark).toBe(CODEX_DARK_SEEDS.accent);
  });

  it('folds the diff color overrides into the derived tokens, light and dark separately', () => {
    const prefs = {
      ...DEFAULT_PREFS,
      diff: { lightAdded: '#00aa00', darkAdded: '#00ff00' },
    } as const;
    const deriveFor = (p: typeof prefs, isDark: boolean) =>
      deriveThemeTokens(seedsForPrefs(p, isDark), isDark, semanticOverridesForPrefs(p, isDark));

    applyAppearance(prefs, false);
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--diff-added')).toBe(deriveFor(prefs, false)['--diff-added']);
    // 没有覆盖的键回落到语义种子（浅色删除色 = SEMANTIC_SEEDS.light.diffRemoved）。
    expect(root.style.getPropertyValue('--diff-removed')).toBe(
      rgbToHslTriplet(hexToRgb(SEMANTIC_SEEDS.light.diffRemoved)),
    );

    applyAppearance(prefs, true);
    // 深色下用的是 darkAdded，不是 lightAdded。
    const darkAdded = root.style.getPropertyValue('--diff-added');
    expect(darkAdded).toBe(deriveFor(prefs, true)['--diff-added']);
    expect(darkAdded).not.toBe(deriveFor(prefs, false)['--diff-added']);
    expect(root.style.getPropertyValue('--diff-removed')).toBe(
      rgbToHslTriplet(hexToRgb(SEMANTIC_SEEDS.dark.diffRemoved)),
    );
  });

  it('drops malformed diff colors instead of writing them into CSS', () => {
    // 只接受 6 位 hex —— `<input type="color">` 永远给 6 位，3 位/颜色名一律丢弃。
    expect(sanitizeDiffColors({ lightAdded: 'red', darkRemoved: '#fff', nope: '#000000' })).toEqual({});
    expect(sanitizeDiffColors({ lightAdded: '#00AA00' })).toEqual({ lightAdded: '#00aa00' });
    expect(sanitizeDiffColors(null)).toEqual({});
    expect(isHexColor('#AABBCC')).toBe(true);
    expect(isHexColor('rgb(0,0,0)')).toBe(false);
  });

  it('applies CSS variables without changing the root font size', () => {
    applyAppearance(
      { ...DEFAULT_PREFS, uiFontFamily: 'IBM Plex Sans', uiFontSize: 18, codeFontSize: 16, accent: 'rose' },
      false,
    );

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--font-ui')).toContain('IBM Plex Sans');
    expect(root.style.getPropertyValue('--ui-font-size')).toBe('18px');
    expect(root.style.getPropertyValue('--code-font-size')).toBe('16px');
    expect(root.style.fontSize).toBe('');
  });

  it('writes the whole derived variable table onto the document root', () => {
    const prefs = { ...DEFAULT_PREFS, accent: 'emerald', contrast: 62 } as const;
    applyAppearance(prefs, true);

    // 最高测试缝：调用 applyAppearance 后从 documentElement 读回完整变量表，
    // 与直接调派生引擎的结果逐项比对 —— 不测内部函数调用。
    const expected = deriveThemeTokens(seedsForPrefs(prefs, true), true);
    const root = document.documentElement;
    for (const [name, value] of Object.entries(expected)) {
      expect({ name, value: root.style.getPropertyValue(name) }, name).toEqual({ name, value });
    }
  });

  it('recolors hover, focus and accent surfaces together when the accent changes', () => {
    applyAppearance({ ...DEFAULT_PREFS, accent: 'azure' }, false);
    const root = document.documentElement;
    const azure = {
      hover: root.style.getPropertyValue('--accent-bg-hover'),
      active: root.style.getPropertyValue('--accent-bg-active'),
      ring: root.style.getPropertyValue('--ring'),
      link: root.style.getPropertyValue('--codemux-link'),
      chip: root.style.getPropertyValue('--codemux-directive-bg'),
    };

    applyAppearance({ ...DEFAULT_PREFS, accent: 'rose' }, false);
    expect(root.style.getPropertyValue('--accent-bg-hover')).not.toBe(azure.hover);
    expect(root.style.getPropertyValue('--accent-bg-active')).not.toBe(azure.active);
    expect(root.style.getPropertyValue('--ring')).not.toBe(azure.ring);
    expect(root.style.getPropertyValue('--codemux-link')).not.toBe(azure.link);
    expect(root.style.getPropertyValue('--codemux-directive-bg')).not.toBe(azure.chip);
  });

  it('recolors the whole surface family when the contrast knob moves', () => {
    applyAppearance({ ...DEFAULT_PREFS, contrast: 10 }, false);
    const root = document.documentElement;
    const low = root.style.getPropertyValue('--border');

    applyAppearance({ ...DEFAULT_PREFS, contrast: 95 }, false);
    expect(root.style.getPropertyValue('--border')).not.toBe(low);
    expect(root.style.getPropertyValue('--muted-foreground')).not.toBe('0 0% 33.73%');
  });
});
