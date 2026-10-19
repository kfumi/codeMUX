//! 按天命名的日志文件路径与保留策略(壳侧 renderer/updater 与 daemon 侧共用命名约定)。
//!
//! 命名 `<base>-YYYY-MM-DD.log`(本地时区):当天文件即「实时」文件,历史按日期归档。
//! 同一天超出大小上限时轮转为 `<base>-YYYY-MM-DD.log.1`(见 log-rotation.ts)。
//! 保留策略:每个 base 只保留最近 `LOG_KEEP_DAYS` 个日期,更旧的删除(失败静默)。

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** 每个日志 base 默认保留的天数。 */
export const LOG_KEEP_DAYS = 7;

/** 每个 base 的日志总量上限(保留日期 + `.1` 备份合计);超出从最旧删起。 */
export const MAX_LOG_TOTAL_BYTES = 20 * 1024 * 1024;

/** 后台清理延迟:不跟写入/跨天路径抢 IO。 */
export const LOG_PRUNE_DELAY_MS = 3000;

const p2 = (n: number): string => n.toString().padStart(2, '0');

/** 本地时区的 `YYYY-MM-DD`(与 log-format.ts 的时间戳同一时区口径)。 */
export function localDateStamp(date: Date = new Date()): string {
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
}

/** 当天日志文件名,如 `renderer-2026-10-19.log`。 */
export function dailyLogFileName(base: string, date: Date = new Date()): string {
  return `${base}-${localDateStamp(date)}.log`;
}

/** 当天日志文件绝对路径。 */
export function dailyLogPath(logDir: string, base: string, date: Date = new Date()): string {
  return path.join(logDir, dailyLogFileName(base, date));
}

/** 匹配 `<base>-YYYY-MM-DD.log` 或带大小轮转后缀的 `<base>-YYYY-MM-DD.log.1`。 */
const DATED_LOG = /-(\d{4}-\d{2}-\d{2})\.log(?:\.(\d+))?$/;

/** 大小轮转后缀序号(`.log` 为 0,`.log.1` 为 1)。 */
function backupIndex(name: string): number {
  const at = name.indexOf('.log');
  const suffix = at >= 0 ? name.slice(at + 4) : '';
  return suffix.startsWith('.') ? Number(suffix.slice(1)) || 0 : 0;
}

/** 删除 base 下过期日期与超出总量上限的日志;任何失败静默。 */
export function pruneDailyLogs(
  logDir: string,
  base: string,
  keepDays: number = LOG_KEEP_DAYS,
  maxTotalBytes: number = MAX_LOG_TOTAL_BYTES,
): void {
  try {
    if (!existsSync(logDir)) return;
    const prefix = `${base}-`;
    const names = readdirSync(logDir);
    const dates = new Set<string>();
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const match = DATED_LOG.exec(name);
      if (match) dates.add(match[1]);
    }
    const sorted = [...dates].sort();
    const expired = new Set(sorted.slice(0, Math.max(0, sorted.length - keepDays)));

    const remaining: Array<{ name: string; stamp: string; index: number; size: number }> = [];
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const match = DATED_LOG.exec(name);
      if (!match) continue;
      const stamp = match[1];
      if (expired.has(stamp)) {
        rmSync(path.join(logDir, name), { force: true });
        continue;
      }
      let size = 0;
      try {
        size = statSync(path.join(logDir, name)).size;
      } catch {
        size = 0;
      }
      remaining.push({ name, stamp, index: backupIndex(name), size });
    }

    let total = remaining.reduce((sum, file) => sum + file.size, 0);
    if (total <= maxTotalBytes) return;

    // 从最旧删起;当天(最新日期)文件永不按总量删除,单文件上限由大小轮转兜底。
    const newestStamp = sorted[sorted.length - 1];
    remaining.sort((left, right) => {
      if (left.stamp !== right.stamp) return left.stamp < right.stamp ? -1 : 1;
      return left.index - right.index;
    });
    for (const file of remaining) {
      if (total <= maxTotalBytes) break;
      if (file.stamp === newestStamp) continue;
      rmSync(path.join(logDir, file.name), { force: true });
      total -= file.size;
    }
  } catch {
    // 清理失败不影响写入。
  }
}

/** 延迟清理(默认 3s):调用方只负责触发,不阻塞写入路径。 */
export function scheduleDailyLogPrune(
  logDir: string,
  base: string,
  keepDays: number = LOG_KEEP_DAYS,
  maxTotalBytes: number = MAX_LOG_TOTAL_BYTES,
  delayMs: number = LOG_PRUNE_DELAY_MS,
): void {
  try {
    const timer = setTimeout(() => {
      pruneDailyLogs(logDir, base, keepDays, maxTotalBytes);
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
  } catch {
    // 定时器创建失败也不影响写入。
  }
}
