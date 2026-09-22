// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useRefreshOnVisible } from './useRefreshOnVisible';

/**
 * 这个 hook 是「保留 Electron 默认的窗口节流」这一决定的配套件。
 *
 * 节流只推迟刷新时机，不会算错值；但用户切回来的第一眼会看到旧数字，
 * 报告出来就是「计时器卡住」。所以恢复可见时必须在那一帧补一次。
 */

let hidden = false;

function setHidden(value: boolean): void {
  hidden = value;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
}

function Probe({ onRefresh }: { onRefresh: () => void }) {
  useRefreshOnVisible(onRefresh);
  return <span>probe</span>;
}

describe('useRefreshOnVisible', () => {
  afterEach(() => {
    cleanup();
    hidden = false;
  });

  it('refreshes once the document becomes visible again', () => {
    setHidden(true);
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);

    // 隐藏期间不补刷：没人看，重算没有意义。
    setHidden(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(onRefresh).not.toHaveBeenCalled();

    setHidden(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes on window focus while visible', () => {
    setHidden(false);
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on focus while hidden', () => {
    setHidden(true);
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('always calls the latest callback', () => {
    setHidden(false);
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe onRefresh={first} />);

    rerender(<Probe onRefresh={second} />);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('detaches its listeners on unmount', () => {
    setHidden(false);
    const onRefresh = vi.fn();
    const { unmount } = render(<Probe onRefresh={onRefresh} />);

    unmount();
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
