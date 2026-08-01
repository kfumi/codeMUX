import type { Theme } from '../types/provider';

export type AccentKey = 'azure' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet' | 'graphite';
export type UiFontKey = 'system' | 'inter' | 'ibm-plex-sans' | 'noto-sans-sc';
export type RadiusKey = 'sharp' | 'soft' | 'round';
export type ContentWidthKey = 'fixed' | 'stream';

export interface AppearancePrefs {
  accent: AccentKey;
  uiFont: UiFontKey;
  uiFontSize: number;
  radius: RadiusKey;
  contentWidth: ContentWidthKey;
}

export interface UiFontPreset {
  name: string;
  description: string;
  family: string;
  previewFamily: string;
}

export interface AccentPreset {
  name: string;
  light: string;
  dark: string;
  lightForeground: string;
  darkForeground: string;
  swatch: string;
}

export const ACCENTS: Record<AccentKey, AccentPreset> = {
  azure: { name: 'Codex 蓝', light: '209 99% 40%', dark: '209 92% 58%', lightForeground: '0 0% 100%', darkForeground: '0 0% 100%', swatch: '#0169CC' },
  cyan: { name: '青碧', light: '192 75% 42%', dark: '187 70% 55%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(192 75% 42%)' },
  emerald: { name: '翠绿', light: '152 56% 40%', dark: '152 56% 50%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(152 56% 40%)' },
  amber: { name: '琥珀', light: '36 80% 42%', dark: '38 90% 58%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(36 80% 42%)' },
  rose: { name: '玫红', light: '346 70% 50%', dark: '346 70% 65%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(346 70% 50%)' },
  violet: { name: '紫罗兰', light: '262 55% 55%', dark: '262 60% 68%', lightForeground: '210 24% 98%', darkForeground: '210 26% 96%', swatch: 'hsl(262 55% 55%)' },
  graphite: { name: '墨黑', light: '222 18% 10%', dark: '220 10% 88%', lightForeground: '210 24% 98%', darkForeground: '220 15% 9%', swatch: 'hsl(222 18% 10%)' },
};

const SYSTEM_FONT_STACK = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
const CHINESE_FONT_FALLBACK = "'Noto Sans SC Variable', 'Microsoft YaHei UI', sans-serif";

export const UI_FONTS: Record<UiFontKey, UiFontPreset> = {
  system: {
    name: '系统字体',
    description: '跟随当前操作系统的界面字体',
    family: SYSTEM_FONT_STACK,
    previewFamily: SYSTEM_FONT_STACK,
  },
  inter: {
    name: 'Inter',
    description: '紧凑清晰，适合高密度工作界面',
    family: `'Inter Variable', ${CHINESE_FONT_FALLBACK}`,
    previewFamily: "'Inter Variable', sans-serif",
  },
  'ibm-plex-sans': {
    name: 'IBM Plex Sans',
    description: '更具技术感，字符辨识度高',
    family: `'IBM Plex Sans Variable', ${CHINESE_FONT_FALLBACK}`,
    previewFamily: "'IBM Plex Sans Variable', sans-serif",
  },
  'noto-sans-sc': {
    name: '思源黑体',
    description: '针对中文界面优化的均衡字形',
    family: `'Noto Sans SC Variable', 'Microsoft YaHei UI', sans-serif`,
    previewFamily: "'Noto Sans SC Variable', sans-serif",
  },
};

export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 18;

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
  uiFont: 'inter',
  uiFontSize: 14,
  radius: 'soft',
  contentWidth: 'fixed',
};

const STORAGE_KEY = 'codemux:appearance';

export function loadPrefs(): AppearancePrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      accent: isValidAccent(parsed.accent) ? parsed.accent : DEFAULT_PREFS.accent,
      uiFont: isValidUiFont(parsed.uiFont) ? parsed.uiFont : DEFAULT_PREFS.uiFont,
      uiFontSize: resolveStoredUiFontSize(parsed.uiFontSize, parsed.fontSize),
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
  root.style.setProperty('--radius', RADII[prefs.radius]);
  root.style.setProperty('--content-width', CONTENT_WIDTHS[prefs.contentWidth]);
  root.style.setProperty('--font-ui', UI_FONTS[prefs.uiFont].family);
  root.style.setProperty('--ui-font-size', `${clampUiFontSize(prefs.uiFontSize)}px`);
}

function isValidAccent(v: unknown): v is AccentKey {
  return typeof v === 'string' && v in ACCENTS;
}

function isValidUiFont(v: unknown): v is UiFontKey {
  return typeof v === 'string' && v in UI_FONTS;
}

function isValidRadius(v: unknown): v is RadiusKey {
  return typeof v === 'string' && v in RADII;
}

function isValidContentWidth(v: unknown): v is ContentWidthKey {
  return typeof v === 'string' && v in CONTENT_WIDTHS;
}

export function clampUiFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PREFS.uiFontSize;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, Math.round(value)));
}

function resolveStoredUiFontSize(currentValue: unknown, legacyValue: unknown): number {
  if (typeof currentValue === 'number') return clampUiFontSize(currentValue);

  if (legacyValue === 'compact') return 13;
  if (legacyValue === 'standard') return 14;
  if (legacyValue === 'comfortable') return 16;

  return DEFAULT_PREFS.uiFontSize;
}
