//! 渲染层 console 落盘(工单 09:接替 Tauri log 插件的打包态文件日志)。
//!
//! 前端 src/lib/logger.ts 现仅输出 console;打包态没有 devtools 时这些日志
//! 会丢失。main 进程把主窗口的 `console-message` 事件接到这里,追加写入
//! `<appDataDir>/logs/renderer-YYYY-MM-DD.log`(按天归档,与 daemon 日志同目录)。
//! 纯 Node 可测;写盘失败静默吞掉 —— 日志绝不反噬壳。

import { appendFileSync, mkdirSync } from 'node:fs';
import { dailyLogPath, LOG_KEEP_DAYS, localDateStamp, scheduleDailyLogPrune } from './daily-log';
import { clampLogText, formatLocalTimestamp } from './log-format';
import { MAX_LOG_BYTES, rotateLogIfOversized } from './log-rotation';

/** 日志文件名 base:实际文件为 `<base>-YYYY-MM-DD.log`。 */
export const RENDERER_LOG_BASE = 'renderer';

/** 每累计写入这么多字节才做一次大小判定(避免每条日志都 stat)。 */
const ROTATE_CHECK_EVERY_BYTES = 64 * 1024;

/** Electron console-message 的 level 枚举(legacy 数字签名)。 */
const LEVEL_NAMES: Record<number, string> = {
  0: 'verbose',
  1: 'info',
  2: 'warn',
  3: 'error',
};

export interface RendererLogRecorder {
  /** 当前日志文件绝对路径(跨天会变)。 */
  readonly filePath: string;
  record(level: number, message: string, line: number, sourceId: string): void;
}

/** 创建渲染层日志记录器:懒建目录,按天追加,任何写盘错误静默忽略。 */
export function createRendererLogRecorder(
  logDir: string,
  now: () => Date = () => new Date(),
  maxBytes: number = MAX_LOG_BYTES,
  keepDays: number = LOG_KEEP_DAYS,
): RendererLogRecorder {
  let currentStamp = localDateStamp(now());
  let currentPath = dailyLogPath(logDir, RENDERER_LOG_BASE, now());
  let dirReady = false;
  let bytesSinceCheck = Number.POSITIVE_INFINITY;
  return {
    get filePath(): string {
      return currentPath;
    },
    record(level, message, line, sourceId) {
      try {
        if (!dirReady) {
          mkdirSync(logDir, { recursive: true });
          dirReady = true;
          scheduleDailyLogPrune(logDir, RENDERER_LOG_BASE, keepDays);
        }
        // 跨天:切到新日期的文件,并清理过期归档。
        const stamp = localDateStamp(now());
        if (stamp !== currentStamp) {
          currentStamp = stamp;
          currentPath = dailyLogPath(logDir, RENDERER_LOG_BASE, now());
          bytesSinceCheck = Number.POSITIVE_INFINITY;
          scheduleDailyLogPrune(logDir, RENDERER_LOG_BASE, keepDays);
        }
        if (bytesSinceCheck >= ROTATE_CHECK_EVERY_BYTES) {
          rotateLogIfOversized(currentPath, maxBytes);
          bytesSinceCheck = 0;
        }
        const levelName = LEVEL_NAMES[level] ?? `level${level}`;
        const origin = sourceId ? ` (${sourceId}:${line})` : '';
        const entry = `[${formatLocalTimestamp(now())}] [${levelName}] ${clampLogText(message)}${origin}\n`;
        appendFileSync(currentPath, entry, 'utf8');
        bytesSinceCheck += Buffer.byteLength(entry);
      } catch {
        // 日志失败不反噬壳(磁盘满/目录被删等)。
      }
    },
  };
}
