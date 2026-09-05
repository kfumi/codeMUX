import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPiMcpConfigFile,
  isPiMcpAdapterCommand,
  piCommandsIncludeMcpAdapter,
  toPiMcpConfig,
} from './piMcp.js';

const pendingCleanups: Array<() => void> = [];

afterEach(() => {
  while (pendingCleanups.length > 0) {
    pendingCleanups.pop()?.();
  }
});

describe('toPiMcpConfig', () => {
  it('maps stdio servers to command/args/env', () => {
    expect(toPiMcpConfig({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
      env: { FOO: 'bar' },
    })).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
      env: { FOO: 'bar' },
    });
  });

  it('maps http servers with oauth disabled', () => {
    expect(toPiMcpConfig({
      type: 'http',
      url: 'http://127.0.0.1:6767/mcp',
      headers: { Authorization: 'Bearer x' },
    })).toEqual({
      url: 'http://127.0.0.1:6767/mcp',
      headers: { Authorization: 'Bearer x' },
      auth: false,
      oauth: false,
    });
  });
});

describe('createPiMcpConfigFile', () => {
  it('writes injected servers and overlays the hosted global mcp.json', () => {
    const piConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-dir-'));
    pendingCleanups.push(() => fs.rmSync(piConfigDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(piConfigDir, 'mcp.json'), JSON.stringify({
      'mcp-servers': {
        brave: { url: 'https://example.com/mcp/brave' },
      },
    }), 'utf8');

    const file = createPiMcpConfigFile(
      {
        fetch: { type: 'stdio', command: 'npx', args: ['-y', 'fetch'] },
      },
      { piConfigDir },
    );
    pendingCleanups.push(file.cleanup);

    const written = JSON.parse(fs.readFileSync(file.path, 'utf8')) as Record<string, unknown>;
    expect(written['mcp-servers']).toBeUndefined();
    expect(written.mcpServers).toEqual({
      brave: { url: 'https://example.com/mcp/brave' },
      fetch: { command: 'npx', args: ['-y', 'fetch'] },
    });
  });
});

describe('pi-mcp-adapter detection', () => {
  it('recognizes the adapter extension command', () => {
    expect(isPiMcpAdapterCommand({
      name: 'mcp',
      source: 'extension',
      sourceInfo: { source: 'npm:pi-mcp-adapter' },
    })).toBe(true);
    expect(isPiMcpAdapterCommand({ name: 'compact', source: 'prompt' })).toBe(false);
    expect(piCommandsIncludeMcpAdapter({
      commands: [
        { name: 'mcp', source: 'extension', sourceInfo: { source: 'npm:pi-mcp-adapter' } },
      ],
    })).toBe(true);
  });
});
