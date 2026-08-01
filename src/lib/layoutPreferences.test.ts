// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  LAYOUT_PREFERENCES_STORAGE_KEY,
  readLayoutPreferences,
  updateLayoutPreferences,
} from './layoutPreferences';

describe('layout preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists and merges window and panel preferences', () => {
    updateLayoutPreferences({ windowWidth: 1440, sidebarRatio: 0.2 });
    updateLayoutPreferences({ windowHeight: 900, sidePanelRatio: 0.3 });

    expect(readLayoutPreferences()).toEqual({
      windowWidth: 1440,
      windowHeight: 900,
      sidebarRatio: 0.2,
      sidePanelRatio: 0.3,
    });
  });

  it('ignores malformed and non-positive values', () => {
    localStorage.setItem(LAYOUT_PREFERENCES_STORAGE_KEY, JSON.stringify({
      windowWidth: -1,
      windowHeight: '900',
      sidebarRatio: Number.NaN,
      sidePanelRatio: 0,
    }));

    expect(readLayoutPreferences()).toEqual({});
  });
});
