//! 「打开资源管理器 / 用编辑器或终端打开路径」的纯 Node 实现件。
//! TS 复刻 crates/daemon/src/commands/file.rs 的最小面(open_in_explorer +
//! open_project_path),Windows 优先;命令序列与 Rust 版对齐。

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export type OpenTarget = 'vscode' | 'cursor' | 'file_explorer' | 'terminal' | 'git_bash';

interface SpawnResult {
  ok: boolean;
  error?: string;
}

function spawnDetached(program: string, args: string[], options: { hideWindow?: boolean } = {}): SpawnResult {
  try {
    const child = spawn(program, args, {
      detached: false,
      windowsHide: options.hideWindow ?? false,
      stdio: 'ignore',
    });
    // spawn 成功即视为成功(对齐 Rust spawn:不等待进程退出)。
    child.on('error', () => {
      /* async error:首次 spawn 同步失败时走 catch,这里兜底 */
    });
    if (child.pid) {
      return { ok: true };
    }
    return { ok: false, error: `${program}: no pid` };
  } catch (error) {
    return { ok: false, error: `${program}: ${String(error)}` };
  }
}

function trySpawnSequential(attempts: Array<() => SpawnResult>): SpawnResult {
  let last: SpawnResult = { ok: false, error: 'no attempt' };
  for (const attempt of attempts) {
    last = attempt();
    if (last.ok) return last;
  }
  return last;
}

/** 打开目录,或 reveal 文件(对齐 Rust open_in_explorer 的行为)。 */
export function openInExplorerPath(rawPath: string, reveal = false): Promise<void> {
  const trimmed = rawPath.trim();
  if (!trimmed || !existsSync(trimmed)) {
    return Promise.reject(new Error(`路径不存在: ${trimmed}`));
  }
  const isFile = statSync(trimmed).isFile();
  const shouldReveal = reveal || isFile;
  if (process.platform === 'win32') {
    const result = shouldReveal
      ? spawnDetached('explorer', ['/select,', path.resolve(trimmed)])
      : spawnDetached('explorer', [path.resolve(trimmed)]);
    return result.ok ? Promise.resolve() : Promise.reject(new Error(`Failed to open explorer: ${result.error}`));
  }
  if (process.platform === 'darwin') {
    const result = spawnDetached('open', shouldReveal ? ['-R', trimmed] : [trimmed]);
    return result.ok ? Promise.resolve() : Promise.reject(new Error(`Failed to open finder: ${result.error}`));
  }
  const result = spawnDetached('xdg-open', [trimmed]);
  return result.ok ? Promise.resolve() : Promise.reject(new Error(`Failed to open file manager: ${result.error}`));
}

function windowsProgramCandidate(paths: string[]): string | null {
  for (const candidate of paths) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function cmdWrapper(command: string, args: string[]): SpawnResult {
  const comspec = process.env.comspec ?? 'cmd.exe';
  try {
    const child = spawn(comspec, ['/d', '/s', '/c', command, ...args], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      /* async fallback */
    });
    return child.pid ? { ok: true } : { ok: false, error: command };
  } catch (error) {
    return { ok: false, error: `${command}: ${String(error)}` };
  }
}

/**
 * 用目标编辑器/终端打开路径(对齐 Rust open_project_path 的 Windows 分支;
 * macOS/Linux 走等价命令)。任一候选命令 spawn 成功即成功。
 */
export async function openProjectPath(rawPath: string, target: string): Promise<void> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error('无效路径');
  }
  if (!existsSync(trimmed)) {
    throw new Error(`路径不存在: ${trimmed}`);
  }
  const isDir = statSync(trimmed).isDirectory();
  const isFile = !isDir;

  if (target === 'file_explorer') {
    if (isFile) return openInExplorerPath(trimmed, true);
    return openInExplorerPath(trimmed, false);
  }
  if ((target === 'terminal' || target === 'git_bash') && !isDir) {
    throw new Error(`不是目录: ${trimmed}`);
  }

  const abs = path.resolve(trimmed);
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  if (target === 'vscode') {
    if (process.platform === 'win32') {
      const exe = windowsProgramCandidate([
        path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
        path.join(programFilesX86, 'Microsoft VS Code', 'Code.exe'),
      ]);
      const errors: string[] = [];
      const result = trySpawnSequential([
        ...(exe ? [() => { const r = spawnDetached(exe, [abs]); if (!r.ok) errors.push(r.error ?? ''); return r; }] : []),
        () => { const r = cmdWrapper('code', [abs]); if (!r.ok) errors.push(r.error ?? ''); return r; },
      ]);
      if (!result.ok) {
        throw new Error(`Failed to open project. Tried: ${errors.join('; ')}`);
      }
      return;
    }
    const program = process.platform === 'darwin' ? 'open' : 'code';
    const args = process.platform === 'darwin' ? ['-a', 'Visual Studio Code', abs] : [abs];
    const result = spawnDetached(program, args);
    if (!result.ok) throw new Error(`Failed to open project. Tried: ${result.error}`);
    return;
  }

  if (target === 'cursor') {
    if (process.platform === 'win32') {
      const exe = windowsProgramCandidate([
        path.join(localAppData, 'Programs', 'Cursor', 'Cursor.exe'),
        path.join(localAppData, 'Programs', 'cursor', 'Cursor.exe'),
        path.join(programFiles, 'Programs', 'Cursor', 'Cursor.exe'),
        path.join(programFilesX86, 'Programs', 'Cursor', 'Cursor.exe'),
      ]);
      const errors: string[] = [];
      const result = trySpawnSequential([
        ...(exe ? [() => { const r = spawnDetached(exe, [abs]); if (!r.ok) errors.push(r.error ?? ''); return r; }] : []),
        () => { const r = cmdWrapper('cursor', [abs]); if (!r.ok) errors.push(r.error ?? ''); return r; },
      ]);
      if (!result.ok) {
        throw new Error(`Failed to open project. Tried: ${errors.join('; ')}`);
      }
      return;
    }
    const program = process.platform === 'darwin' ? 'open' : 'cursor';
    const args = process.platform === 'darwin' ? ['-a', 'Cursor', abs] : [abs];
    const result = spawnDetached(program, args);
    if (!result.ok) throw new Error(`Failed to open project. Tried: ${result.error}`);
    return;
  }

  if (target === 'terminal') {
    if (process.platform === 'win32') {
      const errors: string[] = [];
      const result = trySpawnSequential([
        () => { const r = spawnDetached('wt', ['-d', abs]); if (!r.ok) errors.push(r.error ?? ''); return r; },
        () => { const r = cmdWrapper('wt', ['-d', abs]); if (!r.ok) errors.push(r.error ?? ''); return r; },
        () => {
          const r = spawnDetached(
            'powershell',
            ['-NoExit', '-Command', `Set-Location -LiteralPath '${abs.replace(/'/g, "''")}'`],
            { hideWindow: false },
          );
          if (!r.ok) errors.push(r.error ?? '');
          return r;
        },
      ]);
      if (!result.ok) {
        throw new Error(`Failed to open project. Tried: ${errors.join('; ')}`);
      }
      return;
    }
    if (process.platform === 'darwin') {
      const result = spawnDetached('open', ['-a', 'Terminal', abs]);
      if (!result.ok) throw new Error(`Failed to open project. Tried: ${result.error}`);
      return;
    }
    const result = spawnDetached('x-terminal-emulator', ['--working-directory', abs]);
    if (!result.ok) throw new Error(`Failed to open project. Tried: ${result.error}`);
    return;
  }

  if (target === 'git_bash') {
    if (process.platform === 'win32') {
      const exe = windowsProgramCandidate([
        path.join(programFiles, 'Git', 'git-bash.exe'),
        path.join(programFilesX86, 'Git', 'git-bash.exe'),
      ]);
      const errors: string[] = [];
      const result = trySpawnSequential([
        ...(exe ? [() => { const r = spawnDetached(exe, [`--cd=${abs}`]); if (!r.ok) errors.push(r.error ?? ''); return r; }] : []),
        () => { const r = cmdWrapper('git-bash.exe', [`--cd=${abs}`]); if (!r.ok) errors.push(r.error ?? ''); return r; },
      ]);
      if (!result.ok) {
        throw new Error(`Failed to open project. Tried: ${errors.join('; ')}`);
      }
      return;
    }
    const result = spawnDetached('git-bash', [`--cd=${abs}`]);
    if (!result.ok) throw new Error(`Failed to open project. Tried: ${result.error}`);
    return;
  }

  throw new Error(`Unsupported project open target: ${target}`);
}
