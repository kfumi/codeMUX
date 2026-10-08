import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isPiNativeMcpCommand,
  isValidPiMcpServerName,
  mergePiMcpServers,
  normalizePiMcpServerName,
  piCommandsIncludeNativeMcp,
  syncPiMcpJson,
  toPiMcpConfig,
} from './piMcp.js';

const pendingCleanups: Array<() => void> = [];

afterEach(() => {
  while (pendingCleanups.length > 0) {
    pendingCleanups.pop()?.();
  }
});

describe('toPiMcpConfig', () => {
  it('maps stdio servers to command/args/env/cwd with direct exposure by default', () => {
    expect(toPiMcpConfig({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
      env: { FOO: 'bar' },
      cwd: '/tmp/work',
    })).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
      env: { FOO: 'bar' },
      cwd: '/tmp/work',
      type: 'stdio',
      exposure: 'direct',
    });
  });

  it('honours an explicit exposure instead of the direct default', () => {
    expect(toPiMcpConfig({ command: 'npx', exposure: 'deferred' })?.exposure).toBe('deferred');
    expect(toPiMcpConfig({ command: 'npx', exposure: 'whatever' })?.exposure).toBe('direct');
  });

  it('maps http servers without the legacy auth:false/oauth:false pair', () => {
    expect(toPiMcpConfig({
      type: 'http',
      url: 'http://127.0.0.1:6767/mcp',
      headers: { Authorization: 'Bearer x' },
      description: 'docs',
      timeout: 30,
    })).toEqual({
      url: 'http://127.0.0.1:6767/mcp',
      headers: { Authorization: 'Bearer x' },
      description: 'docs',
      timeout: 30,
      type: 'http',
      exposure: 'direct',
    });
  });

  it('passes oauth through for http servers', () => {
    const oauth = { clientId: 'pi' };
    expect(toPiMcpConfig({ url: 'https://mcp.example.com', oauth })?.oauth).toEqual(oauth);
  });

  it('rejects sse, empty and ambiguous specs', () => {
    expect(toPiMcpConfig({ type: 'sse', url: 'https://x/sse' })).toBeNull();
    expect(toPiMcpConfig({ type: 'http' })).toBeNull();
    expect(toPiMcpConfig({ command: '   ' })).toBeNull();
    expect(toPiMcpConfig({ command: 'npx', url: 'https://x/mcp' })).toBeNull();
    expect(toPiMcpConfig({ type: 'grpc', command: 'npx' })).toBeNull();
  });
});

describe('server names', () => {
  it('accepts only pi-native names', () => {
    expect(isValidPiMcpServerName('fetch')).toBe(true);
    expect(isValidPiMcpServerName('my-server_2')).toBe(true);
    expect(isValidPiMcpServerName('has space')).toBe(false);
    expect(isValidPiMcpServerName('has.dot')).toBe(false);
    expect(isValidPiMcpServerName('')).toBe(false);
  });

  it('treats dash/underscore variants as the same server', () => {
    expect(normalizePiMcpServerName('my-server')).toBe('my_server');
  });
});

describe('mergePiMcpServers', () => {
  it('upserts incoming, preserves user entries, skips invalid and colliding names', () => {
    const result = mergePiMcpServers(
      { keep: { command: 'keep-me' }, 'my-server': { command: 'user-one' } },
      ['stale'],
      {
        fetch: { command: 'npx' },
        'bad name': { command: 'npx' },
        broken: { url: '' },
        my_server: { command: 'codemux-one' },
      },
    );
    expect(result.applied).toEqual(['fetch']);
    expect(result.skipped.sort()).toEqual(['bad name', 'broken', 'my_server'].sort());
    expect(result.mcpServers.keep).toEqual({ command: 'keep-me' });
    expect(result.mcpServers['my-server']).toEqual({ command: 'user-one' });
    expect(result.mcpServers.fetch).toMatchObject({ command: 'npx' });
    expect(result.managed).toEqual(['fetch']);
  });

  it('prunes previously managed names that disappeared from the incoming set', () => {
    const result = mergePiMcpServers(
      { fetch: { command: 'npx' }, keep: { command: 'x' } },
      ['fetch'],
      {},
    );
    expect(result.pruned).toEqual(['fetch']);
    expect(result.mcpServers).toEqual({ keep: { command: 'x' } });
    expect(result.managed).toEqual([]);
  });
});

describe('syncPiMcpJson', () => {
  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-dir-'));
    pendingCleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('writes mcp.json into the hosted dir and keeps other top-level keys', () => {
    const dir = makeDir();
    fs.writeFileSync(dir + '/mcp.json', JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: { keep: { command: 'keep-me' } },
    }), 'utf8');

    const result = syncPiMcpJson(dir, {
      fetch: { type: 'stdio', command: 'npx', args: ['-y', 'fetch'] },
    });

    expect(result.applied).toEqual(['fetch']);
    expect(result.path).toBe(path.join(dir, 'mcp.json'));
    const written = JSON.parse(fs.readFileSync(result.path, 'utf8')) as Record<string, unknown>;
    expect(written.autoEnableCodemode).toBe(false);
    expect(written.mcpServers).toMatchObject({
      keep: { command: 'keep-me' },
      fetch: { command: 'npx', exposure: 'direct' },
    });
  });

  it('prunes disabled servers on the second sync while keeping user entries', () => {
    const dir = makeDir();
    syncPiMcpJson(dir, { fetch: { command: 'npx' } });
    const second = syncPiMcpJson(dir, {});
    expect(second.pruned).toEqual(['fetch']);
    const written = JSON.parse(fs.readFileSync(second.path, 'utf8')) as Record<string, unknown>;
    expect(written.mcpServers).toEqual({});
  });

  it('throws a readable error on corrupt mcp.json instead of overwriting blindly', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'mcp.json'), '{oops', 'utf8');
    expect(() => syncPiMcpJson(dir, {})).toThrow(/mcp\.json/);
  });
});

describe('pi native mcp detection', () => {
  it('recognizes the builtin:mcp extension command', () => {
    expect(isPiNativeMcpCommand({
      name: 'mcp',
      source: 'extension',
      sourceInfo: { path: 'builtin:mcp', source: 'builtin' },
    })).toBe(true);
    expect(isPiNativeMcpCommand({ name: 'mcp', source: 'prompt' })).toBe(false);
    expect(isPiNativeMcpCommand({ name: 'compact', source: 'extension' })).toBe(false);
    expect(piCommandsIncludeNativeMcp({
      commands: [{ name: 'mcp', source: 'extension', sourceInfo: { path: 'builtin:mcp' } }],
    })).toBe(true);
    expect(piCommandsIncludeNativeMcp({ commands: [] })).toBe(false);
  });
});
