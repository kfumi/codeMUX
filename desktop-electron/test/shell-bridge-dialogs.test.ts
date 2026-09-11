// shell-bridge 对话框/更新器通道契约测试(工单 06):electron 以最小 mock 替身
// 注入,验证 `codemux:showDialogOpen/showDialogSave` 的 plugin-dialog 返回形状
// 映射(取消 → null、单选 → string、多选 → string[])与 updater 通道接线。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dialogMock = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}));

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  Notification: { isSupported: () => false },
  dialog: dialogMock,
  ipcMain: ipcMainMock,
}));

import { registerShellBridge, type ShellBridgeDeps } from '../src/shell-bridge';
import type { BrowserGuestTracker } from '../src/browser-host';
import type { UpdaterService } from '../src/updater';

function getHandler(channel: string): (event: unknown, payload: unknown) => unknown {
  const call = ipcMainMock.handle.mock.calls.find(([name]) => name === `codemux:${channel}`);
  if (!call) {
    throw new Error(`channel not registered: ${channel}`);
  }
  return call[1] as (event: unknown, payload: unknown) => unknown;
}

function createDeps(overrides: Partial<ShellBridgeDeps> = {}): ShellBridgeDeps {
  const updater: UpdaterService = {
    check: vi.fn().mockResolvedValue({ status: 'unavailable', version: null }),
    downloadAndInstall: vi.fn().mockResolvedValue({ version: '1.2.3' }),
    quitAndInstall: vi.fn(),
    currentVersion: vi.fn().mockReturnValue('0.3.1'),
  };
  const mainWindow = { isDestroyed: () => false } as never;
  const browserGuests: BrowserGuestTracker = {
    onWebContentsCreated: vi.fn(),
    register: vi.fn(),
    lookup: () => undefined,
  };
  return {
    getAppDataDir: () => 'D:/app-data',
    getLogDir: () => 'D:/app-data/logs',
    getMainWindow: () => mainWindow,
    showMainWindow: () => undefined,
    supervisor: {} as never,
    updater,
    sendToRenderer: vi.fn(),
    browserGuests,
    ...overrides,
  };
}

describe('shell-bridge 对话框/更新器通道(工单 06)', () => {
  beforeEach(() => {
    ipcMainMock.handle.mockClear();
    dialogMock.showOpenDialog.mockReset();
    dialogMock.showSaveDialog.mockReset();
  });

  it('showDialogOpen:目录单选映射 openDirectory,选中返回 string', async () => {
    const deps = createDeps();
    registerShellBridge(deps);
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['D:/work/codeMUX'] });

    const handler = getHandler('showDialogOpen');
    await expect(handler(null, { directory: true, multiple: false, title: '选择项目文件夹' })).resolves.toBe('D:/work/codeMUX');
    expect(dialogMock.showOpenDialog).toHaveBeenCalledTimes(1);
    const [actualParent, options] = dialogMock.showOpenDialog.mock.calls[0];
    expect(actualParent).toBe(deps.getMainWindow());
    expect(options).toMatchObject({
      title: '选择项目文件夹',
      properties: ['openDirectory'],
    });
  });

  it('showDialogOpen:多选返回 string[]', async () => {
    registerShellBridge(createDeps());
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:/a.json', 'D:/b.json'],
    });

    await expect(getHandler('showDialogOpen')(null, { multiple: true })).resolves.toEqual([
      'D:/a.json',
      'D:/b.json',
    ]);
    const [, options] = dialogMock.showOpenDialog.mock.calls[0];
    expect(options.properties).toEqual(['openFile', 'multiSelections']);
  });

  it('showDialogOpen:取消/空选择返回 null;无主窗口时走无 parent 形态', async () => {
    registerShellBridge(createDeps({ getMainWindow: () => null }));
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(getHandler('showDialogOpen')(null, {})).resolves.toBeNull();
    expect(dialogMock.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(dialogMock.showOpenDialog.mock.calls[0]).toHaveLength(1);
  });

  it('showDialogOpen:非法 filters 抛错(参数面校验)', async () => {
    registerShellBridge(createDeps());
    await expect(getHandler('showDialogOpen')(null, { filters: 'json' })).rejects.toThrow('filters must be an array');
  });

  it('showDialogSave:选中返回路径,取消返回 null', async () => {
    registerShellBridge(createDeps());
    const handler = getHandler('showDialogSave');

    dialogMock.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: 'D:/out/snapshot.json',
    });
    await expect(
      handler(null, { defaultPath: 'codemux-perf.json', filters: [{ name: 'JSON', extensions: ['json'] }] }),
    ).resolves.toBe('D:/out/snapshot.json');

    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    await expect(handler(null, {})).resolves.toBeNull();
  });

  it('updater 通道接线:check/downloadAndInstall/quitAndInstall/currentVersion', async () => {
    const deps = createDeps();
    registerShellBridge(deps);

    await expect(getHandler('checkForUpdates')(null, undefined)).resolves.toEqual({
      status: 'unavailable',
      version: null,
    });
    await expect(getHandler('downloadAndInstall')(null, undefined)).resolves.toEqual({ version: '1.2.3' });
    // handler 经 Promise.resolve().then 异步执行,quitAndInstall 需 await 后断言。
    await getHandler('quitAndInstall')(null, undefined);
    expect(deps.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    await expect(getHandler('currentVersion')(null, undefined)).resolves.toBe('0.3.1');
  });
});
