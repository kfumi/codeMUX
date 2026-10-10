//! 武装心跳看门狗(工单 18):提示条宣传「按 Esc 急停」,所以它不能比渲染层活得久。
//!
//! 分工:渲染层在武装期间按固定周期重发一次心跳(见 `src/hooks/useEmergencyStop.ts`
//! 的 `ARMED_HEARTBEAT_INTERVAL_MS`);这里只看「多久没收到」,超时即判定渲染层已失联,
//! 由 main 解除武装并收起提示条。
//!
//! 参考实现(ZCode 的 windowsCuaOperationIndicator)对同一类问题用的是 fail-hidden
//! 计时器:任何显式清除路径失约时,浮层也不能无限期留在屏幕上。区别只在于我们的
//! 「清除路径」是渲染层算出来的武装窗口,所以要多一层心跳来证明它还在。
//!
//! 本文件不 import electron,定时器由调用方注入,可在 Node 里测。

/**
 * 看门狗超时。
 *
 * 不是「心跳间隔的几倍」那么小:CodeMUX 窗口被遮挡/最小化时,Chromium 把渲染层当后台
 * 页面处理 —— 定时器先对齐到 1s,长时间后台(>5min)后按 intensive throttling 压到
 * **分钟级**(见 `apps/desktop/src/main.ts` 里刻意保留默认节流的说明)。5s 的心跳因此
 * 可能 60s 才来一次,超时必须跨越那个量级,否则会把「其实还活着的渲染层」判成失联,
 * 提示条与 Esc 在长时间后台操作里被反复拆建(用户按 Esc 大概率没反应)。
 *
 * 代价是「渲染层主线程真卡死」要两分钟才会被发现;最常见的场景 —— 渲染进程直接崩掉
 * —— 不走这条路径,由 main 的 render-process-gone 直接收尾。
 */
export const ARMED_HEARTBEAT_TIMEOUT_MS = 120_000;

export interface ArmedHeartbeatLogger {
  debug?(message: string): void;
  warn(message: string): void;
}

export interface ArmedHeartbeatDeps {
  /** 超时:调用方据此解除武装并收起提示条(不能只做一半)。 */
  onTimeout(): void;
  schedule?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel?(timer: ReturnType<typeof setTimeout>): void;
  logger?: ArmedHeartbeatLogger;
}

export interface ArmedHeartbeatService {
  /** 收到一次心跳(或刚武装):重新开始倒计时。 */
  beat(): void;
  /** 解除武装/退出:停止等待,不再触发超时。 */
  stop(): void;
  /** 是否正在等待心跳(诊断与测试用)。 */
  isWatching(): boolean;
}

export function createArmedHeartbeat(deps: ArmedHeartbeatDeps): ArmedHeartbeatService {
  const schedule = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = deps.cancel ?? ((timer) => clearTimeout(timer));
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  return {
    beat() {
      clear();
      timer = schedule(() => {
        timer = null;
        deps.logger?.warn(
          `武装心跳超时(${ARMED_HEARTBEAT_TIMEOUT_MS}ms 未收到渲染层心跳):解除 Esc 并收起控制中提示条`,
        );
        try {
          deps.onTimeout();
        } catch (error) {
          // 收尾动作自己抛错不该把看门狗线程带崩;武装状态已经在调用方那边被处理。
          deps.logger?.warn(`武装心跳超时处理失败: ${String(error)}`);
        }
      }, ARMED_HEARTBEAT_TIMEOUT_MS);
    },
    stop() {
      clear();
    },
    isWatching: () => timer !== null,
  };
}
