// 窗口 → 进程身份(工单 11)契约:PowerShell 枚举输出的解析(宁缺勿错)与
// 来源 id ↔ 窗口句柄的拼接。壳只报事实,裁决在 daemon。
import { describe, expect, it } from 'vitest';

import {
  boundsField,
  identityFields,
  identityOfSource,
  parseWindowIdentities,
  windowBoundsField,
  windowHandleFromSourceId,
} from '../src/window-identity';

describe('parseWindowIdentities', () => {
  it('parses the PowerShell array payload', () => {
    const rows = parseWindowIdentities(
      JSON.stringify([
        {
          hwnd: 197_000,
          processId: 4242,
          parentProcessId: 100,
          processName: 'CodeMUX.exe',
          x: 158,
          y: 141,
          width: 1296,
          height: 839,
        },
        { hwnd: 197_100, processId: 5150, parentProcessId: 4242, processName: 'CodeMUX.exe' },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      hwnd: 197_000,
      processId: 4242,
      parentProcessId: 100,
      processName: 'CodeMUX.exe',
      bounds: { x: 158, y: 141, width: 1296, height: 839 },
    });
    expect(rows[1].bounds).toBeUndefined();
  });

  it('only keeps a rect when all four parts are usable', () => {
    const rows = parseWindowIdentities(
      JSON.stringify([
        { hwnd: 1, processId: 10, x: 0, y: 0, width: 800, height: 600 },
        { hwnd: 2, processId: 10, x: 5, y: 5 },
        { hwnd: 3, processId: 10, x: 5, y: 5, width: 0, height: 600 },
        { hwnd: 4, processId: 10, x: 5, y: 5, width: -10, height: 600 },
        { hwnd: 5, processId: 10, x: null, y: 5, width: 10, height: 10 },
      ]),
    );
    // x=0/y=0 合法(屏幕左上角);其余缺分量或非正宽高的一律不带 rect。
    expect(rows[0].bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(rows.slice(1).every((row) => row.bounds === undefined)).toBe(true);
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
      // windowId 是桌面输入工具的寻址字段(与来源 id 里的 hwnd 同值)。
      windowId: 197_100,
      processId: 5150,
      parentProcessId: 4242,
      processName: 'CodeMUX.exe',
    });
  });

  it('names the rect differently in the two payloads', () => {
    // 窗口清单里叫 bounds;截图元数据里叫 windowBounds(那里 width/height 是图像像素)。
    const identity = {
      hwnd: 197_100,
      processId: 5150,
      bounds: { x: 158, y: 141, width: 1296, height: 839 },
    };
    expect(boundsField(identity)).toEqual({ bounds: identity.bounds });
    expect(windowBoundsField(identity)).toEqual({ windowBounds: identity.bounds });
    expect(boundsField(undefined)).toEqual({});
    expect(windowBoundsField(undefined)).toEqual({});
  });
});
