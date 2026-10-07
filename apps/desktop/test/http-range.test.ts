import { describe, expect, it } from 'vitest';

import { parseByteRange } from '../src/http-range';

describe('parseByteRange', () => {
  it('解析显式区间与开区间', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
  });

  it('把越界末尾钳到文件长度', () => {
    expect(parseByteRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
  });

  it('解析后缀区间 bytes=-N', () => {
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    // 后缀超过文件长度:整文件。
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('忽略首尾空白', () => {
    expect(parseByteRange('  bytes=0-9  ', 100)).toEqual({ start: 0, end: 9 });
  });

  it('非法/多段/越界一律返回 null,退化为整文件 200', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('', 100)).toBeNull();
    expect(parseByteRange('items=0-1', 100)).toBeNull();
    expect(parseByteRange('bytes=', 100)).toBeNull();
    expect(parseByteRange('bytes=abc', 100)).toBeNull();
    expect(parseByteRange('bytes=0-1,3-4', 100)).toBeNull();
    expect(parseByteRange('bytes=5-2', 100)).toBeNull();
    expect(parseByteRange('bytes=100-', 100)).toBeNull();
    expect(parseByteRange('bytes=-0', 100)).toBeNull();
    expect(parseByteRange('bytes=0-', 0)).toBeNull();
  });
});
