//! 电脑控制「武装」真值(工单 03;spec 2026-10-10 / ADR 0018):提示条显隐与全局 Esc
//! 由**两个来源**共管,daemon 是权威。
//!
//! 来源与分工:
//!
//! - **daemon**:控制面 WS 上的 `computer-use-activity` 事件(工单 01 的活动真值)。
//!   「这台机器正在被驱动」只有 daemon 知道 —— 没人开界面、渲染层从没加载、
//!   浏览器/手机客户端在用,这三种形态下渲染层都算不出来。
//! - **渲染层**:`codemux:setEmergencyStopArmed`(工单 06/10/18 的旧路径)。并存期保留,
//!   但**只能「加」不能「减」**:它报有活动就保持武装,报没有不能把 daemon 的那份减掉。
//!
//! 合成规则:`链路在 ∧ (daemon 有活动 ∨ 渲染层要武装)`。
//!
//! 链路不在就谁都不武装:唯一能真正停下来的地方(daemon)不可达时,Esc 与提示条都是假的
//! —— 宁可 fail-hidden,也不挂一条按不动的「按 Esc 急停」。
//!
//! 看门狗(工单 18)跟着来源走:渲染层这一半在武装期间继续发心跳,超时只撤掉这半边;
//! daemon 那一半的活性判据是控制面链路本身(断链即解除,见 `browser-automation.ts`
//! 的连接状态回调与 Ping/Pong 保活),不再拿一个与 daemon 无关的计时器去猜。
//!
//! 本文件不 import electron,便于 Node(vitest)契约测试。

import type { ArmedHeartbeatService } from './armed-heartbeat';
import type { ControlBannerService } from './control-banner';
import type { EmergencyStopService } from './emergency-stop';

export type ArmingLogLevel = 'info' | 'warn' | 'error';

/** 诊断与测试用:两个来源 + 链路 + 合成后的实际结果。 */
export interface ComputerUseArmingState {
  /** 全局 Esc 是否**实际**武装着(合成后的结果)。 */
  armed: boolean;
  /** 渲染层来源:渲染层报「有电脑控制在飞」。 */
  renderer: boolean;
  /** daemon 来源:daemon 报「这台机器正在被驱动」。 */
  daemon: boolean;
  /** 控制面链路是否连着(不连则谁都不武装)。 */
  linkUp: boolean;
}

export interface ComputerUseArmingDeps {
  emergencyStop: EmergencyStopService;
  controlBanner: ControlBannerService;
  armedHeartbeat: ArmedHeartbeatService;
  /**
   * 是否正在退出(工单 18)。
   *
   * 退出流程会先解除武装并销毁提示条,而渲染层的武装心跳还会在拿到 false 后重新声明
   * 一次 —— 那条路径必须被拒掉,否则会在关机过程里重新注册全局 Esc、重建提示条窗口,
   * 而 main 那边的引用已经置空,没人再去收它。
   */
  isQuitting?(): boolean;
  log?(level: ArmingLogLevel, message: string): void;
}

export interface ComputerUseArming {
  /** 渲染层来源(IPC);返回**实际**武装结果(注册失败/退出中/链路断都是 false)。 */
  setRendererArmed(armed: boolean): boolean;
  /** 渲染层武装心跳(工单 18):返回实际是否还武装着,顺手给看门狗续期。 */
  heartbeat(): boolean;
  /** daemon 来源:控制面 `computer-use-activity` 事件。 */
  setDaemonActivity(active: boolean): void;
  /** 控制面链路状态:断开即 fail-hidden(收起提示条 + 解除 Esc)。 */
  setDaemonLinkUp(up: boolean): void;
  /**
   * 渲染层不会再驱动这套状态时的收尾(工单 18):只撤**渲染层这一半**。
   *
   * daemon 那一半不受影响 —— 无人值守的驱动没有渲染层也必须留着提示条与 Esc。
   */
  dropRendererSource(reason: string): void;
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
  let rendererArmed = false;
  let daemonActive = false;
  let linkUp = false;
  /** 上一次落到屏幕上的结果:只在真变化时打日志,避免每个桌面动作刷屏。 */
  let applied: boolean | null = null;

  /** 打日志用:这次变化的来源是什么(排障时最先要看的就是它)。 */
  function describeSources(): string {
    const parts: string[] = [];
    if (!linkUp) parts.push('控制面链路断开');
    if (daemonActive) parts.push('daemon 报有活动');
    if (rendererArmed) parts.push('渲染层报有活动');
    return parts.length > 0 ? parts.join(' + ') : '两个来源都没有活动';
  }

  /**
   * 唯一出口:两个来源合成一次结果,合格才武装 + 显示提示条,**并且**只有真武装了才起看门狗
   * —— 注册失败(键被别的程序占着)时提示条本来就是隐藏的,没有「撒谎」的风险。
   */
  function apply(): boolean {
    const want = linkUp && (daemonActive || rendererArmed);
    deps.emergencyStop.setArmed(want);
    const armed = deps.emergencyStop.isArmed();
    deps.controlBanner.setVisible(armed);
    // 看门狗只守渲染层这一半:它证明的是「渲染层还在」;daemon 那一半的活性判据是链路。
    if (armed && rendererArmed) {
      deps.armedHeartbeat.beat();
    } else {
      deps.armedHeartbeat.stop();
    }
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
    setRendererArmed(armed: boolean): boolean {
      if (armed && deps.isQuitting?.()) {
        // 退出中:武装请求一律落空(解除请求照常走,见 deps.isQuitting 的说明)。
        return false;
      }
      rendererArmed = armed;
      return apply();
    },

    heartbeat(): boolean {
      if (!deps.emergencyStop.isArmed()) {
        // 已被看门狗解除武装(渲染层卡顿到心跳丢失)或注册从未成功:如实回 false,
        // 让仍在驱动桌面的渲染层重新声明一次,而不是让它以为一切都好。
        return false;
      }
      if (rendererArmed) deps.armedHeartbeat.beat();
      return true;
    },

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

    dropRendererSource(reason: string): void {
      if (!rendererArmed && !deps.armedHeartbeat.isWatching()) return;
      log('warn', `${reason}:撤掉渲染层这一半武装(daemon 来源不受影响)`);
      rendererArmed = false;
      apply();
    },

    state(): ComputerUseArmingState {
      return {
        armed: deps.emergencyStop.isArmed(),
        renderer: rendererArmed,
        daemon: daemonActive,
        linkUp,
      };
    },
  };
}
