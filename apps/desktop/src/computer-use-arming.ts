//! 电脑控制「武装」真值(工单 03;工单 04 删掉第二个来源后只剩 daemon 这一份):
//! 提示条显隐与全局 Esc 由**一个**来源驱动 —— daemon 的活动真值。
//!
//! 来源:控制面 WS 上的 `computer-use-activity` 事件(工单 01 的活动真值)。
//! 「这台机器正在被驱动」只有 daemon 知道 —— 没人开界面、渲染层从没加载、
//! 浏览器/手机客户端在用,这三种形态下渲染层都算不出来。渲染层那条旧路径
//! (工单 06/10/18 的武装 + 心跳)已随工单 04 退役,并存期的「只能加不能减」随之作废。
//!
//! 合成规则:`控制面链路在 ∧ daemon 报有活动`。
//!
//! 链路不在就谁都不武装:唯一能真正停下来的地方(daemon)不可达时,Esc 与提示条都是假的
//! —— 宁可 fail-hidden,也不挂一条按不动的「按 Esc 急停」。
//!
//! 活性判据是控制面链路本身(断链即解除,见 `browser-automation.ts` 的连接状态回调与
//! Ping/Pong 保活)。渲染层不再有第二份状态:它崩了、卡了、根本不存在,都不影响这台机器
//! 上的提示条与 Esc —— 工单 18 的渲染层心跳看门狗因此一并退役。
//!
//! 本文件不 import electron,便于 Node(vitest)契约测试。

import type { ControlBannerService } from './control-banner';
import type { EmergencyStopService } from './emergency-stop';

export type ArmingLogLevel = 'info' | 'warn' | 'error';

/** 诊断与测试用:来源 + 链路 + 合成后的实际结果。 */
export interface ComputerUseArmingState {
  /** 全局 Esc 是否**实际**武装着(合成后的结果)。 */
  armed: boolean;
  /** daemon 来源:daemon 报「这台机器正在被驱动」。 */
  daemon: boolean;
  /** 控制面链路是否连着(不连则谁都不武装)。 */
  linkUp: boolean;
}

export interface ComputerUseArmingDeps {
  emergencyStop: EmergencyStopService;
  controlBanner: ControlBannerService;
  log?(level: ArmingLogLevel, message: string): void;
}

export interface ComputerUseArming {
  /** daemon 来源:控制面 `computer-use-activity` 事件。 */
  setDaemonActivity(active: boolean): void;
  /** 控制面链路状态:断开即 fail-hidden(收起提示条 + 解除 Esc)。 */
  setDaemonLinkUp(up: boolean): void;
  state(): ComputerUseArmingState;
}

function defaultLog(level: ArmingLogLevel, message: string): void {
  if (level === 'error') {
    console.error(`[computer-use-arming] ${message}`);
  } else if (level === 'warn') {
    console.warn(`[computer-use-arming] ${message}`);
  } else {
    console.log(`[computer-use-arming] ${message}`);
  }
}

export function createComputerUseArming(deps: ComputerUseArmingDeps): ComputerUseArming {
  const log = deps.log ?? defaultLog;
  let daemonActive = false;
  let linkUp = false;
  /** 上一次落到屏幕上的结果:只在真变化时打日志,避免每个桌面动作刷屏。 */
  let applied: boolean | null = null;

  /** 打日志用:这次变化的来源是什么(排障时最先要看的就是它)。 */
  function describeSources(): string {
    const parts: string[] = [];
    if (!linkUp) parts.push('控制面链路断开');
    if (daemonActive) parts.push('daemon 报有活动');
    return parts.length > 0 ? parts.join(' + ') : 'daemon 报没有活动';
  }

  /**
   * 唯一出口:合成一次结果,合格才武装 + 显示提示条。
   *
   * 注册失败(键被别的程序占着)时提示条本来就是隐藏的,没有「撒谎」的风险 ——
   * 提示条宣传的是「按 Esc 急停」,不给一个按不动的键挂条。
   */
  function apply(): boolean {
    const want = linkUp && daemonActive;
    deps.emergencyStop.setArmed(want);
    const armed = deps.emergencyStop.isArmed();
    deps.controlBanner.setVisible(armed);
    if (applied !== armed) {
      applied = armed;
      log(
        'info',
        armed
          ? `全局 Esc 与提示条已接管(${describeSources()})`
          : `全局 Esc 与提示条已收起(${describeSources()})`,
      );
    }
    return armed;
  }

  return {
    setDaemonActivity(active: boolean): void {
      if (active === daemonActive) return;
      daemonActive = active;
      apply();
    },

    setDaemonLinkUp(up: boolean): void {
      if (up === linkUp) return;
      linkUp = up;
      if (!up) {
        // 链路没了:daemon 报的「有活动」不再可信(它的「活动结束」也永远等不到)。
        daemonActive = false;
      }
      apply();
    },

    state(): ComputerUseArmingState {
      return {
        armed: deps.emergencyStop.isArmed(),
        daemon: daemonActive,
        linkUp,
      };
    },
  };
}
