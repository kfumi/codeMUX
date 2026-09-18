import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_NON_PROJECT_FOLDER = 'CodemuxProject';

export function resolveDefaultWorkingDirectory(homeDir = os.homedir()): string {
  return path.join(homeDir, DEFAULT_NON_PROJECT_FOLDER);
}

export function isDefaultWorkingDirectoryRequest(cwd: string | undefined | null): boolean {
  const normalized = cwd?.trim();
  return !normalized || normalized === '.';
}

export function resolveWorkingDirectory(cwd: string | undefined | null, homeDir = os.homedir()): string {
  if (isDefaultWorkingDirectoryRequest(cwd)) {
    return resolveDefaultWorkingDirectory(homeDir);
  }

  return cwd as string;
}

export function ensureWorkingDirectory(cwd: string | undefined | null, homeDir = os.homedir()): string {
  const resolved = resolveWorkingDirectory(cwd, homeDir);
  if (isDefaultWorkingDirectoryRequest(cwd)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * 会话 cwd 可用性预检:返回确保可用的绝对路径,不可用时抛出可定位的错误。
 *
 * 背景:claude.exe 的 spawn 对不存在的 cwd 抛 ENOENT,而 agent SDK 会把它
 * 误报成 "native binary failed to launch / libc 不匹配",极难排查。这里在
 * spawn 前拦截(常路径一次 statSync,开销可忽略)。
 *
 * 默认工作目录('.'/'')仍由 ensureWorkingDirectory 惰性创建;显式路径
 * 不做隐式创建 —— 避免把手输错误的路径静默变成新目录,直接报明确错误。
 */
export function assertWorkingDirectory(cwd: string | undefined | null, homeDir = os.homedir()): string {
  const resolved = ensureWorkingDirectory(cwd, homeDir);
  let stats: fs.Stats | undefined;
  try {
    stats = fs.statSync(resolved);
  } catch {
    stats = undefined;
  }
  if (!stats || !stats.isDirectory()) {
    throw new Error(
      `会话工作目录不存在或不可用: ${resolved} — 请在会话设置中选择一个已存在的目录后重试`,
    );
  }
  return resolved;
}
