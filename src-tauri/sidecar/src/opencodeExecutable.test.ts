import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareOpenCodeExecutable, resolveOpenCodeExecutable } from './opencodeExecutable.js';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe('OpenCode executable resolution', () => {
  it('finds the bundled Windows shim before PATH', () => {
    const result = resolveOpenCodeExecutable({
      sidecarDir: 'C:/app/sidecar/dist',
      platform: 'win32',
      pathEnv: 'C:/global/bin',
      fileExists: (candidate) => candidate === 'C:\\app\\sidecar\\node_modules\\.bin\\opencode.cmd',
    });

    expect(result).toMatchObject({
      executablePath: 'C:\\app\\sidecar\\node_modules\\.bin\\opencode.cmd',
      source: 'bundled',
    });
  });

  it('finds an existing POSIX executable on PATH when no bundled binary exists', () => {
    const result = resolveOpenCodeExecutable({
      sidecarDir: '/opt/codemux/sidecar/dist',
      platform: 'linux',
      pathEnv: '/usr/local/bin:/usr/bin',
      fileExists: (candidate) => candidate === '/usr/local/bin/opencode',
    });

    expect(result).toEqual({
      executablePath: '/usr/local/bin/opencode',
      pathEntry: '/usr/local/bin',
      source: 'path',
    });
  });

  it('returns a credential-free diagnostic when no executable is available', () => {
    expect(() => prepareOpenCodeExecutable({
      sidecarDir: '/opt/codemux/sidecar/dist',
      platform: 'linux',
      pathEnv: '',
      fileExists: () => false,
    })).toThrow('OpenCode executable not found');
    expect(() => prepareOpenCodeExecutable({
      sidecarDir: '/opt/codemux/sidecar/dist',
      platform: 'linux',
      pathEnv: '',
      fileExists: () => false,
    })).toThrow(/PATH/);
  });

  it('prepends the bundled executable directory to PATH for the official SDK spawn', () => {
    process.env.PATH = '/usr/bin';
    const result = prepareOpenCodeExecutable({
      sidecarDir: '/opt/codemux/sidecar/dist',
      platform: 'linux',
      pathEnv: '/usr/bin',
      fileExists: (candidate) => candidate === '/opt/codemux/sidecar/node_modules/opencode-ai/bin/opencode',
    });

    expect(result.source).toBe('bundled');
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe('/opt/codemux/sidecar/node_modules/opencode-ai/bin');
  });
});

