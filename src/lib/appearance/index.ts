/**
 * 外观 —— 「此刻界面该长什么样」的唯一答案。
 *
 * 这个模块拥有两个真值源并把它们合并成**一次 apply**：
 * - `theme`：来自 daemon 配置（异步、迟到、权威），由 `setTheme()` 灌入；
 * - `prefs`：来自 localStorage（同步、模块加载即有），由 `setPref()` 灌入。
 *
 * 合并之前，这两者分居两处，于是「明暗是什么」有三份实现、「外观应用」有两条
 * 路径，且两条路径对「配置还没到」的答案不一致 —— 用户设了深色而系统是浅色时，
 * 那段窗口里会出现深色 class + 亮色强调色。
 *
 * 对外只出按问题回答的函数：调用方问「换主题 / 换一个旋钮」，不自己去拼
 * 「先取 theme、再取 prefs、再决定写哪些变量」。
 */

import { deriveThemeTokens } from '../colorDerivation';
import type { Theme } from '../../types/provider';
import {
  type AppearancePrefs,
  DEFAULT_PREFS,
  ACCENTS,
  CONTENT_WIDTHS,
  RADII,
  RADIUS_SCALES,
  buildUiFontFamily,
  clampCodeFontSize,
  clampContrast,
  clampUiFontSize,
  isValidAccent,
  isValidContentWidth,
  isValidRadius,
  resolveIsDark,
  seedsForPrefs,
} from './presets';
import { cacheBootTheme, readBootTheme, syncThemeChrome } from './boot';

const STORAGE_KEY = 'codemux:appearance';

const LEGACY_UI_FONT_MAP: Record<string, string> = {
  system: '',
  inter: 'Inter',
  'ibm-plex-sans': 'IBM Plex Sans',
  'noto-sans-sc': 'Noto Sans SC',
};

/**
 * 当前生效的主题。`undefined` = 配置还没到 —— 此时按 boot 缓存回落，
 * 缓存也没有才按系统偏好。这条回落链是**模块内部**的实现细节：
 * 曾经它是每个调用方各自的责任，于是两条路径给出了不同答案。
 */
let currentTheme: Theme | undefined;

/** 当前 prefs。模块加载时同步读 localStorage，不等任何异步。 */
let currentPrefs: AppearancePrefs = loadPrefs();

const listeners = new Set<(prefs: AppearancePrefs) => void>();
const isDarkListeners = new Set<(isDark: boolean) => void>();

/** 最近一次 apply 用的明暗 —— `subscribeIsDark` 的对外快照。 */
let lastIsDark = false;

let mediaQuery: MediaQueryList | null = null;

function emit(): void {
  for (const listener of listeners) {
    listener(currentPrefs);
  }
}

function emitIsDark(isDark: boolean): void {
  if (isDark === lastIsDark) return;
  lastIsDark = isDark;
  for (const listener of isDarkListeners) {
    listener(isDark);
  }
}

/**
 * 把一套偏好 + 一个明暗判定写成 `<html>` 上的变量表。**纯写入**，不做任何解析：
 * 明暗由调用方给，prefs 也由调用方给。
 *
 * 这是本模块的可测缝 —— `apply()` 是「决定写什么」的包装（合并 theme 与 prefs、
 * 回落、通知），而这里是「怎么写」。把它单独留出来，测试才能在不模拟整条
 * 状态机的前提下验证派生结果落到了 DOM 上。
 */
export function applyAppearance(prefs: AppearancePrefs, isDark: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  const tokens = deriveThemeTokens(seedsForPrefs(prefs, isDark), isDark);
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }

  root.style.setProperty('--radius-scale', String(RADIUS_SCALES[prefs.radius]));
  root.style.setProperty('--content-width', CONTENT_WIDTHS[prefs.contentWidth]);
  root.style.setProperty('--font-ui', buildUiFontFamily(prefs.uiFontFamily));
  root.style.setProperty('--ui-font-size', `${clampUiFontSize(prefs.uiFontSize)}px`);
  root.style.setProperty('--code-font-size', `${clampCodeFontSize(prefs.codeFontSize)}px`);
}

/**
 * 唯一的应用入口。写全三件事：`<html>` chrome、派生变量表、以及必须与 chrome
 * 同源的底色（由 `syncThemeChrome` 一并处理）。
 */
function apply(): void {
  const isDark = resolveIsDark(currentTheme ?? readBootTheme() ?? undefined);
  syncThemeChrome(isDark);
  applyAppearance(currentPrefs, isDark);
  emitIsDark(isDark);
}

/**
 * 系统偏好变化时重算 —— 只有「跟随系统」才需要，但监听器本身常驻：
 * 主题是运行期可切的，装/卸监听器只会多一种状态。
 */
function onSystemPreferenceChange(): void {
  if (currentTheme === 'System' || !currentTheme) {
    apply();
  }
}

function ensureMediaListener(): void {
  if (typeof window === 'undefined' || mediaQuery) return;
  if (!window.matchMedia) return;
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', onSystemPreferenceChange);
}

/** 灌入权威主题。配置到手、用户切主题、回滚都走这一条。 */
export function setTheme(theme: Theme | undefined): void {
  currentTheme = theme;
  if (theme) {
    cacheBootTheme(theme);
  }
  ensureMediaListener();
  apply();
}

/**
 * 改一个旋钮。`patch` 只带被改的键 —— 七个 setter 曾经逐字重复同一段
 * 「合并 → 落盘 → apply → set」，那是同一个动作的七次抄写。
 */
export function setPref<K extends keyof AppearancePrefs>(
  key: K,
  value: AppearancePrefs[K],
): void {
  currentPrefs = normalizePrefs({ ...currentPrefs, [key]: value });
  savePrefs(currentPrefs);
  apply();
  emit();
}

export function resetPrefs(): void {
  currentPrefs = DEFAULT_PREFS;
  savePrefs(currentPrefs);
  apply();
  emit();
}

export function getPrefs(): AppearancePrefs {
  return currentPrefs;
}

export function getIsDark(): boolean {
  return lastIsDark;
}

/** prefs 变化订阅（给 React 侧的投影 store 用）。 */
export function subscribe(listener: (prefs: AppearancePrefs) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 明暗变化订阅。明暗不只影响 CSS —— 设置页要显示当前强调色的 hex 与名字。 */
export function subscribeIsDark(listener: (isDark: boolean) => void): () => void {
  isDarkListeners.add(listener);
  return () => isDarkListeners.delete(listener);
}

/**
 * 只给测试用的复位钩子：模块是有状态的单例，用例之间必须能回到初始态。
 * 生产代码不该调用 —— 应用生命周期内没有「外观回到出厂」这个动作（`resetPrefs` 才是）。
 *
 * **不清订阅者**：订阅是模块加载时就建立的（比如 store 的投影），属于长期关系，
 * 不该被测试复位拆掉；清掉会让「投影跟着模块走」这条链在后续用例里静默失效。
 */
export function __resetForTests(): void {
  currentTheme = undefined;
  currentPrefs = DEFAULT_PREFS;
  lastIsDark = false;
  if (mediaQuery) {
    mediaQuery.removeEventListener('change', onSystemPreferenceChange);
    mediaQuery = null;
  }
}

function normalizePrefs(prefs: AppearancePrefs): AppearancePrefs {
  return {
    accent: isValidAccent(prefs.accent) ? prefs.accent : DEFAULT_PREFS.accent,
    contrast: clampContrast(prefs.contrast),
    uiFontFamily: prefs.uiFontFamily,
    uiFontSize: clampUiFontSize(prefs.uiFontSize),
    codeFontSize: clampCodeFontSize(prefs.codeFontSize),
    radius: isValidRadius(prefs.radius) ? prefs.radius : DEFAULT_PREFS.radius,
    contentWidth: isValidContentWidth(prefs.contentWidth) ? prefs.contentWidth : DEFAULT_PREFS.contentWidth,
  };
}

export function loadPrefs(): AppearancePrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizePrefs({
      accent: isValidAccent(parsed.accent) ? parsed.accent : DEFAULT_PREFS.accent,
      contrast: typeof parsed.contrast === 'number' ? parsed.contrast : DEFAULT_PREFS.contrast,
      uiFontFamily: resolveStoredUiFontFamily(parsed),
      uiFontSize: resolveStoredUiFontSize(parsed.uiFontSize, parsed.fontSize),
      codeFontSize: resolveStoredCodeFontSize(parsed.codeFontSize),
      radius: isValidRadius(parsed.radius) ? parsed.radius : DEFAULT_PREFS.radius,
      contentWidth: isValidContentWidth(parsed.contentWidth) ? parsed.contentWidth : DEFAULT_PREFS.contentWidth,
    });
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

function resolveStoredUiFontFamily(parsed: Record<string, unknown>): string {
  if (typeof parsed.uiFontFamily === 'string') return parsed.uiFontFamily;
  if (typeof parsed.uiFont === 'string') {
    return LEGACY_UI_FONT_MAP[parsed.uiFont] ?? DEFAULT_PREFS.uiFontFamily;
  }
  return DEFAULT_PREFS.uiFontFamily;
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

// 模块加载即落一次：配置未到时按 boot 缓存，缓存也没有才按系统偏好。
apply();

export { ACCENTS, CONTENT_WIDTHS, RADII, DEFAULT_PREFS };
export type { AppearancePrefs, AccentKey, RadiusKey, ContentWidthKey } from './presets';

/**
 * 预设层是纯数据/纯函数，调用方直接取即可 —— 收窄它没有收益：
 * 设置页要 `CONTRAST_MAX` 来画滑块，终端要 `CODE_FONT_SIZE_MIN` 来夹值，
 * 这些都是**事实**而不是决策，转发一层只会让调用方多跳一次文件。
 */
export {
  accentName,
  accentSwatch,
  buildUiFontFamily,
  formatFontFamilyForCss,
  resolveIsDark,
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  CODE_FONT_SIZE_MAX,
  CONTRAST_MIN,
  CONTRAST_MAX,
  CONTRAST_DEFAULT,
  RADIUS_PREVIEW,
  RADIUS_SCALES,
  clampContrast,
  clampUiFontSize,
  clampCodeFontSize,
  seedsForPrefs,
  isHexColor,
  DARK_CONTRAST_OFFSET,
} from './presets';
