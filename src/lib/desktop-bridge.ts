/**
 * Electron 壳桥(工单 05/06/07):渲染层探测与类型定义。
 *
 * - `desktopBridge`:`window.codemuxDesktop`(preload 经 contextBridge 暴露);
 *   非 Electron 环境(Tauri 壳 / 纯 Web)下为 undefined。
 * - `isElectronDesktop()`:平台分流判据;所有壳方法调用方必须先判它再走
 *   desktopBridge,否则回退既有 Tauri invoke(所有适配必须带回退)。
 * - browser.*:工单 07 起页面由渲染层 `<webview>` 托管(见
 *   src/lib/browser/electronBrowserHost.ts);桥面仅保留清资料 / guest 登记,
 *   几何与导航通道为契约占位(见 desktop-electron/src/shell-bridge.ts)。
 */
import type { BrowserDataScope, BrowserPageBounds } from './browserHost';
import type { OpenTarget } from './openTargets';

// ---------------------------------------------------------------------------
// 结果类型:与 src/lib/tauri.ts 的壳能力返回形状逐一对应(双实现一致性)。
// ---------------------------------------------------------------------------

export interface DesktopLogFileInfo {
  name: string;
  path: string;
  size: number;
  modified: string;
}

export type DesktopEnvironmentCheckStatus = 'ok' | 'warning' | 'missing' | 'error';

export interface DesktopEnvironmentToolCheck {
  name: 'Node.js' | 'npm' | 'Git';
  command: 'node' | 'npm' | 'git';
  status: DesktopEnvironmentCheckStatus;
  version: string | null;
  path: string | null;
  message: string;
}

export interface DesktopDevelopmentEnvironmentCheck {
  checkedAt: string;
  tools: DesktopEnvironmentToolCheck[];
}

export type DesktopAgentRuntimeStatus = 'ok' | 'outdated' | 'missing' | 'error';

export type DesktopInstallSource =
  | 'nvm' | 'homebrew' | 'volta' | 'fnm' | 'mise'
  | 'bun' | 'pnpm' | 'scoop' | 'system' | 'unknown';

export interface DesktopAgentInstallation {
  path: string;
  real: string;
  version: string | null;
  runnable: boolean;
  error: string | null;
  source: DesktopInstallSource;
  isPathDefault: boolean;
}

export interface DesktopAgentInstallationReport {
  agentKind: string;
  installs: DesktopAgentInstallation[];
  isConflict: boolean;
  needsConfirmation: boolean;
  anchored: boolean;
  command: string | null;
}

export interface DesktopAgentRuntimeCheck {
  agentKind: string;
  label: string;
  command: string;
  status: DesktopAgentRuntimeStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  executablePath: string | null;
  configPath: string | null;
  npmPackage: string;
  message: string;
  installedButBroken: boolean;
}

export interface DesktopAgentRuntimeCheckResult {
  checkedAt: string;
  runtimes: DesktopAgentRuntimeCheck[];
}

export interface DesktopAgentRuntimeUpgradeResult {
  agentKind: string;
  success: boolean;
  outcome: 'success' | 'soft_version_unchanged' | 'soft_not_runnable' | 'hard_failure';
  message: string;
  newVersion: string | null;
}

/** supervisor 经 preload 转发的 daemon 生命周期事件(与 daemonLifecycleBridge 同形)。 */
export interface DesktopDaemonLifecycleEvent {
  status?: 'started' | 'exited' | 'start-failed' | string;
  decision?: string;
  error?: string;
}

/**
 * main 进程通知点击事件载荷(与 src/hooks/useAgentNotifications.ts 的
 * `agent-notification-clicked` 契约同形:camelCase sessionId)。
 */
export interface DesktopAgentNotificationClickPayload {
  sessionId?: string;
}

/** getDaemonInfo 的返回:daemon client bootstrap 需要的端口/健康。 */
export interface DesktopDaemonInfo {
  port: number | null;
  running: boolean;
  version: string | null;
}

// ---------------------------------------------------------------------------
// 对话框(工单 06):options/返回形状对齐 @tauri-apps/plugin-dialog
// (取消/关闭一律 null;multiple 为 string[];单选为 string | null)。
// ---------------------------------------------------------------------------

export interface DesktopDialogFilter {
  name: string;
  extensions: string[];
}

export interface DesktopOpenDialogOptions {
  title?: string;
  defaultPath?: string;
  /** true = 选目录;false/缺省 = 选文件。 */
  directory?: boolean;
  multiple?: boolean;
  filters?: DesktopDialogFilter[];
}

export interface DesktopSaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DesktopDialogFilter[];
}

// ---------------------------------------------------------------------------
// 更新器(工单 06):electron-updater 桥;事件契约与 desktop-electron/src/updater.ts 对齐。
// ---------------------------------------------------------------------------

export type DesktopUpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; version: string | null }
  | { type: 'progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string | null }
  | { type: 'error'; message: string };

/** checkForUpdates 的返回(unavailable = 开发/未打包环境,壳侧更新器已禁用)。 */
export interface DesktopUpdaterCheckResult {
  status: 'available' | 'not-available' | 'unavailable';
  version: string | null;
}

/**
 * main 侧弹窗拒绝转发载荷(guest setWindowOpenHandler deny → 渲染层开新标签;
 * 与 BrowserNewWindowPayload 同形,sourceBrowserId 在无法定位来源时为空串)。
 */
export interface DesktopBrowserNewWindowPayload {
  sourceBrowserId?: string | null;
  url?: string;
}

/** window.codemuxDesktop 的完整方法面(与 desktop-electron/src/preload.ts 对齐)。 */
export interface CodemuxDesktopBridge {
  // token / 目录 / 日志
  getLocalDaemonToken(): Promise<string>;
  getAppDataDirectory(): Promise<string>;
  getUserHomeDirectory(): Promise<string>;
  getLogDirectory(): Promise<string>;
  getLogFiles(): Promise<DesktopLogFileInfo[]>;
  readLogFile(fileName: string): Promise<string>;
  readHomeFile(relativePath: string): Promise<string>;

  // 资源管理器 / 项目打开
  openInExplorer(path: string, reveal?: boolean): Promise<void>;
  openProjectPath(path: string, target: OpenTarget): Promise<void>;

  // 文件/目录对话框(工单 06;返回形状对齐 @tauri-apps/plugin-dialog)
  showDialogOpen(options?: DesktopOpenDialogOptions): Promise<string | string[] | null>;
  showDialogSave(options?: DesktopSaveDialogOptions): Promise<string | null>;

  // 通知 / 主窗口
  sendAgentNotification(payload: { title: string; body: string; sessionId: string }): Promise<void>;
  showMainWindow(): Promise<void>;

  // 应用内更新器(工单 06;进度事件经 onUpdaterEvent 转发)
  checkForUpdates(): Promise<DesktopUpdaterCheckResult>;
  downloadAndInstall(): Promise<{ version: string | null }>;
  quitAndInstall(): Promise<void>;
  currentVersion(): Promise<string>;

  // 环境与运行时检测
  checkDevelopmentEnvironment(): Promise<DesktopDevelopmentEnvironmentCheck>;
  checkAgentRuntimes(): Promise<DesktopAgentRuntimeCheckResult>;
  probeAgentInstallations(agentKind: string): Promise<DesktopAgentInstallationReport>;
  upgradeAgentRuntime(agentKind: string): Promise<DesktopAgentRuntimeUpgradeResult>;

  // browser.*(工单 07:渲染层 <webview> 托管;桥面保留清资料 + guest 登记,
  // 其余通道为契约占位 —— 几何 no-op,其余 reject 兜底,渲染层不再调用)
  browserCreate(browserId: string, url: string, bounds: BrowserPageBounds): Promise<void>;
  browserDestroy(browserId: string): Promise<void>;
  browserNavigate(browserId: string, url: string): Promise<void>;
  browserBack(browserId: string): Promise<void>;
  browserForward(browserId: string): Promise<void>;
  browserReload(browserId: string): Promise<void>;
  browserSetBounds(browserId: string, bounds: BrowserPageBounds): Promise<void>;
  browserShow(browserId: string): Promise<void>;
  browserHide(browserId: string): Promise<void>;
  browserEvaluate(browserId: string, script: string): Promise<string>;
  browserOpenDevtools(browserId: string): Promise<void>;
  browserSetZoom(browserId: string, factor: number): Promise<void>;
  browserClearData(scope: BrowserDataScope): Promise<void>;
  /** guest webContentsId → browserId 登记(弹窗拒绝转发据此回填来源)。 */
  browserRegisterGuest(webContentsId: number, browserId: string): Promise<void>;

  // perf / devtools
  exportPerfSnapshot(path: string, content: string): Promise<null>;
  toggleDevtools(): Promise<void>;

  // supervisor
  daemonRestart(): Promise<unknown>;
  getDaemonInfo(): Promise<DesktopDaemonInfo>;

  // 事件
  onDaemonLifecycle(callback: (payload: DesktopDaemonLifecycleEvent) => void): () => void;
  onAgentNotificationClicked(callback: (payload: DesktopAgentNotificationClickPayload) => void): () => void;
  onUpdaterEvent(callback: (event: DesktopUpdaterEvent) => void): () => void;
  onBrowserNewWindow(callback: (payload: DesktopBrowserNewWindowPayload) => void): () => void;
}

/**
 * preload 注入点(contextBridge.exposeInMainWorld('codemuxDesktop', ...))。
 * 以 `typeof window` 守卫:Node 测试环境(vitest)下无 window,模块导入不可抛。
 */
export const desktopBridge =
  typeof window !== 'undefined'
    ? (window as unknown as { codemuxDesktop?: CodemuxDesktopBridge }).codemuxDesktop
    : undefined;

/** 平台分流判据:Electron 壳内为 true;Tauri 壳/纯 Web 为 false(走既有 invoke)。 */
export const isElectronDesktop = (): boolean => !!desktopBridge;
