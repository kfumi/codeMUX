import type { Theme } from '../types/provider';

export type AccentKey = 'azure' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet' | 'graphite';
export type RadiusKey = 'sharp' | 'soft' | 'round';
export type ContentWidthKey = 'fixed' | 'stream';

export interface AppearancePrefs {
  accent: AccentKey;
  uiFontFamily: string;
  uiFontSize: number;
  codeFontSize: number;
  radius: RadiusKey;
  contentWidth: ContentWidthKey;
}

export interface AccentPreset {
  name: string;
  light: string;
  dark: string;
  lightForeground: string;
  darkForeground: string;
  swatch: string;
}

export const SYSTEM_FONT_STACK =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
export const CHINESE_FONT_FALLBACK = "'Microsoft YaHei UI', 'PingFang SC', sans-serif";

export const ACCENTS: Record<AccentKey, AccentPreset> = {
  azure: { name: '天蓝', light: '209 99% 40%', dark: '209 92% 58%', lightForeground: '0 0% 100%', darkForeground: '0 0% 100%', swatch: '#0169CC' },
  cyan: { name: '青碧', light: '192 75% 42%', dark: '187 70% 55%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(192 75% 42%)' },
  emerald: { name: '翠绿', light: '152 56% 40%', dark: '152 56% 50%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(152 56% 40%)' },
  amber: { name: '琥珀', light: '36 80% 42%', dark: '38 90% 58%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(36 80% 42%)' },
  rose: { name: '玫红', light: '346 70% 50%', dark: '346 70% 65%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(346 70% 50%)' },
  violet: { name: '紫罗兰', light: '262 55% 55%', dark: '262 60% 68%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(262 55% 55%)' },
  graphite: { name: '石墨', light: '220 7% 11%', dark: '0 0% 100%', lightForeground: '0 0% 100%', darkForeground: '220 7% 11%', swatch: '#1a1c1f' },
};

export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 18;
export const CODE_FONT_SIZE_MIN = 10;
export const CODE_FONT_SIZE_MAX = 20;

export const RADII: Record<RadiusKey, string> = {
  sharp: '0.25rem',
  soft: '0.5rem',
  round: '0.85rem',
};

export const CONTENT_WIDTHS: Record<ContentWidthKey, string> = {
  fixed: '52rem',
  stream: '100%',
};

export const DEFAULT_PREFS: AppearancePrefs = {
  accent: 'graphite',
  uiFontFamily: '',
  uiFontSize: 14,
  codeFontSize: 13,
  radius: 'soft',
  contentWidth: 'fixed',
};

const DIRECTIVE_CHIP_COLORS = {
  light: {
    accent: '221 83% 46%',
    background: '214 100% 93%',
    border: '214 100% 82%',
  },
  dark: {
    accent: '211 100% 72%',
    background: '211 68% 28%',
    border: '211 68% 43%',
  },
} as const;

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
  return `'${escaped}', ${CHINESE_FONT_FALLBACK}`;
}

export function formatFontFamilyForCss(family: string): string {
  const trimmed = family.trim();
  if (!trimmed) return SYSTEM_FONT_STACK;
  const escaped = trimmed.replace(/'/g, "\\'");
  return `'${escaped}'`;
}

export function loadPrefs(): AppearancePrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      accent: isValidAccent(parsed.accent) ? parsed.accent : DEFAULT_PREFS.accent,
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
  const accent = ACCENTS[prefs.accent];
  const accentColor = isDark ? accent.dark : accent.light;
  const accentForeground = isDark ? accent.darkForeground : accent.lightForeground;

  root.style.setProperty('--primary', accentColor);
  root.style.setProperty('--primary-foreground', accentForeground);
  root.style.setProperty('--ring', accentColor);
  root.style.setProperty('--glow', accentColor);
  const directiveChipColors = isDark ? DIRECTIVE_CHIP_COLORS.dark : DIRECTIVE_CHIP_COLORS.light;
  root.style.setProperty('--codemux-directive-accent', directiveChipColors.accent);
  root.style.setProperty('--codemux-directive-bg', directiveChipColors.background);
  root.style.setProperty('--codemux-directive-border', directiveChipColors.border);
  root.style.setProperty('--radius', RADII[prefs.radius]);
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
