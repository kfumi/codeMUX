// 按天日志路径与保留策略契约。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  dailyLogFileName,
  dailyLogPath,
  localDateStamp,
  MAX_LOG_TOTAL_BYTES,
  pruneDailyLogs,
  scheduleDailyLogPrune,
} from '../src/daily-log';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-daily-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('localDateStamp', () => {
  it('本地年月日补零', () => {
    expect(localDateStamp(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(localDateStamp(new Date(2026, 9, 19))).toBe('2026-10-19');
  });
});

describe('dailyLogFileName / dailyLogPath', () => {
  it('命名 <base>-YYYY-MM-DD.log', () => {
    expect(dailyLogFileName('renderer', new Date(2026, 9, 19))).toBe('renderer-2026-10-19.log');
    expect(dailyLogPath('logs', 'daemon', new Date(2026, 9, 19))).toBe(
      path.join('logs', 'daemon-2026-10-19.log'),
    );
  });
});

describe('pruneDailyLogs', () => {
  it('保留最近 keepDays 个日期(含 .1 备份一起删),不动其它 base 与非日期文件', () => {
    const dir = makeTempDir();
    const names = [
      'daemon-2026-01-01.log',
      'daemon-2026-01-01.log.1',
      'daemon-2026-01-02.log',
      'daemon-2026-01-03.log',
      'daemon-stderr.log',
      'renderer-2026-01-01.log',
    ];
    for (const name of names) writeFileSync(path.join(dir, name), 'x', 'utf8');

    pruneDailyLogs(dir, 'daemon', 2);

    expect(existsSync(path.join(dir, 'daemon-2026-01-01.log'))).toBe(false);
    expect(existsSync(path.join(dir, 'daemon-2026-01-01.log.1'))).toBe(false);
    expect(existsSync(path.join(dir, 'daemon-2026-01-02.log'))).toBe(true);
    expect(existsSync(path.join(dir, 'daemon-2026-01-03.log'))).toBe(true);
    expect(existsSync(path.join(dir, 'daemon-stderr.log'))).toBe(true);
    expect(existsSync(path.join(dir, 'renderer-2026-01-01.log'))).toBe(true);
  });

  it('未超保留天数时不动任何文件', () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'daemon-2026-01-01.log'), 'x', 'utf8');
    pruneDailyLogs(dir, 'daemon', 7);
    expect(existsSync(path.join(dir, 'daemon-2026-01-01.log'))).toBe(true);
  });

  it('总量超上限时从最旧删起,最新日期文件保留', () => {
    const dir = makeTempDir();
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      writeFileSync(path.join(dir, `daemon-${day}.log`), 'x'.repeat(1024), 'utf8');
    }
    pruneDailyLogs(dir, 'daemon', 7, 2048);

    expect(existsSync(path.join(dir, 'daemon-2026-01-01.log'))).toBe(false);
    expect(existsSync(path.join(dir, 'daemon-2026-01-02.log'))).toBe(true);
    expect(existsSync(path.join(dir, 'daemon-2026-01-03.log'))).toBe(true);
  });

  it('最新日期文件即使超过总量上限也不按总量删除', () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'daemon-2026-01-03.log'), 'x'.repeat(4096), 'utf8');
    pruneDailyLogs(dir, 'daemon', 7, 1024);
    expect(existsSync(path.join(dir, 'daemon-2026-01-03.log'))).toBe(true);
  });
});

describe('scheduleDailyLogPrune', () => {
  it('延迟执行清理,不阻塞调用方', async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'daemon-2026-01-01.log'), 'x', 'utf8');
    writeFileSync(path.join(dir, 'daemon-2026-01-02.log'), 'x', 'utf8');

    scheduleDailyLogPrune(dir, 'daemon', 1, MAX_LOG_TOTAL_BYTES, 0);
    expect(existsSync(path.join(dir, 'daemon-2026-01-01.log'))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(path.join(dir, 'daemon-2026-01-01.log'))).toBe(false);
    expect(existsSync(path.join(dir, 'daemon-2026-01-02.log'))).toBe(true);
  });
});
