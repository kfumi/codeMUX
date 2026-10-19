// 渲染层 console 落盘契约(工单 09:接替 Tauri log 插件的打包态文件日志):
// 按天文件命名、level 映射、懒建目录、跨天切档、保留策略、写盘失败静默。
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOG_PRUNE_DELAY_MS } from '../src/daily-log';
import { MAX_LOG_TEXT_CHARS } from '../src/log-format';
import { createRendererLogRecorder } from '../src/renderer-log';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-renderer-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createRendererLogRecorder', () => {
  it('按本地日期命名文件并追加 [时间] [级别] 消息 (来源:行) 行,懒建日志目录', () => {
    const logDir = path.join(makeTempDir(), 'logs', 'nested');
    const recorder = createRendererLogRecorder(logDir, () => new Date(2026, 8, 12, 8, 9, 10, 481));
    expect(recorder.filePath).toBe(path.join(logDir, 'renderer-2026-09-12.log'));

    recorder.record(1, 'hello renderer', 42, 'app:///src/main.tsx');
    recorder.record(3, 'boom', 7, 'app:///src/main.tsx');

    const lines = readFileSync(recorder.filePath, 'utf8').trimEnd().split('\n');
    expect(lines).toEqual([
      '[2026-09-12 08:09:10.481] [info] hello renderer (app:///src/main.tsx:42)',
      '[2026-09-12 08:09:10.481] [error] boom (app:///src/main.tsx:7)',
    ]);
  });

  it('level 数字映射:0=verbose / 2=warn / 未知值原样标注', () => {
    const dir = makeTempDir();
    const recorder = createRendererLogRecorder(dir, () => new Date(2026, 8, 12));
    recorder.record(0, 'v', 1, '');
    recorder.record(2, 'w', 1, '');
    recorder.record(9, 'x', 1, '');
    const lines = readFileSync(recorder.filePath, 'utf8').trimEnd().split('\n');
    expect(lines[0]).toContain('[verbose] v');
    expect(lines[1]).toContain('[warn] w');
    expect(lines[2]).toContain('[level9] x');
  });

  it('跨天写入新日期文件', () => {
    const dir = makeTempDir();
    let clock = new Date(2026, 8, 12, 23, 59, 0);
    const recorder = createRendererLogRecorder(dir, () => clock);

    recorder.record(1, 'day1', 0, '');
    clock = new Date(2026, 8, 13, 0, 1, 0);
    recorder.record(1, 'day2', 0, '');

    expect(readFileSync(path.join(dir, 'renderer-2026-09-12.log'), 'utf8')).toContain('day1');
    expect(readFileSync(path.join(dir, 'renderer-2026-09-13.log'), 'utf8')).toContain('day2');
  });

  it('保留策略:后台只留最近 keepDays 个日期', () => {
    vi.useFakeTimers();
    try {
      const dir = makeTempDir();
      for (const day of ['2026-09-01', '2026-09-02', '2026-09-12']) {
        writeFileSync(path.join(dir, `renderer-${day}.log`), 'x', 'utf8');
      }
      const recorder = createRendererLogRecorder(dir, () => new Date(2026, 8, 12), 1024 * 1024, 2);
      recorder.record(1, 'now', 0, '');

      // 清理是延迟执行的:写入当下旧文件仍在。
      expect(existsSync(path.join(dir, 'renderer-2026-09-01.log'))).toBe(true);
      vi.advanceTimersByTime(LOG_PRUNE_DELAY_MS);

      expect(existsSync(path.join(dir, 'renderer-2026-09-01.log'))).toBe(false);
      expect(existsSync(path.join(dir, 'renderer-2026-09-02.log'))).toBe(true);
      expect(existsSync(path.join(dir, 'renderer-2026-09-12.log'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('单条消息超长时截断并标注', () => {
    const dir = makeTempDir();
    const recorder = createRendererLogRecorder(dir, () => new Date(2026, 8, 12));
    recorder.record(1, 'x'.repeat(MAX_LOG_TEXT_CHARS + 50), 0, '');
    const content = readFileSync(recorder.filePath, 'utf8');
    expect(content).toContain('...[truncated 50 chars]');
    expect(content.length).toBeLessThan(MAX_LOG_TEXT_CHARS + 200);
  });

  it('超过上限时在写入前轮转为 .1', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'renderer-2026-09-12.log');
    writeFileSync(filePath, 'old'.repeat(500), 'utf8');
    const recorder = createRendererLogRecorder(dir, () => new Date(2026, 8, 12), 1024);

    recorder.record(1, 'after rotate', 1, '');

    expect(readFileSync(filePath, 'utf8')).toContain('[info] after rotate');
    expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('old'.repeat(500));
  });

  it('无来源信息时省略 origin 段;写盘失败静默吞掉', () => {
    const dir = makeTempDir();
    const recorder = createRendererLogRecorder(dir, () => new Date(2026, 8, 12));
    recorder.record(1, 'no origin', 0, '');
    expect(readFileSync(recorder.filePath, 'utf8')).toContain('[info] no origin\n');

    // 把日志目录换成普通文件 → mkdir/append 必败,record 不得抛出。
    const blocker = path.join(makeTempDir(), 'occupied');
    writeFileSync(blocker, 'not a dir', 'utf8');
    const broken = createRendererLogRecorder(path.join(blocker, 'logs'));
    expect(() => broken.record(1, 'should not throw', 1, 'x')).not.toThrow();
    expect(existsSync(path.join(blocker, 'logs'))).toBe(false);
    expect(statSync(blocker).isFile()).toBe(true);
  });
});
