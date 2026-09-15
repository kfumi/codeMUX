//! 壳门面的 main 进程实现:注册 `codemux:*` IPC 通道,供 sandboxed preload
//! 经 contextBridge 暴露给渲染层(工单 05/06/07/09)。
//!
//! 通道面与渲染层桥契约对齐(唯一归属见 src/lib/desktop-bridge.ts):
//! - token / 目录 / 日志 / 通知 / 主窗口
//! - 开发环境与 agent 运行时检测(最小面,见 agent-checks.ts)
//! - open_in_explorer / open_project_path / read_home_file
//! - 文件/目录对话框(工单 06;返回形状对齐 @tauri-apps/plugin-dialog)
//! - 应用内更新器(工单 06;electron-updater,见 updater.ts)
//! - browser.*(工单 07):页面托管已迁移到渲染层 <webview>;桥面只保留
//!   清资料(browserClearData)与 guest 登记(browserRegisterGuest)数据面,
//!   几何通道 no-op 占位,其余通道 reject 兜底(渲染层新适配器不再调用)
//! - daemonRestart / getDaemonInfo(supervisor 出口)

import {
  BrowserWindow,
  Notification,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type WebContents,
} from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkAgentRuntimes,
  checkDevelopmentEnvironment,
  probeAgentInstallations,
  upgradeAgentRuntime,
} from './agent-checks';
import { clearBrowserProfileData, type BrowserGuestTracker } from './browser-host';
import { readLocalDaemonTokenOrThrow } from './daemon-token';
import { openInExplorerPath, openProjectPath } from './open-project';
import type { Supervisor } from './supervisor';
import type { UpdaterService } from './updater';

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
  /** 应用内更新器(工单 06;开发/未打包环境自身返回 unavailable)。 */
  updater: UpdaterService;
  /** 渲染层事件出口(通知点击/更新进度等)。 */
  sendToRenderer(channel: string, payload: unknown): void;
  /** Browser Host(工单 07)guest 登记表(main.ts 创建并挂到 app 事件)。 */
  browserGuests: BrowserGuestTracker;
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

// --- 对话框参数解析(对齐 @tauri-apps/plugin-dialog 的 options 形状) --------

interface DialogFilter {
  name: string;
  extensions: string[];
}

function parseDialogFilters(value: unknown): DialogFilter[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('filters must be an array');
  }
  return value.map((entry) => {
    const { name, extensions } = (entry ?? {}) as { name?: unknown; extensions?: unknown };
    if (
      typeof name !== 'string'
      || !Array.isArray(extensions)
      || extensions.some((extension) => typeof extension !== 'string')
    ) {
      throw new Error('filters entry requires { name: string, extensions: string[] }');
    }
    return { name, extensions };
  });
}

function parseOptionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

/** open({ directory, multiple, title, defaultPath, filters }) → Electron showOpenDialog 选项。 */
function parseOpenDialogOptions(payload: unknown): OpenDialogOptions {
  const source = (payload ?? {}) as Record<string, unknown>;
  const directory = source.directory === true;
  const multiple = source.multiple === true;
  const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [
    directory ? 'openDirectory' : 'openFile',
  ];
  if (multiple) {
    properties.push('multiSelections');
  }
  return {
    title: parseOptionalString(source, 'title'),
    defaultPath: parseOptionalString(source, 'defaultPath'),
    properties,
    filters: parseDialogFilters(source.filters),
  };
}

/** save({ title, defaultPath, filters }) → Electron showSaveDialog 选项。 */
function parseSaveDialogOptions(payload: unknown): SaveDialogOptions {
  const source = (payload ?? {}) as Record<string, unknown>;
  return {
    title: parseOptionalString(source, 'title'),
    defaultPath: parseOptionalString(source, 'defaultPath'),
    filters: parseDialogFilters(source.filters),
  };
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
    return readLocalDaemonTokenOrThrow(deps.getAppDataDir());
  });
  handle('getAppDataDirectory', () => deps.getAppDataDir());
  handle('getUserHomeDirectory', () => os.homedir());
  handle('getLogDirectory', () => deps.getLogDir());
  handle('getLogFiles', () => listLogFiles(deps.getLogDir()));
  // preload 统一传对象 payload({fileName} / {relativePath}),与其他通道一致。
  handle('readLogFile', (payload: unknown) => {
    const { fileName } = (payload ?? {}) as { fileName?: unknown };
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
  handle('readHomeFile', (payload: unknown) => {
    const { relativePath } = (payload ?? {}) as { relativePath?: unknown };
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

  // --- 对话框(工单 06;返回形状对齐 @tauri-apps/plugin-dialog:取消为 null)
  handle('showDialogOpen', async (payload: unknown) => {
    const options = parseOpenDialogOptions(payload);
    const parent = deps.getMainWindow();
    const result = parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const multiple = options.properties?.includes('multiSelections') ?? false;
    return multiple ? result.filePaths : result.filePaths[0];
  });
  handle('showDialogSave', async (payload: unknown) => {
    const options = parseSaveDialogOptions(payload);
    const parent = deps.getMainWindow();
    const result = parent && !parent.isDestroyed()
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return null;
    }
    return result.filePath;
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
    // Windows 归组:通知身份 = 进程 AppUserModelID(main.ts setAppUserModelId
    // 'com.codemux.desktop',与 NSIS 快捷方式 AUMID 一致),通知中心按它归组;
    // Electron 33 无 per-notification relevance 配置,无需额外设置。
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

  // --- 外链(工单 09:接替 @tauri-apps/plugin-shell open) --------------------
  // 仅放行 http/https;main 侧 shell.openExternal(浏览器/系统处理)。
  handle('openExternal', (payload: unknown) => {
    if (typeof payload !== 'string' || !payload) {
      throw new Error('openExternal 需要 url 字符串');
    }
    let parsed: URL;
    try {
      parsed = new URL(payload);
    } catch {
      throw new Error(`openExternal: 非法 URL: ${payload}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`openExternal: 仅支持 http/https,收到: ${parsed.protocol}`);
    }
    return shell.openExternal(parsed.toString());
  });

  // --- 窗口控制(工单 09:接替 @tauri-apps/api/window;自绘标题栏) ----------
  // 关闭 = 隐藏到托盘(main.ts close 事件语义一致),真正退出走托盘菜单。
  handle('windowMinimize', () => {
    deps.getMainWindow()?.minimize();
  });
  handle('windowToggleMaximize', () => {
    const window = deps.getMainWindow();
    if (!window) return;
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });
  handle('windowClose', () => {
    deps.getMainWindow()?.hide();
  });
  handle('windowIsMaximized', () => {
    return deps.getMainWindow()?.isMaximized() ?? false;
  });

  // --- 系统字体清单(工单 09:接替 get_system_fonts 壳命令) ------------------
  // 简化实现:返回 Windows 常见字体常量清单(不做系统枚举;Tauri 版经
  // font-kit 枚举,daemon 无此面,UI 只需可选项列表)。
  handle('getSystemFonts', () => [
    'Segoe UI',
    'Segoe UI Variable',
    'Microsoft YaHei UI',
    'Microsoft YaHei',
    '微软雅黑',
    'SimSun',
    '宋体',
    'SimHei',
    'KaiTi',
    'DengXian',
    'Arial',
    'Calibri',
    'Cambria',
    'Candara',
    'Consolas',
    'Constantia',
    'Corbel',
    'Courier New',
    'Georgia',
    'Impact',
    'Malgun Gothic',
    'Meiryo',
    'Microsoft JhengHei',
    'Palatino Linotype',
    'Roboto',
    'Tahoma',
    'Times New Roman',
    'Trebuchet MS',
    'Verdana',
  ]);

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

  // --- browser.*(工单 07:渲染层 <webview> 托管;桥面仅保留数据面) ----------
  // 几何/显隐通道:渲染层适配器直接操作 <webview> DOM/CSS,不再调用;保留 no-op
  // 占位以维持 13 方法契约面完整。
  handle('browserHide', () => undefined);
  handle('browserShow', () => undefined);
  handle('browserSetBounds', () => undefined);
  // 页面生命周期/导航/脚本通道:同样由渲染层适配器本地实现;误用即显式失败。
  const browserBackstopReject = (method: string) => () => {
    throw new Error(`browser host 已由渲染层 <webview> 托管(工单 07): ${method}`);
  };
  handle('browserCreate', browserBackstopReject('create'));
  handle('browserDestroy', browserBackstopReject('destroy'));
  handle('browserNavigate', browserBackstopReject('navigate'));
  handle('browserBack', browserBackstopReject('back'));
  handle('browserForward', browserBackstopReject('forward'));
  handle('browserReload', browserBackstopReject('reload'));
  handle('browserEvaluate', browserBackstopReject('evaluate'));
  handle('browserOpenDevtools', browserBackstopReject('openDevtools'));
  handle('browserSetZoom', browserBackstopReject('setZoom'));
  // 清资料:main 进程清独立 partition session(对齐 Rust clear_data 语义)。
  handle('browserClearData', async (payload: unknown) => {
    const { scope } = (payload ?? {}) as { scope?: unknown };
    if (scope !== 'cache' && scope !== 'all') {
      throw new Error(`未知的清除范围: ${String(scope)}`);
    }
    await clearBrowserProfileData(scope);
  });
  // guest 登记:webview did-attach 后渲染层上报 webContentsId → browserId,
  // main 侧弹窗拒绝转发据此回填 sourceBrowserId。
  handle('browserRegisterGuest', (payload: unknown) => {
    const { webContentsId, browserId } = (payload ?? {}) as {
      webContentsId?: unknown;
      browserId?: unknown;
    };
    if (typeof webContentsId !== 'number' || !Number.isInteger(webContentsId) || webContentsId <= 0) {
      throw new Error('webContentsId must be a positive integer');
    }
    if (typeof browserId !== 'string' || !browserId) {
      throw new Error('browserId must be a non-empty string');
    }
    deps.browserGuests.register(webContentsId, browserId);
  });

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

  // --- 更新器(工单 06;electron-updater,事件经 'updater-event' 转发) -------
  // 开发/未打包环境由 updater.check() 显式返回 unavailable / downloadAndInstall 拒绝。
  handle('checkForUpdates', () => deps.updater.check());
  handle('downloadAndInstall', () => deps.updater.downloadAndInstall());
  handle('quitAndInstall', () => {
    deps.updater.quitAndInstall();
  });
  handle('currentVersion', () => deps.updater.currentVersion());

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
