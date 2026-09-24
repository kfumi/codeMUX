import { describe, expect, it } from 'vitest';

import { estimateOutputTokens, TokenSpeedTracker } from './tokenSpeed';

describe('estimateOutputTokens', () => {
  it('ignores whitespace and estimates English at four characters per token', () => {
    expect(estimateOutputTokens('  hello\nworld\t')).toBe(2.5);
  });

  it('estimates CJK, kana, Hangul, full-width forms, and astral characters densely', () => {
    expect(estimateOutputTokens('中文日本語한국Ａ，。🙂')).toBe(11 / 1.8);
  });

  it('handles astral characters as one character', () => {
    expect(estimateOutputTokens('🙂🙂')).toBe(2 / 1.8);
  });
});

describe('TokenSpeedTracker', () => {
  it('reports a constant rate after warmup', () => {
    const tracker = new TokenSpeedTracker();
    expect(tracker.update(0, 0)).toBeNull();
    expect(tracker.update(100, 1000)).toBeCloseTo(100);
  });

  it('withholds a reading until it covers a meaningful wall-clock window', () => {
    const tracker = new TokenSpeedTracker();
    tracker.update(0, 0);
    expect(tracker.update(5, 100)).toBeNull();
    expect(tracker.update(10, 200)).toBeNull();
    expect(tracker.update(15, 300)).toBeCloseTo(50);
  });

  it('opens near the real rate when the stream commits only every 16ms', () => {
    const tracker = new TokenSpeedTracker();
    const rate = 60;
    let produced = 0;
    let committed = 0;
    let first: number | null = null;
    for (let now = 0; now <= 3000; now += 4) {
      produced += rate * 0.004;
      if (now % 16 === 0) committed = produced;
      const reading = tracker.update(committed, now);
      if (reading != null && first == null) first = reading;
    }
    expect(first).not.toBeNull();
    expect(first as number).toBeGreaterThan(rate * 0.85);
    expect(first as number).toBeLessThan(rate * 1.15);
  });

  it('smooths a burst followed by silence and decays toward zero', () => {
    const tracker = new TokenSpeedTracker();
    tracker.update(0, 0);
    tracker.update(200, 1000);
    const rate = tracker.update(200, 2000);
    expect(rate).toBeGreaterThan(0);
    expect(rate as number).toBeLessThan(200);
    expect(tracker.update(200, 10_000)).toBeLessThan(1);
  });
  it('ignores non-positive time deltas and clamps spikes', () => {
    const tracker = new TokenSpeedTracker();
    expect(tracker.update(0, 0)).toBeNull();
    const warm = tracker.update(100, 1000);
    expect(warm).toBeCloseTo(100);
    expect(tracker.update(100, 1000)).toBeCloseTo(warm as number);
    expect(tracker.update(100, 500)).toBeCloseTo(warm as number);

    const spike = new TokenSpeedTracker();
    spike.update(0, 0);
    expect(spike.update(100_000, 300)).toBe(999.9);
  });

  it('reports the current warm reading again for a non-positive delta', () => {
    const tracker = new TokenSpeedTracker();
    tracker.update(0, 0);
    const warm = tracker.update(100, 1000);
    expect(tracker.update(100, 1000)).toBeCloseTo(warm as number);
  });

  it('resets to a fresh baseline', () => {
    const tracker = new TokenSpeedTracker();
    tracker.update(0, 0);
    tracker.update(100, 1000);
    tracker.reset();
    expect(tracker.update(0, 2000)).toBeNull();
  });
});
