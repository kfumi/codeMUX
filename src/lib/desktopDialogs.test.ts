import { afterEach, describe, expect, it, vi } from 'vitest';

// 工单 06:desktopDialogs 平台分流 —— Electron 走壳桥,Tauri 回退 plugin-dialog。
const bridgeState = vi.hoisted(() => ({
  bridge: undefined as {
    showDialogOpen: ReturnType<typeof vi.fn>;
    showDialogSave: ReturnType<typeof vi.fn>;
  }
  | undefined,
}));

const isElectronDesktopMock = vi.hoisted(() => vi.fn(() => false));

const tauriDialog = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('./desktop-bridge', async () => {
  const actual = await vi.importActual<typeof import('./desktop-bridge')>('./desktop-bridge');
  return {
    ...actual,
    get desktopBridge() {
      return bridgeState.bridge;
    },
    isElectronDesktop: isElectronDesktopMock,
  };
});

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: tauriDialog.open,
  save: tauriDialog.save,
}));

import { openDialog, saveDialog } from './desktopDialogs';

describe('desktopDialogs 平台分流', () => {
  afterEach(() => {
    bridgeState.bridge = undefined;
    isElectronDesktopMock.mockReturnValue(false);
    vi.clearAllMocks();
  });

  it('Electron 壳:openDialog 走壳桥并原样下传 options', async () => {
    bridgeState.bridge = {
      showDialogOpen: vi.fn().mockResolvedValue('D:/work/codeMUX'),
      showDialogSave: vi.fn(),
    };
    isElectronDesktopMock.mockReturnValue(true);

    const result = await openDialog({ directory: true, multiple: false, title: '选择项目文件夹' });

    expect(result).toBe('D:/work/codeMUX');
    expect(bridgeState.bridge.showDialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '选择项目文件夹',
    });
    expect(tauriDialog.open).not.toHaveBeenCalled();
  });

  it('Electron 壳:saveDialog 走壳桥', async () => {
    bridgeState.bridge = {
      showDialogOpen: vi.fn(),
      showDialogSave: vi.fn().mockResolvedValue('D:/out/snapshot.json'),
    };
    isElectronDesktopMock.mockReturnValue(true);

    const result = await saveDialog({
      defaultPath: 'codemux-perf.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    expect(result).toBe('D:/out/snapshot.json');
    expect(bridgeState.bridge.showDialogSave).toHaveBeenCalledWith({
      defaultPath: 'codemux-perf.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    expect(tauriDialog.save).not.toHaveBeenCalled();
  });

  it('Tauri 壳/纯 Web:回退 @tauri-apps/plugin-dialog 且行为不变', async () => {
    tauriDialog.open.mockResolvedValueOnce('D:/work');
    tauriDialog.save.mockResolvedValueOnce('D:/out.json');

    await expect(openDialog({ directory: true, multiple: false })).resolves.toBe('D:/work');
    expect(tauriDialog.open).toHaveBeenCalledWith({ directory: true, multiple: false });

    await expect(saveDialog({})).resolves.toBe('D:/out.json');
    expect(tauriDialog.save).toHaveBeenCalledWith({});
  });

  it('取消(桥返回 null)原样透传', async () => {
    bridgeState.bridge = {
      showDialogOpen: vi.fn().mockResolvedValue(null),
      showDialogSave: vi.fn().mockResolvedValue(null),
    };
    isElectronDesktopMock.mockReturnValue(true);

    await expect(openDialog({ directory: true })).resolves.toBeNull();
    await expect(saveDialog()).resolves.toBeNull();
  });
});
