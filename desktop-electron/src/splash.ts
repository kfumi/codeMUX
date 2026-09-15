//! 启动 splash 窗口控制器:app ready 后先于主窗口创建,主窗口转正后关闭。
//!
//! - splash 尺寸/位置对齐即将显示的主窗口(同一份 window-state):视觉上是
//!   「应用窗口先出现,内容区中央在加载」,转正时同位同尺寸无缝衔接,
//!   而不是一块悬浮的小 logo 面板;
//! - splash 页面(assets/splash.html)为纯 HTML/CSS,数毫秒内即可绘制,
//!   盖住渲染层 bundle 解析 + supervisor 拉 daemon 的黑屏窗口期;
//! - 主窗口转正(main 收到 renderer-ready / 超时兜底 / did-fail-load)时
//!   `dismiss()` 渐隐销毁;幂等,任意时序重复调用安全;
//! - 渲染层加载失败等异常路径走 `dispose()` 立即销毁,不留永动 splash。

import { BrowserWindow, screen } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { WindowState } from './window-state';

/** 无窗口状态可用时的 splash 兜底尺寸(居中显示)。 */
const SPLASH_WIDTH = 320;
const SPLASH_HEIGHT = 240;
/** 主窗口转正后 splash 渐隐时长;结束后真正销毁。 */
const FADE_OUT_MS = 180;
/** 超时兜底:渲染层迟迟不上报(renderer-ready)也不允许 splash 永动。 */
export const SPLASH_TIMEOUT_MS = 10_000;

export interface SplashController {
  /** 主窗口转正:渐隐销毁(幂等)。超时兜底与 renderer-ready 共用。 */
  dismiss(): void;
  /** 异常路径(did-fail-load / 退出)立即销毁,不做渐隐(幂等)。 */
  dispose(): void;
  /** 兜底重复 show(首个可见窗口自动获得焦点,不主动抢激活态)。 */
  ensureVisible(): void;
}

export interface SplashOptions {
  /** 即将显示的主窗口状态(loadWindowState 结果):splash 按同一 bounds 显示。 */
  bounds?: WindowState;
  /** 超时兜底毫秒数(测试注入短值);默认 SPLASH_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 渐隐时长毫秒数(测试注入 0 便于立即断言);默认 FADE_OUT_MS。 */
  fadeOutMs?: number;
  /** 测试注入计时器(fake timers);缺省用全局 setTimeout/clearTimeout。 */
  scheduleTimeout?: (callback: () => void, ms: number) => () => void;
}

/** splash 页面解析:dev 与打包态都从仓库 assets/ 同路径读(asar 内亦可直接 loadFile)。 */
function resolveSplashFile(): string | null {
  // __dirname = dist-electron(打包态在 asar 内),assets 与其同级。
  const candidate = path.resolve(__dirname, '..', 'assets', 'splash.html');
  return existsSync(candidate) ? candidate : null;
}

/**
 * splash 显示 bounds:与主窗口同源(window-state)。最大化重放时按目标显示器
 * 工作区铺满(与 main.ts 的 window.maximize() 落点一致);未定位(首启)时不传
 * x/y,交给 Electron 默认居中,与主窗口缺省行为一致。
 */
function resolveSplashBounds(bounds: WindowState | undefined): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  if (!bounds) {
    return { width: SPLASH_WIDTH, height: SPLASH_HEIGHT };
  }
  if (bounds.maximized) {
    const workArea = bounds.x !== null && bounds.y !== null
      ? screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }).workArea
      : screen.getPrimaryDisplay().workArea;
    return { width: workArea.width, height: workArea.height, x: workArea.x, y: workArea.y };
  }
  if (bounds.x !== null && bounds.y !== null) {
    return { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
  }
  return { width: bounds.width, height: bounds.height };
}

export function createSplashWindow(options: SplashOptions = {}): SplashController {
  const timeoutMs = options.timeoutMs ?? SPLASH_TIMEOUT_MS;
  const fadeOutMs = options.fadeOutMs ?? FADE_OUT_MS;
  const scheduleTimeout = options.scheduleTimeout
    ?? ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });

  const splashFile = resolveSplashFile();
  if (!splashFile) {
    // 资源缺失(不完整的构建产物)不阻塞启动:返回 no-op 控制器。
    console.warn('[splash] splash.html not found; skip splash window');
    return { dismiss: () => {}, dispose: () => {}, ensureVisible: () => {} };
  }

  const splash = new BrowserWindow({
    ...resolveSplashBounds(options.bounds),
    show: false,
    frame: false,
    // Windows 无边框窗口默认保留 WS_THICKFRAME:会有 1px 系统边框 + 阴影,
    // 在深色桌面上看起来像「logo 外有个大边框」;关闭后才是纯净矩形。
    thickFrame: false,
    hasShadow: false,
    roundedCorners: false, // macOS 圆角同样关掉,避免四角漏色。
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true, // 任务栏只保留主窗口一个图标。
    alwaysOnTop: true, // 避免被其他应用窗口盖住(主窗口尚未显示)。
    backgroundColor: '#111111',
    title: 'CodeMUX',
    webPreferences: {
      // 纯静态页面:不需要 Node/预载任何桥。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  splash.setMenuBarVisibility(false);
  void splash.loadFile(splashFile);
  splash.once('ready-to-show', () => {
    if (!dismissed && !destroyed) {
      splash.show();
    }
  });

  let dismissed = false;
  let destroyed = false;
  let cancelTimer: (() => void) | null = null;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  /** 渐隐销毁:setOpacity 分步线性渐隐(主进程控制,平台行为最稳)。 */
  const destroyAfterFade = () => {
    destroyed = true;
    if (splash.isDestroyed()) return;
    if (fadeOutMs <= 0) {
      splash.destroy();
      return;
    }
    const steps = 6;
    let step = 0;
    const stepInterval = Math.max(1, Math.floor(fadeOutMs / steps));
    const fadeTimer = setInterval(() => {
      step += 1;
      if (splash.isDestroyed()) {
        clearInterval(fadeTimer);
        return;
      }
      if (step >= steps) {
        clearInterval(fadeTimer);
        splash.destroy();
        return;
      }
      splash.setOpacity(1 - step / steps);
    }, stepInterval);
  };

  cancelTimer = scheduleTimeout(() => {
    cancelTimer = null;
    // 超时路径视同 dismiss:渲染层可能永远不上报(如崩溃后的异常白屏)。
    if (!dismissed && !destroyed) {
      dismissed = true;
      destroyAfterFade();
    }
  }, timeoutMs);

  return {
    dismiss() {
      if (dismissed || destroyed) return;
      dismissed = true;
      clearTimer();
      destroyAfterFade();
    },
    dispose() {
      if (destroyed) return;
      dismissed = true;
      clearTimer();
      destroyed = true;
      if (!splash.isDestroyed()) {
        splash.destroy();
      }
    },
    ensureVisible() {
      if (dismissed || destroyed) return;
      if (!splash.isVisible()) {
        splash.showInactive();
      }
    },
  };
}
