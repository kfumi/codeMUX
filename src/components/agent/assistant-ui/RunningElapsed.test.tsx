// @vitest-environment jsdom

import { act, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunningElapsedTimer, formatElapsed } from './RunningElapsed';

describe('formatElapsed', () => {
  it('formats seconds when under a minute', () => {
    expect(formatElapsed(10_000)).toBe('10s');
    expect(formatElapsed(30_000)).toBe('30s');
  });

  it('formats minutes and seconds when under an hour', () => {
    expect(formatElapsed(70_000)).toBe('1m 10s');
    expect(formatElapsed(80_000)).toBe('1m 20s');
  });

  it('formats the two largest units when under a day', () => {
    expect(formatElapsed(4_810_000)).toBe('1h 20m');
  });

  it('can widen to three units so the turn header keeps the seconds', () => {
    // 整轮「已处理 2h 32m 14s」标题要看得见秒：默认两档会把秒截掉。
    expect(formatElapsed(9_134_000, { maxParts: 3 })).toBe('2h 32m 14s');
    expect(formatElapsed(1_172_000, { maxParts: 3 })).toBe('19m 32s');
    expect(formatElapsed(123_010_000, { maxParts: 3 })).toBe('1d 10h 10m');
  });

  it('formats the two largest units when over a day', () => {
    expect(formatElapsed(123_010_000)).toBe('1d 10h');
  });

  it('clamps negative values to zero', () => {
    expect(formatElapsed(-500)).toBe('0s');
  });
});

describe('RunningElapsedTimer', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows a live execution timer while running', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

    render(<RunningElapsedTimer />);

    expect(screen.getAllByText('正在执行 · 0s').length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getAllByText('正在执行 · 30s').length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(screen.getAllByText('正在执行 · 1m 10s').length).toBeGreaterThan(0);
  });
  it('空 label 只渲染时长，不留下孤立的分隔符', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

    render(<RunningElapsedTimer label="" startTime={Date.now() - 90_000} active={false} />);

    expect(screen.getByText('1m 30s')).toBeTruthy();
    expect(screen.queryByText(/·/)).toBeNull();
  });
});
