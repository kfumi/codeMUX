//! 控制中提示条(工单 10;常驻语义与顶部样式见工单 15;壳侧兜底与窗口复用见工单 18):
//! 智能体正在操作这台电脑时,屏幕上要有一句人话,并且写明「按 Esc 急停」是有效的。
//!
//! 与全局 Esc 同生共死:提示条宣传的就是那个键,所以只在 Esc 真武装了之后显示
//! —— 注册失败(被别的程序占着)时宁可什么都不显示,也不给一个骗人的提示。
//! 武装状态由渲染层按「这个回合里出现过 computer_* 调用」驱动(见
//! `src/hooks/useEmergencyStop.ts`),所以**武装多久就显示多久**:操作进行期间常驻,
//! 回合结束才收起。
//!
//! 但壳侧不再无条件相信渲染层(工单 18):武装期间渲染层要持续发心跳,壳侧看门狗
//! (`apps/desktop/src/armed-heartbeat.ts`)收不到就自己收起并解除 Esc —— 提示条可能
//! 比渲染层活得久,它不能替一个已经失联的渲染层继续声称「按 Esc 能停下」。
//!
//! 窗口不销毁、只离场(工单 18):下一次显示复用同一个窗口,省掉建窗 + 数据页加载的
//! 可见延迟(操作已经开始而提示条还在加载,等于没提示)。真隐藏不了时降级销毁,并把
//! 「其实没隐藏成功」如实回报给调用方,绝不把降级当成功。
//!
//! 位置与外观对齐参考实现(ZCode)的顶部指示条:光标所在显示器工作区顶部下方一点、
//! 水平居中、深色半透明圆角小条,左侧三点动画。窗口本身不可交互(点击穿透、不抢
//! 焦点、不进任务栏),并且不进截图(见 control-banner-window 的内容保护)。
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

/**
 * 离场动画时长(ms),必须与下面页面里的 transition 一致。
 *
 * 窗口复用(工单 18)之后不能再靠「重新加载页面」播入场动画,所以入场/离场都由页面
 * 上的 `data-state` 驱动;隐藏要等这段动画播完再 hide(),否则会看到一帧硬切。
 */
export const CONTROL_BANNER_LEAVE_ANIMATION_MS = 120;

export interface BannerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  // token;动画只有一处入场/离场位移淡入与三点呼吸,并尊重 reduce-motion。
  //
  // 页面**以 leaving 起步**:窗口复用后不再重新加载页面(工单 18),入场只能靠
  // 把 data-state 切成 active 触发过渡 —— 起步停在 leaving,首次显示才有同样的淡入。
  return `<!doctype html>
<html data-state="leaving"><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    user-select: none; -webkit-user-select: none; cursor: default; }
  .pill { height: 100%; box-sizing: border-box; display: flex; align-items: center;
    justify-content: center; gap: 10px; padding: 0 16px; border-radius: 12px;
    white-space: nowrap; overflow: hidden;
    font: 500 14px/1.2 "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
    color: #f4f4f5; background: rgba(32, 33, 38, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    opacity: 0; transform: translateY(-4px);
    transition: opacity 120ms ease, transform 120ms ease; }
  html[data-state="active"] .pill { opacity: 1; transform: translateY(0); }
  .dots { display: inline-flex; gap: 3px; flex: none; }
  .dots i { width: 4px; height: 4px; border-radius: 999px; background: #d4d4d8;
    animation: dots 1.2s ease-in-out infinite; }
  .dots i:nth-child(2) { animation-delay: 180ms; }
  .dots i:nth-child(3) { animation-delay: 360ms; }
  .hint { color: #a1a1aa; font-weight: 400; }
  @keyframes dots { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .pill { transition: none; }
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
  /**
   * 目标可见态。返回**是否达成**:`false` = 窗口层已经降级(建不出来 / 隐藏失败后
   * 销毁),调用方必须丢掉这个句柄并在下次显示时重建 —— 绝不能把 false 当成功,
   * 否则会出现「代码认为已隐藏,屏幕上还挂着提示」。
   *
   * 隐藏是「播完离场动画再 hide」,窗口本身保留复用。
   */
  setVisible(visible: boolean): boolean;
  /** 彻底销毁窗口(退出/管线重建)。 */
  dispose(): void;
}

export interface ControlBannerDeps {
  /** 建窗并返回句柄。抛错视为显示失败(调用方不该崩)。 */
  open(): ControlBannerHandle;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface ControlBannerService {
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  /** 退出:收起并销毁窗口(提示条是独立窗口,不该比应用活得久)。此后本服务就地失效。 */
  dispose(): void;
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
 * 提示条状态机:纯跟随「该不该显示」,没有自己的定时器 —— 显示多久由渲染层的武装
 * 窗口 + 壳侧心跳看门狗决定(工单 15/18),这里不替它们做超时决定。
 *
 * 句柄在隐藏时**保留**(窗口复用);只有窗口层回报失败时才丢弃重建。
 */
export function createControlBannerService(deps: ControlBannerDeps): ControlBannerService {
  const log = deps.log ?? defaultLog;
  let handle: ControlBannerHandle | null = null;
  let visible = false;
  /**
   * dispose 之后就地失效(工单 18)。
   *
   * 退出等待期间渲染层的武装心跳会拿到 false 并重新声明一次武装,那条路径会再走一遍
   * setVisible(true):此刻窗口已经销毁,若还允许重建,退出过程里就会闪出一条「正在操作
   * 电脑」的提示条,并重新占住全局 Esc —— 而 main 那边的引用已经置空,没人再收它。
   */
  let disposed = false;

  const dropHandle = (reason: string): void => {
    const dropping = handle;
    handle = null;
    if (!dropping) return;
    try {
      dropping.dispose();
    } catch (error) {
      log('warn', `控制中提示条销毁失败(${reason}): ${String(error)}`);
    }
  };

  return {
    setVisible(next: boolean) {
      if (disposed) return;
      if (next) {
        // 武装期间判据会随工具事件反复重算,重复请求是常态:提醒窗口层没有意义。
        if (visible) return;
        if (!handle) {
          try {
            handle = deps.open();
          } catch (error) {
            handle = null;
            log('warn', `控制中提示条创建失败: ${String(error)}`);
            return;
          }
        }
        let shown = false;
        try {
          shown = handle.setVisible(true);
        } catch (error) {
          log('warn', `控制中提示条显示失败: ${String(error)}`);
        }
        if (!shown) {
          // 没显示成就不能记成已显示:下一次请求重建,期间屏幕上是干净的。
          log('warn', '控制中提示条未显示成功,丢弃窗口(下次显示重建)');
          dropHandle('show-failed');
          return;
        }
        visible = true;
        log('info', '控制中提示条已显示(电脑控制进行中,按 Esc 急停)');
        return;
      }
      if (!visible) return;
      visible = false;
      if (!handle) return;
      let hidden = false;
      try {
        hidden = handle.setVisible(false);
      } catch (error) {
        log('warn', `控制中提示条隐藏失败: ${String(error)}`);
      }
      if (!hidden) {
        // fail-hidden:隐藏没成功就等于屏幕上还挂着「按 Esc 急停」的提示。窗口层已在
        // 内部降级销毁,这里丢掉句柄,下一次显示重建 —— 绝不能只把记账改成"已隐藏"。
        log('warn', '控制中提示条隐藏未确认,丢弃窗口(下次显示重建)');
        dropHandle('hide-failed');
        return;
      }
      log('info', '控制中提示条已隐藏(电脑控制结束)');
    },
    isVisible: () => visible,
    dispose() {
      disposed = true;
      visible = false;
      dropHandle('dispose');
    },
  };
}
