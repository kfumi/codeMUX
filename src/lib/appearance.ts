import {
  CODEX_DARK_SEEDS,
  CODEX_LIGHT_SEEDS,
  SEMANTIC_SEEDS,
  type SemanticOverrides,
  type ThemeSeeds,
  deriveThemeTokens,
} from './colorDerivation';
import type { Theme } from '../types/provider';

export type AccentKey =
  | 'codex'
  | 'azure'
  | 'cyan'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'graphite';
export type RadiusKey = 'sharp' | 'soft' | 'round';
export type ContentWidthKey = 'fixed' | 'stream';

export interface AppearancePrefs {
  accent: AccentKey;
  /** 0–100 的整体浓淡旋钮，驱动所有 alpha 步进（Codex 同名旋钮）。 */
  contrast: number;
  /** diff 新增/删除色，按明暗各存一套；缺省字段回落到语义种子。 */
  diff: DiffColors;
  uiFontFamily: string;
  uiFontSize: number;
  codeFontSize: number;
  radius: RadiusKey;
  contentWidth: ContentWidthKey;
}

export type DiffColorKey = 'lightAdded' | 'lightRemoved' | 'darkAdded' | 'darkRemoved';

export type DiffColors = Partial<Record<DiffColorKey, string>>;

export interface AccentPreset {
  name: string;
  /** hex；由 `colorDerivation` 继续派生出悬停底 / 焦点环 / 强调背景。 */
  light: string;
  dark: string;
}

export const SYSTEM_FONT_STACK =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
export const CHINESE_FONT_FALLBACK = "'Microsoft YaHei UI', 'PingFang SC', sans-serif";

/**
 * 内置字体(外观设置可选,随应用打包,OFL 协议):
 * key 是选择器里的显示名,value 是 @font-face 注册的真实字体族
 * (@font-face 定义在 src/styles/fonts.css,woff2 存放于 public/fonts/;
 * 改名时两处需同步)。
 */
export const BUILT_IN_FONT_FAMILIES: Record<string, string> = {
  Geist: 'Geist',
  Inter: 'Inter',
  'Noto Sans SC': 'Noto Sans SC',
  'LXGW WenKai': 'LXGW WenKai',
};

export const ACCENTS: Record<AccentKey, AccentPreset> = {
  // Codex / ChatGPT 的默认强调色。放在第一位且作为默认值 —— 整套换色的意义
  // 就是「开箱即与 Codex 一致」，默认给别的色会让第一次打开的人看到半成品。
  codex: { name: 'Codex', light: '#3a83f7', dark: '#3a83f7' },
  azure: { name: '天蓝', light: '#0169cb', dark: '#3197f6' },
  cyan: { name: '青碧', light: '#1b9bbb', dark: '#3ccadd' },
  emerald: { name: '翠绿', light: '#2d9f6a', dark: '#38c784' },
  amber: { name: '琥珀', light: '#c17c15', dark: '#f4ae34' },
  rose: { name: '玫红', light: '#d92650', dark: '#e46784' },
  violet: { name: '紫罗兰', light: '#7b4dcb', dark: '#a07cde' },
  graphite: { name: '石墨', light: '#1a1b1e', dark: '#ffffff' },
};

/** 色板圆点直接用 hex，不再维护第二份 swatch。 */
export const accentSwatch = (accent: AccentKey, isDark: boolean): string =>
  isDark ? ACCENTS[accent].dark : ACCENTS[accent].light;

export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 18;
export const CODE_FONT_SIZE_MIN = 10;
export const CODE_FONT_SIZE_MAX = 20;

export const CONTRAST_MIN = 0;
export const CONTRAST_MAX = 100;
export const CONTRAST_DEFAULT = 45;
/**
 * 深色比浅色高 15 —— Codex 的所有预设都是这个关系（浅 45 / 深 60）：
 * 纯黑底上同样的墨色 alpha 看起来更淡，所以要补一档才达到同样的通透度。
 */
export const DARK_CONTRAST_OFFSET = 15;

/**
 * 三档圆角是 Codex 刻度的**缩放档**，不是具体值：整条阶梯等比缩放，
 * 所以换档只改「有多圆」，不改「哪一档用在哪」。
 */
export const RADIUS_SCALES: Record<RadiusKey, number> = {
  sharp: 0.75,
  soft: 1,
  round: 1.35,
};

/** 设置面板里三档圆角的字面量预览（阶梯 md 档 × 各档缩放系数）。 */
export const RADII: Record<RadiusKey, string> = {
  sharp: '0.375rem',
  soft: '0.5rem',
  round: '0.675rem',
};

/** 三档圆角的预览半径：阶梯 md 档（8px 基准）乘以缩放系数。 */
export const RADIUS_PREVIEW: Record<RadiusKey, string> = {
  sharp: `${(0.5 * RADIUS_SCALES.sharp).toFixed(3)}rem`,
  soft: `${(0.5 * RADIUS_SCALES.soft).toFixed(3)}rem`,
  round: `${(0.5 * RADIUS_SCALES.round).toFixed(3)}rem`,
};

export const CONTENT_WIDTHS: Record<ContentWidthKey, string> = {
  fixed: '48rem',
  stream: '100%',
};

export const DEFAULT_PREFS: AppearancePrefs = {
  accent: 'codex',
  contrast: CONTRAST_DEFAULT,
  // 空对象 = 完全跟随语义种子；用户改过的键才会被写进来。
  diff: {},
  uiFontFamily: '',
  uiFontSize: 14,
  codeFontSize: 13,
  radius: 'soft',
  contentWidth: 'fixed',
};

const STORAGE_KEY = 'codemux:appearance';

const LEGACY_UI_FONT_MAP: Record<string, string> = {
  system: '',
  inter: 'Inter',
  'ibm-plex-sans': 'IBM Plex Sans',
  'noto-sans-sc': 'Noto Sans SC',
};

export function buildUiFontFamily(family: string): string {
  const trimmed = family.trim();
  if (!trimmed) return SYSTEM_FONT_STACK;
  const escaped = trimmed.replace(/'/g, "\\'");
  // 内置字体映射到打包的 @font-face 字体族;未命中按本机已安装字体名处理。
  const resolved = BUILT_IN_FONT_FAMILIES[trimmed] ?? escaped;
  return `'${resolved}', ${CHINESE_FONT_FALLBACK}`;
}

export function formatFontFamilyForCss(family: string): string {
  const trimmed = family.trim();
  if (!trimmed) return SYSTEM_FONT_STACK;
  const resolved = BUILT_IN_FONT_FAMILIES[trimmed] ?? trimmed;
  const escaped = resolved.replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/** 把偏好折成 4 个种子 —— 界面与表面的色值到这里为止，全交给派生引擎。 */
export function seedsForPrefs(prefs: AppearancePrefs, isDark: boolean): ThemeSeeds {
  const base = isDark ? CODEX_DARK_SEEDS : CODEX_LIGHT_SEEDS;
  const contrast = isDark
    ? Math.min(CONTRAST_MAX, clampContrast(prefs.contrast) + DARK_CONTRAST_OFFSET)
    : clampContrast(prefs.contrast);
  return { ...base, accent: ACCENTS[prefs.accent][isDark ? 'dark' : 'light'], contrast };
}

/** 当前主题下生效的 diff 配色（用户覆盖优先，缺省回落到语义种子）。 */
export function semanticOverridesForPrefs(prefs: AppearancePrefs, isDark: boolean): SemanticOverrides {
  const keys: DiffColorKey[] = isDark ? ['darkAdded', 'darkRemoved'] : ['lightAdded', 'lightRemoved'];
  const seed = isDark ? SEMANTIC_SEEDS.dark : SEMANTIC_SEEDS.light;
  return {
    diffAdded: prefs.diff[keys[0]] ?? seed.diffAdded,
    diffRemoved: prefs.diff[keys[1]] ?? seed.diffRemoved,
  };
}

/** 只接受 `#rrggbb`；其余一律忽略，避免坏值写进 CSS。 */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim());
}

export function sanitizeDiffColors(value: unknown): DiffColors {
  if (!value || typeof value !== 'object') return {};
  const parsed = value as Record<string, unknown>;
  const result: DiffColors = {};
  for (const key of ['lightAdded', 'lightRemoved', 'darkAdded', 'darkRemoved'] as DiffColorKey[]) {
    if (isHexColor(parsed[key])) result[key] = (parsed[key] as string).trim().toLowerCase();
  }
  return result;
}

export function clampContrast(value: number): number {
  if (!Number.isFinite(value)) return CONTRAST_DEFAULT;
  return Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, Math.round(value)));
}

export function loadPrefs(): AppearancePrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      accent: isValidAccent(parsed.accent) ? parsed.accent : DEFAULT_PREFS.accent,
      contrast: clampContrast(
        typeof parsed.contrast === 'number' ? parsed.contrast : CONTRAST_DEFAULT,
      ),
      diff: sanitizeDiffColors(parsed.diff),
      uiFontFamily: resolveStoredUiFontFamily(parsed),
      uiFontSize: resolveStoredUiFontSize(parsed.uiFontSize, parsed.fontSize),
      codeFontSize: resolveStoredCodeFontSize(parsed.codeFontSize),
      radius: isValidRadius(parsed.radius) ? parsed.radius : DEFAULT_PREFS.radius,
      contentWidth: isValidContentWidth(parsed.contentWidth) ? parsed.contentWidth : DEFAULT_PREFS.contentWidth,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: AppearancePrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota errors
  }
}

export function resolveIsDark(theme: Theme | undefined): boolean {
  if (theme === 'Dark') return true;
  if (theme === 'Light') return false;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyAppearance(prefs: AppearancePrefs, isDark: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  const tokens = deriveThemeTokens(
    seedsForPrefs(prefs, isDark),
    isDark,
    semanticOverridesForPrefs(prefs, isDark),
  );
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }

  root.style.setProperty('--radius-scale', String(RADIUS_SCALES[prefs.radius]));
  root.style.setProperty('--content-width', CONTENT_WIDTHS[prefs.contentWidth]);
  root.style.setProperty('--font-ui', buildUiFontFamily(prefs.uiFontFamily));
  root.style.setProperty('--ui-font-size', `${clampUiFontSize(prefs.uiFontSize)}px`);
  root.style.setProperty('--code-font-size', `${clampCodeFontSize(prefs.codeFontSize)}px`);
}

function isValidAccent(v: unknown): v is AccentKey {
  return typeof v === 'string' && v in ACCENTS;
}

function isValidRadius(v: unknown): v is RadiusKey {
  return typeof v === 'string' && v in RADII;
}

function isValidContentWidth(v: unknown): v is ContentWidthKey {
  return typeof v === 'string' && v in CONTENT_WIDTHS;
}

function resolveStoredUiFontFamily(parsed: Record<string, unknown>): string {
  if (typeof parsed.uiFontFamily === 'string') return parsed.uiFontFamily;
  if (typeof parsed.uiFont === 'string') {
    return LEGACY_UI_FONT_MAP[parsed.uiFont] ?? DEFAULT_PREFS.uiFontFamily;
  }
  return DEFAULT_PREFS.uiFontFamily;
}

export function clampUiFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PREFS.uiFontSize;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, Math.round(value)));
}

export function clampCodeFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PREFS.codeFontSize;
  return Math.min(CODE_FONT_SIZE_MAX, Math.max(CODE_FONT_SIZE_MIN, Math.round(value)));
}

function resolveStoredUiFontSize(currentValue: unknown, legacyValue: unknown): number {
  if (typeof currentValue === 'number') return clampUiFontSize(currentValue);

  if (legacyValue === 'compact') return 13;
  if (legacyValue === 'standard') return 14;
  if (legacyValue === 'comfortable') return 16;

  return DEFAULT_PREFS.uiFontSize;
}

function resolveStoredCodeFontSize(value: unknown): number {
  return typeof value === 'number' ? clampCodeFontSize(value) : DEFAULT_PREFS.codeFontSize;
}