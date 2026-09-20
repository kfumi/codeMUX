/**
 * Electron 壳桥(工单 05/06/07/09):渲染层探测与类型定义。
 *
 * - `desktopBridge`:`window.codemuxDesktop`(preload 经 contextBridge 暴露);
 *   非 Electron 环境下为 undefined,壳方法调用方必须显式处理缺失(报错/降级)。
 * - `isElectronDesktop()`:平台分流判据。
 * - browser.*:工单 07 起页面由渲染层 `<webview>` 托管(见
 *   src/lib/browser/electronBrowserHost.ts);桥面仅保留清资料 / guest 登记,
 *   几何与导航通道为契约占位(见 apps/desktop/src/shell-bridge.ts)。
 * - 本文件同时是壳载荷类型的唯一归属(工单 09:Tauri 壳退役后,
 *   原 src/lib/tauri.ts 的日志/环境/agent 运行时检测契约迁入,消除双份定义)。
 */
import type { BrowserDataScope, BrowserPageBounds } from './browserHost';
import type { OpenTarget } from './openTargets';

// ---------------------------------------------------------------------------
// 壳命令载荷契约(与 apps/desktop/src/agent-checks.ts、shell-bridge.ts 对齐)。
// ---------------------------------------------------------------------------

export interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  modified: string;
}

export type EnvironmentCheckStatus = 'ok' | 'warning' | 'missing' | 'error';

export type EnvironmentToolName = 'node' | 'npm' | 'git';

export interface EnvironmentToolCheck {
  name: 'Node.js' | 'npm' | 'Git';
  command: EnvironmentToolName;
  status: EnvironmentCheckStatus;
  version: string | null;
  path: string | null;
  message: string;
}

export interface DevelopmentEnvironmentCheck {
  checkedAt: string;
  tools: EnvironmentToolCheck[];
}

export type AgentRuntimeStatus = 'ok' | 'outdated' | 'missing' | 'error';

export type InstallSource =
  | 'nvm' | 'homebrew' | 'volta' | 'fnm' | 'mise'
  | 'bun' | 'pnpm' | 'scoop' | 'system' | 'unknown';

export interface AgentInstallation {
  path: string;
  real: string;
  version: string | null;
  runnable: boolean;
  error: string | null;
  source: InstallSource;
  isPathDefault: boolean;
}

export interface AgentInstallationReport {
  agentKind: string;
  installs: AgentInstallation[];
  isConflict: boolean;
  needsConfirmation: boolean;
  anchored: boolean;
  command: string | null;
}

export interface AgentRuntimeCheck {
  agentKind: string;
  label: string;
  command: string;
  status: AgentRuntimeStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  executablePath: string | null;
  configPath: string | null;
  npmPackage: string;
  message: string;
  installedButBroken: boolean;
}

export interface AgentRuntimeCheckResult {
  checkedAt: string;
  runtimes: AgentRuntimeCheck[];
}

export type UpgradeOutcome =
  | 'success'
  | 'soft_version_unchanged'
  | 'soft_not_runnable'
  | 'hard_failure';

export interface AgentRuntimeUpgradeResult {
  agentKind: string;
  success: boolean;
  outcome: UpgradeOutcome;
  message: string;
  newVersion: string | null;
}

// ---------------------------------------------------------------------------
// 事件 / 更新器 / 对话框载荷(壳桥私有契约)。
// ---------------------------------------------------------------------------

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
// 对话框(工单 06):options/返回形状对齐原 Tauri plugin-dialog 契约
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
// 更新器(工单 06):electron-updater 桥;事件契约与 apps/desktop/src/updater.ts 对齐。
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

/** window-maximize-changed 事件载荷(main 窗口 maximize/unmaximize 转发)。 */
export type DesktopWindowMaximizePayload = boolean;

/** window.codemuxDesktop 的完整方法面(与 apps/desktop/src/preload.ts 对齐)。 */
export interface CodemuxDesktopBridge {
  // token / 目录 / 日志
  getLocalDaemonToken(): Promise<string>;
  getAppDataDirectory(): Promise<string>;
  getUserHomeDirectory(): Promise<string>;
  getLogDirectory(): Promise<string>;
  getLogFiles(): Promise<LogFileInfo[]>;
  readLogFile(fileName: string): Promise<string>;
  readHomeFile(relativePath: string): Promise<string>;
  /** 确保绝对路径目录存在(缺则递归创建)。返回 false = 不可用,调用方降级。 */
  ensureDirectory(path: string): Promise<boolean>;

  // 资源管理器 / 项目打开
  openInExplorer(path: string, reveal?: boolean): Promise<void>;
  openProjectPath(path: string, target: OpenTarget): Promise<void>;

  // 外链(工单 09:接替原 plugin-shell open;main 仅放行 http/https)
  openExternal(url: string): Promise<void>;

  // 窗口控制(工单 09:接替原 Tauri window API;自绘标题栏;
  // 关闭 = 隐藏到托盘,最大化态经 onDesktopEvent('window-maximize-changed') 订阅)
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;

  // 文件/目录对话框(工单 06;返回形状对齐原 Tauri plugin-dialog 契约)
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
  checkDevelopmentEnvironment(): Promise<DevelopmentEnvironmentCheck>;
  checkAgentRuntimes(): Promise<AgentRuntimeCheckResult>;
  probeAgentInstallations(agentKind: string): Promise<AgentInstallationReport>;
  upgradeAgentRuntime(agentKind: string): Promise<AgentRuntimeUpgradeResult>;

  // 系统字体清单(工单 09:main 侧返回常见字体常量清单,后续可增强为系统枚举)
  listSystemFonts(): Promise<string[]>;

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
  /** daemon 桌面 UI 事件(工单 09:sessions-changed / scheduled-tasks-changed /
   * runtime-install-progress* / window-maximize-changed),main 按同名事件转发;
   * 返回取消订阅。 */
  onDesktopEvent(name: string, callback: (payload: unknown) => void): () => void;
}

/**
 * preload 注入点(contextBridge.exposeInMainWorld('codemuxDesktop', ...))。
 * 以 `typeof window` 守卫:Node 测试环境(vitest)下无 window,模块导入不可抛。
 */
export const desktopBridge =
  typeof window !== 'undefined'
    ? (window as unknown as { codemuxDesktop?: CodemuxDesktopBridge }).codemuxDesktop
    : undefined;

/**
 * 桥缺失(非 Electron 壳 / preload 未注入)的统一错误文案。
 *
 * 同步入口(`requireDesktopBridge`)与异步入口(壳门面)共用同一份文案,
 * 避免两处字面量漂移导致用户看到两种说法。
 */
export const DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE = 'codemuxDesktop 桥不可用(Electron preload 未注入)';

/** 平台分流判据:Electron 壳内为 true。 */
export const isElectronDesktop = (): boolean => !!desktopBridge;

/**
 * 壳方法共用断言(工单 09):desktopBridge 缺失(非 Electron 壳/preload 未注入)
 * 时统一抛出明确错误 —— 不再存在 Tauri invoke 回退。
 */
export function requireDesktopBridge(): CodemuxDesktopBridge {
  if (!desktopBridge) {
    throw new Error(DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE);
  }
  return desktopBridge;
}
