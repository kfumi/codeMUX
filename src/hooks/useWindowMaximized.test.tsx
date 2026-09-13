// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 桩在 vi.hoisted 里注入:`desktop-bridge` 在模块求值时就抓 `window.codemuxDesktop`,
 * 必须在它被导入之前写好,否则 hook 只会看到「没有壳桥」。
 */
const bridge = vi.hoisted(() => {
  const listeners = new Set<(payload: unknown) => void>();
  const api = {
    isWindowMaximized: vi.fn(async () => false),
    onDesktopEvent: vi.fn((_name: string, callback: (payload: unknown) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    emit(payload: unknown) {
      for (const listener of listeners) listener(payload);
    },
  };
  (globalThis as unknown as { codemuxDesktop?: unknown }).codemuxDesktop = api;
  return api;
});

import { useWindowMaximized } from './useWindowMaximized';

afterEach(() => {
  cleanup();
  bridge.isWindowMaximized.mockReset();
  bridge.isWindowMaximized.mockImplementation(async () => false);
  bridge.onDesktopEvent.mockClear();
  bridge.emit(undefined);
});

describe('useWindowMaximized', () => {
  it('reads the current window state from the shell bridge', async () => {
    bridge.isWindowMaximized.mockImplementation(async () => true);

    const { result } = renderHook(() => useWindowMaximized());

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('follows maximize changes pushed by the shell', async () => {
    const { result } = renderHook(() => useWindowMaximized());

    await waitFor(() => expect(bridge.isWindowMaximized).toHaveBeenCalled());
    expect(result.current).toBe(false);

    act(() => bridge.emit(true));
    expect(result.current).toBe(true);

    act(() => bridge.emit(false));
    expect(result.current).toBe(false);
  });
});
