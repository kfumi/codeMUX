// 日志行时间戳格式契约:本地时区 YYYY-MM-DD HH:MM:SS.mmm。
import { describe, expect, it } from 'vitest';

import { clampLogText, formatLocalTimestamp, MAX_LOG_TEXT_CHARS } from '../src/log-format';

describe('formatLocalTimestamp', () => {
  it('按本地时区输出 YYYY-MM-DD HH:MM:SS.mmm', () => {
    expect(formatLocalTimestamp(new Date(2026, 8, 13, 3, 20, 47, 481))).toBe('2026-09-13 03:20:47.481');
  });

  it('月/日/时/分/秒/毫秒均补零', () => {
    expect(formatLocalTimestamp(new Date(2026, 0, 5, 7, 5, 3, 9))).toBe('2026-01-05 07:05:03.009');
  });
});

describe('clampLogText', () => {
  it('未超上限原样返回', () => {
    expect(clampLogText('short')).toBe('short');
  });

  it('超上限截断并标注省略字符数', () => {
    const text = 'x'.repeat(MAX_LOG_TEXT_CHARS + 12);
    expect(clampLogText(text)).toBe(`${'x'.repeat(MAX_LOG_TEXT_CHARS)}...[truncated 12 chars]`);
  });

  it('不把代理对切成半个字符', () => {
    const text = `xxx${'😀'}`;
    // maxChars=4 时恰好切在代理对中间,应回退到 3。
    expect(clampLogText(text, 4)).toBe('xxx...[truncated 2 chars]');
  });
});
