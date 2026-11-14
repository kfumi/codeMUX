import { describe, expect, it } from 'vitest';

import type { ManagedNodeInfo } from '@/lib/runtimeTypes';

import {
  describeRuntimeBlocker,
  formatCheckedAt,
  formatElapsed,
  knownNumber,
} from './RuntimeSettings';

describe('formatCheckedAt', () => {
  it('formats legacy Unix-second timestamps instead of displaying the raw number', () => {
    const timestamp = '1786019897';
    expect(formatCheckedAt(timestamp)).toBe(new Date(Number(timestamp) * 1000).toLocaleString());
    expect(formatCheckedAt(timestamp)).not.toBe(timestamp);
  });

  it('keeps RFC3339 timestamps readable', () => {
    const timestamp = '2026-08-06T20:00:00+08:00';
    expect(formatCheckedAt(timestamp)).toBe(new Date(timestamp).toLocaleString());
  });
});

describe('knownNumber', () => {
  it('treats a missing field (undefined) as unknown', () => {
    expect(knownNumber(undefined)).toBeNull();
  });

  it('treats a null from an older daemon as unknown rather than zero', () => {
    // 回归：`null` 曾经穿过 `!== undefined` 守卫，被 `?? 0` 渲染成一个假的 0%，
    // 字节行则被 formatBytes 插值成 "null B / null B"。
    expect(knownNumber(null)).toBeNull();
  });

  it('rejects NaN and Infinity', () => {
    expect(knownNumber(Number.NaN)).toBeNull();
    expect(knownNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps real measurements, including a legitimate 0%', () => {
    expect(knownNumber(0)).toBe(0);
    expect(knownNumber(42)).toBe(42);
  });
});

describe('formatElapsed', () => {
  it('reports whole seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0 秒');
    expect(formatElapsed(8_400)).toBe('8 秒');
  });

  it('switches to minutes and seconds for long installs', () => {
    expect(formatElapsed(83_000)).toBe('1 分 23 秒');
  });

  it('never renders a negative duration from clock skew', () => {
    expect(formatElapsed(-5_000)).toBe('0 秒');
  });
});

function nodeInfo(overrides: Partial<ManagedNodeInfo> = {}): ManagedNodeInfo {
  return {
    available: true,
    satisfiesMinimum: true,
    version: 'v22.20.0',
    executablePath: 'node.exe',
    error: null,
    npm: {
      available: true,
      version: '10.9.3',
      executablePath: 'npm.cmd',
      matchesNode: true,
      error: null,
    },
    ...overrides,
  };
}

describe('describeRuntimeBlocker', () => {
  it('reports nothing when Node and npm are both usable', () => {
    expect(describeRuntimeBlocker(nodeInfo())).toBeNull();
  });

  it('includes backend detail and recovery guidance when Node is unavailable', () => {
    const node = nodeInfo({
      available: false,
      satisfiesMinimum: false,
      version: null,
      error: 'PATH 中未找到 node 可执行文件',
    });
    expect(describeRuntimeBlocker(node)).toBe(
      'PATH 中未找到 node 可执行文件。请安装或升级到 Node.js 18+ 后重新检测。',
    );
  });

  it('recommends installing Node 18+ when detection has no backend error', () => {
    const node = nodeInfo({
      available: false,
      satisfiesMinimum: false,
      version: null,
      error: null,
    });
    expect(describeRuntimeBlocker(node)).toBe('未检测到可用的 Node.js。请安装 Node.js 18+ 后重新检测。');
  });

  it('blames npm rather than Node when only the bundled npm is broken', () => {
    // 回归：随包 node.exe 在、npm.cmd 在,但 npm.cmd 找不到 npm-cli.js 时,
    // 后端 node.error 是 null。旧代码于是显示「Node.js 运行时不可用」,
    // 把打包丢失 node_modules 的问题指成了 Node 的问题。
    const node = nodeInfo({
      npm: {
        available: false,
        version: null,
        executablePath: 'npm.cmd',
        matchesNode: false,
        error: null,
      },
    });
    const message = describeRuntimeBlocker(node);
    expect(message).toContain('npm');
    expect(message).not.toContain('Node.js 运行时不可用');
  });

  it('surfaces the npm error verbatim when the daemon provides one', () => {
    const node = nodeInfo({
      npm: {
        available: false,
        version: null,
        executablePath: null,
        matchesNode: false,
        error: 'npm --version 执行失败：退出码 Some(1)',
      },
    });
    expect(describeRuntimeBlocker(node)).toBe('npm --version 执行失败：退出码 Some(1)');
  });

  it('explains an outdated Node instead of claiming it is missing', () => {
    const node = nodeInfo({ satisfiesMinimum: false, version: 'v16.20.2' });
    expect(describeRuntimeBlocker(node)).toContain('v16.20.2');
    expect(describeRuntimeBlocker(node)).toContain('版本过低');
    expect(describeRuntimeBlocker(node)).toContain('升级到 Node.js 18+ 后重新检测');
  });
});
