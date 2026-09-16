/**
 * Monaco 与 CodeMUX 外观系统的桥接。
 *
 * 设计约束(为什么这么做):
 *
 * 1. **色板只有一个来源**。色值的权威定义在 `src/styles/globals.css`(`--card`、
 *    `--muted`、`--border` 等)。这里全部用 `getComputedStyle` 读回来,而不是在 TS
 *    里按 `prefs` 再推导一遍 —— 后者会形成第二份色板,和 CSS 迟早漂移。强调色是
 *    例外:它本来就是 `src/lib/appearance.ts` 里的 JS 数据,读它就是读同一个来源。
 *
 * 2. **Monaco 吃不了 CSS 变量**。主题是 JS 对象,拿不到 `var(--card)`;字号与字体
 *    也只能通过 options 传。所以外观变化必须主动推给 Monaco,这是这套桥存在的
 *    理由,而不是可以直接用 CSS 解决的事。
 *
 * 3. **监听 class 与 style 两个属性**。暗色模式是 `html.dark`(`settingsStore`),
 *    而强调色、字号、圆角是 `applyAppearance` 往 `documentElement.style` 写的内联
 *    变量。只监听 `class` 会漏掉换色和改字号。
 *
 * 4. **语法高亮沿用 Monaco 内置主题**。`base: 'vs' | 'vs-dark'` + `inherit: true`
 *    只覆盖 UI chrome 颜色,不自己编 14 套配色 —— 语法着色的语义色是内容固有属性
 *    (AGENTS.md 允许这类固定色),硬编一套只会比内置的更差。
 */
import { useEffect, useMemo, useState } from 'react';

import type { Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

/**
 * Monaco 主题名固定不变。
 *
 * 不按 `codemux-${mode}-${accent}` 那样随外观改名,是为了避开一个挂载顺序问题:
 * `@monaco-editor/react` 在 `theme` prop 变化时会自己调 `setTheme`,而子组件 effect
 * 先于父组件 effect 执行,于是「换成新名字」的那一帧会先 setTheme 一个尚未 define
 * 的主题(Monaco 会告警并保留旧主题)。名字稳定 + 每次变化由本模块 define 后再
 * `setTheme` 同名,就没有这个窗口。
 */
export const CODEMUX_MONACO_THEME = 'codemux';

/** 从 CSS 读不到色值时的兜底(仅防御 DOM 缺失/变量被覆盖)。 */
const FALLBACK_TOKENS: MonacoAppearanceTokens = {
  isDark: false,
  card: '0 0% 100%',
  background: '0 0% 99%',
  foreground: '0 0% 12%',
  muted: '0 0% 95%',
  mutedForeground: '0 0% 40%',
  border: '0 0% 88%',
  popover: '0 0% 100%',
  primary: '209 99% 40%',
  success: '142 55% 40%',
  destructive: '358 70% 62%',
  warning: '38 88% 55%',
  codeFontSize: 13,
  codeFontFamily: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Consolas, monospace",
};

export interface MonacoAppearanceTokens {
  isDark: boolean;
  /** 以下色值均为 globals.css 风格的 `H S% L%` 三元组。 */
  card: string;
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  popover: string;
  primary: string;
  success: string;
  destructive: string;
  warning: string;
  /** 已解析的 px 数值,对应 --code-font-size。 */
  codeFontSize: number;
  /** 已解析的字体族栈,对应 @theme 的 --font-mono。 */
  codeFontFamily: string;
}

/**
 * `H S% L%` → `#rrggbb`(alpha < 1 时给 `#rrggbbaa`)。
 *
 * 必须是 hex。CSS 色板是 hsl 三元组,而 Monaco 主题的颜色解析在 monaco-editor
 * 0.56 只接受 `#rrggbb` / `#rrggbbaa`:颜色映射用的是
 * `/^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/`,喂 `rgb()` / `rgba()` / `hsl()`
 * 都会抛 `Illegal value for token color`。`defineTheme` 是在 React effect 里调的,
 * 抛出来会直接打断主题应用,所以格式没有试错余地 —— 这一点是在真实 Electron
 * 渲染层里对 0.56.0 实测确认的,不是推测。
 *
 * 解析失败返回 null,由调用方决定兜底。
 */
export function hslTripletToHex(triplet: string, alpha = 1): string | null {
  const match = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(triplet.trim());
  if (!match) {
    return null;
  }

  const hue = ((parseFloat(match[1]) % 360) + 360) % 360;
  const saturation = parseFloat(match[2]) / 100;
  const lightness = parseFloat(match[3]) / 100;

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;

  let rgb: [number, number, number];
  if (hue < 60) rgb = [chroma, second, 0];
  else if (hue < 120) rgb = [second, chroma, 0];
  else if (hue < 180) rgb = [0, chroma, second];
  else if (hue < 240) rgb = [0, second, chroma];
  else if (hue < 300) rgb = [second, 0, chroma];
  else rgb = [chroma, 0, second];

  const byte = (value: number) =>
    Math.max(0, Math.min(255, Math.round((value + offset) * 255)))
      .toString(16)
      .padStart(2, '0');

  const opaque = `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`;
  if (alpha >= 1) {
    return opaque;
  }
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  return `${opaque}${Math.round(clampedAlpha * 255).toString(16).padStart(2, '0')}`;
}

/** 结构化的样式读取口,便于单测直接传桩(jsdom 不完整支持自定义属性)。 */
export interface MonacoStyleReader {
  getPropertyValue(name: string): string;
}

/** 结构化的 classList 读取口,只需能判断暗色模式。 */
export interface MonacoRootReader {
  classList: { contains(token: string): boolean };
}

function readTriplet(styles: MonacoStyleReader, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

/**
 * 读取当前生效的外观 token。以「实际渲染出来的样子」为准(DOM 上的 class/style),
 * 而不是 `prefs`,这样配色、暗色模式、系统主题偏好三条路径都自动收敛到这里。
 */
export function readAppearanceTokens(
  root: MonacoRootReader,
  styles: MonacoStyleReader,
): MonacoAppearanceTokens {
  const isDark = root.classList.contains('dark');
  const fontSize = parseFloat(styles.getPropertyValue('--code-font-size'));
  const fontFamily = styles.getPropertyValue('--font-mono').trim();

  return {
    isDark,
    card: readTriplet(styles, '--card', FALLBACK_TOKENS.card),
    background: readTriplet(styles, '--background', FALLBACK_TOKENS.background),
    foreground: readTriplet(styles, '--foreground', FALLBACK_TOKENS.foreground),
    muted: readTriplet(styles, '--muted', FALLBACK_TOKENS.muted),
    mutedForeground: readTriplet(styles, '--muted-foreground', FALLBACK_TOKENS.mutedForeground),
    border: readTriplet(styles, '--border', FALLBACK_TOKENS.border),
    popover: readTriplet(styles, '--popover', FALLBACK_TOKENS.popover),
    primary: readTriplet(styles, '--primary', FALLBACK_TOKENS.primary),
    success: readTriplet(styles, '--success', FALLBACK_TOKENS.success),
    destructive: readTriplet(styles, '--destructive', FALLBACK_TOKENS.destructive),
    warning: readTriplet(styles, '--warning', FALLBACK_TOKENS.warning),
    codeFontSize: Number.isFinite(fontSize) ? fontSize : FALLBACK_TOKENS.codeFontSize,
    codeFontFamily: fontFamily || FALLBACK_TOKENS.codeFontFamily,
  };
}

/** 把外观 token 编译成 Monaco 主题。纯函数,便于单测。 */
export function buildMonacoTheme(tokens: MonacoAppearanceTokens): editor.IStandaloneThemeData {
  const color = (triplet: string, alpha = 1) => hslTripletToHex(triplet, alpha) ?? triplet;

  return {
    base: tokens.isDark ? 'vs-dark' : 'vs',
    // 保留内置主题的语法着色规则,只覆盖 UI chrome。
    inherit: true,
    rules: [],
    colors: {
      'editor.background': color(tokens.card),
      'editor.foreground': color(tokens.foreground),
      'editorGutter.background': color(tokens.card),
      'editorLineNumber.foreground': color(tokens.mutedForeground, 0.6),
      'editorLineNumber.activeForeground': color(tokens.foreground),
      'editor.lineHighlightBackground': color(tokens.muted),
      'editor.lineHighlightBorder': color(tokens.primary, 0),
      'editor.selectionBackground': color(tokens.primary, 0.24),
      'editor.inactiveSelectionBackground': color(tokens.primary, 0.12),
      'editor.selectionHighlightBackground': color(tokens.primary, 0.16),
      'editor.wordHighlightBackground': color(tokens.primary, 0.14),
      'editor.wordHighlightStrongBackground': color(tokens.primary, 0.2),
      'editorCursor.foreground': color(tokens.primary),
      'editorIndentGuide.background1': color(tokens.border, 0.7),
      'editorIndentGuide.activeBackground1': color(tokens.primary, 0.45),
      'editorWhitespace.foreground': color(tokens.border),
      'editorBracketMatch.background': color(tokens.primary, 0.16),
      'editorBracketMatch.border': color(tokens.primary, 0.5),
      'editorLink.activeForeground': color(tokens.primary),
      'textLink.foreground': color(tokens.primary),
      'textLink.activeForeground': color(tokens.primary),
      'editorError.foreground': color(tokens.destructive),
      'editorWarning.foreground': color(tokens.warning),
      'editorInfo.foreground': color(tokens.primary),
      'editorWidget.background': color(tokens.popover),
      'editorWidget.border': color(tokens.border),
      'editorHoverWidget.background': color(tokens.popover),
      'editorHoverWidget.border': color(tokens.border),
      'editorSuggestWidget.background': color(tokens.popover),
      'editorSuggestWidget.border': color(tokens.border),
      'editorSuggestWidget.foreground': color(tokens.foreground),
      'editorSuggestWidget.selectedBackground': color(tokens.primary, 0.16),
      'editorSuggestWidget.highlightForeground': color(tokens.primary),
      'editorSuggestWidget.focusHighlightForeground': color(tokens.primary),
      'list.hoverBackground': color(tokens.muted),
      'list.focusBackground': color(tokens.muted),
      'input.background': color(tokens.background),
      'input.foreground': color(tokens.foreground),
      'input.border': color(tokens.border),
      'dropdown.background': color(tokens.popover),
      'dropdown.border': color(tokens.border),
      'dropdown.foreground': color(tokens.foreground),
      'focusBorder': color(tokens.primary, 0.5),
      'widget.shadow': color(tokens.isDark ? '0 0% 0%' : '0 0% 10%', 0.2),
      'scrollbarSlider.background': color(tokens.mutedForeground, 0.2),
      'scrollbarSlider.hoverBackground': color(tokens.mutedForeground, 0.3),
      'scrollbarSlider.activeBackground': color(tokens.mutedForeground, 0.4),
      'editorOverviewRuler.border': color(tokens.border, 0.6),
      'minimap.background': color(tokens.card),
      'minimapSlider.background': color(tokens.mutedForeground, 0.12),
      'minimapSlider.hoverBackground': color(tokens.mutedForeground, 0.2),
      'minimapSlider.activeBackground': color(tokens.mutedForeground, 0.3),
      // diffEditor.* 系列刻意不覆盖:这里的 colors 表是「覆盖表」,未列出的色回落到
      // Monaco registerColor 的内置默认 —— 也就是 VS Code 原生的 diff 观感
      // (插入行 rgba(155,185,85,.2) 黄绿 / 删除行 rgba(255,0,0,.2) 纯红 /
      // 字符级 #9ccc2c33 / #ff000033,以及斜线填充与 gutter 的原生配色)。
      // 此前用 app 语义色(success/destructive 低透明度)覆盖过,比原生更淡、
      // 色相偏移,视觉上明显不像 VS Code,故撤掉交还给 Monaco 默认。
    },
  };
}

function readTokensFromDocument(): MonacoAppearanceTokens {
  if (typeof document === 'undefined') {
    return FALLBACK_TOKENS;
  }
  const root = document.documentElement;
  return readAppearanceTokens(root, getComputedStyle(root));
}

function tokensKey(tokens: MonacoAppearanceTokens): string {
  return [
    tokens.isDark,
    tokens.card,
    tokens.foreground,
    tokens.muted,
    tokens.mutedForeground,
    tokens.border,
    tokens.popover,
    tokens.primary,
    tokens.success,
    tokens.destructive,
    tokens.warning,
    tokens.codeFontSize,
    tokens.codeFontFamily,
  ].join('|');
}

export interface MonacoAppearance {
  themeName: string;
  /** 直接铺给 <Editor options>,让 Monaco 跟随全局代码字号与字体。 */
  options: editor.IStandaloneEditorConstructionOptions;
}

/**
 * 外观同步 hook:把当前 token 定义成 Monaco 主题并套用,跟随暗色模式、强调色与
 * 代码字号变化。`monaco` 为 null(尚未挂载)时只返回 options。
 */
export function useMonacoAppearance(monaco: Monaco | null): MonacoAppearance {
  const [tokens, setTokens] = useState<MonacoAppearanceTokens>(readTokensFromDocument);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const root = document.documentElement;
    const sync = () => {
      const next = readAppearanceTokens(root, getComputedStyle(root));
      // 只在真正变化时更新,避免无关的 style 变更反复 define 主题。
      setTokens((current) => (tokensKey(current) === tokensKey(next) ? current : next));
    };

    // class = 暗色模式;style = 强调色 / 字号 / 圆角(见 applyAppearance)。
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
    sync();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!monaco) {
      return;
    }
    monaco.editor.defineTheme(CODEMUX_MONACO_THEME, buildMonacoTheme(tokens));
    // defineTheme 不会刷新已套用的主题,必须再 setTheme 一次同一个名字。
    monaco.editor.setTheme(CODEMUX_MONACO_THEME);
  }, [monaco, tokens]);

  const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({
      fontSize: tokens.codeFontSize,
      fontFamily: tokens.codeFontFamily,
    }),
    [tokens.codeFontSize, tokens.codeFontFamily],
  );

  return { themeName: CODEMUX_MONACO_THEME, options };
}

/**
 * 供 <Editor beforeMount> 使用:Monaco 实例出现后、编辑器创建前先把主题定义好,
 * 避免首帧拿不到主题。同时返回当时的 token 供调用方复用。
 */
export function defineMonacoTheme(monaco: Monaco): MonacoAppearanceTokens {
  const tokens = readTokensFromDocument();
  monaco.editor.defineTheme(CODEMUX_MONACO_THEME, buildMonacoTheme(tokens));
  return tokens;
}

export { FALLBACK_TOKENS };
