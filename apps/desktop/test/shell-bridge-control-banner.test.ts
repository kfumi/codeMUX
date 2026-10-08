// shell-bridge 的「武装 + 提示条」接线契约(工单 10):提示条宣传的是 Esc 急停,
// 所以它必须跟随**实际**武装结果 —— 键被别的程序占用(注册失败)时不能显示。
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
import type { UpdaterService } from '../src/updater';

/** 通道注册在 Promise 里执行(见 registerShellBridge 的 handle 包装)。 */
function invokeArmed(payload: unknown): Promise<unknown> {
  const call = ipcMainMock.handle.mock.calls.find(
    ([name]) => name === 'codemux:setEmergencyStopArmed',
  );
  if (!call) {
    throw new Error('channel not registered: setEmergencyStopArmed');
  }
  const wrapper = call[1] as (event: unknown, payload: unknown) => unknown;
  return Promise.resolve(wrapper({}, payload));
}

/**
 * 最小壳依赖:急停服务由 `registrationSucceeds` 决定 setArmed 是否生效
 * (对应 Electron globalShortcut.register 被别的程序占用时返回 false)。
 */
function createDeps(registrationSucceeds: boolean): ShellBridgeDeps {
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
  let armed = false;
  const emergencyStop = {
    setArmed: vi.fn((next: boolean) => {
      armed = next && registrationSucceeds;
    }),
    isArmed: vi.fn(() => armed),
    trigger: vi.fn(),
  };
  return {
    getAppDataDir: () => 'D:/app-data',
    getLogDir: () => 'D:/app-data/logs',
    getMainWindow: () => ({ isDestroyed: () => false }) as never,
    showMainWindow: () => undefined,
    supervisor: {} as never,
    updater,
    sendToRenderer: vi.fn(),
    browserGuests,
    emergencyStop,
    controlBanner: { setVisible: vi.fn(), isVisible: vi.fn(() => false) },
  };
}

describe('shell-bridge 武装/提示条接线(工单 10)', () => {
  beforeEach(() => {
    ipcMainMock.handle.mockClear();
  });

  it('shows the banner while the shortcut is actually armed', async () => {
    const deps = createDeps(true);
    registerShellBridge(deps);

    await expect(invokeArmed({ armed: true })).resolves.toBe(true);
    expect(deps.controlBanner.setVisible).toHaveBeenCalledWith(true);
  });

  it('keeps the banner hidden when the shortcut registration failed', async () => {
    // 被别的程序占着:武装不生效 → 不能挂一个「按 Esc 急停」却按不动的提示。
    const deps = createDeps(false);
    registerShellBridge(deps);

    await expect(invokeArmed({ armed: true })).resolves.toBe(false);
    expect(deps.controlBanner.setVisible).toHaveBeenCalledWith(false);
  });

  it('hides the banner when the turn ends', async () => {
    const deps = createDeps(true);
    registerShellBridge(deps);

    await invokeArmed({ armed: false });

    expect(deps.controlBanner.setVisible).toHaveBeenCalledWith(false);
  });

  it('rejects a non-boolean armed payload', async () => {
    const deps = createDeps(false);
    registerShellBridge(deps);

    await expect(invokeArmed({ armed: 'yes' })).rejects.toThrow('armed must be a boolean');
  });
});
