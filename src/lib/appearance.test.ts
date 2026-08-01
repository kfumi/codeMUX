// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFS,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  applyAppearance,
  clampUiFontSize,
  loadPrefs,
} from './appearance';

describe('appearance preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('style');
  });

  it('loads valid preferences and migrates the legacy font size', () => {
    window.localStorage.setItem(
      'codemux:appearance',
      JSON.stringify({ accent: 'cyan', fontSize: 'comfortable', radius: 'sharp', contentWidth: 'stream' }),
    );

    expect(loadPrefs()).toEqual({
      ...DEFAULT_PREFS,
      accent: 'cyan',
      uiFontSize: 16,
      radius: 'sharp',
      contentWidth: 'stream',
    });
  });

  it('falls back from invalid values and clamps numeric sizes', () => {
    window.localStorage.setItem(
      'codemux:appearance',
      JSON.stringify({ accent: 'unknown', uiFont: 'unknown', uiFontSize: 99, radius: null, contentWidth: 1 }),
    );

    expect(loadPrefs()).toEqual({ ...DEFAULT_PREFS, uiFontSize: UI_FONT_SIZE_MAX });
    expect(clampUiFontSize(Number.NaN)).toBe(DEFAULT_PREFS.uiFontSize);
    expect(clampUiFontSize(UI_FONT_SIZE_MIN - 4.4)).toBe(UI_FONT_SIZE_MIN);
    expect(clampUiFontSize(UI_FONT_SIZE_MAX + 4.4)).toBe(UI_FONT_SIZE_MAX);
    expect(clampUiFontSize(15.6)).toBe(16);
  });

  it('applies CSS variables without changing the root font size', () => {
    applyAppearance({ ...DEFAULT_PREFS, uiFont: 'ibm-plex-sans', uiFontSize: 18, accent: 'rose' }, false);

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--font-ui')).toContain('IBM Plex Sans Variable');
    expect(root.style.getPropertyValue('--ui-font-size')).toBe('18px');
    expect(root.style.getPropertyValue('--primary')).toBe('346 70% 50%');
    expect(root.style.fontSize).toBe('');
  });
});
