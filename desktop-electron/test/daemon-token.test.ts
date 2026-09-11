// daemon-token 读取契约(main 进程共用,纯 Node):容错版 null 回退、
// 显式版区分「未生成」与「为空」。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readLocalDaemonToken, readLocalDaemonTokenOrThrow } from '../src/daemon-token';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-daemon-token-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readLocalDaemonToken(容错版)', () => {
  it('缺失返回 null', () => {
    expect(readLocalDaemonToken(makeTempDir())).toBeNull();
  });

  it('空白内容返回 null', () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'local-daemon-token'), '   \n', 'utf8');
    expect(readLocalDaemonToken(dir)).toBeNull();
  });

  it('有效内容返回 trim 后的 token', () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'local-daemon-token'), '  tok-abc123 \n', 'utf8');
    expect(readLocalDaemonToken(dir)).toBe('tok-abc123');
  });
});

describe('readLocalDaemonTokenOrThrow(显式版)', () => {
  it('缺失与空白分别抛出带原因的错误', () => {
    const dir = makeTempDir();
    expect(() => readLocalDaemonTokenOrThrow(dir)).toThrow('local-daemon-token 尚未生成(daemon 未启动?)');
    writeFileSync(path.join(dir, 'local-daemon-token'), '\n', 'utf8');
    expect(() => readLocalDaemonTokenOrThrow(dir)).toThrow('local-daemon-token 为空');
  });

  it('有效内容原样返回(trim)', () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'local-daemon-token'), ' tok-xyz \n', 'utf8');
    expect(readLocalDaemonTokenOrThrow(dir)).toBe('tok-xyz');
  });
});
