// @vitest-environment jsdom
// 全局 Esc 急停的武装窗口(工单 10)契约:只在「有回合在跑 且 系统级执行开启」
// 时武装 —— 开着开关就整天占着 Esc 会跟所有软件打架,空闲时必须还给系统。
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeState = vi.hoisted(() => ({ present: true }));

const { setArmedMock, onEmergencyStopMock, unsubscribeMock } = vi.hoisted(() => ({
  setArmedMock: vi.fn(async (armed: boolean) => armed),
  onEmergencyStopMock: vi.fn(() => unsubscribeMock),
  unsubscribeMock: vi.fn(),
}));

vi.mock('../lib/desktop-bridge', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/desktop-bridge')>('../lib/desktop-bridge');
  return {
    ...actual,
    get desktopBridge() {
      return bridgeState.present
        ? { setEmergencyStopArmed: setArmedMock, onEmergencyStop: onEmergencyStopMock }
        : undefined;
    },
  };
});

import { useAgentStore } from '../stores/agentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useEmergencyStop } from './useEmergencyStop';

function setSystemExecution(enabled: boolean): void {
  useSettingsStore.setState({
    config: { computer_use: { system_execution_enabled: enabled } } as never,
  });
}

function setRunning(sessions: Record<string, boolean>): void {
  useAgentStore.setState({ isRunning: sessions });
}

describe('useEmergencyStop 武装窗口(工单 10)', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    bridgeState.present = true;
    setSystemExecution(false);
    setRunning({});
  });

  it('arms while a turn is running and system execution is on', async () => {
    setSystemExecution(true);
    setRunning({ sessionA: true });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));
  });

  it('stays disarmed while idle, even with the switch on', async () => {
    setSystemExecution(true);
    setRunning({ sessionA: false });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
  });

  it('never arms while system execution is off', async () => {
    setRunning({ sessionA: true });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
  });

  it('disarms again as soon as the turn ends', async () => {
    setSystemExecution(true);
    setRunning({ sessionA: true });
    renderHook(() => useEmergencyStop());
    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));

    setRunning({ sessionA: false });

    await waitFor(() => expect(setArmedMock).toHaveBeenLastCalledWith(false));
  });

  it('interrupts every running session when the shell reports the hotkey', async () => {
    const interrupt = vi.fn(async () => {});
    useAgentStore.setState({ interrupt } as never);
    setRunning({ sessionA: true, sessionB: false, sessionC: true });

    renderHook(() => useEmergencyStop());
    await waitFor(() => expect(onEmergencyStopMock).toHaveBeenCalled());

    const onStop = onEmergencyStopMock.mock.calls[0]?.[0] as (() => void) | undefined;
    onStop?.();

    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(interrupt).toHaveBeenCalledWith('sessionA');
    expect(interrupt).toHaveBeenCalledWith('sessionC');
  });

  it('does nothing when the desktop bridge is missing (browser hosts)', () => {
    bridgeState.present = false;
    setSystemExecution(true);
    setRunning({ sessionA: true });

    expect(() => renderHook(() => useEmergencyStop())).not.toThrow();
    expect(setArmedMock).not.toHaveBeenCalled();
  });
});
