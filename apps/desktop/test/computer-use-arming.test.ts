// 电脑控制「武装」真值(工单 03)契约测试:两个来源合成、链路断开 fail-hidden、
// 看门狗只守渲染层这一半。这一层是「提示条显隐 + 全局 Esc」的唯一出口,
// 每一条断言都对应屏幕上看得见的行为。
import { describe, expect, it, vi } from 'vitest';

import { createComputerUseArming, type ComputerUseArmingDeps } from '../src/computer-use-arming';

interface Stubs {
  deps: ComputerUseArmingDeps;
  emergencyStop: {
    setArmed: ReturnType<typeof vi.fn>;
    isArmed: ReturnType<typeof vi.fn>;
    trigger: ReturnType<typeof vi.fn>;
  };
  controlBanner: {
    setVisible: ReturnType<typeof vi.fn>;
    isVisible: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  armedHeartbeat: {
    beat: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    isWatching: ReturnType<typeof vi.fn>;
  };
  log: ReturnType<typeof vi.fn>;
}

/**
 * 最小壳依赖:`registrationSucceeds = false` 对应 Electron `globalShortcut.register`
 * 被别的程序占用(武装请求落空);`quitting` 对应正在退出的壳。
 */
function stubs(options: { registrationSucceeds?: boolean; quitting?: boolean } = {}): Stubs {
  const registrationSucceeds = options.registrationSucceeds ?? true;
  let armed = false;
  let watching = false;
  const emergencyStop = {
    setArmed: vi.fn((next: boolean) => {
      armed = next && registrationSucceeds;
    }),
    isArmed: vi.fn(() => armed),
    trigger: vi.fn(),
  };
  const controlBanner = {
    setVisible: vi.fn(),
    isVisible: vi.fn(() => false),
    dispose: vi.fn(),
  };
  const armedHeartbeat = {
    beat: vi.fn(() => {
      watching = true;
    }),
    stop: vi.fn(() => {
      watching = false;
    }),
    isWatching: vi.fn(() => watching),
  };
  const log = vi.fn();
  return {
    emergencyStop,
    controlBanner,
    armedHeartbeat,
    log,
    deps: {
      emergencyStop,
      controlBanner,
      armedHeartbeat,
      log,
      ...(options.quitting ? { isQuitting: () => true } : {}),
    },
  };
}

describe('电脑控制武装真值(工单 03)', () => {
  it('daemon 报有活动就武装并显示提示条(渲染层从没加载也能显示)', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);

    arming.setDaemonActivity(true);
    expect(s.emergencyStop.setArmed).toHaveBeenLastCalledWith(true);
    expect(s.emergencyStop.isArmed()).toBe(true);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(true);

    // 活动转假 → 收起:这是无人值守回合结束后的正常收尾。
    arming.setDaemonActivity(false);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);
    expect(s.emergencyStop.isArmed()).toBe(false);
  });

  it('链路断了 fail-hidden:收起提示条 + 解除 Esc,不挂一条按不动的急停提示', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);
    arming.setDaemonActivity(true);
    expect(s.emergencyStop.isArmed()).toBe(true);

    arming.setDaemonLinkUp(false);
    expect(s.emergencyStop.setArmed).toHaveBeenLastCalledWith(false);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);
    // daemon 报过的「有活动」也不再可信(它的「活动结束」永远等不到了)。
    expect(arming.state()).toEqual({ armed: false, renderer: false, daemon: false, linkUp: false });

    // 链路不在时,渲染层自己报「有活动」也不能武装:daemon 不可达,Esc 按下去停不了
    // 任何东西(它的举手只落空,链接恢复后再由合成结果决定)。
    expect(arming.setRendererArmed(true)).toBe(false);
    expect(s.emergencyStop.isArmed()).toBe(false);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('并存期两个来源只能加不能减:任一报有活动就保持武装与显示', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);

    expect(arming.setRendererArmed(true)).toBe(true);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(true);

    // 渲染层说没活动,但 daemon 说在驱动 → 保持武装(不丢 Esc)。
    arming.setDaemonActivity(true);
    arming.setRendererArmed(false);
    expect(s.emergencyStop.isArmed()).toBe(true);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(true);

    // 两个都说没有 → 才收起。
    arming.setDaemonActivity(false);
    expect(s.emergencyStop.isArmed()).toBe(false);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('链路还没连上时渲染层的举手先落空,链路一通就补上(不丢 Esc)', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);

    // 控制面还没连上:谁都不武装(daemon 不可达时 Esc 与提示条都是假的)。
    expect(arming.setRendererArmed(true)).toBe(false);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);

    arming.setDaemonLinkUp(true);
    expect(s.emergencyStop.isArmed()).toBe(true);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('注册失败(键被别的程序占着)不显示提示条,也不起看门狗', () => {
    const s = stubs({ registrationSucceeds: false });
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);

    arming.setDaemonActivity(true);

    expect(s.emergencyStop.isArmed()).toBe(false);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);
    expect(s.armedHeartbeat.beat).not.toHaveBeenCalled();
  });

  it('渲染层这一半被收尾(看门狗超时 / 渲染进程没了)时,daemon 那一半照旧', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);
    arming.setRendererArmed(true);
    expect(s.armedHeartbeat.beat).toHaveBeenCalledTimes(1);

    // 没有 daemon 活动时:撤渲染层 = 收起提示条(工单 18 的既有行为)。
    arming.dropRendererSource('测试:渲染进程已退出');
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);
    expect(s.armedHeartbeat.stop).toHaveBeenCalled();
    expect(arming.heartbeat()).toBe(false);

    // 有 daemon 活动时:同一个收尾不能把 daemon 报的活动一起撤掉。
    arming.setDaemonActivity(true);
    arming.setRendererArmed(true);
    arming.dropRendererSource('测试:武装心跳超时');
    expect(s.emergencyStop.isArmed()).toBe(true);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(true);
    expect(arming.state()).toMatchObject({ daemon: true, renderer: false, armed: true });
  });

  it('只有渲染层来源武装时才喂看门狗(daemon 来源的活性判据是链路)', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);

    arming.setDaemonActivity(true);
    expect(s.armedHeartbeat.beat).not.toHaveBeenCalled();
    expect(s.armedHeartbeat.stop).toHaveBeenCalled();

    arming.setRendererArmed(true);
    expect(s.armedHeartbeat.beat).toHaveBeenCalledTimes(1);
    // 心跳续期照旧(渲染层据此发现壳已经撤过它一次)。
    expect(arming.heartbeat()).toBe(true);
    expect(s.armedHeartbeat.beat).toHaveBeenCalledTimes(2);
  });

  it('退出中的武装请求一律落空(不在关机过程里重建提示条与全局 Esc)', () => {
    const s = stubs({ quitting: true });
    const arming = createComputerUseArming(s.deps);

    expect(arming.setRendererArmed(true)).toBe(false);
    expect(s.emergencyStop.setArmed).not.toHaveBeenCalled();
    expect(s.controlBanner.setVisible).not.toHaveBeenCalled();
  });

  it('重复的同一事实不重复动屏幕状态(不刷屏、不闪断)', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);
    // 链路这一段自己的首次合成已经落过一次状态,从这里开始看「重复同一事实」。
    s.emergencyStop.setArmed.mockClear();

    arming.setDaemonActivity(false);
    arming.setDaemonLinkUp(true);
    expect(s.emergencyStop.setArmed).not.toHaveBeenCalled();

    arming.setDaemonActivity(true);
    expect(s.emergencyStop.setArmed).toHaveBeenCalledTimes(1);
    // 同样的「有活动」再来一次:不重复落状态(屏幕上不闪)。
    arming.setDaemonActivity(true);
    expect(s.emergencyStop.setArmed).toHaveBeenCalledTimes(1);
  });
});
