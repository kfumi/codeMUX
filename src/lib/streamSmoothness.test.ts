import { beforeEach, describe, expect, it } from 'vitest';
import {
  coefficientOfVariation,
  percentile,
  readAndResetSmoothness,
  recordRevealFrame,
  resetSmoothness,
} from './streamSmoothness';

describe('coefficientOfVariation', () => {
  it('is zero for a constant series', () => {
    expect(coefficientOfVariation([5, 5, 5, 5])).toBe(0);
  });

  it('is zero for an empty series rather than NaN', () => {
    expect(coefficientOfVariation([])).toBe(0);
  });

  it('is zero for an all-stalled window, which is why updatesPerSecond exists', () => {
    // 完全停顿的流是"完美平滑"的 —— 变异系数无法识别它。
    expect(coefficientOfVariation([0, 0, 0, 0])).toBe(0);
  });

  it('grows with spread', () => {
    const tight = coefficientOfVariation([100, 100, 100, 100, 0]);
    const loose = coefficientOfVariation([100, 0, 0, 0, 0]);
    expect(loose).toBeGreaterThan(tight);
  });
});

describe('percentile', () => {
  it('returns zero for an empty series', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('picks by nearest rank', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 100)).toBe(100);
  });
});

describe('windowed sampling', () => {
  beforeEach(() => {
    resetSmoothness();
  });

  it('reports an even commit stream as CV 0 with a stable interval', () => {
    for (let update = 0; update < 25; update += 1) {
      recordRevealFrame(7, update * 40);
    }

    const snapshot = readAndResetSmoothness(25 * 40);

    expect(snapshot.sampledFrames).toBe(25);
    expect(snapshot.visibleUpdates).toBe(25);
    expect(snapshot.charsPerUpdateCv).toBe(0);
    expect(snapshot.updateIntervalP50).toBe(40);
    expect(snapshot.updateIntervalP95).toBe(40);
    expect(snapshot.updatesPerSecond).toBeCloseTo(25, 1);
    expect(snapshot.charsPerSecond).toBeGreaterThan(150);
  });

  it('exposes a stalled stream through updatesPerSecond, not through CV', () => {
    for (let frame = 0; frame < 60; frame += 1) {
      recordRevealFrame(0, frame * 16);
    }

    const snapshot = readAndResetSmoothness(60 * 16);

    expect(snapshot.charsPerUpdateCv).toBe(0);
    expect(snapshot.visibleUpdates).toBe(0);
    expect(snapshot.updatesPerSecond).toBe(0);
  });

  it('ignores throttled frames so the CV measures visible updates only', () => {
    // Throttled commits (0) must not be treated as stalled visible updates —
    // mixing them in would inflate the CV and report a healthy stream as jagged.
    let now = 0;
    for (let update = 0; update < 20; update += 1) {
      recordRevealFrame(0, now); // skipped frame
      now += 16;
      recordRevealFrame(0, now); // skipped frame
      now += 16;
      recordRevealFrame(6, now); // committed update
      now += 8;
    }

    const snapshot = readAndResetSmoothness(now);

    expect(snapshot.visibleUpdates).toBe(20);
    expect(snapshot.charsPerUpdateCv).toBe(0);
    expect(snapshot.updateIntervalP50).toBe(40);
  });

  it('reports uneven visible updates as a high CV', () => {
    let now = 0;
    const sizes = [2, 40, 3, 60, 2, 80, 3, 90];
    for (const size of sizes) {
      recordRevealFrame(size, now);
      now += 40;
    }

    const snapshot = readAndResetSmoothness(now);

    expect(snapshot.visibleUpdates).toBe(sizes.length);
    expect(snapshot.charsPerUpdateCv).toBeGreaterThan(0.8);
  });

  it('bounds the sample buffers so an unmounted overlay cannot leak', () => {
    for (let update = 0; update < 3_000; update += 1) {
      recordRevealFrame(1, update * 16);
    }

    const snapshot = readAndResetSmoothness(3_000 * 16);

    // MAX_SAMPLES is 2048; the window must not grow without bound.
    expect(snapshot.visibleUpdates).toBeLessThanOrEqual(2048);
  });

  it('empties the window on read', () => {
    recordRevealFrame(5, 0);
    readAndResetSmoothness(16);
    expect(readAndResetSmoothness(32).sampledFrames).toBe(0);
  });
});
