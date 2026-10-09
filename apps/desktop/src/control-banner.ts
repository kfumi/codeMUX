//! 控制中提示条(工单 10):智能体正在操作这台电脑时,屏幕上要有一句人话,
//! 并且写明「按 Esc 急停」是有效的。
//!
//! 与全局 Esc 同生共死:提示条宣传的就是那个键,所以只在 Esc 真武装了之后显示
//! —— 注册失败(被别的程序占着)时宁可什么都不显示,也不给一个骗人的提示。
//! 显示本身有上限(见 CONTROL_BANNER_MAX_VISIBLE_MS):到点自动收起,同一次连续
//! 活动期间不重复弹;活动断开后新的活动才会再显示(急停的武装状态不受影响)。
//!
//! 窗口本身不可交互(点击穿透、不抢焦点、不进任务栏),生命周期由渲染层按
//! 「有回合在跑」驱动。本文件不 import electron(建窗在 control-banner-window),
//! 纯函数与状态机都能在 Node 里测。

/** 提示条文案(与 PI-Desktop 的提示条同一件事:告诉用户电脑正在被控制)。 */
export const CONTROL_BANNER_TEXT = 'CodeMUX 正在控制这台电脑 · 按 Esc 急停';

/**
 * 显示上限(ms):提示条是「闪一下告知」,不是常驻角标。
 *
 * 一是别在屏幕上碍眼;二是 driver 会截屏,提示条必须赶在后续截图之前收掉
 * (配合 `control-banner-window` 的内容保护,截图里也不会出现它)。
 */
export const CONTROL_BANNER_MAX_VISIBLE_MS = 1000;

/** 提示条尺寸(px)。 */
export const CONTROL_BANNER_WIDTH = 460;
export const CONTROL_BANNER_HEIGHT = 44;

/** 垂直位置:主屏工作区高度的 17% —— 避开顶部工具栏与标题栏,又靠近视线中心。 */
export const CONTROL_BANNER_TOP_RATIO = 0.17;

/** 提示条窗口的创建参数(纯函数,便于测试钉住「不抢焦点 / 点击穿透 / 不进任务栏」)。 */
export function bannerWindowOptions(workArea: {
  x: number;
  y: number;
  width: number;
  height: number;
}): {
  x: number;
  y: number;
  width: number;
  height: number;
  frame: boolean;
  transparent: boolean;
  resizable: boolean;
  movable: boolean;
  minimizable: boolean;
  maximizable: boolean;
  fullscreenable: boolean;
  skipTaskbar: boolean;
  focusable: boolean;
  hasShadow: boolean;
  show: boolean;
  alwaysOnTop: boolean;
  backgroundColor: string;
} {
  const width = CONTROL_BANNER_WIDTH;
  const height = CONTROL_BANNER_HEIGHT;
  const y =
    workArea.y +
    Math.min(
      Math.max(Math.round(workArea.height * CONTROL_BANNER_TOP_RATIO) - Math.round(height / 2), 0),
      Math.max(workArea.height - height, 0),
    );
  return {
    x: workArea.x + Math.max(Math.round((workArea.width - width) / 2), 0),
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 不抢焦点是关键:提示条出现时不能把用户正在输入的窗口切走,也不能让
    // 智能体正在操作的目标窗口失焦。
    focusable: false,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
  };
}

/** 提示条页面(纯字符串;无脚本、无外链,点一下都不该有反应)。 */
export function bannerHtml(text: string = CONTROL_BANNER_TEXT): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    user-select: none; -webkit-user-select: none; cursor: default; }
  .pill { height: 100%; box-sizing: border-box; display: flex; align-items: center;
    justify-content: center; gap: 8px; padding: 0 18px; border-radius: 999px;
    font: 500 14px/1.2 "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
    color: #f4f4f5; background: rgba(24, 24, 27, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.18); }
  .dot { width: 8px; height: 8px; border-radius: 999px; background: #f59e0b; flex: none; }
</style></head><body><div class="pill"><span class="dot"></span><span>${escaped}</span></div></body></html>`;
}

/** 提示条页面以 data URL 加载(不落盘、不占协议处理器)。 */
export function bannerDataUrl(text: string = CONTROL_BANNER_TEXT): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(bannerHtml(text))}`;
}

export interface ControlBannerHandle {
  close(): void;
}

export interface ControlBannerDeps {
  /** 建窗并显示;返回关闭句柄。抛错视为显示失败(调用方不该崩)。 */
  open(): ControlBannerHandle;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface ControlBannerService {
  setVisible(visible: boolean): void;
  isVisible(): boolean;
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') {
    console.error(`[control-banner] ${message}`);
  } else if (level === 'warn') {
    console.warn(`[control-banner] ${message}`);
  } else {
    console.log(`[control-banner] ${message}`);
  }
}

export function createControlBannerService(deps: ControlBannerDeps): ControlBannerService {
  const log = deps.log ?? defaultLog;
  let handle: ControlBannerHandle | null = null;
  /** 被显示上限收起后仍处于「已请求」状态:同一次连续活动期间不再弹。 */
  let suppressedByTimeout = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHideTimer = () => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const closeHandle = () => {
    const closing = handle;
    handle = null;
    try {
      closing?.close();
    } catch (error) {
      // 关窗失败不该拦住退出流程,记一条就够。
      log('warn', `控制中提示条关闭失败: ${String(error)}`);
    }
  };

  return {
    setVisible(visible: boolean) {
      if (visible) {
        if (handle !== null || suppressedByTimeout) return;
        try {
          handle = deps.open();
        } catch (error) {
          handle = null;
          log('warn', `控制中提示条创建失败: ${String(error)}`);
          return;
        }
        log('info', '控制中提示条已显示(电脑控制进行中,按 Esc 急停)');
        hideTimer = setTimeout(() => {
          hideTimer = null;
          closeHandle();
          suppressedByTimeout = true;
          log('info', `控制中提示条已自动收起(显示上限 ${CONTROL_BANNER_MAX_VISIBLE_MS}ms)`);
        }, CONTROL_BANNER_MAX_VISIBLE_MS);
        return;
      }
      clearHideTimer();
      const wasVisible = handle !== null;
      closeHandle();
      suppressedByTimeout = false;
      if (wasVisible) {
        log('info', '控制中提示条已隐藏');
      }
    },
    isVisible: () => handle !== null,
  };
}
