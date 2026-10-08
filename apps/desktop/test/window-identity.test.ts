// 窗口 → 进程身份(工单 11)契约:PowerShell 枚举输出的解析(宁缺勿错)与
// 来源 id ↔ 窗口句柄的拼接。壳只报事实,裁决在 daemon。
import { describe, expect, it } from 'vitest';

import {
  identityFields,
  identityOfSource,
  parseWindowIdentities,
  windowHandleFromSourceId,
} from '../src/window-identity';

describe('parseWindowIdentities', () => {
  it('parses the PowerShell array payload', () => {
    const rows = parseWindowIdentities(
      JSON.stringify([
        { hwnd: 197_000, processId: 4242, parentProcessId: 100, processName: 'CodeMUX.exe' },
        { hwnd: 197_100, processId: 5150, parentProcessId: 4242, processName: 'CodeMUX.exe' },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      hwnd: 197_000,
      processId: 4242,
      parentProcessId: 100,
      processName: 'CodeMUX.exe',
    });
  });

  it('accepts a single object (PowerShell drops the array for one row)', () => {
    const rows = parseWindowIdentities(
      JSON.stringify({ hwnd: 5, processId: 9, parentProcessId: 0, processName: null }),
    );
    expect(rows).toEqual([{ hwnd: 5, processId: 9 }]);
  });

  it('drops rows without a usable handle or pid instead of guessing', () => {
    const rows = parseWindowIdentities(
      JSON.stringify([
        { hwnd: 0, processId: 9 },
        { hwnd: 7, processId: 0 },
        { hwnd: 8, processId: -1 },
        { processId: 9 },
        'nonsense',
        { hwnd: 11, processId: 12, parentProcessId: 0, processName: '   ' },
      ]),
    );
    expect(rows).toEqual([{ hwnd: 11, processId: 12 }]);
  });

  it('returns an empty list for junk or empty output', () => {
    expect(parseWindowIdentities('')).toEqual([]);
    expect(parseWindowIdentities('   ')).toEqual([]);
    expect(parseWindowIdentities('Get-CimInstance : 拒绝访问')).toEqual([]);
  });
});

describe('来源 id ↔ 窗口句柄', () => {
  it('reads the handle out of an Electron window source id', () => {
    expect(windowHandleFromSourceId('window:197000:0')).toBe(197_000);
    expect(windowHandleFromSourceId('window:197000')).toBe(197_000);
  });

  it('refuses non-window source ids', () => {
    expect(windowHandleFromSourceId('screen:0:0')).toBeNull();
    expect(windowHandleFromSourceId('window:0:0')).toBeNull();
    expect(windowHandleFromSourceId('')).toBeNull();
  });

  it('joins a source id to its identity', () => {
    const identities = [
      { hwnd: 197_000, processId: 4242, processName: 'CodeMUX.exe' },
      { hwnd: 197_100, processId: 5150, parentProcessId: 4242, processName: 'CodeMUX.exe' },
    ];
    expect(identityOfSource('window:197100:0', identities)?.processId).toBe(5150);
    expect(identityOfSource('window:999:0', identities)).toBeUndefined();
    expect(identityFields(undefined)).toEqual({});
    expect(identityFields(identities[1])).toEqual({
      processId: 5150,
      parentProcessId: 4242,
      processName: 'CodeMUX.exe',
    });
  });
});
