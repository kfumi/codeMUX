import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadClaudeSdk,
  loadOpenCodeClientSdk,
  loadOpenCodeServerSdk,
} from './sdkLoader.js';
import { loadProviderRuntime, type RuntimeLoadResult } from './runtimeLoader.js';
import type { ProviderRuntimeRef } from './runtimeContract.js';

function makeRef(runtimePath: string): ProviderRuntimeRef {
  return {
    provider: 'claude_code',
    runtimeRoot: path.dirname(runtimePath),
    runtimePath,
    runtimeVersion: '0.3.170',
  };
}

function createRuntimePack(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
}

function createMockSdkModule(dir: string, packageName: string, exports: Record<string, unknown>): void {
  const pkgDir = path.join(dir, 'node_modules', packageName);
  fs.mkdirSync(pkgDir, { recursive: true });
  const isScoped = packageName.startsWith('@');
  const subPath = packageName.split('/').slice(1).join('/');
  const mainFile = isScoped
    ? path.join(pkgDir, subPath || 'index.js')
    : path.join(pkgDir, 'index.js');
  fs.mkdirSync(path.dirname(mainFile), { recursive: true });
  // Write a CJS module that exports the given exports
  const lines = Object.entries(exports).map(([key, value]) => {
    if (typeof value === 'function') {
      return `module.exports.${key} = ${value.toString()};`;
    }
    return `module.exports.${key} = ${JSON.stringify(value)};`;
  });
  fs.writeFileSync(mainFile, lines.join('\n'));
  // Write package.json to mark as CJS
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '0.0.0', type: 'commonjs', main: path.relative(pkgDir, mainFile) }),
  );
}

describe('sdkLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-loader-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadClaudeSdk', () => {
    it('loads Claude SDK from the managed runtime path', async () => {
      const runtimePath = path.join(tmpDir, 'claude_code', '0.3.170');
      createRuntimePack(runtimePath);
      createMockSdkModule(runtimePath, '@anthropic-ai/claude-agent-sdk', {
        query: function query() { return 'mock-query'; },
        startup: function startup() { return 'mock-startup'; },
      });

      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;
      const sdk = await loadClaudeSdk(loaded);
      expect(typeof sdk.query).toBe('function');
      expect(typeof sdk.startup).toBe('function');
    });

    it('loads Claude SDK from runtime path via runtimeRequire', async () => {
      const runtimePath = path.join(tmpDir, 'claude_code', '0.3.170');
      createRuntimePack(runtimePath);
      createMockSdkModule(runtimePath, '@anthropic-ai/claude-agent-sdk', {
        query: function query() { return 'mock-query-result'; },
        startup: function startup() { return 'mock-startup-result'; },
      });

      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;
      const sdk = await loadClaudeSdk(loaded);
      expect(sdk.query()).toBe('mock-query-result');
      expect(sdk.startup()).toBe('mock-startup-result');
    });
  });

  describe('loadOpenCodeClientSdk', () => {
    it('loads OpenCode client SDK from runtime path via runtimeRequire', async () => {
      const runtimePath = path.join(tmpDir, 'opencode', '1.18.3');
      createRuntimePack(runtimePath);
      // @opencode-ai/sdk/client is a scoped subpath
      const pkgDir = path.join(runtimePath, 'node_modules', '@opencode-ai', 'sdk');
      fs.mkdirSync(pkgDir, { recursive: true });
      // Create the client subpath module
      const clientDir = path.join(pkgDir, 'client');
      fs.mkdirSync(clientDir, { recursive: true });
      fs.writeFileSync(
        path.join(clientDir, 'index.js'),
        'module.exports.createOpencodeClient = function() { return { session: {} }; };',
      );
      fs.writeFileSync(
        path.join(clientDir, 'package.json'),
        JSON.stringify({ name: '@opencode-ai/sdk-client', version: '0.0.0', type: 'commonjs' }),
      );
      // Main package.json with exports mapping
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@opencode-ai/sdk',
          version: '1.18.3',
          type: 'commonjs',
          exports: {
            './client': './client/index.js',
            './server': './server/index.js',
          },
        }),
      );

      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;
      const sdk = await loadOpenCodeClientSdk(loaded);
      expect(typeof sdk.createOpencodeClient).toBe('function');
      const client = sdk.createOpencodeClient({ baseUrl: 'http://localhost', directory: '/tmp' });
      expect(client).toHaveProperty('session');
    });
  });

  describe('loadOpenCodeServerSdk', () => {
    it('loads OpenCode server SDK from runtime path via runtimeRequire', async () => {
      const runtimePath = path.join(tmpDir, 'opencode', '1.18.3');
      createRuntimePack(runtimePath);
      const pkgDir = path.join(runtimePath, 'node_modules', '@opencode-ai', 'sdk');
      fs.mkdirSync(pkgDir, { recursive: true });
      const serverDir = path.join(pkgDir, 'server');
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(
        path.join(serverDir, 'index.js'),
        'module.exports.createOpencodeServer = async function() { return { url: "http://127.0.0.1:4097", close: () => {} }; };',
      );
      fs.writeFileSync(
        path.join(serverDir, 'package.json'),
        JSON.stringify({ name: '@opencode-ai/sdk-server', version: '0.0.0', type: 'commonjs' }),
      );
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@opencode-ai/sdk',
          version: '1.18.3',
          type: 'commonjs',
          exports: {
            './client': './client/index.js',
            './server': './server/index.js',
          },
        }),
      );

      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;
      const sdk = await loadOpenCodeServerSdk(loaded);
      expect(typeof sdk.createOpencodeServer).toBe('function');
      const server = await sdk.createOpencodeServer({ hostname: '127.0.0.1', port: 0 });
      expect(server).toHaveProperty('url');
    });
  });

  describe('managed runtime requirement', () => {
    it('rejects when no managed runtime is supplied', async () => {
      await expect(loadClaudeSdk(null)).rejects.toThrow('Claude Code Runtime is required');
    });
  });
});
