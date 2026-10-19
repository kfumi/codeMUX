// 日志轮转契约:未超阈值不动、超阈值改名 `.1`、覆盖旧备份、缺失文件静默。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { rotateLogIfOversized } from '../src/log-rotation';

const tempDirs: string[] = [];

function tempFile(name: string, content = ''): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-log-rotate-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('rotateLogIfOversized', () => {
  it('未超阈值时不动文件', () => {
    const filePath = tempFile('daemon.log', 'small');
    expect(rotateLogIfOversized(filePath, 1024)).toBe(false);
    expect(readFileSync(filePath, 'utf8')).toBe('small');
    expect(existsSync(`${filePath}.1`)).toBe(false);
  });

  it('超阈值时改名为 .1', () => {
    const filePath = tempFile('daemon.log', 'x'.repeat(2048));
    expect(rotateLogIfOversized(filePath, 1024)).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('x'.repeat(2048));
  });

  it('已有旧备份时被覆盖', () => {
    const filePath = tempFile('daemon.log', 'new-content');
    writeFileSync(`${filePath}.1`, 'stale-backup', 'utf8');
    expect(rotateLogIfOversized(filePath, 1)).toBe(true);
    expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('new-content');
  });

  it('文件不存在时返回 false 且不抛', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-log-rotate-'));
    tempDirs.push(dir);
    expect(() => rotateLogIfOversized(path.join(dir, 'missing.log'))).not.toThrow();
    expect(rotateLogIfOversized(path.join(dir, 'missing.log'))).toBe(false);
  });
});
