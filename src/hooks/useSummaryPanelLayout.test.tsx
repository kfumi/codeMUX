// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSummaryPanelLayout } from './useSummaryPanelLayout';
import { useSummaryPanelStore } from '../stores/summaryPanelStore';
import type { RefObject } from 'react';

/** jsdom 不排版，量不到宽度 —— 给对话列按一个假的 clientWidth。 */
function paneWithWidth(width: number): HTMLDivElement {
  const pane = document.createElement('div');
  Object.defineProperty(pane, 'clientWidth', { value: width, configurable: true });
  return pane;
}

describe('useSummaryPanelLayout', () => {
  beforeEach(() => {
    useSummaryPanelStore.getState().reset();
    // `--content-width` 在 jsdom 里读不到真值，直接给一份计算样式。
    vi.spyOn(window, 'getComputedStyle').mockImplementation((() => ({
      getPropertyValue: (name: string) => (name === '--content-width' ? '48rem' : ''),
      fontSize: '16px',
    })) as unknown as typeof window.getComputedStyle);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载即量一次，把宽度与正文列宽写进 store', async () => {
    const pane = paneWithWidth(1600);
    renderHook(() => useSummaryPanelLayout({ current: pane }));

    await waitFor(() => expect(useSummaryPanelStore.getState().availableWidth).toBe(1600));
    expect(useSummaryPanelStore.getState().contentWidth).toBe(768);
  });

  it('首帧量到 0（样式还没生效）时不动 store，次帧再补一次', async () => {
    const pane = paneWithWidth(0);
    const ref: RefObject<HTMLElement | null> = { current: pane };
    renderHook(() => useSummaryPanelLayout(ref));

    expect(useSummaryPanelStore.getState().availableWidth).toBeNull();

    // 样式到位、宽度出现 —— 补测那一拍应当把它写进去。
    Object.defineProperty(pane, 'clientWidth', { value: 1400, configurable: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    await waitFor(() => expect(useSummaryPanelStore.getState().availableWidth).toBe(1400));
  });

  it('窗口尺寸变化时补量一次', async () => {
    const pane = paneWithWidth(1200);
    renderHook(() => useSummaryPanelLayout({ current: pane }));
    await waitFor(() => expect(useSummaryPanelStore.getState().availableWidth).toBe(1200));

    Object.defineProperty(pane, 'clientWidth', { value: 1000, configurable: true });
    window.dispatchEvent(new Event('resize'));

    await waitFor(() => expect(useSummaryPanelStore.getState().availableWidth).toBe(1000));
  });

  it('ResizeObserver 回调也走同一条写路径', async () => {
    let notify: (() => void) | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe = observe;
      disconnect = disconnect;
    });

    const pane = paneWithWidth(1200);
    const { unmount } = renderHook(() => useSummaryPanelLayout({ current: pane }));
    expect(observe).toHaveBeenCalledWith(pane);

    Object.defineProperty(pane, 'clientWidth', { value: 1900, configurable: true });
    notify?.();
    await waitFor(() => expect(useSummaryPanelStore.getState().availableWidth).toBe(1900));

    unmount();
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('正文铺满（--content-width 解析不出来）时按「没有空槽」算', async () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation((() => ({
      getPropertyValue: () => '100%',
      fontSize: '16px',
    })) as unknown as typeof window.getComputedStyle);

    const pane = paneWithWidth(1700);
    renderHook(() => useSummaryPanelLayout({ current: pane }));

    await waitFor(() => expect(useSummaryPanelStore.getState().availableWidth).toBe(1700));
    expect(useSummaryPanelStore.getState().contentWidth).toBe(1700);
  });

  it('对话列卸载后清掉测量值，但不动用户的「钉住」', async () => {
    useSummaryPanelStore.setState({ isPinned: true });
    const pane = paneWithWidth(1600);
    const { unmount } = renderHook(() => useSummaryPanelLayout({ current: pane }));
    await waitFor(() => expect(useSummaryPanelStore.getState().availableWidth).toBe(1600));

    unmount();

    expect(useSummaryPanelStore.getState().availableWidth).toBeNull();
    expect(useSummaryPanelStore.getState().isPinned).toBe(true);
  });
});
