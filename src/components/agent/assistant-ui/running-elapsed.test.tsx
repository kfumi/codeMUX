// @vitest-environment jsdom

import { act, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunningElapsedTimer, formatElapsed } from './running-elapsed';

describe('formatElapsed', () => {
  it('formats seconds and minutes like the legacy timer', () => {
    expect(formatElapsed(30_000)).toBe('30s');
    expect(formatElapsed(70_000)).toBe('1m10s');
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

    expect(screen.getByText('Agent 执行中 · 0s')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Agent 执行中 · 30s')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(screen.getByText('Agent 执行中 · 1m10s')).toBeTruthy();
  });
});
