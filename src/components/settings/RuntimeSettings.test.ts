import { describe, expect, it } from 'vitest';

import { formatCheckedAt, formatElapsed, knownNumber } from './RuntimeSettings';

describe('formatCheckedAt', () => {
  it('formats legacy Unix-second timestamps instead of displaying the raw number', () => {
    const timestamp = '1786019897';
    expect(formatCheckedAt(timestamp)).toBe(new Date(Number(timestamp) * 1000).toLocaleString());
    expect(formatCheckedAt(timestamp)).not.toBe(timestamp);
  });

  it('keeps RFC3339 timestamps readable', () => {
    const timestamp = '2026-08-06T20:00:00+08:00';
    expect(formatCheckedAt(timestamp)).toBe(new Date(timestamp).toLocaleString());
  });
});

describe('knownNumber', () => {
  it('treats a missing field (undefined) as unknown', () => {
    expect(knownNumber(undefined)).toBeNull();
  });

  it('treats a null from an older daemon as unknown rather than zero', () => {
    // 回归：`null` 曾经穿过 `!== undefined` 守卫，被 `?? 0` 渲染成一个假的 0%，
    // 字节行则被 formatBytes 插值成 "null B / null B"。
    expect(knownNumber(null)).toBeNull();
  });

  it('rejects NaN and Infinity', () => {
    expect(knownNumber(Number.NaN)).toBeNull();
    expect(knownNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps real measurements, including a legitimate 0%', () => {
    expect(knownNumber(0)).toBe(0);
    expect(knownNumber(42)).toBe(42);
  });
});

describe('formatElapsed', () => {
  it('reports whole seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0 秒');
    expect(formatElapsed(8_400)).toBe('8 秒');
  });

  it('switches to minutes and seconds for long installs', () => {
    expect(formatElapsed(83_000)).toBe('1 分 23 秒');
  });

  it('never renders a negative duration from clock skew', () => {
    expect(formatElapsed(-5_000)).toBe('0 秒');
  });
});
