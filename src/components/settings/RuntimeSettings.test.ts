import { describe, expect, it } from 'vitest';

import { formatCheckedAt } from './RuntimeSettings';

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
