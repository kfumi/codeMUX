import { describe, expect, it } from 'vitest';
import { createBurstyStreamSchedule, pumpBurstySchedule } from './burstyStreamSchedule';
import { coefficientOfVariation } from '../streamSmoothness';

describe('createBurstyStreamSchedule', () => {
  it('is deterministic for a given seed', () => {
    const a = createBurstyStreamSchedule({ seed: 42, totalMs: 3_000 });
    const b = createBurstyStreamSchedule({ seed: 42, totalMs: 3_000 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(10);
  });

  it('produces different streams for different seeds', () => {
    const a = createBurstyStreamSchedule({ seed: 1, totalMs: 3_000 });
    const b = createBurstyStreamSchedule({ seed: 2, totalMs: 3_000 });
    expect(a).not.toEqual(b);
  });

  it('is genuinely bursty, unlike a uniform distribution', () => {
    const schedule = createBurstyStreamSchedule({ seed: 7, totalMs: 20_000 });
    const sizes = schedule.map((chunk) => chunk.text.length);

    // A uniform distribution over the same range would sit near CV 0.57;
    // the cubed bias deliberately produces a much heavier tail.
    expect(coefficientOfVariation(sizes)).toBeGreaterThan(0.9);
    expect(Math.max(...sizes)).toBeGreaterThan(Math.min(...sizes) * 5);
  });

  it('emits monotonically increasing timestamps starting at zero', () => {
    const schedule = createBurstyStreamSchedule({ seed: 11, totalMs: 5_000 });
    expect(schedule[0].atMs).toBe(0);
    for (let index = 1; index < schedule.length; index += 1) {
      expect(schedule[index].atMs).toBeGreaterThan(schedule[index - 1].atMs);
    }
  });

  it('honours a custom alphabet', () => {
    const schedule = createBurstyStreamSchedule({ seed: 3, totalMs: 1_000, alphabet: 'ab' });
    for (const chunk of schedule) {
      expect(chunk.text).toMatch(/^[ab]+$/);
    }
  });

  it('stays within the configured duration', () => {
    const schedule = createBurstyStreamSchedule({ seed: 5, totalMs: 2_000 });
    expect(schedule[schedule.length - 1].atMs).toBeLessThan(2_000);
  });
});

describe('pumpBurstySchedule', () => {
  it('delivers every chunk in order and stops when the schedule is exhausted', () => {
    const schedule = [
      { atMs: 0, text: 'a' },
      { atMs: 10, text: 'b' },
      { atMs: 30, text: 'c' },
    ];
    const delivered: string[] = [];
    let clock = 0;
    const timers: Array<{ at: number; callback: () => void }> = [];

    const cancel = pumpBurstySchedule(schedule, (text) => delivered.push(text), {
      now: () => clock,
      setTimer: (callback, delayMs) => {
        const at = clock + delayMs;
        timers.push({ at, callback });
        return timers.length;
      },
      clearTimer: () => {},
    });

    while (timers.length > 0) {
      const next = timers.shift()!;
      clock = next.at;
      next.callback();
    }

    expect(delivered).toEqual(['a', 'b', 'c']);
    cancel();
  });

  it('stops delivering after cancellation', () => {
    const schedule = [
      { atMs: 0, text: 'a' },
      { atMs: 50, text: 'b' },
      { atMs: 100, text: 'c' },
    ];
    const delivered: string[] = [];
    let clock = 0;
    const timers: Array<{ at: number; callback: () => void }> = [];

    const cancel = pumpBurstySchedule(schedule, (text) => delivered.push(text), {
      now: () => clock,
      setTimer: (callback, delayMs) => {
        timers.push({ at: clock + delayMs, callback });
        return timers.length;
      },
      clearTimer: () => {},
    });

    // 先只跑到第一批，然后取消。
    const first = timers.shift()!;
    clock = first.at;
    first.callback();
    expect(delivered).toEqual(['a']);

    cancel();

    // 把剩余已排的定时器全部触发 —— 取消之后不应再有任何投递。
    while (timers.length > 0) {
      const next = timers.shift()!;
      clock = next.at;
      next.callback();
    }
    expect(delivered).toEqual(['a']);
  });
});
