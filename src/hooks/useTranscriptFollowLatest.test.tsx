// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTranscriptFollowLatest } from './useTranscriptFollowLatest';

function Harness({ followKey, scrollHeight }: { followKey: string; scrollHeight: number }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { isAtBottom } = useTranscriptFollowLatest({ viewportRef, followKey });
  return (
    <div
      ref={viewportRef}
      data-testid="viewport"
      data-at-bottom={isAtBottom ? 'true' : 'false'}
      style={{ height: 100, overflowY: 'scroll' }}
    >
      <div style={{ height: scrollHeight }} />
    </div>
  );
}

function setScrollHeight(viewport: HTMLElement, value: number) {
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value });
}

/** jsdom 没有 ResizeObserver，用可手动触发的替身来精确控制"内容尺寸变化"时机。 */
class ControllableResizeObserver {
  static instances: ControllableResizeObserver[] = [];

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControllableResizeObserver.instances.push(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function latestResizeObserver(): ControllableResizeObserver {
  const observer = ControllableResizeObserver.instances.at(-1);
  if (!observer) {
    throw new Error('ResizeObserver was not attached');
  }
  return observer;
}

describe('useTranscriptFollowLatest', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    ControllableResizeObserver.instances = [];
  });

  it('followKey 变化时自动跟随到新的底部', async () => {
    const { rerender, getByTestId } = render(
      <Harness followKey="v1" scrollHeight={100} />,
    );
    const viewport = getByTestId('viewport');
    setScrollHeight(viewport, 100);
    await waitFor(() => {
      expect(viewport.getAttribute('data-at-bottom')).toBe('true');
    });

    // 内容长高（如子智能体状态行出现）且 followKey 变化 → 跟随到底。
    setScrollHeight(viewport, 500);
    rerender(<Harness followKey="v2" scrollHeight={500} />);

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(500);
    });
    expect(viewport.getAttribute('data-at-bottom')).toBe('true');
  });

  it('用户向上滚动后，followKey 变化不抢滚动控制权', async () => {
    const { rerender, getByTestId } = render(
      <Harness followKey="v1" scrollHeight={500} />,
    );
    const viewport = getByTestId('viewport');
    setScrollHeight(viewport, 500);
    await waitFor(() => {
      expect(viewport.scrollTop).toBe(500);
    });

    // 用户上翻：scrollTop 减小且内容高度未变。
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event('scroll'));
    await waitFor(() => {
      expect(viewport.getAttribute('data-at-bottom')).toBe('false');
    });

    setScrollHeight(viewport, 800);
    act(() => {
      rerender(<Harness followKey="v2" scrollHeight={800} />);
    });
    await waitFor(() => {
      expect(viewport.scrollTop).toBe(100);
    });
    expect(viewport.getAttribute('data-at-bottom')).toBe('false');
  });

  it('内容长高但 followKey 未变时仍然钉底（不再依赖 key 抢帧）', async () => {
    vi.stubGlobal('ResizeObserver', ControllableResizeObserver);
    const { getByTestId } = render(<Harness followKey="v1" scrollHeight={100} />);
    const viewport = getByTestId('viewport');
    setScrollHeight(viewport, 100);

    act(() => {
      latestResizeObserver().trigger();
    });
    await waitFor(() => {
      expect(viewport.scrollTop).toBe(100);
    });

    // assistant-ui 二次提交 / 折叠动画 / 图片解码等：高度增长，key 不变。
    setScrollHeight(viewport, 620);
    act(() => {
      latestResizeObserver().trigger();
    });

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(620);
    });
    expect(viewport.getAttribute('data-at-bottom')).toBe('true');
  });

  it('用户上滚后内容长高不抢回滚动位置', async () => {
    vi.stubGlobal('ResizeObserver', ControllableResizeObserver);
    const { getByTestId } = render(<Harness followKey="v1" scrollHeight={500} />);
    const viewport = getByTestId('viewport');
    setScrollHeight(viewport, 500);

    act(() => {
      latestResizeObserver().trigger();
    });
    await waitFor(() => {
      expect(viewport.scrollTop).toBe(500);
    });

    viewport.scrollTop = 120;
    viewport.dispatchEvent(new Event('scroll'));
    await waitFor(() => {
      expect(viewport.getAttribute('data-at-bottom')).toBe('false');
    });

    setScrollHeight(viewport, 900);
    act(() => {
      latestResizeObserver().trigger();
    });

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(120);
    });
    expect(viewport.getAttribute('data-at-bottom')).toBe('false');
  });

  it('DOM/文本变化（无尺寸回调）也会重新钉底', async () => {
    const { getByTestId } = render(<Harness followKey="v1" scrollHeight={100} />);
    const viewport = getByTestId('viewport');
    setScrollHeight(viewport, 100);

    await act(async () => {
      viewport.appendChild(document.createElement('div'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(viewport.scrollTop).toBe(100);
    });

    // 流式文本追加：只动 DOM，不触发 ResizeObserver。
    setScrollHeight(viewport, 480);
    await act(async () => {
      viewport.lastElementChild?.appendChild(document.createTextNode('streaming chunk'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(480);
    });
    expect(viewport.getAttribute('data-at-bottom')).toBe('true');
  });
});
