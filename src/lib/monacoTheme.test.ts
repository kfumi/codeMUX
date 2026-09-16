import { describe, expect, it } from 'vitest';

import {
  buildMonacoTheme,
  hslTripletToHex,
  readAppearanceTokens,
  type MonacoAppearanceTokens,
  type MonacoStyleReader,
} from './monacoTheme';

function styleReader(values: Record<string, string>): MonacoStyleReader {
  return { getPropertyValue: (name: string) => values[name] ?? '' };
}

const LIGHT_TOKENS: MonacoAppearanceTokens = {
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
  codeFontFamily: "'JetBrains Mono Variable', monospace",
};

describe('hslTripletToHex', () => {
  it('转换 globals.css 的 H S% L% 三元组', () => {
    expect(hslTripletToHex('0 0% 100%')).toBe('#ffffff');
    expect(hslTripletToHex('0 0% 0%')).toBe('#000000');
    // 主色的三原色边界
    expect(hslTripletToHex('0 100% 50%')).toBe('#ff0000');
    expect(hslTripletToHex('120 100% 50%')).toBe('#00ff00');
    expect(hslTripletToHex('240 100% 50%')).toBe('#0000ff');
  });

  it('带透明度', () => {
    expect(hslTripletToHex('0 0% 100%', 0.5)).toBe('#ffffff80');
    expect(hslTripletToHex('0 0% 100%', 0)).toBe('#ffffff00');
  });

  it('忽略空白并对超范围色相取模', () => {
    expect(hslTripletToHex('  0 0% 100%  ')).toBe('#ffffff');
    expect(hslTripletToHex('360 100% 50%')).toBe(hslTripletToHex('0 100% 50%'));
  });

  it('无法解析时返回 null，由调用方兜底', () => {
    expect(hslTripletToHex('')).toBeNull();
    expect(hslTripletToHex('#fff')).toBeNull();
    expect(hslTripletToHex('var(--card)')).toBeNull();
    expect(hslTripletToHex('0 0 100%')).toBeNull();
  });
});

describe('readAppearanceTokens', () => {
  it('读回 CSS 变量并解析代码字号', () => {
    const tokens = readAppearanceTokens({ classList: { contains: () => false } }, styleReader({
      '--card': ' 0 0% 10% ',
      '--foreground': '0 0% 93%',
      '--code-font-size': '16px',
      '--font-mono': "'JetBrains Mono Variable', monospace",
    }));

    expect(tokens.isDark).toBe(false);
    expect(tokens.card).toBe('0 0% 10%');
    expect(tokens.codeFontSize).toBe(16);
    expect(tokens.codeFontFamily).toBe("'JetBrains Mono Variable', monospace");
  });

  it('html 带 dark class 时判定为暗色', () => {
    const tokens = readAppearanceTokens({ classList: { contains: (token) => token === 'dark' } }, styleReader({}));
    expect(tokens.isDark).toBe(true);
  });

  it('变量缺失时用兜底值，字号非数值也兜底', () => {
    const tokens = readAppearanceTokens({ classList: { contains: () => false } }, styleReader({
      '--code-font-size': 'not-a-size',
    }));

    expect(tokens.card).toBe('0 0% 100%');
    expect(tokens.primary).toBe('209 99% 40%');
    expect(tokens.codeFontSize).toBe(13);
    expect(tokens.codeFontFamily).toContain('JetBrains Mono');
  });
});

describe('buildMonacoTheme', () => {
  it('亮色以 vs 为基底、暗色以 vs-dark 为基底', () => {
    expect(buildMonacoTheme(LIGHT_TOKENS).base).toBe('vs');
    expect(buildMonacoTheme({ ...LIGHT_TOKENS, isDark: true }).base).toBe('vs-dark');
  });

  it('继承内置主题的语法着色规则，不自己编配色', () => {
    const theme = buildMonacoTheme(LIGHT_TOKENS);
    expect(theme.inherit).toBe(true);
    expect(theme.rules).toEqual([]);
  });

  it('chrome 颜色来自 token，而不是硬编码色板', () => {
    const theme = buildMonacoTheme(LIGHT_TOKENS);
    const colors = theme.colors!;

    expect(colors['editor.background']).toBe(hslTripletToHex(LIGHT_TOKENS.card));
    expect(colors['editor.foreground']).toBe(hslTripletToHex(LIGHT_TOKENS.foreground));
    expect(colors['editorLineNumber.activeForeground']).toBe(hslTripletToHex(LIGHT_TOKENS.foreground));
    // 强调色驱动的光标 / 选区 / 括号匹配
    expect(colors['editorCursor.foreground']).toBe(hslTripletToHex(LIGHT_TOKENS.primary));
    expect(colors['editor.selectionBackground']).toBe(hslTripletToHex(LIGHT_TOKENS.primary, 0.24));
    expect(colors['editorBracketMatch.border']).toBe(hslTripletToHex(LIGHT_TOKENS.primary, 0.5));
  });

  it('diff 增删配色不覆盖,回落到 Monaco/VS Code 原生默认', () => {
    const colors = buildMonacoTheme(LIGHT_TOKENS).colors!;

    // colors 是覆盖表:diffEditor.* 未列出即走 registerColor 的内置默认
    // (insert rgba(155,185,85,.2) / remove rgba(255,0,0,.2)),保持正宗 VS Code 观感。
    expect(colors['diffEditor.insertedLineBackground']).toBeUndefined();
    expect(colors['diffEditor.removedLineBackground']).toBeUndefined();
    expect(colors['diffEditor.insertedTextBackground']).toBeUndefined();
    expect(colors['diffEditor.removedTextBackground']).toBeUndefined();
    expect(colors['diffEditorGutter.insertedLineBackground']).toBeUndefined();
    expect(colors['editorGutter.addedBackground']).toBeUndefined();
  });

  it('强调色变化会改变主题里的强调色，但不动背景', () => {
    const azure = buildMonacoTheme(LIGHT_TOKENS).colors!;
    const violet = buildMonacoTheme({ ...LIGHT_TOKENS, primary: '262 55% 55%' }).colors!;

    expect(violet['editorCursor.foreground']).not.toBe(azure['editorCursor.foreground']);
    expect(violet['editor.background']).toBe(azure['editor.background']);
  });

  it('每个颜色键都是 hex —— Monaco 的 /vs 主题只接受 #rrggbb 与 #rrggbbaa', () => {
    // 实测(monaco-editor 0.56.0,在真实 Electron 渲染层里):主题 colors 的值喂
    // rgb() / rgba() / hsl() 都会抛 `Illegal value for token color`,其颜色映射只
    // 匹配 /^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/。这里把格式钉死,避免再退回函数式写法。
    for (const [key, value] of Object.entries(buildMonacoTheme(LIGHT_TOKENS).colors!)) {
      expect(value, key).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    }
  });

  it('带透明度的键用 8 位 hex 表达 alpha', () => {
    const colors = buildMonacoTheme(LIGHT_TOKENS).colors!;

    // 完全不透明 → 6 位;半透明 → 8 位
    expect(colors['editor.background']).toMatch(/^#[0-9a-f]{6}$/);
    expect(colors['editor.selectionBackground']).toMatch(/^#[0-9a-f]{8}$/);
    // alpha 0(用于把某些内置边框抹掉)必须是合法颜色,不能变成空串
    expect(colors['editor.lineHighlightBorder']).toMatch(/^#[0-9a-f]{8}$/);
    expect(colors['editor.lineHighlightBorder']).toMatch(/00$/);
  });
});
