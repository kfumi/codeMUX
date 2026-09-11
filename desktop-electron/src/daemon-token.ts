//! Local Daemon Token 读取(main 进程共用,纯 Node 可测)。
//!
//! daemon 启动时在 `<appDataDir>/local-daemon-token` 落盘(明文,仅回环可用);
//! 壳侧只读:自动化 WS 客户端用容错版(null 回退),渲染层 IPC 通道用显式报错版。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LOCAL_DAEMON_TOKEN_FILE = 'local-daemon-token';

/** 读取 token;文件缺失或内容为空返回 null(容错路径用)。 */
export function readLocalDaemonToken(appDataDir: string): string | null {
  try {
    const tokenPath = path.join(appDataDir, LOCAL_DAEMON_TOKEN_FILE);
    if (!existsSync(tokenPath)) return null;
    const token = readFileSync(tokenPath, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

/** 读取 token;缺失/为空抛出带原因的明确错误(渲染层 getLocalDaemonToken 通道用)。 */
export function readLocalDaemonTokenOrThrow(appDataDir: string): string {
  const tokenPath = path.join(appDataDir, LOCAL_DAEMON_TOKEN_FILE);
  if (!existsSync(tokenPath)) {
    throw new Error('local-daemon-token 尚未生成(daemon 未启动?)');
  }
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!token) {
    throw new Error('local-daemon-token 为空');
  }
  return token;
}
