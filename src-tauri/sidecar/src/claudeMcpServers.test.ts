import { describe, expect, it } from 'vitest';

import { mapClaudeMcpServers, toClaudeSdkMcpServer } from './claudeMcpServers.js';

describe('claudeMcpServers', () => {
  it('toClaudeSdkMcpServer:stdio spec 带 args/env,缺省字段省略', () => {
    expect(
      toClaudeSdkMcpServer({ command: 'codemux-daemon', args: ['mcp-browser'], env: { A: '1' } }),
    ).toEqual({ type: 'stdio', command: 'codemux-daemon', args: ['mcp-browser'], env: { A: '1' } });
    expect(toClaudeSdkMcpServer({ command: 'npx' })).toEqual({ type: 'stdio', command: 'npx' });
  });

  it('toClaudeSdkMcpServer:非 stdio(无 command)返回 null', () => {
    expect(toClaudeSdkMcpServer({ url: 'https://mcp.example/sse' })).toBeNull();
    expect(toClaudeSdkMcpServer({ command: '   ' })).toBeNull();
  });

  it('mapClaudeMcpServers:跳过非法条目;全空返回 null;可用条目保留原键名', () => {
    expect(mapClaudeMcpServers(undefined)).toBeNull();
    expect(mapClaudeMcpServers({})).toBeNull();
    expect(mapClaudeMcpServers({ bad: { url: 'https://x' } })).toBeNull();
    const mapped = mapClaudeMcpServers({
      'codemux-browser': { command: 'D:/bin/codemux-daemon.exe', args: ['mcp-browser', '--app-data-dir', 'D:/data'] },
      bad: { url: 'https://x' },
    });
    expect(Object.keys(mapped ?? {})).toEqual(['codemux-browser']);
    expect((mapped ?? {})['codemux-browser']).toMatchObject({ type: 'stdio' });
  });
});
