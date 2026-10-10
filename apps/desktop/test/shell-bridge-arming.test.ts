// shell-bridge 的「武装 + 提示条」IPC 契约(工单 10;工单 03 起合成规则搬进
// computer-use-arming):通道名与载荷形状不变,壳这一层只做校验 + 委派。
// 合成语义(daemon 事件 → 显示/武装、链路断开 → fail-hidden、退出守卫)在
// computer-use-arming.test.ts 里测。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  Notification: { isSupported: () => false },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: ipcMainMock,
}));

import { registerShellBridge, type ShellBridgeDeps } from '../src/shell-bridge';
import type { BrowserGuestTracker } from '../src/browser-host';
import type { ComputerUseArming } from '../src/computer-use-arming';
import type { UpdaterService } from '../src/updater';

/** 通道注册在 Promise 里执行(见 registerShellBridge 的 handle 包装)。 */
function invoke(channel: string, payload: unknown): Promise<unknown> {
  const call = ipcMainMock.handle.mock.calls.find(
    ([name]) => name === `codemux:${channel}`,
  );
  if (!call) {
    throw new Error(`channel not registered: ${channel}`);
  }
  const wrapper = call[1] as (event: unknown, payload: unknown) => unknown;
  return Promise.resolve(wrapper({}, payload));
}

interface Harness {
  deps: ShellBridgeDeps;
  arming: ComputerUseArming;
  /** 让 arming 假装回不同的答案(注册失败/链路断/退出中都是 false)。 */
  answers: { armed: boolean; heartbeat: boolean };
}

/** 最小壳依赖:武装真值用替身,这里只验证通道 → arming 的委派。 */
function createDeps(): Harness {
  const answers = { armed: true, heartbeat: true };
  const arming: ComputerUseArming = {
    setRendererArmed: vi.fn(() => answers.armed),
    heartbeat: vi.fn(() => answers.heartbeat),
    setDaemonActivity: vi.fn(),
    setDaemonLinkUp: vi.fn(),
    dropRendererSource: vi.fn(),
    state: vi.fn(() => ({ armed: true, renderer: true, daemon: false, linkUp: true })),
  };
  const updater: UpdaterService = {
    check: vi.fn(),
    downloadAndInstall: vi.fn(),
    quitAndInstall: vi.fn(),
    currentVersion: vi.fn().mockReturnValue('0.4.7'),
  };
  const browserGuests: BrowserGuestTracker = {
    onWebContentsCreated: vi.fn(),
    register: vi.fn(),
    lookup: () => undefined,
  };
  return {
    arming,
    answers,
    deps: {
      getAppDataDir: () => 'D:/app-data',
      getLogDir: () => 'D:/app-data/logs',
      getMainWindow: () => ({ isDestroyed: () => false }) as never,
      showMainWindow: () => undefined,
      supervisor: {} as never,
      updater,
      sendToRenderer: vi.fn(),
      browserGuests,
      computerUseArming: arming,
    },
  };
}

describe('shell-bridge 武装/提示条通道(工单 03 起委派 computer-use-arming)', () => {
  beforeEach(() => {
    ipcMainMock.handle.mockClear();
  });

  it('把 armed 交给 arming,并把**实际**结果回给渲染层', async () => {
    const { deps, arming } = createDeps();
    registerShellBridge(deps);

    await expect(invoke('setEmergencyStopArmed', { armed: true })).resolves.toBe(true);
    expect(arming.setRendererArmed).toHaveBeenCalledWith(true);
  });

  it('arming 说没生效(注册失败 / 链路断 / 退出中)时如实回 false', async () => {
    const { deps, arming, answers } = createDeps();
    answers.armed = false;
    registerShellBridge(deps);

    await expect(invoke('setEmergencyStopArmed', { armed: true })).resolves.toBe(false);
    expect(arming.setRendererArmed).toHaveBeenCalledWith(true);
  });

  it('非布尔 armed 直接拒绝(通道契约)', async () => {
    const { deps, arming } = createDeps();
    registerShellBridge(deps);

    await expect(invoke('setEmergencyStopArmed', { armed: 'yes' })).rejects.toThrow(
      'armed must be a boolean',
    );
    expect(arming.setRendererArmed).not.toHaveBeenCalled();
  });

  it('心跳通道把 arming 的答案原样回给渲染层(渲染层据此重新声明)', async () => {
    const { deps, arming, answers } = createDeps();
    answers.heartbeat = false;
    registerShellBridge(deps);

    await expect(invoke('emergencyStopHeartbeat', undefined)).resolves.toBe(false);
    expect(arming.heartbeat).toHaveBeenCalledTimes(1);
  });
});
