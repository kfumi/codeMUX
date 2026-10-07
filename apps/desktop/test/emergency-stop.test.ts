// 全局 Esc 强打断(工单 06)契约测试:武装/解除/触发/注册失败的降级。
import { describe, expect, it, vi } from 'vitest';

import {
  EMERGENCY_STOP_ACCELERATOR,
  createEmergencyStopService,
  type EmergencyStopDeps,
} from '../src/emergency-stop';

function deps(overrides: Partial<EmergencyStopDeps> = {}): EmergencyStopDeps & {
  registered: Map<string, () => void>;
} {
  const registered = new Map<string, () => void>();
  return {
    registerShortcut: vi.fn((accelerator: string, handler: () => void) => {
      registered.set(accelerator, handler);
      return true;
    }),
    unregisterShortcut: vi.fn((accelerator: string) => {
      registered.delete(accelerator);
    }),
    estopDriver: vi.fn(async () => {}),
    notifyRenderer: vi.fn(),
    log: vi.fn(),
    registered,
    ...overrides,
  };
}

describe('emergency stop', () => {
  it('arms and disarms the global Escape shortcut', () => {
    const d = deps();
    const service = createEmergencyStopService(d);

    service.setArmed(true);
    expect(service.isArmed()).toBe(true);
    expect(d.registered.has(EMERGENCY_STOP_ACCELERATOR)).toBe(true);

    service.setArmed(false);
    expect(service.isArmed()).toBe(false);
    expect(d.registered.size).toBe(0);
  });

  it('is idempotent: arming twice registers once', () => {
    const d = deps();
    const service = createEmergencyStopService(d);
    service.setArmed(true);
    service.setArmed(true);
    expect(d.registerShortcut).toHaveBeenCalledTimes(1);
  });

  it('the shortcut kills the driver and interrupts the turn', async () => {
    const d = deps();
    const service = createEmergencyStopService(d);
    service.setArmed(true);

    d.registered.get(EMERGENCY_STOP_ACCELERATOR)?.();

    expect(d.notifyRenderer).toHaveBeenCalledTimes(1);
    expect(d.estopDriver).toHaveBeenCalledTimes(1);
  });

  it('a failing estop still interrupts the turn', async () => {
    const d = deps({ estopDriver: vi.fn(async () => { throw new Error('daemon 断连'); }) });
    const service = createEmergencyStopService(d);
    service.setArmed(true);

    d.registered.get(EMERGENCY_STOP_ACCELERATOR)?.();
    await Promise.resolve();

    expect(d.notifyRenderer).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledWith('error', expect.stringContaining('急停驱动失败'));
  });

  it('stays disarmed when the shortcut cannot be registered', () => {
    const d = deps({ registerShortcut: vi.fn(() => false) });
    const service = createEmergencyStopService(d);

    service.setArmed(true);

    expect(service.isArmed()).toBe(false);
    expect(d.log).toHaveBeenCalledWith('warn', expect.stringContaining('注册失败'));
    // 解除时不该去撤销一个没注册上的快捷键。
    service.setArmed(false);
    expect(d.unregisterShortcut).not.toHaveBeenCalled();
  });
});
