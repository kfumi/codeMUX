import { describe, expect, it } from 'vitest';

import {
  CODEX_DARK_SEEDS,
  CODEX_LIGHT_SEEDS,
  SEMANTIC_SEEDS,
  type ThemeSeeds,
  derivePalette,
  deriveThemeTokens,
  hexToRgb,
  normalizeContrast,
  overlayRgb,
  rgbToHex,
  rgbToHslTriplet,
} from './colorDerivation';

/* ------------------------------------------------------------------ *
 * Codex 参考实现 —— `jba` / `Nba` 与其辅助函数的逐行转写。
 *
 * 唯一职责是当「对拍对象」：本文件之外的任何代码都不得引用它。转写自
 * Codex 桌面包的压缩产物（`app-initial.js`，函数名 jba/Nba/eY/QJ/$J/tY）。
 * 任何一行的公式被改动都会让 parity 用例变红，从而暴露「我们对 Codex
 * 的理解」和「Codex 的真实算法」之间的偏差。
 * ------------------------------------------------------------------ */
interface CodexRgb {
  red: number;
  green: number;
  blue: number;
}

const CODEX_WHITE: CodexRgb = { red: 255, green: 255, blue: 255 };
const CODEX_BLACK: CodexRgb = { red: 0, green: 0, blue: 0 };

/** Codex 的 `zba`：alpha 裁剪到 0..1 后保留三位小数并去掉尾随零。 */
function codexAlpha(value: number): string {
  return Math.min(1, Math.max(0, value))
    .toFixed(3)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

/** Codex 的 `QJ`：输出 rgba() 字符串。 */
function codexAlphaColor(rgb: CodexRgb, alpha: number): string {
  return `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, ${codexAlpha(alpha)})`;
}

/** Codex 的 `eY`：逐通道线性混色。 */
function codexMix(base: CodexRgb, target: CodexRgb, amount: number): CodexRgb {
  const a = Math.min(1, Math.max(0, amount));
  const channel = (from: number, to: number) => Math.round(from + (to - from) * a);
  return {
    red: channel(base.red, target.red),
    green: channel(base.green, target.green),
    blue: channel(base.blue, target.blue),
  };
}

/** Codex 的 `$J`：混色后输出不透明 hex。 */
function codexMixHex(base: CodexRgb, target: CodexRgb, amount: number): string {
  const mixed = codexMix(base, target, amount);
  const channel = (v: number) => v.toString(16).padStart(2, '0');
  return `#${channel(mixed.red)}${channel(mixed.green)}${channel(mixed.blue)}`;
}

/** Codex 的 `tY`：输出不透明 rgb() 字符串。 */
function codexRgbString(rgb: CodexRgb): string {
  return `rgb(${rgb.red}, ${rgb.green}, ${rgb.blue})`;
}

interface CodexInput {
  surface: CodexRgb;
  ink: CodexRgb;
  accent: CodexRgb;
  /** 已归一化到 0..1 的对比度。 */
  contrast: number;
}

/** Codex 的 `jba`（浅色）。 */
function codexLight(input: CodexInput) {
  const { surface, ink, accent, contrast: c } = input;
  return {
    accentBackground: codexMixHex(surface, accent, 0.11 + c * 0.04),
    accentBackgroundActive: codexMixHex(surface, accent, 0.13 + c * 0.05),
    accentBackgroundHover: codexMixHex(surface, accent, 0.12 + c * 0.045),
    border: codexAlphaColor(ink, 0.06 + c * 0.04),
    borderFocus: codexRgbString(accent),
    borderHeavy: codexAlphaColor(ink, 0.09 + c * 0.06),
    borderLight: codexAlphaColor(ink, 0.04 + c * 0.02),
    buttonPrimaryBackground: codexRgbString(ink),
    buttonSecondaryBackground: codexAlphaColor(ink, 0.04 + c * 0.02),
    buttonTertiaryBackground: codexAlphaColor(ink, 0),
    controlBackground: codexAlphaColor(codexMix(surface, CODEX_WHITE, 0.09 + c * 0.04), 0.96),
    controlBackgroundOpaque: codexMixHex(surface, CODEX_WHITE, 0.09 + c * 0.04),
    elevatedPrimary: codexAlphaColor(codexMix(surface, CODEX_WHITE, 0.16 + c * 0.12), 0.96),
    elevatedPrimaryOpaque: codexMixHex(surface, CODEX_WHITE, 0.16 + c * 0.12),
    elevatedSecondary: codexAlphaColor(codexMix(surface, CODEX_WHITE, 0.08 + c * 0.08), 0.96),
    elevatedSecondaryOpaque: codexMixHex(surface, CODEX_WHITE, 0.08 + c * 0.08),
    iconAccent: codexRgbString(accent),
    iconPrimary: codexRgbString(ink),
    iconSecondary: codexAlphaColor(ink, 0.65 + c * 0.1),
    iconTertiary: codexAlphaColor(ink, 0.45 + c * 0.1),
    simpleScrim: codexAlphaColor(CODEX_BLACK, 0.08 + c * 0.04),
    textAccent: codexRgbString(accent),
    textForeground: codexRgbString(ink),
    textForegroundSecondary: codexAlphaColor(ink, 0.65 + c * 0.1),
    textForegroundTertiary: codexAlphaColor(ink, 0.45 + c * 0.1),
  };
}

/** Codex 的 `Nba`（深色）。 */
function codexDark(input: CodexInput) {
  const { surface, ink, accent, contrast: c } = input;
  const accentLift = codexMix(accent, CODEX_WHITE, 0.3 + c * 0.15);
  const primaryFill = codexMix(surface, CODEX_WHITE, 0.38 + c * 0.12);
  return {
    accentBackground: codexMixHex(CODEX_BLACK, accent, 0.2 + c * 0.08),
    accentBackgroundActive: codexMixHex(CODEX_BLACK, accent, 0.22 + c * 0.12),
    accentBackgroundHover: codexMixHex(CODEX_BLACK, accent, 0.21 + c * 0.1),
    border: codexAlphaColor(ink, 0.06 + c * 0.04),
    borderFocus: codexAlphaColor(accentLift, 0.7 + c * 0.1),
    borderHeavy: codexAlphaColor(ink, 0.12 + c * 0.06),
    borderLight: codexAlphaColor(ink, 0.03 + c * 0.02),
    buttonPrimaryBackground: codexRgbString(primaryFill),
    buttonSecondaryBackground: codexAlphaColor(ink, 0.04 + c * 0.02),
    buttonTertiaryBackground: codexAlphaColor(ink, 0.02 + c * 0.015),
    controlBackground: codexAlphaColor(codexMix(surface, ink, 0.06 + c * 0.05), 0.96),
    controlBackgroundOpaque: codexMixHex(surface, ink, 0.06 + c * 0.05),
    elevatedPrimary: codexAlphaColor(codexMix(surface, ink, 0.08 + c * 0.08), 0.96),
    elevatedPrimaryOpaque: codexMixHex(surface, ink, 0.08 + c * 0.08),
    elevatedSecondary: codexAlphaColor(ink, 0.02 + c * 0.02),
    elevatedSecondaryOpaque: codexMixHex(surface, ink, 0.04 + c * 0.05),
    iconAccent: codexRgbString(accentLift),
    iconPrimary: codexAlphaColor(ink, 0.82 + c * 0.14),
    iconSecondary: codexAlphaColor(ink, 0.65 + c * 0.1),
    iconTertiary: codexAlphaColor(ink, 0.45 + c * 0.1),
    simpleScrim: codexAlphaColor(ink, 0.08 + c * 0.04),
    textAccent: codexRgbString(accentLift),
    textForeground: codexRgbString(ink),
    textForegroundSecondary: codexAlphaColor(ink, 0.65 + c * 0.1),
    textForegroundTertiary: codexAlphaColor(ink, 0.42 + c * 0.13),
  };
}

/** 把 Codex 的 `rgba(r, g, b, a)` / `rgb(r, g, b)` / `#rrggbb` 合成到底色上。 */
function compositeCodexColor(baseHex: string, cssColor: string): string {
  if (cssColor.startsWith('#')) return cssColor;
  const alpha = cssColor.startsWith('rgba')
    ? Number.parseFloat(cssColor.slice(cssColor.lastIndexOf(',') + 1))
    : 1;
  const numbers = cssColor.match(/\d+/g)?.map(Number) ?? [];
  return rgbToHex(
    overlayRgb(hexToRgb(baseHex), { red: numbers[0], green: numbers[1], blue: numbers[2] }, alpha),
  );
}

/** 取 HSL 三元组里的饱和度/明度（% 号要去掉）。 */
function saturationOf(triplet: string): number {
  return Number(triplet.split(' ')[1].replace('%', ''));
}

function lightnessOf(triplet: string): number {
  return Number(triplet.split(' ')[2].replace('%', ''));
}

/* ------------------------------------------------------------------ */

const SEED_GRID: ThemeSeeds[] = [
  CODEX_LIGHT_SEEDS,
  CODEX_DARK_SEEDS,
  { surface: '#ffffff', ink: '#000000', accent: '#3a83f7', contrast: 0 },
  { surface: '#ffffff', ink: '#000000', accent: '#3a83f7', contrast: 100 },
  { surface: '#0f1115', ink: '#f2f4f7', accent: '#ff7a45', contrast: 17 },
  { surface: '#f6f3ee', ink: '#2b2118', accent: '#8b5cf6', contrast: 83 },
  { surface: '#eef6fb', ink: '#04222f', accent: '#0f766e', contrast: 50 },
];

describe('colorDerivation', () => {
  it('normalizes the contrast knob and clamps out-of-range input', () => {
    expect(normalizeContrast(45)).toBeCloseTo(0.45, 10);
    expect(normalizeContrast(0)).toBe(0);
    expect(normalizeContrast(100)).toBe(1);
    expect(normalizeContrast(-20)).toBe(0);
    expect(normalizeContrast(240)).toBe(1);
    expect(normalizeContrast(Number.NaN)).toBe(0);
  });

  it('matches the Codex reference implementation for every seed combination', () => {
    for (const seeds of SEED_GRID) {
      for (const isDark of [false, true]) {
        const reference = isDark
          ? codexDark({ surface: hexToRgb(seeds.surface), ink: hexToRgb(seeds.ink), accent: hexToRgb(seeds.accent), contrast: normalizeContrast(seeds.contrast) })
          : codexLight({ surface: hexToRgb(seeds.surface), ink: hexToRgb(seeds.ink), accent: hexToRgb(seeds.accent), contrast: normalizeContrast(seeds.contrast) });
        const actual = derivePalette(seeds, isDark);
        // 参考实现给的是 rgba()/rgb() 字符串 ours 给的是已合成的不透明色，
        // 所以比较方式是把**参考实现**合成到同一底色上。
        const from = (key: keyof typeof reference) => compositeCodexColor(seeds.surface, reference[key]);
        const where = `${seeds.surface}/${seeds.ink}/${seeds.accent}@${seeds.contrast} ${isDark ? 'dark' : 'light'}`;
        const expectParity = (key: keyof typeof reference, ours: string) =>
          expect({ where, value: ours }, key).toEqual({ where, value: from(key) });

        expectParity('accentBackground', actual.accentBackground);
        expectParity('accentBackgroundActive', actual.accentBackgroundActive);
        expectParity('accentBackgroundHover', actual.accentBackgroundHover);
        expectParity('border', actual.border);
        expectParity('borderFocus', actual.borderFocus);
        expectParity('borderHeavy', actual.borderHeavy);
        expectParity('borderLight', actual.borderLight);
        expectParity('buttonPrimaryBackground', actual.buttonPrimaryBackground);
        expectParity('controlBackground', actual.controlBackground);
        expectParity('controlBackgroundOpaque', actual.controlBackgroundOpaque);
        expectParity('elevatedPrimary', actual.elevatedPrimary);
        expectParity('elevatedPrimaryOpaque', actual.elevatedPrimaryOpaque);
        expectParity('elevatedSecondary', actual.elevatedSecondary);
        expectParity('elevatedSecondaryOpaque', actual.elevatedSecondaryOpaque);
        expectParity('iconAccent', actual.iconAccent);
        expectParity('iconPrimary', actual.iconPrimary);
        expectParity('iconSecondary', actual.iconSecondary);
        expectParity('iconTertiary', actual.iconTertiary);
        expectParity('simpleScrim', actual.simpleScrim);
        expectParity('textAccent', actual.textAccent);
        expectParity('textForeground', actual.textForeground);
        expectParity('textForegroundSecondary', actual.textForegroundSecondary);
        expectParity('textForegroundTertiary', actual.textForegroundTertiary);
      }
    }
  });

  it('recolors the whole surface family when the accent changes', () => {
    const base: ThemeSeeds = { ...CODEX_LIGHT_SEEDS, accent: '#3a83f7' };
    const swapped: ThemeSeeds = { ...base, accent: '#d92650' };
    const a = deriveThemeTokens(base, false);
    const b = deriveThemeTokens(swapped, false);

    // 强调色本身、强调背景与其两个态、焦点环、链接、指令 chip 必须一起变。
    for (const token of [
      '--primary',
      '--accent',
      '--ring',
      '--glow',
      '--accent-bg',
      '--accent-bg-hover',
      '--accent-bg-active',
      '--codemux-link',
      '--codemux-directive-accent',
      '--codemux-directive-bg',
    ]) {
      expect(b[token], token).not.toBe(a[token]);
    }

    // 与强调色无关的中性层必须**原样不动** —— 这是「换色不牵动全局」的关键保证。
    for (const token of ['--background', '--foreground', '--muted-foreground', '--border', '--surface-1', '--surface-2']) {
      expect(b[token], token).toBe(a[token]);
    }
  });

  it('recomputes every alpha-derived token when the contrast knob moves', () => {
    const low = deriveThemeTokens({ ...CODEX_LIGHT_SEEDS, contrast: 0 }, false);
    const high = deriveThemeTokens({ ...CODEX_LIGHT_SEEDS, contrast: 100 }, false);

    for (const token of ['--border', '--border-light', '--surface-edge', '--muted-foreground', '--foreground-tertiary', '--surface-3']) {
      expect(high[token], token).not.toBe(low[token]);
    }
    // 种子本身不随对比度变。
    expect(high['--background']).toBe(low['--background']);
    expect(high['--foreground']).toBe(low['--foreground']);
    expect(high['--primary']).toBe(low['--primary']);

    // 深色下所有 alpha 步进都可见：浅色的「往白混」在近白表面上会被 8bit 取整吃掉，
    // 这是 Codex 真实的行为（surface 已经接近纯白，白混白本来就没有可见变化）。
    const darkLow = deriveThemeTokens({ ...CODEX_DARK_SEEDS, contrast: 0 }, true);
    const darkHigh = deriveThemeTokens({ ...CODEX_DARK_SEEDS, contrast: 100 }, true);
    for (const token of ['--border', '--border-light', '--surface-edge', '--muted', '--card', '--secondary', '--surface-1', '--surface-2', '--surface-3']) {
      expect(darkHigh[token], token).not.toBe(darkLow[token]);
    }
  });

  it('keeps the three shell planes apart: chrome, sidebar surface, content surface', () => {
    // 顶栏+图标轨（窗口面）、侧栏、内容面是外壳的三道平面。Codex 实测：
    //   浅色 窗框 245 / 侧栏 252 / 内容 253；深色 窗框 14 / 侧栏 16 / 内容 17。
    // 两套都是「窗框比面板更深，面板之间只差 1 级」—— 任两者塌到同一个值上，
    // 整扇窗就成了一块平的；反过来把面板之间拉开几十级（比如深色下侧栏纯黑、
    // 内容面用抬高档），侧栏就会读成面板上的一个洞。这两种毛病都实测出现过。
    const light = deriveThemeTokens(CODEX_LIGHT_SEEDS, false);
    expect(lightnessOf(light['--chrome-bg'])).toBeLessThan(lightnessOf(light['--background']));
    // 侧栏与内容面同属面板档：同为表面种子，差值不该超过一两级。
    expect(Math.abs(lightnessOf(light['--sidebar-bg']) - lightnessOf(light['--background']))).toBeLessThan(1);
    // 窗口面上的悬停档还要再深一点，否则导航栏的选中态压在窗口面上看不出来。
    expect(lightnessOf(light['--chrome-bg-hover'])).toBeLessThan(lightnessOf(light['--chrome-bg']));
    // 抬高档（composer 那类浮起控件）必须比内容面亮，否则控件浮不起来。
    expect(lightnessOf(light['--surface-1'])).toBeGreaterThan(lightnessOf(light['--background']));

    const dark = deriveThemeTokens(CODEX_DARK_SEEDS, true);
    expect(lightnessOf(dark['--chrome-bg'])).toBeLessThan(lightnessOf(dark['--background']));
    expect(lightnessOf(dark['--chrome-bg-hover'])).toBeGreaterThan(lightnessOf(dark['--chrome-bg']));
    expect(Math.abs(lightnessOf(dark['--sidebar-bg']) - lightnessOf(dark['--background']))).toBeLessThan(1);
    expect(lightnessOf(dark['--surface-1'])).toBeGreaterThan(lightnessOf(dark['--background']));
  });

  it('keeps the composer context bar off both the page and the input surface', () => {
    // 输入区顶部那条上下文条的底 —— Codex 的 `background-composer-action-bar`
    // （浅色 surfaceUnder / 深色 elevatedSecondaryOpaque）。它必须同时离开页面底色
    // **和**输入框：
    //   浅色 Codex 实测 页面 246–249 / 上下文条 241 / 输入框 255；
    //   深色 Codex 实测 页面 17  / 上下文条 33  / 输入框 47。
    // 曾经按 `elevatedSecondaryOpaque` 一个值套两套主题，浅色下发到 98.82% —— 与
    // 页面底色同值，整条在页面上隐形（实机截图里只剩一个孤零零的标签）。
    const light = deriveThemeTokens(CODEX_LIGHT_SEEDS, false);
    expect(lightnessOf(light['--composer-action-bar-bg']))
      .toBeLessThan(lightnessOf(light['--background']));
    expect(lightnessOf(light['--composer-action-bar-bg']))
      .toBeLessThan(lightnessOf(light['--surface-1']));

    const dark = deriveThemeTokens(CODEX_DARK_SEEDS, true);
    expect(lightnessOf(dark['--composer-action-bar-bg']))
      .toBeGreaterThan(lightnessOf(dark['--background']));
    expect(lightnessOf(dark['--composer-action-bar-bg']))
      .toBeLessThan(lightnessOf(dark['--surface-1']));
  });

  it('keeps the user-message bubble off the page background in both themes', () => {
    // 用户消息气泡的底 —— Codex 浅色实测 243（`#f3f3f3`）。
    // 曾经它取 `--muted`：浅色的 muted 混向 white，在 `#fcfcfc` 的表面上被 8bit 取整
    // 整个吃掉，与页面底色同值 —— 气泡在浅色下整片消失，而深色下同一 token 却是可见的
    // 一档（46 vs 17），问题只在一侧显形。两套主题因此都要钉住。
    const light = deriveThemeTokens(CODEX_LIGHT_SEEDS, false);
    expect(lightnessOf(light['--user-message-bg']))
      .toBeLessThan(lightnessOf(light['--background']));
    // 右侧面板主体（凹面）上也可能出现用户消息的只读副本，同样要压得住。
    expect(lightnessOf(light['--user-message-bg']))
      .toBeLessThan(lightnessOf(light['--surface-canvas']));
    // 但它不能比「抬高档」还亮：那是浮起控件的档，气泡读成浮起面板就不对了。
    expect(lightnessOf(light['--user-message-bg']))
      .toBeLessThan(lightnessOf(light['--surface-1']));

    const dark = deriveThemeTokens(CODEX_DARK_SEEDS, true);
    expect(lightnessOf(dark['--user-message-bg']))
      .toBeGreaterThan(lightnessOf(dark['--background']));
    expect(lightnessOf(dark['--user-message-bg']))
      .toBeLessThan(lightnessOf(dark['--surface-1']));
  });

  it('keeps borders neutral translucent-ink rather than grey', () => {
    const light = deriveThemeTokens(CODEX_LIGHT_SEEDS, false);
    // 边框必须完全无彩色相（墨色低 alpha 合成到近白表面上），靠明度差体现。
    expect(saturationOf(light['--border'])).toBe(0);
    expect(saturationOf(light['--border-light'])).toBe(0);
    expect(lightnessOf(light['--border'])).toBeLessThan(lightnessOf(light['--background']));
    expect(lightnessOf(light['--border-light'])).toBeGreaterThan(lightnessOf(light['--border']));

    // 三档文字色同样无彩色相，且明度依次递减。
    for (const token of ['--foreground', '--muted-foreground', '--foreground-tertiary']) {
      expect(saturationOf(light[token]), token).toBe(0);
    }
    expect(lightnessOf(light['--foreground'])).toBeLessThan(lightnessOf(light['--muted-foreground']));
    expect(lightnessOf(light['--muted-foreground'])).toBeLessThan(lightnessOf(light['--foreground-tertiary']));
  });

  it('emits the frozen expectation table for the Codex defaults', () => {
    // 这张表是「我们对 Codex 的理解」的基线：公式被无声改动时这里先红，
    // 提醒人去更新 research 文档，而不是让界面悄悄变样。
    expect(deriveThemeTokens(CODEX_LIGHT_SEEDS, false)).toEqual({
      '--accent': '215 75% 93.73%',
      '--accent-bg': '215 75% 93.73%',
      '--accent-bg-active': '215.17 78.38% 92.75%',
      '--accent-bg-hover': '216.92 76.47% 93.33%',
      '--accent-foreground': '0 0% 5.1%',
      '--background': '0 0% 98.82%',
      '--border': '0 0% 91.37%',
      '--border-light': '0 0% 94.12%',
      '--card': '0 0% 99.22%',
      '--card-foreground': '0 0% 5.1%',
      '--card-opaque': '0 0% 99.22%',
      '--chrome-bg': '0 0% 94.9%',
      '--chrome-bg-hover': '0 0% 86.27%',
      '--codemux-directive-accent': '216.83 92.2% 59.8%',
      '--codemux-directive-bg': '215 75% 93.73%',
      '--codemux-directive-border': '0 0% 91.37%',
      '--codemux-link': '216.83 92.2% 59.8%',
      '--composer-action-bar-bg': '0 0% 94.9%',
      '--destructive': '1.19 68.33% 43.33%',
      '--destructive-foreground': '0 0% 98.82%',
      '--destructive-vivid': '0 72.22% 50.59%',
      '--diff-added': '143.7 100% 31.76%',
      '--diff-removed': '1.19 68.33% 43.33%',
      '--foreground': '0 0% 5.1%',
      '--foreground-tertiary': '0 0% 52.55%',
      '--glow': '216.83 92.2% 59.8%',
      '--icon-secondary': '0 0% 33.73%',
      '--icon-tertiary': '0 0% 52.55%',
      '--input': '0 0% 91.37%',
      '--layout-divider': '0 0% 91.37%',
      '--muted': '0 0% 98.82%',
      '--muted-foreground': '0 0% 33.73%',
      '--muted-opaque': '0 0% 98.82%',
      '--popover': '0 0% 99.22%',
      '--popover-foreground': '0 0% 5.1%',
      '--primary': '216.83 92.2% 59.8%',
      '--primary-foreground': '0 0% 98.82%',
      '--ring': '216.83 92.2% 59.8%',
      '--scrim': 'rgba(0, 0, 0, 0.098)',
      '--secondary': '0 0% 98.82%',
      '--secondary-foreground': '0 0% 5.1%',
      '--secondary-opaque': '0 0% 98.82%',
      '--settings-sidebar-bg': '0 0% 98.82%',
      '--shell-bg': '0 0% 98.82%',
      '--sidebar-accent': '216.83 92.2% 59.8%',
      '--sidebar-bg': '0 0% 98.82%',
      '--sidebar-border': '0 0% 91.37%',
      '--sidebar-fg': '0 0% 5.1%',
      '--sidebar-glow': '216.83 92.2% 59.8%',
      '--sidebar-muted': '0 0% 94.12%',
      '--success': '145.79 78.1% 26.86%',
      '--success-vivid': '142.13 76.22% 36.27%',
      '--surface-1': '0 0% 99.22%',
      '--surface-2': '0 0% 98.82%',
      '--surface-3': '0 0% 94.12%',
      '--surface-canvas': '0 0% 96.86%',
      '--surface-edge': '0 0% 87.84%',
      '--surface-glow': '216.83 92.2% 59.8%',
      '--surface-shadow': '0 0% 0%',
      '--surface-shadow-strong': '0 0% 0%',
      '--user-message-bg': '0 0% 95.29%',
      '--warning': '35.45 91.67% 32.94%',
      '--warning-vivid': '39.46 90.2% 40%',
    });

    expect(deriveThemeTokens(CODEX_DARK_SEEDS, true)).toEqual({
      '--accent': '217.02 62.67% 14.71%',
      '--accent-bg': '217.02 62.67% 14.71%',
      '--accent-bg-active': '217.09 61.8% 17.45%',
      '--accent-bg-hover': '217.65 61.45% 16.27%',
      '--accent-foreground': '0 0% 92.94%',
      '--background': '0 0% 6.67%',
      '--border': '0 0% 13.73%',
      '--border-light': '0 0% 10.2%',
      '--card': '0 0% 17.25%',
      '--card-foreground': '0 0% 92.94%',
      '--card-opaque': '0 0% 17.65%',
      '--chrome-bg': '0 0% 5.49%',
      '--chrome-bg-hover': '0 0% 11.37%',
      '--codemux-directive-accent': '217.04 92% 75.49%',
      '--codemux-directive-bg': '217.02 62.67% 14.71%',
      '--codemux-directive-border': '0 0% 13.73%',
      '--codemux-link': '217.04 92% 75.49%',
      '--composer-action-bar-bg': '0 0% 12.55%',
      '--destructive': '1.28 94.95% 61.18%',
      '--destructive-foreground': '0 0% 6.67%',
      '--destructive-vivid': '1.28 94.95% 61.18%',
      '--diff-added': '144.09 55.92% 51.96%',
      '--diff-removed': '1.28 94.95% 61.18%',
      '--foreground': '0 0% 92.94%',
      '--foreground-tertiary': '0 0% 49.8%',
      '--glow': '216.83 92.2% 59.8%',
      '--icon-secondary': '0 0% 67.84%',
      '--icon-tertiary': '0 0% 50.59%',
      '--input': '0 0% 13.73%',
      '--layout-divider': '0 0% 13.73%',
      '--muted': '0 0% 14.12%',
      '--muted-foreground': '0 0% 67.84%',
      '--muted-opaque': '0 0% 14.51%',
      '--popover': '0 0% 17.25%',
      '--popover-foreground': '0 0% 92.94%',
      '--primary': '216.83 92.2% 59.8%',
      '--primary-foreground': '0 0% 100%',
      '--ring': '217.24 41.63% 59.02%',
      '--scrim': 'rgba(237, 237, 237, 0.104)',
      '--secondary': '0 0% 9.41%',
      '--secondary-foreground': '0 0% 92.94%',
      '--secondary-opaque': '0 0% 12.55%',
      '--settings-sidebar-bg': '0 0% 6.67%',
      '--shell-bg': '0 0% 6.67%',
      '--sidebar-accent': '217.04 92% 75.49%',
      '--sidebar-bg': '0 0% 6.67%',
      '--sidebar-border': '0 0% 13.73%',
      '--sidebar-fg': '0 0% 92.94%',
      '--sidebar-glow': '216.83 92.2% 59.8%',
      '--sidebar-muted': '0 0% 13.73%',
      '--success': '144.09 55.92% 51.96%',
      '--success-vivid': '144.09 55.92% 51.96%',
      '--surface-1': '0 0% 17.65%',
      '--surface-2': '0 0% 12.55%',
      '--surface-3': '0 0% 13.73%',
      '--surface-canvas': '0 0% 6.67%',
      '--surface-edge': '0 0% 20%',
      '--surface-glow': '216.83 92.2% 59.8%',
      '--surface-shadow': '0 0% 0%',
      '--surface-shadow-strong': '0 0% 0%',
      '--user-message-bg': '0 0% 14.12%',
      '--warning': '39.44 74.17% 52.94%',
      '--warning-vivid': '39.44 74.17% 52.94%',
    });
  });

it('keeps diff colors as fixed seeds: accent and contrast must not move them', () => {
    // diff 增删色与状态色是这套设计语言的常量,不是旋钮的产物。
    // 这里钉住两件事:换强调色不动它、调对比度不动它。
    const base = deriveThemeTokens(CODEX_LIGHT_SEEDS, false);
    const otherAccent = deriveThemeTokens(
      { ...CODEX_LIGHT_SEEDS, accent: '#d92650' },
      false,
    );
    const highContrast = deriveThemeTokens(
      { ...CODEX_LIGHT_SEEDS, contrast: 100 },
      false,
    );

    for (const tokens of [otherAccent, highContrast]) {
      expect(tokens['--diff-added']).toBe(base['--diff-added']);
      expect(tokens['--diff-removed']).toBe(base['--diff-removed']);
    }
    expect(base['--diff-added']).toBe(rgbToHslTriplet(hexToRgb(SEMANTIC_SEEDS.light.diffAdded)));
    expect(base['--diff-removed']).toBe(rgbToHslTriplet(hexToRgb(SEMANTIC_SEEDS.light.diffRemoved)));
    // 注意:Codex 自己的色板里 diff 增删色与 success/destructive 取的是同一个色值
    // （浅色删除色 = 危险色,深色同理）。分开的是**变量与语义**而不是颜色 ——
    // 组件要「删除行」时读 --diff-removed,要「失败」时读 --destructive,
    // 两者可以各自演化而不必互相牵连。这里钉住现状,色板若变则此断言会提醒。
    expect(base['--diff-added']).not.toBe(base['--success']);
  });

  it('converts rgb to hsl triplets without rounding drift', () => {
    expect(rgbToHslTriplet({ red: 0, green: 0, blue: 0 })).toBe('0 0% 0%');
    expect(rgbToHslTriplet({ red: 255, green: 255, blue: 255 })).toBe('0 0% 100%');
    expect(rgbToHslTriplet(hexToRgb('#3a83f7'))).toBe('216.83 92.2% 59.8%');
    expect(rgbToHslTriplet(hexToRgb('#fff'))).toBe(rgbToHslTriplet({ red: 255, green: 255, blue: 255 }));
    expect(rgbToHslTriplet(hexToRgb('#abc'))).toBe(rgbToHslTriplet(hexToRgb('#aabbcc')));
  });

  it('emits the scrim as a self-contained rgba so it can sit over any content', () => {
    expect(deriveThemeTokens(CODEX_LIGHT_SEEDS, false)['--scrim']).toBe('rgba(0, 0, 0, 0.098)');
    // 深色下 Codex 的 simpleScrim 压的是 ink（白），浅色压黑 —— 两套都照抄。
    expect(deriveThemeTokens(CODEX_DARK_SEEDS, true)['--scrim']).toBe('rgba(237, 237, 237, 0.104)');
    // 浅底 + 深色主题时，色相仍跟着 isDark 走（用该次运行的 ink），与底色无关。
    expect(deriveThemeTokens(CODEX_LIGHT_SEEDS, true)['--scrim']).toBe('rgba(13, 13, 13, 0.098)');
  });
});
