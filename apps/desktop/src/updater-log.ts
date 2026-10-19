//! 更新器落盘日志:<appDataDir>/logs/updater-YYYY-MM-DD.log(按天归档,与 daemon 日志同目录)。
//!
//! 起因:updater.ts 原先把 `autoUpdater.logger` 设成 null,又把所有更新事件
//! 只往渲染层丢 —— 更新失败(网络/404/校验和/未先 check)在磁盘上不留任何痕迹,
//! 应用内「日志」面板也看不到,线上排障等于盲猜。这里给 electron-updater 本体
//! 和壳侧生命周期各留一份可读时间线。
//!
//! 写盘失败一律静默吞掉:日志绝不反噬壳(与 renderer-log.ts 同一取舍)。

import { appendFileSync, mkdirSync } from 'node:fs';
import { dailyLogPath, LOG_KEEP_DAYS, localDateStamp, scheduleDailyLogPrune } from './daily-log';
import { clampLogText, formatLocalTimestamp } from './log-format';
import { MAX_LOG_BYTES, rotateLogIfOversized } from './log-rotation';

/** 日志文件名 base:实际文件为 `<base>-YYYY-MM-DD.log`。 */
export const UPDATER_LOG_BASE = 'updater';

/** 每累计写入这么多字节才做一次大小判定(避免每条日志都 stat)。 */
const ROTATE_CHECK_EVERY_BYTES = 64 * 1024;

export type UpdaterLogLevel = 'info' | 'warn' | 'error';

export interface UpdaterLogRecorder {
  /** 当前日志文件绝对路径(跨天会变)。 */
  readonly filePath: string;
  record(level: UpdaterLogLevel, message: string): void;
}

/**
 * 归一化 electron-updater 传进来的 message(类型是 any,实际多为 Error 或
 * 拼好的字符串):Error 取 message + stack,其余走 JSON/字符串兜底。
 */
export function formatUpdaterMessage(message: unknown): string {
  if (message instanceof Error) {
    return message.stack ?? `${message.name}: ${message.message}`;
  }
  if (typeof message === 'string') {
    return message;
  }
  if (message === undefined || message === null) {
    return '(no message)';
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/** 创建更新器日志记录器:懒建目录,按天追加,任何写盘错误静默忽略。 */
export function createUpdaterLogRecorder(
  logDir: string,
  now: () => Date = () => new Date(),
  maxBytes: number = MAX_LOG_BYTES,
  keepDays: number = LOG_KEEP_DAYS,
): UpdaterLogRecorder {
  let currentStamp = localDateStamp(now());
  let currentPath = dailyLogPath(logDir, UPDATER_LOG_BASE, now());
  let dirReady = false;
  let bytesSinceCheck = Number.POSITIVE_INFINITY;
  return {
    get filePath(): string {
      return currentPath;
    },
    record(level, message) {
      try {
        if (!dirReady) {
          mkdirSync(logDir, { recursive: true });
          dirReady = true;
          scheduleDailyLogPrune(logDir, UPDATER_LOG_BASE, keepDays);
        }
        const stamp = localDateStamp(now());
        if (stamp !== currentStamp) {
          currentStamp = stamp;
          currentPath = dailyLogPath(logDir, UPDATER_LOG_BASE, now());
          bytesSinceCheck = Number.POSITIVE_INFINITY;
          scheduleDailyLogPrune(logDir, UPDATER_LOG_BASE, keepDays);
        }
        if (bytesSinceCheck >= ROTATE_CHECK_EVERY_BYTES) {
          rotateLogIfOversized(currentPath, maxBytes);
          bytesSinceCheck = 0;
        }
        const entry = `[${formatLocalTimestamp(now())}] [${level}] ${clampLogText(message)}\n`;
        appendFileSync(currentPath, entry, 'utf8');
        bytesSinceCheck += Buffer.byteLength(entry);
      } catch {
        // 日志失败不反噬壳(磁盘满/目录被删等)。
      }
    },
  };
}

/** 没有任何依赖时的兜底记录器(测试或日志目录不可用)。 */
export function createNoopUpdaterLogRecorder(): UpdaterLogRecorder {
  return { filePath: '', record: () => {} };
}

/**
 * 适配成 electron-updater 的 `Logger`(info/warn/error/debug 可选)。
 * electron-updater 内部所有下载/HTTP 细节都走这里,排障时是唯一的信息源。
 */
export function createElectronUpdaterLogger(recorder: UpdaterLogRecorder) {
  return {
    info: (message?: unknown) => recorder.record('info', formatUpdaterMessage(message)),
    warn: (message?: unknown) => recorder.record('warn', formatUpdaterMessage(message)),
    error: (message?: unknown) => recorder.record('error', formatUpdaterMessage(message)),
    debug: (message?: string) => recorder.record('info', formatUpdaterMessage(message)),
  };
}
