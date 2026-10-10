// 电脑控制「武装」真值(工单 03;工单 04 之后只剩 daemon 一个来源)契约测试:
// daemon 活动 → 武装 + 显示提示条,链路断开 → fail-hidden。这一层是「提示条显隐 +
// 全局 Esc」的唯一出口,每一条断言都对应屏幕上看得见的行为。
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
  log: ReturnType<typeof vi.fn>;
}

/** 最小壳依赖:`registrationSucceeds = false` 对应 Electron `globalShortcut.register` 被别的程序占用。 */
function stubs(options: { registrationSucceeds?: boolean } = {}): Stubs {
  const registrationSucceeds = options.registrationSucceeds ?? true;
  let armed = false;
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
  const log = vi.fn();
  return {
    emergencyStop,
    controlBanner,
    log,
    deps: { emergencyStop, controlBanner, log },
  };
}

describe('电脑控制武装真值(工单 04 起只认 daemon 活动)', () => {
  it('daemon 报有活动就武装并显示提示条(渲染层从没加载也能显示)', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);

    arming.setDaemonActivity(true);
    expect(s.emergencyStop.setArmed).toHaveBeenLastCalledWith(true);
    expect(s.emergencyStop.isArmed()).toBe(true);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('活动转假就收起提示条并解除 Esc(无人值守回合的正常收尾)', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);
    arming.setDaemonActivity(true);

    arming.setDaemonActivity(false);
    expect(s.emergencyStop.setArmed).toHaveBeenLastCalledWith(false);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);
    expect(arming.state()).toEqual({ armed: false, daemon: false, linkUp: true });
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
    expect(arming.state()).toEqual({ armed: false, daemon: false, linkUp: false });
  });

  it('链路还没连上时 daemon 的活动不武装,链路一通就补上(不丢 Esc)', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);

    // 控制面还没连上:谁都不武装(daemon 不可达时 Esc 与提示条都是假的)。
    arming.setDaemonActivity(true);
    expect(s.emergencyStop.isArmed()).toBe(false);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);

    arming.setDaemonLinkUp(true);
    expect(s.emergencyStop.isArmed()).toBe(true);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('注册失败(键被别的程序占着)不显示提示条', () => {
    const s = stubs({ registrationSucceeds: false });
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);

    arming.setDaemonActivity(true);

    expect(s.emergencyStop.isArmed()).toBe(false);
    expect(s.controlBanner.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('重复的同一事实不重复动屏幕状态(不刷屏、不闪断)', () => {
    const s = stubs();
    const arming = createComputerUseArming(s.deps);
    arming.setDaemonLinkUp(true);
    // 链路这一段自己的首次合成就落过一次状态,从这里开始看「重复同一事实」。
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
