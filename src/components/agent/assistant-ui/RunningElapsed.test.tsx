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
});
