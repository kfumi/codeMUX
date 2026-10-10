//! 全局 Esc 强打断(工单 06 需求 12;工单 10 收窄窗口,10 跟进再收窄):失控时两秒内停下来。
//!
//! 武装窗口(工单 03 起)由两个来源共同决定,见 `computer-use-arming.ts`:daemon 的
//! `computer-use-activity` 事件(权威)与渲染层的旧路径(并存期,见
//! `src/hooks/useEmergencyStop.ts`)。两者都只在「真的有电脑控制在飞」时举手 ——
//! 平时接管全局 Esc 等于替用户决定 Esc 归谁,而急停要停的是真实驱动动作。
//!
//! 触发动作是一件事:让 daemon 把**驱动子进程、限时授权、有活动的回合**一起停下
//! (工单 02 的 `/api/computer-use/estop`,工单 03 改用它)。不再依赖渲染层回话 ——
//! 「没人开界面」时那半条路本来就不存在,而这一层要能在任何形态下都停得下来。
//!
//! 本文件不 import electron(registerShortcut 由调用方注入),便于 Node 测试。

/** 注入面:全局快捷键注册 + 触发时的收尾动作。 */
export interface EmergencyStopDeps {
  /** 注册全局快捷键;返回是否注册成功(被占用时为 false)。 */
  registerShortcut(accelerator: string, handler: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
  /**
   * 触发时:一次调用把驱动、限时授权与有活动的回合一起停下(daemon 侧急停端点)。
   *
   * 失败只记日志(用户已经按下去了,这里没有第二条路可退);也没有「先通知渲染层」
   * 这种顺序依赖 —— 回合由 daemon 打断,界面从 daemon 的事件里知道结果。
   */
  estopEverything(): Promise<void>;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface EmergencyStopService {
  /** 武装/解除(工单 03 起由 computer-use-arming 按两个来源合成后调用)。 */
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
    log('warn', '全局 Esc 触发:急停驱动、收回限时授权并打断有活动的回合');
    void deps.estopEverything().catch((error: unknown) => {
      log('error', `急停失败: ${String(error)}`);
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
        log('info', '全局 Esc 已武装(有电脑控制在飞期间生效)');
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
