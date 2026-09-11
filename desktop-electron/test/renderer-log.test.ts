// 渲染层 console 落盘契约(工单 09:接替 Tauri log 插件的打包态文件日志):
// 行格式、level 映射、懒建目录、写盘失败静默。
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RENDERER_LOG_FILE, createRendererLogRecorder } from '../src/renderer-log';

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
  it('追加写入 [时间] [级别] 消息 (来源:行) 行,并懒建日志目录', () => {
    const logDir = path.join(makeTempDir(), 'logs', 'nested');
    const recorder = createRendererLogRecorder(logDir, () => new Date('2026-09-12T08:09:10Z'));
    expect(recorder.filePath).toBe(path.join(logDir, RENDERER_LOG_FILE));

    recorder.record(1, 'hello renderer', 42, 'app:///src/main.tsx');
    recorder.record(3, 'boom', 7, 'app:///src/main.tsx');

    const lines = readFileSync(recorder.filePath, 'utf8').trimEnd().split('\n');
    expect(lines).toEqual([
      '[2026-09-12T08:09:10.000Z] [info] hello renderer (app:///src/main.tsx:42)',
      '[2026-09-12T08:09:10.000Z] [error] boom (app:///src/main.tsx:7)',
    ]);
  });

  it('level 数字映射:0=verbose / 2=warn / 未知值原样标注', () => {
    const dir = makeTempDir();
    const recorder = createRendererLogRecorder(dir, () => new Date('2026-09-12T00:00:00Z'));
    recorder.record(0, 'v', 1, '');
    recorder.record(2, 'w', 1, '');
    recorder.record(9, 'x', 1, '');
    const lines = readFileSync(recorder.filePath, 'utf8').trimEnd().split('\n');
    expect(lines[0]).toContain('[verbose] v');
    expect(lines[1]).toContain('[warn] w');
    expect(lines[2]).toContain('[level9] x');
  });

  it('无来源信息时省略 origin 段;写盘失败静默吞掉', () => {
    const dir = makeTempDir();
    const recorder = createRendererLogRecorder(dir, () => new Date('2026-09-12T00:00:00Z'));
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
