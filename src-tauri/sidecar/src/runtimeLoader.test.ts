import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadProviderRuntime,
  resolveClaudeFromRuntime,
  resolveOpenCodeFromRuntime,
  injectRuntimePath,
  hasRuntimeRef,
  sdkPackageName,
  type RuntimeLoadResult,
} from './runtimeLoader.js';
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

describe('runtimeLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-loader-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadProviderRuntime', () => {
    it('returns error when runtimePath does not exist', () => {
      const ref = makeRef(path.join(tmpDir, 'nonexistent'));
      const result = loadProviderRuntime(ref);
      expect(result).toHaveProperty('kind', 'integrity_failed');
    });

    it('returns error when package.json is missing', () => {
      const runtimePath = path.join(tmpDir, 'claude_code', '0.3.170');
      fs.mkdirSync(runtimePath, { recursive: true });
      fs.mkdirSync(path.join(runtimePath, 'node_modules'), { recursive: true });
      // 不创建 package.json

      const result = loadProviderRuntime(makeRef(runtimePath));
      expect(result).toHaveProperty('kind', 'integrity_failed');
    });

    it('returns error when node_modules is missing', () => {
      const runtimePath = path.join(tmpDir, 'claude_code', '0.3.170');
      fs.mkdirSync(runtimePath, { recursive: true });
      fs.writeFileSync(path.join(runtimePath, 'package.json'), '{}');
      // 不创建 node_modules

      const result = loadProviderRuntime(makeRef(runtimePath));
      expect(result).toHaveProperty('kind', 'integrity_failed');
    });

    it('returns RuntimeLoadResult when runtime is valid', () => {
      const runtimePath = path.join(tmpDir, 'claude_code', '0.3.170');
      createRuntimePack(runtimePath);

      const result = loadProviderRuntime(makeRef(runtimePath));
      expect(result).toHaveProperty('ref');
      expect(result).toHaveProperty('nodeModulesPath');
      expect(result).toHaveProperty('runtimeRequire');
      const loaded = result as RuntimeLoadResult;
      expect(loaded.nodeModulesPath).toBe(path.join(runtimePath, 'node_modules'));
      expect(typeof loaded.runtimeRequire).toBe('function');
    });

    it('supports paths with spaces and non-ASCII characters', () => {
      const runtimePath = path.join(tmpDir, '测试 目录', 'claude code', '0.3.170');
      createRuntimePack(runtimePath);

      const result = loadProviderRuntime(makeRef(runtimePath));
      expect(result).toHaveProperty('ref');
    });
  });

  describe('resolveClaudeFromRuntime', () => {
    it('returns undefined when platform binary is not present', () => {
      const runtimePath = path.join(tmpDir, 'claude_code', '0.3.170');
      createRuntimePack(runtimePath);
      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;

      expect(resolveClaudeFromRuntime(loaded)).toBeUndefined();
    });

    it('returns path when platform binary exists', () => {
      const runtimePath = path.join(tmpDir, 'claude_code', '0.3.170');
      createRuntimePack(runtimePath);

      // 创建平台二进制
      const platform = process.platform;
      const arch = process.arch;
      const archSuffix = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
      expect(archSuffix).not.toBeNull();
      const packageName =
        platform === 'win32'
          ? `@anthropic-ai/claude-agent-sdk-win32-${archSuffix}`
          : platform === 'darwin'
            ? `@anthropic-ai/claude-agent-sdk-darwin-${archSuffix}`
            : `@anthropic-ai/claude-agent-sdk-linux-${archSuffix}`;
      const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';
      const binDir = path.join(runtimePath, 'node_modules', packageName);
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, binaryName), 'binary');

      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;
      const resolved = resolveClaudeFromRuntime(loaded, platform, arch);
      expect(resolved).toBeDefined();
      expect(resolved).toContain(binaryName);
    });
  });

  describe('resolveOpenCodeFromRuntime', () => {
    it('returns undefined when opencode binary is not present', () => {
      const runtimePath = path.join(tmpDir, 'opencode', '1.18.3');
      createRuntimePack(runtimePath);
      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;

      expect(resolveOpenCodeFromRuntime(loaded)).toBeUndefined();
    });

    it('returns path when opencode binary exists in opencode-ai/bin', () => {
      const runtimePath = path.join(tmpDir, 'opencode', '1.18.3');
      createRuntimePack(runtimePath);

      const binDir = path.join(runtimePath, 'node_modules', 'opencode-ai', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const binaryName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
      fs.writeFileSync(path.join(binDir, binaryName), 'binary');

      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;
      const resolved = resolveOpenCodeFromRuntime(loaded);
      expect(resolved).toBeDefined();
      expect(resolved).toContain(binaryName);
    });
  });

  describe('injectRuntimePath', () => {
    it('prepends bin directory to PATH when it exists', () => {
      const runtimePath = path.join(tmpDir, 'claude_code', '0.3.170');
      createRuntimePack(runtimePath);
      const binDir = path.join(runtimePath, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });

      const originalPath = process.env.PATH;
      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;
      injectRuntimePath(loaded);

      expect(process.env.PATH).toContain(binDir);
      // 恢复 PATH 避免影响其它测试
      process.env.PATH = originalPath;
    });

    it('does not modify PATH when bin directory does not exist', () => {
      const runtimePath = path.join(tmpDir, 'claude_code', '0.3.170');
      createRuntimePack(runtimePath);
      // 不创建 .bin 目录

      const originalPath = process.env.PATH;
      const loaded = loadProviderRuntime(makeRef(runtimePath)) as RuntimeLoadResult;
      injectRuntimePath(loaded);

      expect(process.env.PATH).toBe(originalPath);
    });
  });

  describe('hasRuntimeRef', () => {
    it('returns false for null', () => {
      expect(hasRuntimeRef(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(hasRuntimeRef(undefined)).toBe(false);
    });

    it('returns false for object missing required fields', () => {
      expect(hasRuntimeRef({ provider: 'claude_code' })).toBe(false);
    });

    it('returns true for valid ProviderRuntimeRef', () => {
      expect(
        hasRuntimeRef({
          provider: 'claude_code',
          runtimeRoot: '/tmp',
          runtimePath: '/tmp/rt',
          runtimeVersion: '0.3.170',
        }),
      ).toBe(true);
    });
  });

  describe('sdkPackageName', () => {
    it('returns correct package name for each provider', () => {
      expect(sdkPackageName('claude_code')).toBe('@anthropic-ai/claude-agent-sdk');
      expect(sdkPackageName('codex')).toBe('@openai/codex-sdk');
      expect(sdkPackageName('opencode')).toBe('@opencode-ai/sdk');
    });
  });
});
