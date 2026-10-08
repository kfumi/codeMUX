//! 全局 Esc 强打断(工单 06 需求 12):失控时两秒内停下来。
//!
//! 只在「系统级执行」开启期间武装 —— 全局 Esc 会抢走所有应用的 Esc,平时
//! 装着它等于替用户决定 Esc 归谁。开启系统级执行意味着智能体能碰真实键鼠,
//! 这个代价才是值的。
//!
//! 触发动作是两件事,缺一不可:杀驱动子进程(在途动作立刻断),并通知渲染层
//! 打断当前回合(把「停下来」这个事实告诉模型与用户)。
//!
//! 本文件不 import electron(registerShortcut 由调用方注入),便于 Node 测试。

/** 注入面:全局快捷键注册 + 触发时的收尾动作。 */
export interface EmergencyStopDeps {
  /** 注册全局快捷键;返回是否注册成功(被占用时为 false)。 */
  registerShortcut(accelerator: string, handler: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
  /** 触发时:杀驱动子进程(daemon 侧 estop)。失败不应拦住通知。 */
  estopDriver(): Promise<void>;
  /** 触发时:通知渲染层打断当前回合。 */
  notifyRenderer(): void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface EmergencyStopService {
  /** 渲染层按配置武装/解除(开启系统级执行才武装)。 */
  setArmed(armed: boolean): void;
  isArmed(): boolean;
  /** 手动触发(测试与将来的菜单项用)。 */
  trigger(): void;
}

export const EMERGENCY_STOP_ACCELERATOR = 'Escape';

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') {
    console.error(`[emergency-stop] ${message}`);
  } else if (level === 'warn') {
    console.warn(`[emergency-stop] ${message}`);
  } else {
    console.log(`[emergency-stop] ${message}`);
  }
}

export function createEmergencyStopService(deps: EmergencyStopDeps): EmergencyStopService {
  const log = deps.log ?? defaultLog;
  let armed = false;

  const run = () => {
    log('warn', '全局 Esc 触发:急停驱动并打断当前回合');
    // 先通知界面(人看到的要先发生),再异步杀驱动。
    try {
      deps.notifyRenderer();
    } catch (error) {
      log('error', `通知渲染层失败: ${String(error)}`);
    }
    void deps.estopDriver().catch((error: unknown) => {
      log('error', `急停驱动失败: ${String(error)}`);
    });
  };

  return {
    setArmed(next: boolean) {
      if (next === armed) return;
      if (next) {
        const registered = deps.registerShortcut(EMERGENCY_STOP_ACCELERATOR, run);
        if (!registered) {
          log('warn', '全局 Esc 注册失败(可能被其他程序占用),急停仍可用设置页按钮');
          return;
        }
        armed = true;
        log('info', '全局 Esc 已武装(系统级执行开启期间生效)');
      } else {
        deps.unregisterShortcut(EMERGENCY_STOP_ACCELERATOR);
        armed = false;
        log('info', '全局 Esc 已解除');
      }
    },
    isArmed: () => armed,
    trigger: run,
  };
}
