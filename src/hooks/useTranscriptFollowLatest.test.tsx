// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

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

describe('useTranscriptFollowLatest', () => {
  afterEach(() => {
    cleanup();
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
});
