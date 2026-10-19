//! 日志尾部读取(工单:日志页卡顿修复)。
//!
//! 旧实现 readLogFile 用 readFileSync 把整份日志读进 main 进程,再经 IPC 全量
//! 传给渲染层 —— daemon.log / renderer.log 可长到数 MB,既是主进程同步阻塞,
//! 又让渲染层每 3s 重建数万行 DOM。这里改为按 fd 定位、只读文件末尾 maxBytes,
//! 从源头把成本压成常量。

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** 日志页一次读取的最大字节数(512 KB ≈ 数千行,足够排障)。 */
export const LOG_TAIL_BYTES = 512 * 1024;

export interface LogTail {
  /** 文件尾部内容(truncated 时起点已对齐到整行边界)。 */
  content: string;
  /** 文件大于 maxBytes、内容被截断。 */
  truncated: boolean;
  /** 文件真实字节数(用于向用户说明「共多大」)。 */
  totalBytes: number;
}

/** 读取文件末尾 maxBytes(不超过文件大小时返回全文);首行若被截断则丢弃半行。 */
export function readLogTail(filePath: string, maxBytes: number = LOG_TAIL_BYTES): LogTail {
  const fd = openSync(filePath, 'r');
  try {
    const totalBytes = fstatSync(fd).size;
    const start = Math.max(0, totalBytes - maxBytes);
    const length = totalBytes - start;
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const read = readSync(fd, buffer, filled, length - filled, start + filled);
      if (read <= 0) break;
      filled += read;
    }
    let content = buffer.subarray(0, filled).toString('utf8');
    if (start > 0) {
      // start 可能落在某行中间(甚至多字节字符中间):丢掉第一个换行前的内容。
      const newline = content.indexOf('\n');
      content = newline === -1 ? '' : content.slice(newline + 1);
    }
    return { content, truncated: start > 0, totalBytes };
  } finally {
    closeSync(fd);
  }
}
