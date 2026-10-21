// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OverflowMarqueeText } from './overflow-marquee-text';

const resizeObserverState = vi.hoisted(() => ({
  callback: null as ResizeObserverCallback | null,
}));
const cancelAnimation = vi.fn();
const animateTrack = vi.fn(() => ({ cancel: cancelAnimation }) as unknown as Animation);
const originalAnimateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverState.callback = callback;
  }

  observe() {}

  unobserve() {}

  disconnect() {}
}

function setTitleWidths({ clientWidth, contentWidth }: { clientWidth: number; contentWidth: number }) {
  const title = screen.getByTestId('overflow-marquee-text');
  const original = title.querySelector('[data-marquee-copy="original"]');
  Object.defineProperty(title, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(original, 'scrollWidth', { configurable: true, value: contentWidth });
}

function notifyResize() {
  act(() => {
    resizeObserverState.callback?.([], {} as ResizeObserver);
  });
}

beforeEach(() => {
  resizeObserverState.callback = null;
  animateTrack.mockClear();
  cancelAnimation.mockClear();
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: animateTrack,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalAnimateDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimateDescriptor);
  } else {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  }
});

describe('OverflowMarqueeText', () => {
  it('drops the native title tooltip that would cover the marquee', () => {
    render(
      <OverflowMarqueeText data-testid="overflow-marquee-text" title="完整会话标题">
        很长的会话标题
      </OverflowMarqueeText>,
    );

    expect(screen.getByTestId('overflow-marquee-text').getAttribute('title')).toBeNull();
  });

  it('starts the marquee after one second of hovering and pauses at the aligned copy', () => {
    vi.useFakeTimers();
    render(
      <div data-marquee-hover-target="true" data-testid="session-row">
        <OverflowMarqueeText data-testid="overflow-marquee-text">很长的会话标题</OverflowMarqueeText>
      </div>,
    );
    setTitleWidths({ clientWidth: 120, contentWidth: 240 });
    notifyResize();

    const row = screen.getByTestId('session-row');
    fireEvent.mouseEnter(row);

    expect(animateTrack).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(999));
    expect(animateTrack).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));

    expect(animateTrack).toHaveBeenCalledTimes(2);
    expect(animateTrack.mock.calls[0]?.[0]).toEqual([
      { offset: 0, transform: 'translate3d(0, 0, 0)' },
      { offset: 6.6 / 8.6, transform: 'translate3d(-264px, 0, 0)' },
      { offset: 1, transform: 'translate3d(-264px, 0, 0)' },
    ]);
    expect(animateTrack.mock.calls[0]?.[1]).toEqual({
      duration: 8_600,
      easing: 'linear',
      iterations: Infinity,
    });

    fireEvent.mouseLeave(row);
    expect(cancelAnimation).toHaveBeenCalledTimes(2);
  });

  it('cancels the delayed start when hover ends early', () => {
    vi.useFakeTimers();
    render(
      <div data-marquee-hover-target="true" data-testid="session-row">
        <OverflowMarqueeText data-testid="overflow-marquee-text">很长的会话标题</OverflowMarqueeText>
      </div>,
    );
    setTitleWidths({ clientWidth: 120, contentWidth: 240 });
    notifyResize();

    const row = screen.getByTestId('session-row');
    fireEvent.mouseEnter(row);
    act(() => vi.advanceTimersByTime(300));
    fireEvent.mouseLeave(row);
    act(() => vi.advanceTimersByTime(1_000));

    expect(animateTrack).not.toHaveBeenCalled();
  });

  it('keeps short titles untouched without a fade mask or duplicate copy', () => {
    render(<OverflowMarqueeText data-testid="overflow-marquee-text">短标题</OverflowMarqueeText>);
    setTitleWidths({ clientWidth: 160, contentWidth: 120 });
    notifyResize();

    const title = screen.getByTestId('overflow-marquee-text');
    expect(title.className).not.toContain('mask-image');
    expect(title.querySelectorAll('[data-marquee-copy]')).toHaveLength(1);
  });

  it('renders an aria-hidden duplicate only while the title overflows', () => {
    render(<OverflowMarqueeText data-testid="overflow-marquee-text">很长的会话标题</OverflowMarqueeText>);
    setTitleWidths({ clientWidth: 120, contentWidth: 240 });
    notifyResize();

    const title = screen.getByTestId('overflow-marquee-text');
    expect(title.className).toContain('mask-image:linear-gradient');
    expect(title.querySelectorAll('[data-marquee-copy]')).toHaveLength(2);
    expect(title.querySelector('[data-marquee-copy="duplicate"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(title.querySelector('[data-marquee-track]')).not.toBeNull();

    setTitleWidths({ clientWidth: 240, contentWidth: 240 });
    notifyResize();

    expect(title.className).not.toContain('mask-image');
    expect(title.querySelectorAll('[data-marquee-copy]')).toHaveLength(1);
  });
});
