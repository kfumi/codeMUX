// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MOBILE_VIEWPORT_MAX_WIDTH } from '@/lib/host/host-form';

import { NARROW_VIEWPORT_QUERY, useIsNarrowViewport } from './useIsNarrowViewport';

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setViewportWidth(1024);
});

describe('useIsNarrowViewport', () => {
  it('uses the same threshold as the mobile host form', () => {
    expect(NARROW_VIEWPORT_QUERY).toBe(`(max-width: ${MOBILE_VIEWPORT_MAX_WIDTH}px)`);
  });

  it('falls back to viewport width when matchMedia is unavailable', () => {
    // jsdom 默认没有 matchMedia:实现必须仍能在窄屏下给出正确结果。
    Object.defineProperty(window, 'matchMedia', { value: undefined, writable: true, configurable: true });
    setViewportWidth(420);

    const { result } = renderHook(() => useIsNarrowViewport());
    expect(result.current).toBe(true);
  });

  it('reacts to viewport resize without matchMedia', () => {
    Object.defineProperty(window, 'matchMedia', { value: undefined, writable: true, configurable: true });
    setViewportWidth(1280);

    const { result } = renderHook(() => useIsNarrowViewport());
    expect(result.current).toBe(false);

    act(() => {
      setViewportWidth(600);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(true);
  });

  it('subscribes to the matching media query when available', () => {
    let listener: ((event: MediaQueryListEvent) => void) | null = null;
    const removeEventListener = vi.fn();
    const matchMedia = vi.fn((query: string) => ({
      matches: query === NARROW_VIEWPORT_QUERY,
      media: query,
      addEventListener: (_type: string, handler: (event: MediaQueryListEvent) => void) => {
        listener = handler;
      },
      removeEventListener,
    }));
    Object.defineProperty(window, 'matchMedia', { value: matchMedia, writable: true, configurable: true });

    const { result, unmount } = renderHook(() => useIsNarrowViewport());
    expect(matchMedia).toHaveBeenCalledWith(NARROW_VIEWPORT_QUERY);
    expect(result.current).toBe(true);

    act(() => {
      listener?.({ matches: false } as MediaQueryListEvent);
    });
    expect(result.current).toBe(false);

    unmount();
    expect(removeEventListener).toHaveBeenCalled();
  });
});
