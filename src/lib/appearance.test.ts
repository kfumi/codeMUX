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
  accentName,
  applyAppearance,
  buildUiFontFamily,
  clampCodeFontSize,
  clampContrast,
  clampUiFontSize,
  formatFontFamilyForCss,
  isHexColor,
  loadPrefs,
  seedsForPrefs,
  type AccentKey,
} from './appearance';
import {
  CODEX_DARK_SEEDS,
  CODEX_LIGHT_SEEDS,
  SEMANTIC_SEEDS,
  contrastRatio,
  deriveThemeTokens,
  hexToRgb,
  rgbToHslTriplet,
} from './colorDerivation';

/** 把派生出来的 HSL 三元组还原成 RGB，好在测试里量对比度。 */
function hslTripletToRgb(triplet: string) {
  const [h, s, l] = triplet.split(/\s+/).map((part) => Number.parseFloat(part));
  const c = (1 - Math.abs((l / 100) * 2 - 1)) * (s / 100);
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = l / 100 - c / 2;
  const to255 = (v: number) => Math.round((v + m) * 255);
  return { red: to255(r1), green: to255(g1), blue: to255(b1) };
}

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
    // 默认强调色是 azure,深浅各取自己的 hex。
    expect(seedsForPrefs(DEFAULT_PREFS, false)).toEqual({
      ...CODEX_LIGHT_SEEDS,
      accent: ACCENTS.azure.light,
      contrast: CONTRAST_DEFAULT,
    });
    // 深色比浅色高 15 档（Codex 的 45 / 60 关系）。
    expect(seedsForPrefs(DEFAULT_PREFS, true)).toEqual({
      ...CODEX_DARK_SEEDS,
      accent: ACCENTS.azure.dark,
      contrast: CONTRAST_DEFAULT + DARK_CONTRAST_OFFSET,
    });
    // 深色侧的加成不会越过上限。
    expect(seedsForPrefs({ ...DEFAULT_PREFS, contrast: 95 }, true).contrast).toBe(CONTRAST_MAX);
    // 换个强调色时，深浅取各自的种子值。
    expect(seedsForPrefs({ ...DEFAULT_PREFS, accent: 'rose' }, false).accent).toBe('#d92650');
    expect(seedsForPrefs({ ...DEFAULT_PREFS, accent: 'rose' }, true).accent).toBe('#e46784');
  });

  it('defaults the accent to azure and has no duplicate codex preset', () => {
    expect(DEFAULT_PREFS.accent).toBe('azure');
    expect(ACCENTS.azure).toBeDefined();
    expect(Object.keys(ACCENTS)).not.toContain('codex');
  });

  it('falls a stored codex accent back to azure after the preset was removed', () => {
    window.localStorage.setItem('codemux:appearance', JSON.stringify({ accent: 'codex' }));
    expect(loadPrefs().accent).toBe('azure');
  });

  it('keeps the label on the accent legible for every preset, in both themes', () => {
    // 回归:强调色选到「白色」档(深色下 accent 纯白)时,前景曾是写死的白 —— 1:1,
    // 所有 bg-primary 的按钮/图标一起瞎。前景现在跟着强调色翻面,这里钉住这条不变量。
    for (const isDark of [false, true]) {
      for (const accent of Object.keys(ACCENTS) as AccentKey[]) {
        const seeds = seedsForPrefs({ ...DEFAULT_PREFS, accent }, isDark);
        const tokens = deriveThemeTokens(seeds, isDark);
        const label = hslTripletToRgb(tokens['--primary-foreground']);
        const ratio = contrastRatio(label, hexToRgb(seeds.accent));
        expect(ratio, `${accent}/${isDark ? 'dark' : 'light'}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('flips the on-accent foreground to the dark pole when the accent itself is light', () => {
    const tokens = deriveThemeTokens(
      seedsForPrefs({ ...DEFAULT_PREFS, accent: 'graphite' }, true),
      true,
    );
    // 深色 + 「白色」档:前景翻到暗极 = surface(= --background),不再是白。
    expect(tokens['--primary-foreground']).toBe(tokens['--background']);
  });

  it('names the black/white preset per resolved theme, and keeps others theme-agnostic', () => {
    expect(accentName('graphite', false)).toBe('黑色');
    expect(accentName('graphite', true)).toBe('白色');
    // 其余预设没有 darkName,深浅同名(不会因主题切换而改名)。
    expect(accentName('azure', false)).toBe(ACCENTS.azure.name);
    expect(accentName('azure', true)).toBe(ACCENTS.azure.name);
  });

  it('writes the fixed semantic diff colors, light and dark separately', () => {
    const root = document.documentElement;

    applyAppearance(DEFAULT_PREFS, false);
    const lightAdded = root.style.getPropertyValue('--diff-added');
    expect(lightAdded).toBe(deriveThemeTokens(seedsForPrefs(DEFAULT_PREFS, false), false)['--diff-added']);
    expect(lightAdded).toBe(rgbToHslTriplet(hexToRgb(SEMANTIC_SEEDS.light.diffAdded)));
    expect(root.style.getPropertyValue('--diff-removed')).toBe(
      rgbToHslTriplet(hexToRgb(SEMANTIC_SEEDS.light.diffRemoved)),
    );

    applyAppearance(DEFAULT_PREFS, true);
    // 深色用 dark 种子,不是浅色那套 —— 否则深色下的 diff 会暗到看不见。
    const darkAdded = root.style.getPropertyValue('--diff-added');
    expect(darkAdded).toBe(deriveThemeTokens(seedsForPrefs(DEFAULT_PREFS, true), true)['--diff-added']);
    expect(darkAdded).not.toBe(lightAdded);
    expect(root.style.getPropertyValue('--diff-removed')).toBe(
      rgbToHslTriplet(hexToRgb(SEMANTIC_SEEDS.dark.diffRemoved)),
    );
  });

  it('exposes no diff override seam: the pref has no diff field to carry one', () => {
    // 外观页的 diff 取色器已经移除,这里钉住「偏好里不存在 diff 覆盖」——
    // 免得以后又长出一个只能写不能改的幽灵字段。
    expect('diff' in DEFAULT_PREFS).toBe(false);
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
