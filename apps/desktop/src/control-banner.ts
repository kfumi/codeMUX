//! 控制中提示条(工单 10;常驻语义与顶部样式见工单 15):智能体正在操作这台电脑时,
//! 屏幕上要有一句人话,并且写明「按 Esc 急停」是有效的。
//!
//! 与全局 Esc 同生共死:提示条宣传的就是那个键,所以只在 Esc 真武装了之后显示
//! —— 注册失败(被别的程序占着)时宁可什么都不显示,也不给一个骗人的提示。
//! 武装状态由渲染层按「这个回合里出现过 computer_* 调用」驱动(见
//! `src/hooks/useEmergencyStop.ts`),所以**武装多久就显示多久**:操作进行期间常驻,
//! 回合结束才收起。工单 15 之前是显示 1s 自动收起(同一次活动期间不重复弹),多步
//! 操作里只闪一下就没,用户实测反馈不合理。
//!
//! 位置与外观对齐参考实现(ZCode)的顶部指示条:主屏工作区顶部下方一点、水平居中、
//! 深色半透明圆角小条,左侧三点动画。窗口本身不可交互(点击穿透、不抢焦点、不进
//! 任务栏),并且不进截图(见 control-banner-window 的内容保护)。
//!
//! 本文件不 import electron(建窗在 control-banner-window),纯函数与状态机都能在
//! Node 里测。

/** 提示条主文案(与参考实现的「正在操作电脑」是同一件事)。 */
export const CONTROL_BANNER_TEXT = 'CodeMUX 正在操作电脑';

/** 次级文案:提示条宣传的急停键(全局 Esc 真武装了才会显示)。 */
export const CONTROL_BANNER_HINT = '按 Esc 急停';

/** 提示条尺寸(px):宽度对当前文案留有余量,配合 nowrap 不会裁字。 */
export const CONTROL_BANNER_WIDTH = 360;
export const CONTROL_BANNER_HEIGHT = 44;

/** 垂直位置:主屏工作区顶部下方 28px —— 贴近屏幕顶端,与参考指示条同位。 */
export const CONTROL_BANNER_TOP_OFFSET = 28;

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
  const y = workArea.y + Math.min(CONTROL_BANNER_TOP_OFFSET, Math.max(workArea.height - height, 0));
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
export function bannerHtml(
  text: string = CONTROL_BANNER_TEXT,
  hint: string = CONTROL_BANNER_HINT,
): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escaped = escape(text);
  const escapedHint = escape(hint);
  // 样式与动效值就地写:这是独立的壳页面(data URL),拿不到渲染层的动效/配色
  // token;动画只有一处入场淡入和三点呼吸,并尊重 reduce-motion。
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    user-select: none; -webkit-user-select: none; cursor: default; }
  .pill { height: 100%; box-sizing: border-box; display: flex; align-items: center;
    justify-content: center; gap: 10px; padding: 0 16px; border-radius: 12px;
    white-space: nowrap; overflow: hidden;
    font: 500 14px/1.2 "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
    color: #f4f4f5; background: rgba(32, 33, 38, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    animation: banner-in 200ms ease-out both; }
  .dots { display: inline-flex; gap: 3px; flex: none; }
  .dots i { width: 4px; height: 4px; border-radius: 999px; background: #d4d4d8;
    animation: dots 1.2s ease-in-out infinite; }
  .dots i:nth-child(2) { animation-delay: 180ms; }
  .dots i:nth-child(3) { animation-delay: 360ms; }
  .hint { color: #a1a1aa; font-weight: 400; }
  @keyframes dots { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
  @keyframes banner-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .pill { animation: none; }
    .dots i { animation: none; opacity: 0.7; }
  }
</style></head><body><div class="pill"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${escaped}</span><span class="hint">${escapedHint}</span></div></body></html>`;
}

/** 提示条页面以 data URL 加载(不落盘、不占协议处理器)。 */
export function bannerDataUrl(
  text: string = CONTROL_BANNER_TEXT,
  hint: string = CONTROL_BANNER_HINT,
): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(bannerHtml(text, hint))}`;
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

/**
 * 提示条状态机:纯跟随「该不该显示」,没有自己的定时器 —— 显示多久由渲染层的
 * 武装窗口决定(工单 15),壳侧不替它做超时决定。
 */
export function createControlBannerService(deps: ControlBannerDeps): ControlBannerService {
  const log = deps.log ?? defaultLog;
  let handle: ControlBannerHandle | null = null;

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
        // 武装期间判据会随工具事件反复重算,重复请求是常态:开一次就够。
        if (handle !== null) return;
        try {
          handle = deps.open();
        } catch (error) {
          handle = null;
          log('warn', `控制中提示条创建失败: ${String(error)}`);
          return;
        }
        log('info', '控制中提示条已显示(电脑控制进行中,按 Esc 急停)');
        return;
      }
      if (handle === null) return;
      closeHandle();
      log('info', '控制中提示条已隐藏(电脑控制结束)');
    },
    isVisible: () => handle !== null,
  };
}
