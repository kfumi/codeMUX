// 日志尾部读取契约:小于上限返回全文,超过上限只给末尾并从整行边界开始,
// 多字节字符不被切成乱码;totalBytes 始终是文件真实大小。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readLogTail } from '../src/log-tail';

const tempDirs: string[] = [];

function writeLog(name: string, content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-log-tail-'));
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

describe('readLogTail', () => {
  it('文件不超过上限时返回全文', () => {
    const content = 'one\ntwo\nthree\n';
    const filePath = writeLog('a.log', content);
    expect(readLogTail(filePath, 1024)).toEqual({
      content,
      truncated: false,
      totalBytes: Buffer.byteLength(content),
    });
  });

  it('超过上限时只返回末尾,且从整行边界开始', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const filePath = writeLog('b.log', lines.join('\n'));
    const tail = readLogTail(filePath, 30);

    expect(tail.truncated).toBe(true);
    expect(tail.totalBytes).toBe(Buffer.byteLength(lines.join('\n')));
    expect(tail.content.endsWith('line-99')).toBe(true);
    // 每一段都必须是完整的原始行,不能出现半行。
    for (const part of tail.content.split('\n')) {
      expect(lines).toContain(part);
    }
  });

  it('起点落在多字节字符中间时不产生替换字符', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `行-${i}中文内容`);
    const filePath = writeLog('c.log', lines.join('\n'));
    const tail = readLogTail(filePath, 25);

    expect(tail.truncated).toBe(true);
    expect(tail.content).not.toContain('\uFFFD');
    for (const part of tail.content.split('\n')) {
      expect(lines).toContain(part);
    }
  });
});
