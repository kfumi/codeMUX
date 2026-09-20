//! 渲染层 console 落盘(工单 09:接替 Tauri log 插件的打包态文件日志)。
//!
//! 前端 src/lib/logger.ts 现仅输出 console;打包态没有 devtools 时这些日志
//! 会丢失。main 进程把主窗口的 `console-message` 事件接到这里,追加写入
//! `<appDataDir>/logs/renderer.log`(与 daemon.log 同目录)。纯 Node 可测;
//! 写盘失败静默吞掉 —— 日志绝不反噬壳。

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { formatLocalTimestamp } from './log-format';

export const RENDERER_LOG_FILE = 'renderer.log';

/** Electron console-message 的 level 枚举(legacy 数字签名)。 */
const LEVEL_NAMES: Record<number, string> = {
  0: 'verbose',
  1: 'info',
  2: 'warn',
  3: 'error',
};

export interface RendererLogRecorder {
  /** 目标文件绝对路径(排障/日志清单入口用)。 */
  filePath: string;
  record(level: number, message: string, line: number, sourceId: string): void;
}

/** 创建渲染层日志记录器:懒建目录,逐行追加,任何写盘错误静默忽略。 */
export function createRendererLogRecorder(
  logDir: string,
  now: () => Date = () => new Date(),
): RendererLogRecorder {
  const filePath = path.join(logDir, RENDERER_LOG_FILE);
  let dirReady = false;
  return {
    filePath,
    record(level, message, line, sourceId) {
      try {
        if (!dirReady) {
          mkdirSync(logDir, { recursive: true });
          dirReady = true;
        }
        const levelName = LEVEL_NAMES[level] ?? `level${level}`;
        const origin = sourceId ? ` (${sourceId}:${line})` : '';
        appendFileSync(filePath, `[${formatLocalTimestamp(now())}] [${levelName}] ${message}${origin}\n`, 'utf8');
      } catch {
        // 日志失败不反噬壳(磁盘满/目录被删等)。
      }
    },
  };
}
