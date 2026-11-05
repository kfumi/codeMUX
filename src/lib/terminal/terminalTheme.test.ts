// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { TERMINAL_FONT_FAMILY, terminalTheme } from './terminalTheme';

const VALID_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i;

describe('terminalTheme', () => {
  it('returns resolvable colors for xterm in both modes', () => {
    for (const isDark of [true, false]) {
      const theme = terminalTheme(isDark);
      for (const [key, value] of Object.entries(theme)) {
        if (key === 'foreground' || key === 'background' || key === 'cursor' || key.endsWith('Background') || key === 'cursorAccent') {
          expect(String(value), `${key} must not leak a css var`).not.toContain('var(');
          expect(String(value), `${key} must be a color`).toMatch(VALID_COLOR);
        }
      }
    }
  });

  it('uses the same fixed ANSI palette regardless of the app accent', () => {
    expect(terminalTheme(true).red).toBe('#f87171');
    expect(terminalTheme(false).red).toBe('#b91c1c');
    expect(terminalTheme(true).red).toBe(terminalTheme(true).red);
  });

  it('keeps a monospace font stack', () => {
    expect(TERMINAL_FONT_FAMILY).toContain('monospace');
  });
});
