//! 控制中提示条窗口的 Electron 实现(工单 10;依赖注入与窗口复用见工单 18):
//! 一个置顶、点击穿透、不抢焦点的小条。
//!
//! 纯逻辑(文案/尺寸/页面/状态机)在 control-banner.ts;这里只做 Electron 那一层,
//! 但把「建窗 / 取显示器工作区 / 订阅显示器变化 / 定时」全部做成可注入的依赖 —— 与
//! 参考实现(ZCode 的 windowsCuaOperationIndicator)同样的做法,于是显示时机、置顶
//! 重申、离场动画与显示器变化都能在 Node 里用假窗口测,不必真开一个 Electron 窗口。
//!
//! 三条不变量的来源写在这里,别处不要重复推导:
//! - **点击穿透**:提示条不能挡住用户或智能体的鼠标操作(setIgnoreMouseEvents)。
//! - **内容保护**:`setContentProtection(true)` 走 Windows 的 WDA_EXCLUDEFROMCAPTURE,
//!   提示条从所有截屏里被排除,driver 的 `computer_screenshot` 拍不到它(工单 10 跟进)。
//! - **不抢焦点**:`focusable:false` + `showInactive()`,显示时不能把用户正在输入的
//!   窗口切走,也不能让智能体正在操作的目标窗口失焦。

import { BrowserWindow, screen } from 'electron';

import {
  CONTROL_BANNER_LEAVE_ANIMATION_MS,
  bannerDataUrl,
  bannerWindowOptions,
  type BannerBounds,
  type ControlBannerHandle,
} from './control-banner';

/** 周期性重申置顶:全屏应用或别的置顶窗会把它压下去(与 PI 提示条同样处理)。 */
const KEEP_TOP_INTERVAL_MS = 2000;

/** 系统把窗口关掉(而我们仍认为该显示)后重建的间隔;失败不再连环重试。 */
const REBUILD_DELAY_MS = 250;

/**
 * 页面上的状态开关(见 control-banner.ts 的 CSS)。
 *
 * 复用窗口后入场动画不能再靠「重新加载页面」播:页面以 leaving 起步,显示时切成
 * active 触发过渡,隐藏时切回 leaving 播完再 hide。
 */
const ACTIVE_STATE_SCRIPT = "document.documentElement.dataset.state='active'";
const LEAVING_STATE_SCRIPT = "document.documentElement.dataset.state='leaving'";

/** 这里只用到窗口的一小部分能力;窄接口让假窗口能在 Node 里完整替代它。 */
export interface BannerWindowLike {
  readonly webContents: { executeJavaScript(code: string): Promise<unknown> };
  loadURL(url: string): Promise<void>;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void;
  moveTop(): void;
  setBounds(bounds: BannerBounds): void;
  getBounds(): BannerBounds;
  setIgnoreMouseEvents(ignore: boolean): void;
  setContentProtection(enable: boolean): void;
  on(event: 'closed', listener: () => void): unknown;
}

export interface ControlBannerWindowDeps {
  createWindow?(options: ReturnType<typeof bannerWindowOptions>): BannerWindowLike;
  /**
   * 提示条该落在哪个显示器的工作区。
   *
   * `anchor` 非空时以「这个矩形当前所在显示器」为准(显示器增删/改分辨率后重定位);
   * `anchor` 为空时用**光标所在显示器** —— 用户/被控窗口在副屏时,固定主屏会让提示
   * 出现在另一块屏幕上,等于没有提示(参考实现同一口径)。
   */
  resolveWorkArea?(anchor: BannerBounds | null): BannerBounds;
  /** 订阅显示器增删/度量变化,返回取消订阅。 */
  subscribeDisplayChanges?(handler: () => void): () => void;
  schedule?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel?(timer: ReturnType<typeof setTimeout>): void;
  log?(level: 'info' | 'warn' | 'error', message: string): void;
  /**
   * 窗口层「已经不在屏幕上,而且自己也补不回来」时上报(工单 18)。
   *
   * 服务层据此把记账改成未显示 —— 否则它的 `visible` 会一直是 true,后面的显示请求全被
   * 短路,这一整段操作里提示条再也回不来(而 Esc 还武装着)。
   */
  onVisibilityLost?(): void;
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') {
    console.error(`[control-banner-window] ${message}`);
  } else if (level === 'warn') {
    console.warn(`[control-banner-window] ${message}`);
  } else {
    console.log(`[control-banner-window] ${message}`);
  }
}

function defaultCreateWindow(
  options: ReturnType<typeof bannerWindowOptions>,
): BannerWindowLike {
  return new BrowserWindow({
    ...options,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  }) as unknown as BannerWindowLike;
}

function defaultResolveWorkArea(anchor: BannerBounds | null): BannerBounds {
  const display = anchor
    ? screen.getDisplayMatching(anchor)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return display.workArea;
}

function defaultSubscribeDisplayChanges(handler: () => void): () => void {
  // 每个事件单独注册:Electron 的 Screen.on 是按事件名重载的,循环一个联合类型过不了。
  screen.on('display-added', handler);
  screen.on('display-metrics-changed', handler);
  screen.on('display-removed', handler);
  return () => {
    screen.off('display-added', handler);
    screen.off('display-metrics-changed', handler);
    screen.off('display-removed', handler);
  };
}

export function createControlBannerWindow(
  deps: ControlBannerWindowDeps = {},
): ControlBannerHandle {
  const createWindow = deps.createWindow ?? defaultCreateWindow;
  const resolveWorkArea = deps.resolveWorkArea ?? defaultResolveWorkArea;
  const subscribeDisplayChanges = deps.subscribeDisplayChanges ?? defaultSubscribeDisplayChanges;
  const schedule = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = deps.cancel ?? ((timer) => clearTimeout(timer));
  const log = deps.log ?? defaultLog;
  const onVisibilityLost = deps.onVisibilityLost;

  let window: BannerWindowLike | null = null;
  let unsubscribeDisplay: (() => void) | null = null;
  let keepTopTimer: ReturnType<typeof setTimeout> | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  let desiredVisible = false;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  function stopKeepTop(): void {
    if (keepTopTimer === null) return;
    cancel(keepTopTimer);
    keepTopTimer = null;
  }

  function cancelLeave(): void {
    if (leaveTimer === null) return;
    cancel(leaveTimer);
    leaveTimer = null;
  }

  function cancelRebuild(): void {
    if (rebuildTimer === null) return;
    cancel(rebuildTimer);
    rebuildTimer = null;
  }

  /** 丢掉窗口:能销毁就销毁;销毁失败说明它可能还在屏幕上,如实记 error。 */
  function discard(target: BannerWindowLike | null, reason: string): void {
    cancelLeave();
    cancelRebuild();
    stopKeepTop();
    if (target && window === target) window = null;
    if (unsubscribeDisplay) {
      try {
        unsubscribeDisplay();
      } catch (error) {
        log('warn', `显示器变化退订失败: ${String(error)}`);
      }
      unsubscribeDisplay = null;
    }
    if (!target) return;
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (error) {
      log('error', `${reason}:窗口销毁失败,提示条可能仍留在屏幕上: ${String(error)}`);
      return;
    }
    log('warn', `${reason}:窗口已销毁(下次显示重建)`);
  }

  function ensureWindow(): BannerWindowLike {
    if (window && !window.isDestroyed()) return window;
    const created = createWindow(bannerWindowOptions(resolveWorkArea(null)));
    // 点击穿透:提示条不能挡住用户或智能体的鼠标操作。
    created.setIgnoreMouseEvents(true);
    // 内容保护:提示条从所有截屏里被排除(driver 的 computer_screenshot 拍不到它)。
    created.setContentProtection(true);
    created.on('closed', () => {
      const wasCurrent = window === created;
      if (wasCurrent) {
        window = null;
        cancelLeave();
        stopKeepTop();
      }
      // 只有「系统在我们仍认为该显示的时候关掉它」才自愈重建。我们自己降级销毁的
      // 窗口(discard 会先把 window 置空)不重建,否则会和失败重试互相打架。
      if (!wasCurrent || !desiredVisible || rebuildTimer !== null) return;
      log('warn', '提示条窗口被系统关闭,正在重建');
      rebuildTimer = schedule(() => {
        rebuildTimer = null;
        if (!desiredVisible || window) return;
        if (showNow()) return;
        // 补不回来了:窗口层自己认输没有用 —— 服务层的记账还是「已显示」,它会继续把
        // 后面的显示请求短路掉,这一整段操作里提示条再也回不来(而 Esc 还武装着)。
        // 如实上报,让服务层把状态改成未显示。
        desiredVisible = false;
        log('warn', '提示条重建失败,上报窗口已不在屏幕上');
        try {
          onVisibilityLost?.();
        } catch (error) {
          log('warn', `上报提示条丢失失败: ${String(error)}`);
        }
      }, REBUILD_DELAY_MS);
    });
    window = created;
    if (!unsubscribeDisplay) unsubscribeDisplay = subscribeDisplayChanges(repositionCurrent);
    // 不 await:页面是一个极小的 data URL,透明窗口在内容画出来之前本来就是空的。
    void created.loadURL(bannerDataUrl()).then(
      () => {
        // 页面加载完成后再补一次入场状态。上面 reveal 的 executeJavaScript 可能落在
        // 导航提交**前**的文档上 —— 新文档一提交就把它连状态一起丢掉,那样首次显示会
        // 停在 leaving:窗口占着置顶层级、服务层与看门狗都认为显示成功,而肉眼看什么都
        // 没有。这正是本工单要修的那类「操作已经开始却看不见提示条」。
        if (!desiredVisible || window !== created || created.isDestroyed()) return;
        void created.webContents
          .executeJavaScript(ACTIVE_STATE_SCRIPT)
          .catch((error) => log('warn', `提示条入场状态补写失败: ${String(error)}`));
      },
      (error) => log('error', `提示条页面加载失败(窗口是空的): ${String(error)}`),
    );
    return created;
  }

  function startKeepTop(target: BannerWindowLike): void {
    stopKeepTop();
    keepTopTimer = schedule(() => {
      keepTopTimer = null;
      if (!desiredVisible || window !== target || target.isDestroyed()) return;
      try {
        target.setAlwaysOnTop(true, 'screen-saver');
      } catch (error) {
        log('warn', `置顶重申失败: ${String(error)}`);
        return;
      }
      startKeepTop(target);
    }, KEEP_TOP_INTERVAL_MS);
  }

  function reveal(target: BannerWindowLike): void {
    cancelLeave();
    target.setBounds(bannerWindowOptions(resolveWorkArea(null)));
    void target.webContents.executeJavaScript(ACTIVE_STATE_SCRIPT).catch((error) => {
      log('warn', `提示条入场状态切换失败: ${String(error)}`);
    });
    // showInactive:显示但不激活 —— 不把用户正在输入的窗口切走。
    target.showInactive();
    // Windows 隐藏透明窗口后会清掉 WS_EX_TOPMOST;showInactive 只恢复可见性,不恢复
    // 原生 Z-order,所以**每次显示**都必须重新声明层级并移到该层级最前。
    target.setAlwaysOnTop(true, 'screen-saver');
    target.moveTop();
    startKeepTop(target);
  }

  function repositionCurrent(): void {
    if (!desiredVisible || !window || window.isDestroyed()) return;
    try {
      window.setBounds(bannerWindowOptions(resolveWorkArea(window.getBounds())));
    } catch (error) {
      log('warn', `显示器变化后重定位失败: ${String(error)}`);
    }
  }

  /** 建窗 + 显示。返回是否达成;失败时窗口已降级销毁,调用方不该再复用句柄。 */
  function showNow(): boolean {
    let target: BannerWindowLike;
    try {
      target = ensureWindow();
    } catch (error) {
      log('warn', `提示条窗口创建失败: ${String(error)}`);
      discard(window, '建窗失败');
      return false;
    }
    try {
      reveal(target);
    } catch (error) {
      log('warn', `提示条显示失败: ${String(error)}`);
      discard(target, '显示失败');
      return false;
    }
    return true;
  }

  return {
    setVisible(visible: boolean): boolean {
      if (!visible) {
        desiredVisible = false;
        cancelLeave();
        stopKeepTop();
        const target = window;
        if (!target || target.isDestroyed()) return true; // 没有窗口 = 已经不在屏幕上
        try {
          void target.webContents.executeJavaScript(LEAVING_STATE_SCRIPT).catch((error) => {
            log('warn', `提示条离场状态切换失败: ${String(error)}`);
          });
          // 先播离场动画再 hide:窗口保留复用,下一次显示立即出现(不等建窗与页面加载)。
          leaveTimer = schedule(() => {
            leaveTimer = null;
            if (window !== target || target.isDestroyed()) return;
            try {
              target.hide();
            } catch (error) {
              log('warn', `提示条隐藏失败,降级销毁窗口: ${String(error)}`);
              discard(target, '隐藏失败');
            }
          }, CONTROL_BANNER_LEAVE_ANIMATION_MS);
        } catch (error) {
          log('warn', `提示条隐藏失败: ${String(error)}`);
          discard(target, '隐藏失败');
          return false;
        }
        return true;
      }

      desiredVisible = true;
      const shown = showNow();
      if (!shown) desiredVisible = false;
      return shown;
    },
    dispose(): void {
      desiredVisible = false;
      const target = window;
      window = null;
      cancelLeave();
      cancelRebuild();
      stopKeepTop();
      if (unsubscribeDisplay) {
        try {
          unsubscribeDisplay();
        } catch (error) {
          log('warn', `显示器变化退订失败: ${String(error)}`);
        }
        unsubscribeDisplay = null;
      }
      if (!target) return;
      try {
        target.hide();
      } catch {
        // 藏不住也要销毁:退出路径不能因为一次 hide 失败就留下提示条。
      }
      try {
        if (!target.isDestroyed()) target.destroy();
      } catch (error) {
        log('warn', `退出时销毁提示条失败: ${String(error)}`);
      }
    },
  };
}
