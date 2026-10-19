//! 日志文件轮转:超过阈值时把当前文件改名为 `<name>.1`(覆盖上一份备份)。
//!
//! 起因:daemon.log / renderer.log 只追加、不封顶,长跑后可达数 MB —— 既拖慢
//! 日志页,也占磁盘。这里给写入侧一个统一的上限判定。日志「绝不反噬壳」:
//! 任何失败(文件被占用/权限不足等)都静默忽略,返回 false。

import { existsSync, renameSync, rmSync, statSync } from 'node:fs';

/** 默认大小上限:5 MB(超过即轮转)。 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** 轮转一次(名如 `daemon.log` → `daemon.log.1`);未超阈值或失败返回 false。 */
export function rotateLogIfOversized(filePath: string, maxBytes: number = MAX_LOG_BYTES): boolean {
  try {
    if (!existsSync(filePath)) return false;
    if (statSync(filePath).size < maxBytes) return false;
    // 先删旧备份:Windows 上 rename 覆盖已存在目标会失败(EBUSY/EPERM)。
    const backup = `${filePath}.1`;
    rmSync(backup, { force: true });
    renameSync(filePath, backup);
    return true;
  } catch {
    return false;
  }
}
