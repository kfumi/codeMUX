import { describe, expect, it } from 'vitest';

import { BUILTIN_MCP_SERVER_NAMES, builtinMcpToolSegment } from './builtinMcp';

describe('builtinMcpToolSegment', () => {
  it('recognizes the current and the pre-rename server name in the mcp__ form', () => {
    expect(builtinMcpToolSegment('mcp__codemux-control__computer_click')).toBe('computer_click');
    expect(builtinMcpToolSegment('mcp__codemux-control__browser_snapshot')).toBe('browser_snapshot');
    expect(builtinMcpToolSegment('mcp__codemux-browser__computer_click')).toBe('computer_click');
  });

  it('recognizes the concatenated form, including the underscored server spelling', () => {
    expect(builtinMcpToolSegment('codemux-control_computer_launch')).toBe('computer_launch');
    expect(builtinMcpToolSegment('codemux_control_computer_click')).toBe('computer_click');
    expect(builtinMcpToolSegment('codemux-browser_computer_type')).toBe('computer_type');
    expect(builtinMcpToolSegment('codemux_browser_browser_click')).toBe('browser_click');
  });

  it('is case and whitespace tolerant', () => {
    expect(builtinMcpToolSegment('  MCP__CODEMUX-CONTROL__COMPUTER_CLICK ')).toBe('computer_click');
  });

  it('returns undefined for anything that is not our builtin tool face', () => {
    expect(builtinMcpToolSegment('mcp__context7__query_docs')).toBeUndefined();
    expect(builtinMcpToolSegment('mcp__other__computer_click')).toBeUndefined();
    // 裸名(daemon 审批帧)不带 server 段,由调用点自己的裸名表处理。
    expect(builtinMcpToolSegment('computer_click')).toBeUndefined();
    expect(builtinMcpToolSegment('my_computer_click')).toBeUndefined();
    expect(builtinMcpToolSegment('mcp__codemux-control__')).toBeUndefined();
    expect(builtinMcpToolSegment('')).toBeUndefined();
  });

  it('keeps the current name first and the historical name in the list', () => {
    expect(BUILTIN_MCP_SERVER_NAMES).toEqual(['codemux-control', 'codemux-browser']);
  });
});
