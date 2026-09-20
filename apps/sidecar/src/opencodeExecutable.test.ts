import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareOpenCodeExecutable, resolveOpenCodeExecutable } from './opencodeExecutable.js';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe('OpenCode executable resolution', () => {
  it('does not search sidecar node_modules when no managed runtime is supplied', () => {
    const result = resolveOpenCodeExecutable({
      platform: 'win32',
      fileExists: (candidate) => candidate === 'C:\\app\\sidecar\\node_modules\\.bin\\opencode.cmd',
    });

    expect(result).toBeUndefined();
  });

  it('does not use a global OpenCode executable from PATH', () => {
    const result = resolveOpenCodeExecutable({
      platform: 'linux',
      fileExists: (candidate) => candidate === '/usr/local/bin/opencode',
    });

    expect(result).toBeUndefined();
  });

  it('returns a credential-free diagnostic when no executable is available', () => {
    expect(() => prepareOpenCodeExecutable({
      platform: 'linux',
      fileExists: () => false,
    })).toThrow('OpenCode executable not found');
    expect(() => prepareOpenCodeExecutable({
      platform: 'linux',
      fileExists: () => false,
    })).toThrow(/托管 OpenCode Runtime/);
  });

  it('prepends the managed runtime executable directory to PATH for the official SDK spawn', () => {
    process.env.PATH = '/usr/bin';
    const result = prepareOpenCodeExecutable({
      platform: 'linux',
      runtimePath: '/opt/codemux/runtimes/opencode/1.18.3',
      fileExists: (candidate) => candidate === '/opt/codemux/runtimes/opencode/1.18.3/node_modules/opencode-ai/bin/opencode',
    });

    expect(result.source).toBe('runtime');
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe('/opt/codemux/runtimes/opencode/1.18.3/node_modules/opencode-ai/bin');
  });
});

