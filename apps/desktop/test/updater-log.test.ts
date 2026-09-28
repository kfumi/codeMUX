// 更新器落盘日志契约:行格式、Error 归一化、electron-updater Logger 适配、
// 懒建目录与写盘失败静默。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  UPDATER_LOG_FILE,
  createElectronUpdaterLogger,
  createUpdaterLogRecorder,
  formatUpdaterMessage,
} from '../src/updater-log';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-updater-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createUpdaterLogRecorder', () => {
  it('追加写入 [本地时间] [级别] 消息 行,并懒建日志目录', () => {
    const logDir = path.join(makeTempDir(), 'logs', 'nested');
    const recorder = createUpdaterLogRecorder(logDir, () => new Date(2026, 8, 12, 8, 9, 10, 481));
    expect(recorder.filePath).toBe(path.join(logDir, UPDATER_LOG_FILE));

    recorder.record('info', '开始检查更新');
    recorder.record('error', '下载失败');

    const lines = readFileSync(recorder.filePath, 'utf8').trimEnd().split('\n');
    expect(lines).toEqual([
      '[2026-09-12 08:09:10.481] [info] 开始检查更新',
      '[2026-09-12 08:09:10.481] [error] 下载失败',
    ]);
  });

  it('写盘失败静默吞掉(日志不反噬壳)', () => {
    const blocker = path.join(makeTempDir(), 'occupied');
    writeFileSync(blocker, 'not a dir', 'utf8');
    const broken = createUpdaterLogRecorder(path.join(blocker, 'logs'));
    expect(() => broken.record('info', 'should not throw')).not.toThrow();
    expect(existsSync(path.join(blocker, 'logs'))).toBe(false);
  });
});

describe('formatUpdaterMessage', () => {
  it('Error 取 stack,字符串原样,对象走 JSON,空值有兜底', () => {
    expect(formatUpdaterMessage(new Error('boom'))).toContain('boom');
    expect(formatUpdaterMessage('plain')).toBe('plain');
    expect(formatUpdaterMessage({ code: 404 })).toBe('{"code":404}');
    expect(formatUpdaterMessage(undefined)).toBe('(no message)');
  });

  it('循环引用对象不抛(回落 String)', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatUpdaterMessage(cyclic)).not.toThrow();
  });
});

describe('createElectronUpdaterLogger', () => {
  it('info/warn/error 映射到对应级别,debug 记为 info', () => {
    const recorder = createUpdaterLogRecorder(makeTempDir(), () => new Date('2026-09-12T00:00:00Z'));
    const logger = createElectronUpdaterLogger(recorder);

    logger.info('checking');
    logger.warn('slow');
    logger.error('failed');
    logger.debug?.('verbose detail');

    const lines = readFileSync(recorder.filePath, 'utf8').trimEnd().split('\n');
    expect(lines[0]).toContain('[info] checking');
    expect(lines[1]).toContain('[warn] slow');
    expect(lines[2]).toContain('[error] failed');
    expect(lines[3]).toContain('[info] verbose detail');
  });
});
