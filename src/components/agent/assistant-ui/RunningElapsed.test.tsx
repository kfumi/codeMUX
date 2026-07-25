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
    expect(formatElapsed(70_000)).toBe('1m10s');
    expect(formatElapsed(80_000)).toBe('1m20s');
  });

  it('formats hours, minutes, seconds when under a day', () => {
    // 1h 20m 10s = 4810s
    expect(formatElapsed(4_810_000)).toBe('1h20m10s');
  });

  it('formats days, hours, minutes, seconds when over a day', () => {
    // 1d 10h 10m 10s = 86400 + 36000 + 600 + 10 = 123010s
    expect(formatElapsed(123_010_000)).toBe('1d10h10m10s');
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

    expect(screen.getAllByText('思考中 · 0s').length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getAllByText('思考中 · 30s').length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(screen.getAllByText('思考中 · 1m10s').length).toBeGreaterThan(0);
  });
});
