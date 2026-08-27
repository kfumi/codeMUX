import { describe, expect, it } from 'vitest';

import { formatScheduleSummary, formatNextRunRelative } from './scheduleSummary';

describe('formatScheduleSummary', () => {
  it('formats hourly schedule with minute', () => {
    expect(formatScheduleSummary('hourly', '00:30', [], 1, '+08:00')).toBe(
      'GMT+8 每小时的第 30 分',
    );
  });

  it('formats weekdays schedule', () => {
    expect(formatScheduleSummary('weekdays', '09:00', [], 1, '+08:00')).toBe(
      'GMT+8 每工作日 09:00',
    );
  });

  it('formats weekly schedule with multiple days', () => {
    expect(formatScheduleSummary('weekly', '09:00', [0, 1, 2, 3, 4], 1, '+08:00')).toBe(
      'GMT+8 每周一、二、三、四、五 09:00',
    );
  });

  it('formats monthly schedule', () => {
    expect(formatScheduleSummary('monthly', '09:00', [], 1, '+08:00')).toBe(
      'GMT+8 每月 1 号 09:00',
    );
  });

  it('can omit timezone for compact labels', () => {
    expect(formatScheduleSummary('hourly', '00:30', [], 1, '+08:00', { includeTimezone: false })).toBe(
      '每小时的第 30 分',
    );
  });
});

describe('formatNextRunRelative', () => {
  it('formats minutes until next run', () => {
    const now = Date.parse('2026-08-28T08:00:00+08:00');
    expect(formatNextRunRelative('2026-08-28T08:44:00+08:00', now)).toBe('44 分钟后');
  });

  it('formats imminent runs', () => {
    const now = Date.parse('2026-08-28T08:00:00+08:00');
    expect(formatNextRunRelative('2026-08-28T08:00:00+08:00', now)).toBe('即将运行');
  });
});
