// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useTheme } from './useTheme';
import { useSettingsStore } from '../stores/settingsStore';
import { BOOT_BACKGROUND_DARK, BOOT_BACKGROUND_LIGHT, THEME_BOOT_STORAGE_KEY } from '../lib/themeBoot';

describe('useTheme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  it('applies the configured dark theme and caches it for the next launch', () => {
    // 回归用例：主题只在内存里生效时,首帧引导脚本读不到缓存,深色用户会闪一下白。
    useSettingsStore.setState({ config: { ...baseConfig, theme: 'Dark' } });

    renderHook(() => useTheme());

    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.getPropertyValue('--boot-bg')).toBe(BOOT_BACKGROUND_DARK);
    expect(window.localStorage.getItem(THEME_BOOT_STORAGE_KEY)).toBe('Dark');
  });

  it('drops the dark class and re-caches when the theme flips to light', () => {
    useSettingsStore.setState({ config: { ...baseConfig, theme: 'Dark' } });
    const { rerender } = renderHook(() => useTheme());
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      useSettingsStore.setState({ config: { ...baseConfig, theme: 'Light' } });
    });
    rerender();

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--boot-bg')).toBe(BOOT_BACKGROUND_LIGHT);
    expect(window.localStorage.getItem(THEME_BOOT_STORAGE_KEY)).toBe('Light');
  });

  it('re-applies when the OS preference changes while the theme is System', () => {
    let listener: ((event: MediaQueryListEvent) => void) | null = null;
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        get matches() {
          return query.includes('dark') && prefersDarkNow;
        },
        media: query,
        addEventListener: (_type: string, handler: (event: MediaQueryListEvent) => void) => {
          listener = handler;
        },
        removeEventListener: () => {},
      }),
      writable: true,
      configurable: true,
    });
    let prefersDarkNow = false;
    useSettingsStore.setState({ config: { ...baseConfig, theme: 'System' } });

    renderHook(() => useTheme());
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    prefersDarkNow = true;
    act(() => {
      listener?.({} as MediaQueryListEvent);
    });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_BOOT_STORAGE_KEY)).toBe('System');
  });
});

const baseConfig = {
  model_providers: [] as never[],
  active_provider_id: null,
  agent_defaults: { default_agent_kind: 'claude_code' as const },
  agent_configs: {
    claude_code: { executable_mode: 'auto' as const, resume_sessions: true },
    codex: {},
    gemini_cli: {},
    opencode: {},
  },
  theme: 'System' as const,
  compact_ai_output: false,
  default_open_target: 'file_explorer' as const,
};
