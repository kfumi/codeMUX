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

  it('persists and merges panel preferences', () => {
    updateLayoutPreferences({ sidebarWidth: 320 });
    updateLayoutPreferences({ sidebarRatio: 0.2 });
    updateLayoutPreferences({ sidePanelRatio: 0.3 });

    expect(readLayoutPreferences()).toEqual({
      sidebarWidth: 320,
      sidebarRatio: 0.2,
      sidePanelRatio: 0.3,
    });
  });

  it('ignores malformed and non-positive values', () => {
    localStorage.setItem(LAYOUT_PREFERENCES_STORAGE_KEY, JSON.stringify({
      sidebarWidth: -50,
      sidebarRatio: Number.NaN,
      sidePanelRatio: 0,
    }));

    expect(readLayoutPreferences()).toEqual({});
  });
});
