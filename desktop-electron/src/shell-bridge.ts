//! 壳门面的 main 进程实现:注册 `codemux:*` IPC 通道,供 sandboxed preload
//! 经 contextBridge 暴露给渲染层(工单 05)。
//!
//! 通道面与前端审计对齐(见 src/lib/tauri.ts / src/lib/facades/shell-facade.ts):
//! - token / 目录 / 日志 / 通知 / 主窗口
//! - 开发环境与 agent 运行时检测(最小面,见 agent-checks.ts)
//! - open_in_explorer / open_project_path / read_home_file
//! - browser.* 13 方法:除纯窗口几何(hide/show/setBounds,no-op)外全部迁移中拒绝(工单 07)
//! - daemonRestart / getDaemonInfo(supervisor 出口)

import { BrowserWindow, Notification, ipcMain, type WebContents } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkAgentRuntimes,
  checkDevelopmentEnvironment,
  probeAgentInstallations,
  upgradeAgentRuntime,
} from './agent-checks';
import { openInExplorerPath, openProjectPath } from './open-project';
import type { Supervisor } from './supervisor';

export interface ShellBridgeDeps {
  /** 与 Tauri 版 app_data_dir 完全一致(零迁移)。 */
  getAppDataDir(): string;
  /** 日志目录(壳自身日志 + daemon.log 同目录)。 */
  getLogDir(): string;
  /** 现有主窗口(可能为 null,例如仍隐藏/已关闭)。 */
  getMainWindow(): BrowserWindow | null;
  /** 恢复/聚焦主窗口。 */
  showMainWindow(): void;
  /** supervisor 出口。 */
  supervisor: Supervisor;
  /** 渲染层事件出口(通知点击等)。 */
  sendToRenderer(channel: string, payload: unknown): void;
}

function webContentsOf(window: BrowserWindow | null): WebContents | null {
  if (!window || window.isDestroyed()) return null;
  return window.webContents ?? null;
}

/** 与 Rust LogFileInfo 同形:{name, path, size, modified:"YYYY-MM-DD HH:MM:SS"},按修改时间倒序。 */
function listLogFiles(logDir: string): Array<{ name: string; path: string; size: number; modified: string }> {
  if (!existsSync(logDir)) {
    return [];
  }
  const files: Array<{ name: string; path: string; size: number; modified: string }> = [];
  for (const entry of readdirSync(logDir)) {
    const fullPath = path.join(logDir, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    files.push({
      name: entry,
      path: fullPath,
      size: stats.size,
      modified: stats.mtime
        ? `${stats.mtime.getFullYear().toString().padStart(4, '0')}-`
          + `${(stats.mtime.getMonth() + 1).toString().padStart(2, '0')}-`
          + `${stats.mtime.getDate().toString().padStart(2, '0')} `
          + `${stats.mtime.getHours().toString().padStart(2, '0')}:`
          + `${stats.mtime.getMinutes().toString().padStart(2, '0')}:`
          + `${stats.mtime.getSeconds().toString().padStart(2, '0')}`
        : '',
    });
  }
  files.sort((a, b) => b.modified.localeCompare(a.modified));
  return files;
}

/** read_home_file 的安全校验(对齐 resolve_secure_home_path:拒绝绝对路径与 `..`)。 */
function readHomeFile(relativePath: string): string {
  const relative = relativePath.trim();
  if (path.isAbsolute(relative)) {
    throw new Error('Invalid home file path: path must be relative');
  }
  if (relative.split(/[\\/]/).includes('..')) {
    throw new Error("Invalid home file path: '..' components are not allowed");
  }
  const home = os.homedir();
  const target = path.resolve(home, relative);
  const resolved = path.resolve(target);
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new Error(`Access denied: home file path is outside home directory, path '${relativePath}'`);
  }
  return readFileSync(resolved, 'utf8');
}

/** 注册全部 `codemux:*` IPC 通道;返回解除注册(测试/热重载用)。 */
export function registerShellBridge(deps: ShellBridgeDeps): () => void {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const handle = <T>(channel: string, handler: (payload: T) => unknown): void => {
    handlers.set(channel, handler as (payload: unknown) => unknown);
    ipcMain.handle(`codemux:${channel}`, (_event, payload: T) =>
      Promise.resolve().then(() => handler(payload)));
  };

  // --- token / 目录 / 日志 -------------------------------------------------
  handle('getLocalDaemonToken', () => {
    // Local Daemon Token 由 daemon 在 app-data-dir 落盘(local-daemon-token 明文文件);
    // 壳侧只读,Tauri 版同样语义(daemon 启动时已 ensure)。
    const tokenPath = path.join(deps.getAppDataDir(), 'local-daemon-token');
    if (!existsSync(tokenPath)) {
      throw new Error('local-daemon-token 尚未生成(daemon 未启动?)');
    }
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (!token) {
      throw new Error('local-daemon-token 为空');
    }
    return token;
  });
  handle('getAppDataDirectory', () => deps.getAppDataDir());
  handle('getUserHomeDirectory', () => os.homedir());
  handle('getLogDirectory', () => deps.getLogDir());
  handle('getLogFiles', () => listLogFiles(deps.getLogDir()));
  handle('readLogFile', (fileName: unknown) => {
    if (typeof fileName !== 'string') throw new Error('fileName must be a string');
    if (fileName.includes('/') || fileName.includes('\\')) {
      throw new Error(`Invalid file name: must not contain path separators (got: ${fileName})`);
    }
    const target = path.join(deps.getLogDir(), fileName);
    if (!existsSync(target)) {
      throw new Error(`Failed to read log file ${target}: not found`);
    }
    return readFileSync(target, 'utf8');
  });
  handle('readHomeFile', (relativePath: unknown) => {
    if (typeof relativePath !== 'string') throw new Error('relativePath must be a string');
    return readHomeFile(relativePath);
  });

  // --- 资源管理器 / 项目打开 ------------------------------------------------
  handle('openInExplorer', (payload: unknown) => {
    const { path: targetPath, reveal } = (payload ?? {}) as { path?: string; reveal?: boolean };
    if (typeof targetPath !== 'string') throw new Error('path must be a string');
    return openInExplorerPath(targetPath, reveal === true);
  });
  handle('openProjectPath', (payload: unknown) => {
    const { path: targetPath, target } = (payload ?? {}) as { path?: string; target?: string };
    if (typeof targetPath !== 'string' || typeof target !== 'string') {
      throw new Error('path and target must be strings');
    }
    return openProjectPath(targetPath, target);
  });

  // --- 通知 / 主窗口 --------------------------------------------------------
  handle('sendAgentNotification', (payload: unknown) => {
    const { title, body, sessionId } = (payload ?? {}) as { title?: string; body?: string; sessionId?: string };
    if (!title || !body || !sessionId) {
      throw new Error('sendAgentNotification 需要 { title, body, sessionId }');
    }
    if (!Notification.isSupported()) {
      return; // 与 Tauri 通知插件在无通知环境下的静默行为一致。
    }
    const notification = new Notification({ title, body });
    notification.once('click', () => {
      deps.showMainWindow();
      deps.sendToRenderer('agent-notification-clicked', { sessionId });
    });
    notification.show();
  });
  handle('showMainWindow', () => {
    deps.showMainWindow();
  });

  // --- 环境与运行时检测(agent-checks.ts 最小面;工单 06 完善) ---------------
  handle('checkDevelopmentEnvironment', () => checkDevelopmentEnvironment());
  handle('checkAgentRuntimes', () => checkAgentRuntimes());
  handle('probeAgentInstallations', (agentKind: unknown) => {
    if (typeof agentKind !== 'string') throw new Error('agentKind must be a string');
    return probeAgentInstallations(agentKind);
  });
  handle('upgradeAgentRuntime', (agentKind: unknown) => {
    if (typeof agentKind !== 'string') throw new Error('agentKind must be a string');
    return upgradeAgentRuntime(agentKind);
  });

  // --- browser.*:工单 07 迁移;纯窗口几何先 no-op,其余显式拒绝 ---------------
  // BrowserHost 共 13 方法;渲染层(browserStore/BrowserPanel)已按失败降级处理。
  handle('browserHide', () => undefined);
  handle('browserShow', () => undefined);
  handle('browserSetBounds', () => undefined);
  const browserReject = (method: string) => () => {
    throw new Error(`browser host 迁移中(工单 07): ${method}`);
  };
  handle('browserCreate', browserReject('create'));
  handle('browserDestroy', browserReject('destroy'));
  handle('browserNavigate', browserReject('navigate'));
  handle('browserBack', browserReject('back'));
  handle('browserForward', browserReject('forward'));
  handle('browserReload', browserReject('reload'));
  handle('browserEvaluate', browserReject('evaluate'));
  handle('browserOpenDevtools', browserReject('openDevtools'));
  handle('browserSetZoom', browserReject('setZoom'));
  handle('browserClearData', browserReject('clearData'));

  // --- perf / devtools ------------------------------------------------------
  handle('exportPerfSnapshot', (payload: unknown) => {
    const { path: filePath, content } = (payload ?? {}) as { path?: string; content?: string };
    if (typeof filePath !== 'string' || typeof content !== 'string') {
      throw new Error('exportPerfSnapshot 需要 { path, content }');
    }
    const parent = path.dirname(filePath);
    if (parent) mkdirSync(parent, { recursive: true });
    writeFileSync(filePath, content, 'utf8');
    return null; // 与 Tauri export_perf_snapshot 的返回(单元型)对齐。
  });
  handle('toggleDevtools', () => {
    const contents = webContentsOf(deps.getMainWindow());
    contents?.toggleDevTools();
  });

  // --- supervisor -----------------------------------------------------------
  handle('daemonRestart', () => deps.supervisor.restart());
  handle('getDaemonInfo', async () => {
    const status = await deps.supervisor.daemonStatus();
    return { port: status.port, running: status.running, version: status.version };
  });

  return () => {
    for (const channel of handlers.keys()) {
      ipcMain.removeHandler(`codemux:${channel}`);
    }
    handlers.clear();
  };
}

/** 渲染层 → main 的一次性调用助手(preload 使用;此处导出仅为类型/单测便利)。 */
export const SHELL_BRIDGE_CHANNELS = [
  'getLocalDaemonToken',
  'getAppDataDirectory',
  'getUserHomeDirectory',
  'getLogDirectory',
  'getLogFiles',
  'readLogFile',
  'readHomeFile',
  'openInExplorer',
  'openProjectPath',
  'sendAgentNotification',
  'showMainWindow',
  'checkDevelopmentEnvironment',
  'checkAgentRuntimes',
  'probeAgentInstallations',
  'upgradeAgentRuntime',
  'browserHide',
  'browserShow',
  'browserSetBounds',
  'browserCreate',
  'browserDestroy',
  'browserNavigate',
  'browserBack',
  'browserForward',
  'browserReload',
  'browserEvaluate',
  'browserOpenDevtools',
  'browserSetZoom',
  'browserClearData',
  'exportPerfSnapshot',
  'toggleDevtools',
  'daemonRestart',
  'getDaemonInfo',
] as const;
