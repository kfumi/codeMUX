import type { Theme } from '../types/provider';

export type AccentKey = 'azure' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet';
export type FontSizeKey = 'compact' | 'standard' | 'comfortable';
export type RadiusKey = 'sharp' | 'soft' | 'round';
export type ContentWidthKey = 'fixed' | 'stream';

export interface AppearancePrefs {
  accent: AccentKey;
  fontSize: FontSizeKey;
  radius: RadiusKey;
  contentWidth: ContentWidthKey;
}

export interface AccentPreset {
  name: string;
  light: string;
  dark: string;
  swatch: string;
}

export const ACCENTS: Record<AccentKey, AccentPreset> = {
  azure: { name: '天蓝', light: '217 42% 48%', dark: '198 42% 49%', swatch: 'hsl(217 42% 48%)' },
  cyan: { name: '青碧', light: '192 75% 42%', dark: '187 70% 55%', swatch: 'hsl(192 75% 42%)' },
  emerald: { name: '翠绿', light: '152 56% 40%', dark: '152 56% 50%', swatch: 'hsl(152 56% 40%)' },
  amber: { name: '琥珀', light: '36 80% 42%', dark: '38 90% 58%', swatch: 'hsl(36 80% 42%)' },
  rose: { name: '玫红', light: '346 70% 50%', dark: '346 70% 65%', swatch: 'hsl(346 70% 50%)' },
  violet: { name: '紫罗兰', light: '262 55% 55%', dark: '262 60% 68%', swatch: 'hsl(262 55% 55%)' },
};

export const FONT_SIZES: Record<FontSizeKey, string> = {
  compact: '15px',
  standard: '16px',
  comfortable: '18px',
};

export const RADII: Record<RadiusKey, string> = {
  sharp: '0.25rem',
  soft: '0.5rem',
  round: '0.85rem',
};

export const CONTENT_WIDTHS: Record<ContentWidthKey, string> = {
  fixed: '48rem',
  stream: '100%',
};

export const DEFAULT_PREFS: AppearancePrefs = {
  accent: 'azure',
  fontSize: 'standard',
  radius: 'soft',
  contentWidth: 'fixed',
};

const STORAGE_KEY = 'codemux:appearance';

export function loadPrefs(): AppearancePrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<AppearancePrefs>;
    return {
      accent: isValidAccent(parsed.accent) ? parsed.accent : DEFAULT_PREFS.accent,
      fontSize: isValidFontSize(parsed.fontSize) ? parsed.fontSize : DEFAULT_PREFS.fontSize,
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

  root.style.setProperty('--primary', accentColor);
  root.style.setProperty('--ring', accentColor);
  root.style.setProperty('--glow', accentColor);
  root.style.setProperty('--radius', RADII[prefs.radius]);
  root.style.setProperty('--content-width', CONTENT_WIDTHS[prefs.contentWidth]);
  root.style.fontSize = FONT_SIZES[prefs.fontSize];
}

function isValidAccent(v: unknown): v is AccentKey {
  return typeof v === 'string' && v in ACCENTS;
}

function isValidFontSize(v: unknown): v is FontSizeKey {
  return typeof v === 'string' && v in FONT_SIZES;
}

function isValidRadius(v: unknown): v is RadiusKey {
  return typeof v === 'string' && v in RADII;
}

function isValidContentWidth(v: unknown): v is ContentWidthKey {
  return typeof v === 'string' && v in CONTENT_WIDTHS;
}
