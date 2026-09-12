// 日志行时间戳格式契约:本地时区 YYYY-MM-DD HH:MM:SS.mmm。
import { describe, expect, it } from 'vitest';

import { formatLocalTimestamp } from '../src/log-format';

describe('formatLocalTimestamp', () => {
  it('按本地时区输出 YYYY-MM-DD HH:MM:SS.mmm', () => {
    expect(formatLocalTimestamp(new Date(2026, 8, 13, 3, 20, 47, 481))).toBe('2026-09-13 03:20:47.481');
  });

  it('月/日/时/分/秒/毫秒均补零', () => {
    expect(formatLocalTimestamp(new Date(2026, 0, 5, 7, 5, 3, 9))).toBe('2026-01-05 07:05:03.009');
  });
});
