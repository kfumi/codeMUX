//! 更新器落盘日志:<appDataDir>/logs/updater.log(与 daemon.log / renderer.log 同目录)。
//!
//! 起因:updater.ts 原先把 `autoUpdater.logger` 设成 null,又把所有更新事件
//! 只往渲染层丢 —— 更新失败(网络/404/校验和/未先 check)在磁盘上不留任何痕迹,
//! 应用内「日志」面板也看不到,线上排障等于盲猜。这里给 electron-updater 本体
//! 和壳侧生命周期各留一份可读时间线。
//!
//! 写盘失败一律静默吞掉:日志绝不反噬壳(与 renderer-log.ts 同一取舍)。

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { formatLocalTimestamp } from './log-format';

export const UPDATER_LOG_FILE = 'updater.log';

export type UpdaterLogLevel = 'info' | 'warn' | 'error';

export interface UpdaterLogRecorder {
  /** 目标文件绝对路径(排障时直接让用户去看这个文件)。 */
  filePath: string;
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

/** 创建更新器日志记录器:懒建目录,逐行追加,任何写盘错误静默忽略。 */
export function createUpdaterLogRecorder(
  logDir: string,
  now: () => Date = () => new Date(),
): UpdaterLogRecorder {
  const filePath = path.join(logDir, UPDATER_LOG_FILE);
  let dirReady = false;
  return {
    filePath,
    record(level, message) {
      try {
        if (!dirReady) {
          mkdirSync(logDir, { recursive: true });
          dirReady = true;
        }
        appendFileSync(filePath, `[${formatLocalTimestamp(now())}] [${level}] ${message}\n`, 'utf8');
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
