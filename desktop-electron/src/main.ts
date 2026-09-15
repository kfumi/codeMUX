//! CodeMUX Electron 壳入口(工单 05:日常路径跑通)。
//!
//! - userData 显式指到 `%APPDATA%/com.codemux.desktop`(与 Tauri identifier
//!   完全同一目录)→ 会话/配置/配对/Local Daemon Token 零迁移;
//! - 同一 supervisor 契约的 TS 版拉起/附着独立 daemon(codemux-daemon);
//! - 生产渲染层经自定义 `app://` scheme 加载(SPA fallback 到 index.html),
//!   开发态用 CODEMUX_DEV_SERVER_URL(默认脚本注入 http://localhost:1420);
//! - 渲染层 console 追加落盘到 logs/renderer.log(接替 Tauri log 插件);
//! - 关窗到托盘;托盘「打开 CodeMUX / 退出」;退出时 stopManaged 停掉自有 daemon。
//!
//! 打包形态注意:渲染层 dist 在打包态指向随包分发的 renderer-dist/(打包前
//! 由 scripts/copy-renderer-dist.mjs 从仓库根 dist/ 拷入)。更新器经
//! electron-updater + GitHub Releases(工单 06)。

import { app, BrowserWindow, Menu, protocol, Tray, nativeImage } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { createBrowserGuestTracker, guardWebviewAttach, type BrowserGuestTracker } from './browser-host';
import { createBrowserAutomationService, type BrowserAutomationService } from './browser-automation';
import { readLocalDaemonToken } from './daemon-token';
import { createRendererLogRecorder, type RendererLogRecorder } from './renderer-log';
import { createSupervisor, type DaemonLifecycleEvent } from './supervisor';
import { registerShellBridge } from './shell-bridge';
import { createUpdaterService } from './updater';
import { attachWindowStatePersistence, loadWindowState } from './window-state';

const APP_ID = 'com.codemux.desktop';
const DEV_SERVER_URL = process.env.CODEMUX_DEV_SERVER_URL;
const MAIN_WINDOW_WIDTH = 1280;
const MAIN_WINDOW_HEIGHT = 820;

/** 编译产物目录(dist-electron)。 */
const moduleDir = __dirname;
/** 仓库根(dev 态 = desktop-electron/ 的上一级;打包态由 app.getAppPath() 决定)。 */
const appRoot = path.resolve(moduleDir, '..');
const repoRoot = path.resolve(appRoot, '..');

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 与 Tauri app_data_dir 完全一致:%APPDATA%/com.codemux.desktop。 */
function resolveAppDataDir(): string {
  return path.join(app.getPath('appData'), APP_ID);
}

/** 壳与 daemon 共用的日志目录。 */
function resolveLogDir(): string {
  return path.join(resolveAppDataDir(), 'logs');
}

/**
 * daemon 二进制解析(对齐 Rust resolve_daemon_exe 的候选顺序):
 * 环境变量 → 打包资源 daemon/ → dev 构建目录(target/debug|release)→ PATH。
 */
function resolveDaemonExe(): string {
  const binaryName = process.platform === 'win32' ? 'codemux-daemon.exe' : 'codemux-daemon';
  const candidates: string[] = [];
  if (process.env.CODEMUX_DAEMON_BIN) {
    candidates.push(process.env.CODEMUX_DAEMON_BIN);
  }
  if (app.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'daemon', binaryName));
  }
  candidates.push(path.join(repoRoot, 'src-tauri', 'target', 'debug', binaryName));
  candidates.push(path.join(repoRoot, 'src-tauri', 'target', 'release', binaryName));
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? binaryName;
}

/** 托盘图标:打包资源 icons/icon.ico → 仓库 src-tauri/icons/icon.ico。 */
function resolveTrayIcon(): string | null {
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'icons', 'icon.ico'));
  }
  candidates.push(path.join(repoRoot, 'src-tauri', 'icons', 'icon.ico'));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// ---------------------------------------------------------------------------
// app:// 静态协议(生产渲染层)
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

/**
 * 生产渲染层目录:dev 态指向仓库根 dist/(`npm run build` 产物);
 * 打包态指向随安装包分发的 renderer-dist/(构建脚本在打包前把仓库根 dist/
 * 拷入 desktop-electron/renderer-dist,见 scripts/copy-renderer-dist.mjs)。
 */
function resolveRendererDist(): string {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), 'renderer-dist');
  }
  return path.join(repoRoot, 'dist');
}

function registerAppProtocol(): void {
  // standard + secure + supportFetchAPI:让 app:// 下的 fetch/WS 与 http 一致。
  protocol.handle('app', async (request) => {
    const distRoot = resolveRendererDist();
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    let filePath = path.join(distRoot, relative);
    const isRootRequest = relative === '';
    const missing = !existsSync(filePath) || statSync(filePath).isDirectory();
    if (missing) {
      // SPA fallback:非根路径一律回落 index.html(对齐 Vite history 路由)。
      filePath = path.join(distRoot, 'index.html');
      if (!existsSync(filePath)) {
        return new Response('renderer dist not found; run `npm run build` in repo root', { status: 404 });
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    const body = readFileSync(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': CONTENT_TYPES[ext] ?? (isRootRequest ? 'text/html; charset=utf-8' : 'application/octet-stream'),
        'cache-control': isRootRequest || missing ? 'no-cache' : 'public, max-age=3600',
      },
    });
  });
}

function loadRenderer(window: BrowserWindow): void {
  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
    return;
  }
  // 标准 scheme 形如 app://bundle/index.html(SPA fallback 在协议处理器内完成)。
  void window.loadURL('app://bundle/index.html');
}

// ---------------------------------------------------------------------------
// 主窗口 / 托盘
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 主动退出标记:close 事件据此区分「关窗到托盘」与「退出应用」。 */
let quitting = false;
let unregisterBridge: (() => void) | null = null;
/** Browser Host(工单 07)guest 登记表(webview webContentsId → browserId)。 */
let browserGuests: BrowserGuestTracker | null = null;
/** 浏览器自动化接缝(工单 08):daemon → 壳内页面的自动化执行客户端。 */
let automation: BrowserAutomationService | null = null;
/** 渲染层 console 落盘器(窗口可能重建,记录器本身无状态可复用)。 */
let rendererLog: RendererLogRecorder | null = null;

function getRendererLog(): RendererLogRecorder {
  rendererLog ??= createRendererLogRecorder(resolveLogDir());
  return rendererLog;
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow(): BrowserWindow {
  // 恢复用户上次调整的窗口尺寸/位置(缺失或显示器变化时按工作区钳制/居中)。
  const windowState = loadWindowState({ width: MAIN_WINDOW_WIDTH, height: MAIN_WINDOW_HEIGHT });
  const window = new BrowserWindow({
    title: 'CodeMUX',
    width: windowState.width,
    height: windowState.height,
    ...(windowState.x !== null && windowState.y !== null ? { x: windowState.x, y: windowState.y } : {}),
    show: false,
    frame: false, // 与现 Tauri 窗口一致(自绘标题栏)。
    resizable: true,
    fullscreenable: true,
    // 对齐主题暗色 --background(hsl(0 0% 6.7%));亮色主题切换由渲染层接管,
    // 此色仅覆盖首帧与渲染层 #boot 加载态,统一可避免转场跳色。
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(moduleDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Browser Host(工单 07):内置浏览由渲染层 <webview> 标签托管。
      webviewTag: true,
    },
  });

  // 渲染层 console → logs/renderer.log(工单 09:接替 Tauri log 插件的
  // 打包态文件日志;webview guest 的 console 不在此列,由 browser-host 管)。
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    getRendererLog().record(level, message, line, sourceId);
  });

  // 开发态右键菜单:WebView2/Tauri dev 默认带「刷新/检查」,Electron 需自建。
  // 仅开发态注册;打包态不注册(页面内的自定义 React onContextMenu 不受影响)。
  if (!app.isPackaged) {
    window.webContents.on('context-menu', (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => window.webContents.reload() },
        { label: '强制刷新', click: () => window.webContents.reloadIgnoringCache() },
      ];
      if (params.selectionText || params.isEditable) {
        items.push(
          { type: 'separator' },
          { label: '复制', enabled: params.selectionText.length > 0, click: () => window.webContents.copy() },
        );
      }
      if (params.isEditable) {
        items.push({ label: '粘贴', click: () => window.webContents.paste() });
      }
      items.push(
        { type: 'separator' },
        { label: '检查元素', click: () => window.webContents.inspectElement(params.x, params.y) },
      );
      Menu.buildFromTemplate(items).popup({ window });
    });

    // 开发态 devtools 快捷键(Tauri dev 默认有 F12;Electron 不内置)。
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      const isF12 = input.key === 'F12';
      const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i';
      if (isF12 || isCtrlShiftI) {
        window.webContents.toggleDevTools();
      }
    });
  }

  // 关窗 → 隐藏到托盘(与 Tauri 版行为一致);真正的退出走托盘菜单。
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });

  // 用户调整过的尺寸/位置持久化(Tauri window-state 插件的 Electron 等价物)。
  attachWindowStatePersistence(window);
  // 上次关窗时是最大化:先按存储的正常尺寸创建,再重放最大化。
  if (windowState.maximized) {
    window.maximize();
  }

  // 窗口最大化状态变化 → 渲染层(TitleBar 自绘窗口控制按钮据此切换图标,
  // 行为对齐 Tauri getCurrentWindow().onResized)。
  const sendMaximizeState = () => {
    sendToRenderer('window-maximize-changed', window.isMaximized());
  };
  window.on('maximize', sendMaximizeState);
  window.on('unmaximize', sendMaximizeState);

  // 首帧绘制完成即显示:启动加载画面由渲染层 index.html 内嵌的 #boot 承担
  // (bundle 解析期间就有 logo 扫光),窗口尽早可见 = 任务栏/层级/焦点行为
  // 与普通窗口一致,不再是「先出假窗口再换真窗口」。
  window.once('ready-to-show', () => {
    window.show();
  });

  // Browser Host(工单 07):<webview> guest 附挂前校验 —— 剥 preload、禁 Node、
  // partition 必须带 cmx- 前缀(独立会话),否则销毁 guest(guest 无任何应用桥)。
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!guardWebviewAttach(webPreferences, params)) {
      event.preventDefault();
    }
  });

  // 阻止导航离开渲染层(外链交工单 06 的 openExternal;先就地拦截)。
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL
      ? url.startsWith(DEV_SERVER_URL)
      : url.startsWith('app://');
    if (!allowed) {
      event.preventDefault();
    }
  });

  loadRenderer(window);
  return window;
}

function createTray(onQuit: () => void): void {
  const iconPath = resolveTrayIcon();
  if (!iconPath) {
    // 无图标也可用(托盘仅是恢复入口);开发环境找不到 ico 时不阻塞启动。
    tray = null;
    return;
  }
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('CodeMUX');
  const menu = Menu.buildFromTemplate([
    { label: '打开 CodeMUX', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => onQuit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => showMainWindow());
}

// ---------------------------------------------------------------------------
// supervisor 装配
// ---------------------------------------------------------------------------

let supervisor: ReturnType<typeof createSupervisor> | null = null;

function forwardLifecycle(event: DaemonLifecycleEvent): void {
  sendToRenderer('daemon-lifecycle', event);
}

function startSupervisor(): void {
  supervisor = createSupervisor({
    appDataDir: resolveAppDataDir(),
    exePath: resolveDaemonExe(),
    // 开发态不传 --resource-dir(对齐 Rust:仅打包环境传);打包态指向资源根。
    resourceDir: app.isPackaged && process.resourcesPath ? process.resourcesPath : null,
    managedBy: 'desktop',
    // 版本配对:壳期望的 daemon 版本默认 = 壳自身版本(发版流程把 package.json
    // / desktop-electron/package.json / Cargo.toml 同步到同一版本,见
    // scripts/prepare-release.mjs)。env 显式覆盖,便于本地调试旧 daemon。
    expectedDaemonVersion: process.env.CODEMUX_EXPECTED_DAEMON_VERSION ?? app.getVersion(),
    onEvent: forwardLifecycle,
  });

  void supervisor
    .ensureDaemon()
    .then((decision) => {
      console.info(`[supervisor] daemon ensured (${decision})`);
    })
    .catch((error: unknown) => {
      console.error('[supervisor] failed to ensure daemon:', error);
      // 与 Tauri 壳一致:启动失败向渲染层发 start-failed(overlay 提供重试)。
      forwardLifecycle({ status: 'start-failed', error: error instanceof Error ? error.message : String(error) });
    });
}

async function quitApplication(): Promise<void> {
  quitting = true;
  // 自动化客户端先行断开(不重连),再停自有 daemon。
  automation?.stop();
  automation = null;
  // 只停自有 child;attach 的外部 daemon 绝不动(stopManaged 语义保证)。
  try {
    await supervisor?.stopManaged();
  } catch (error) {
    console.error('[supervisor] stopManaged failed:', error);
  }
  supervisor?.dispose();
  app.quit();
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

// 必须在 ready 前设置:与 Tauri 共用同一数据目录(零迁移)。
app.setPath('userData', path.join(app.getPath('appData'), APP_ID));
// 通知身份(工单 06):Windows 通知中心按 AppUserModelID 归组;该 ID 必须与
// electron-builder.yml 的 appId 一致(NSIS 快捷方式 AUMID 由此派生),否则
// 从快捷方式启动时通知会被 Windows 拒投或归到未知应用。
// 仅打包态设置:任务栏图标按 AUMID 反查开始菜单快捷方式,dev 态没有对应
// 快捷方式,设置了反而导致任务栏不显示图标(dev 态用 Electron 默认 AUMID)。
if (app.isPackaged) {
  app.setAppUserModelId(APP_ID);
}

// app:// 需要在 ready 前声明特权(fetch/标准 scheme)。
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 二次启动:交给已有实例,自身退出。
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  void app.whenReady().then(() => {
    registerAppProtocol();
    // Browser Host(工单 07):guest 弹窗兜底(webContents 创建即注册,先于主窗口)。
    const guests = createBrowserGuestTracker({ sendToRenderer });
    browserGuests = guests;
    app.on('web-contents-created', guests.onWebContentsCreated);
    mainWindow = createMainWindow();
    startSupervisor();
    if (!supervisor) {
      throw new Error('supervisor not initialized');
    }
    // 浏览器自动化接缝(工单 08):main 进程 WS 客户端连 daemon 控制面,
    // 端口来自 supervisor(supervisor 出口/daemonStatus 同源)。连接失败仅
    // 退避重连,不崩溃(降级为无自动化能力)。同一连接上的 daemon ui-event
    // 帧(工单 09:sessions-changed / scheduled-tasks-changed /
    // runtime-install-progress*)以同名事件名转发渲染层 —— Tauri 壳删除后
    // 这些事件的原投递方(app.emit)由本 sink 接管。
    automation = createBrowserAutomationService({
      getPort: () => supervisor?.getPort() ?? null,
      readToken: () => readLocalDaemonToken(resolveAppDataDir()),
      resolveTarget: (browserId) => guests.resolveTarget(browserId),
      resolveMostRecent: () => guests.resolveMostRecent(),
      listTargets: () => guests.list(),
      onUiEvent: (name, payload) => sendToRenderer(name, payload),
    });
    automation.start();
    // 应用内更新器(工单 06):electron-updater(GitHub Releases);
    // 开发/未打包环境在服务内部自动禁用(check → unavailable)。
    const updater = createUpdaterService({
      isPackaged: () => app.isPackaged,
      sendToRenderer,
    });
    unregisterBridge = registerShellBridge({
      getAppDataDir: resolveAppDataDir,
      getLogDir: resolveLogDir,
      getMainWindow: () => mainWindow,
      showMainWindow,
      supervisor,
      updater,
      sendToRenderer,
      browserGuests: guests,
    });
    createTray(() => {
      void quitApplication();
    });
  });

  // 关窗到托盘:window-all-closed 不退出(除非正在退出)。
  app.on('window-all-closed', () => {
    if (quitting) {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    if (!quitting) {
      // 兜底:任何非托盘路径触发的 quit 也先停自有 daemon。
      event.preventDefault();
      void quitApplication();
    }
  });

  app.on('quit', () => {
    unregisterBridge?.();
    unregisterBridge = null;
    if (browserGuests) {
      app.off('web-contents-created', browserGuests.onWebContentsCreated);
      browserGuests = null;
    }
  });
}
