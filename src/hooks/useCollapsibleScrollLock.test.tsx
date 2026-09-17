// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';

import { useCollapsibleScrollLock } from './useCollapsibleScrollLock';

type LockFn = () => void;

/** jsdom 能读内联样式的 computed 值，故用内联 overflow 声明可滚动祖先。 */
function Harness({ capture }: { capture: (lock: LockFn) => void }) {
  const targetRef = useRef<HTMLDivElement>(null);
  const lock = useCollapsibleScrollLock(targetRef, 200);
  capture(lock);
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto', height: '100px' }}>
      <div ref={targetRef} style={{ height: '500px' }}>
        content
      </div>
    </div>
  );
}

function NoScrollableAncestorHarness({ capture }: { capture: (lock: LockFn) => void }) {
  const targetRef = useRef<HTMLDivElement>(null);
  const lock = useCollapsibleScrollLock(targetRef, 200);
  capture(lock);
  return (
    <div style={{ overflowY: 'visible' }}>
      <div ref={targetRef}>content</div>
    </div>
  );
}

function getScroller(): HTMLElement {
  return document.querySelector('[data-testid="scroller"]') as HTMLElement;
}

describe('useCollapsibleScrollLock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('锁定期间把 scrollTop 钉在锁定值，到期后恢复自由滚动', () => {
    let lock: LockFn = () => {};
    render(<Harness capture={(fn) => (lock = fn)} />);
    const scroller = getScroller();

    scroller.scrollTop = 50;
    lock();
    scroller.scrollTop = 90;
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.scrollTop).toBe(50);

    vi.advanceTimersByTime(200);
    scroller.scrollTop = 90;
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.scrollTop).toBe(90);
  });

  it('锁定期间与之后都不改写滚动容器的内联 scrollbar-width / padding（旧实现泄漏面回归）', () => {
    let lock: LockFn = () => {};
    render(<Harness capture={(fn) => (lock = fn)} />);
    const scroller = getScroller();

    lock();
    expect(scroller.style.scrollbarWidth).toBe('');
    expect(scroller.style.paddingRight).toBe('');

    vi.advanceTimersByTime(200);
    expect(scroller.style.scrollbarWidth).toBe('');
    expect(scroller.style.paddingRight).toBe('');
  });

  it('两个实例在同一滚动容器上重叠锁定，也不残留任何内联样式', () => {
    let lockA: LockFn = () => {};
    let lockB: LockFn = () => {};
    render(
      <>
        <Harness capture={(fn) => (lockA = fn)} />
        <Harness capture={(fn) => (lockB = fn)} />
      </>,
    );
    const scrollers = document.querySelectorAll('[data-testid="scroller"]');
    const scrollerA = scrollers[0] as HTMLElement;
    const scrollerB = scrollers[1] as HTMLElement;

    lockA();
    lockB();
    vi.advanceTimersByTime(200);

    for (const scroller of [scrollerA, scrollerB]) {
      expect(scroller.style.scrollbarWidth).toBe('');
      expect(scroller.style.paddingRight).toBe('');
    }
  });

  it('同一实例连续快速上锁（先清理再上锁）同样不残留', () => {
    let lock: LockFn = () => {};
    render(<Harness capture={(fn) => (lock = fn)} />);
    const scroller = getScroller();

    lock();
    lock();
    lock();
    vi.advanceTimersByTime(200);

    expect(scroller.style.scrollbarWidth).toBe('');
    expect(scroller.style.paddingRight).toBe('');
    // 多次上锁后只应剩一个定时器：再推进一段不会抛错，行为等同单个锁。
    vi.advanceTimersByTime(200);
  });

  it('没有可滚动祖先时是安全空操作', () => {
    let lock: LockFn = () => {};
    render(<NoScrollableAncestorHarness capture={(fn) => (lock = fn)} />);
    expect(() => lock()).not.toThrow();
    vi.advanceTimersByTime(200);
  });
});
