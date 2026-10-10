// @vitest-environment jsdom
// 全局 Esc 急停的渲染层半边:武装窗口与提示条显隐已随工单 03/04 搬到 daemon 与壳
// (daemon 活动事件 → 壳武装 + 显示提示条),这里只剩旧 daemon 兜底路径下的那件事 ——
// 壳通知渲染层,把在跑的回合打断。
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeState = vi.hoisted(() => ({ present: true }));
const { onEmergencyStopMock, unsubscribeMock } = vi.hoisted(() => ({
  onEmergencyStopMock: vi.fn(() => unsubscribeMock),
  unsubscribeMock: vi.fn(),
}));

vi.mock('../lib/desktop-bridge', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/desktop-bridge')>('../lib/desktop-bridge');
  return {
    ...actual,
    get desktopBridge() {
      // 桥面只剩这一件:武装/心跳通道已随工单 04 退役,渲染层不该再调用它们。
      return bridgeState.present ? { onEmergencyStop: onEmergencyStopMock } : undefined;
    },
  };
});

import { useAgentStore } from '../stores/agentStore';
import { useEmergencyStop } from './useEmergencyStop';

describe('useEmergencyStop(工单 04 起只剩兜底打断)', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    bridgeState.present = true;
    useAgentStore.setState({ isRunning: {} } as never);
  });

  it('壳报急停时打断所有在跑的回合', async () => {
    const interrupt = vi.fn(async () => {});
    useAgentStore.setState({
      interrupt,
      isRunning: { sessionA: true, sessionB: false, sessionC: true },
    } as never);

    renderHook(() => useEmergencyStop());
    await waitFor(() => expect(onEmergencyStopMock).toHaveBeenCalled());

    const onStop = onEmergencyStopMock.mock.calls[0]?.[0] as (() => void) | undefined;
    onStop?.();

    // 只打断在跑的:已经停下的会话不该再收到一次打断。
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(interrupt).toHaveBeenCalledWith('sessionA');
    expect(interrupt).toHaveBeenCalledWith('sessionC');
  });

  it('没有界面宿主(浏览器/手机形态)时挂载不报错', () => {
    bridgeState.present = false;

    expect(() => renderHook(() => useEmergencyStop())).not.toThrow();
  });

  it('卸载后不再监听壳的急停事件', () => {
    const { unmount } = renderHook(() => useEmergencyStop());

    unmount();

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
