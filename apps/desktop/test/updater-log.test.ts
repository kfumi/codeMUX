// 更新器落盘日志契约:按天文件命名、行格式、Error 归一化、electron-updater Logger
// 适配、跨天切档、写盘失败静默。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createElectronUpdaterLogger,
  createUpdaterLogRecorder,
  formatUpdaterMessage,
} from '../src/updater-log';
import { MAX_LOG_TEXT_CHARS } from '../src/log-format';

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
  it('按本地日期命名文件并追加 [时间] [级别] 消息 行,懒建日志目录', () => {
    const logDir = path.join(makeTempDir(), 'logs', 'nested');
    const recorder = createUpdaterLogRecorder(logDir, () => new Date(2026, 8, 12, 8, 9, 10, 481));
    expect(recorder.filePath).toBe(path.join(logDir, 'updater-2026-09-12.log'));

    recorder.record('info', '开始检查更新');
    recorder.record('error', '下载失败');

    const lines = readFileSync(recorder.filePath, 'utf8').trimEnd().split('\n');
    expect(lines).toEqual([
      '[2026-09-12 08:09:10.481] [info] 开始检查更新',
      '[2026-09-12 08:09:10.481] [error] 下载失败',
    ]);
  });

  it('跨天写入新日期文件', () => {
    const dir = makeTempDir();
    let clock = new Date(2026, 8, 12, 23, 59, 0);
    const recorder = createUpdaterLogRecorder(dir, () => clock);
    recorder.record('info', 'day1');
    clock = new Date(2026, 8, 13, 0, 1, 0);
    recorder.record('info', 'day2');

    expect(readFileSync(path.join(dir, 'updater-2026-09-12.log'), 'utf8')).toContain('day1');
    expect(readFileSync(path.join(dir, 'updater-2026-09-13.log'), 'utf8')).toContain('day2');
  });

  it('超过上限时在写入前轮转为 .1', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'updater-2026-09-12.log');
    writeFileSync(filePath, 'old'.repeat(500), 'utf8');
    const recorder = createUpdaterLogRecorder(dir, () => new Date(2026, 8, 12), 1024);

    recorder.record('info', 'after rotate');

    expect(readFileSync(filePath, 'utf8')).toContain('[info] after rotate');
    expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('old'.repeat(500));
  });

  it('单条消息超长时截断并标注', () => {
    const recorder = createUpdaterLogRecorder(makeTempDir(), () => new Date(2026, 8, 12));
    recorder.record('info', 'y'.repeat(MAX_LOG_TEXT_CHARS + 7));
    expect(readFileSync(recorder.filePath, 'utf8')).toContain('...[truncated 7 chars]');
  });

  it('写盘失败静默吞掉(日志不反噬壳)', () => {
    const blocker = path.join(makeTempDir(), 'occupied');
    writeFileSync(blocker, 'not a dir', 'utf8');
    const broken = createUpdaterLogRecorder(path.join(blocker, 'logs'));
    expect(() => broken.record('info', 'should not throw')).not.toThrow();
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
    const recorder = createUpdaterLogRecorder(makeTempDir(), () => new Date(2026, 8, 12));
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
