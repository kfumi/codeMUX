import type { ITheme } from '@xterm/xterm';

/**
 * 终端字体栈：与应用其余部分一致，优先 Consolas / JetBrains Mono。
 * 字号不在这里写死 —— 它跟随外观设置里的 `codeFontSize`（见 sessionRegistry）。
 */
export const TERMINAL_FONT_FAMILY = 'Consolas, "JetBrains Mono", monospace';

/**
 * ANSI 16 色是终端语义色（红=错误、绿=成功、黄=警告…），不随应用强调色派生，
 * 也不能简单从表面色算出来：色相一旦跟着强调色走，`ls --color` 的颜色语义就乱了。
 * 明暗各一套，保持固定。
 */
const ANSI_DARK = {
  black: '#0f172a',
  red: '#f87171',
  green: '#86efac',
  yellow: '#fde047',
  blue: '#93c5fd',
  magenta: '#d8b4fe',
  cyan: '#67e8f9',
  white: '#e5e7eb',
  brightBlack: '#64748b',
  brightRed: '#fca5a5',
  brightGreen: '#bbf7d0',
  brightYellow: '#fef08a',
  brightBlue: '#bfdbfe',
  brightMagenta: '#e9d5ff',
  brightCyan: '#a5f3fc',
  brightWhite: '#ffffff',
} as const;

const ANSI_LIGHT = {
  black: '#1f2937',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#1d4ed8',
  magenta: '#7e22ce',
  cyan: '#0e7490',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#9333ea',
  brightCyan: '#0891b2',
  brightWhite: '#ffffff',
} as const;

/**
 * 把 `hsl(var(--token))` 解析成 xterm 能接受的实色。
 *
 * xterm 的颜色解析器不认 `var()` 与 `color-mix()`，而应用的颜色全是 HSL 三元组
 * 变量（`--background`、`--primary` 等）。用一个临时元素让浏览器算一次是最稳的；
 * jsdom / 无样式环境拿不到值（返回空串或原样文本）时回落到传入的兜底色。
 */
function resolveCssColor(variable: string, fallback: string, alpha?: number): string {
  if (typeof document === 'undefined' || !document.body) return fallback;

  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = alpha === undefined
    ? `hsl(var(${variable}))`
    : `hsl(var(${variable}) / ${alpha})`;
  document.body.appendChild(probe);

  let resolved = '';
  try {
    resolved = window.getComputedStyle(probe).color;
  } finally {
    probe.remove();
  }

  // 变量未定义的浏览器会保留 `hsl(var(--x))` 文本或返回空串，两种都不能交给 xterm。
  if (!resolved || resolved.includes('var(')) return fallback;
  return resolved;
}

/**
 * xterm 主题：背景/前景/光标/选区跟随应用的四颗种子，ANSI 色保持固定。
 *
 * 明暗由调用方给（外观模块的 `getIsDark`），而不是在这里读 DOM class —— 主题可能来自
 * 「跟随系统」，class 不一定是唯一的真值来源。
 */
export function terminalTheme(isDark: boolean): ITheme {
  return {
    background: resolveCssColor('--background', isDark ? '#000000' : '#fcfcfc'),
    foreground: resolveCssColor('--foreground', isDark ? '#ededed' : '#0d0d0d'),
    cursor: resolveCssColor('--primary', '#3a83f7'),
    cursorAccent: resolveCssColor('--background', isDark ? '#000000' : '#fcfcfc'),
    selectionBackground: resolveCssColor('--primary', '#3a83f7', 0.28),
    ...(isDark ? ANSI_DARK : ANSI_LIGHT),
  };
}
