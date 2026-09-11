import { afterEach, describe, expect, it, vi } from 'vitest';

// 工单 09 终态:desktopDialogs 只走壳桥;桥缺失时显式报错(不再回退 Tauri plugin-dialog)。
const bridgeState = vi.hoisted(() => ({
  bridge: undefined as {
    showDialogOpen: ReturnType<typeof vi.fn>;
    showDialogSave: ReturnType<typeof vi.fn>;
  }
  | undefined,
}));

vi.mock('./desktop-bridge', () => ({
  requireDesktopBridge: () => {
    if (!bridgeState.bridge) {
      throw new Error('codemuxDesktop 桥不可用(Electron preload 未注入)');
    }
    return bridgeState.bridge;
  },
}));

import { openDialog, saveDialog } from './desktopDialogs';

describe('desktopDialogs(壳桥直连)', () => {
  afterEach(() => {
    bridgeState.bridge = undefined;
    vi.clearAllMocks();
  });

  it('openDialog 走壳桥并原样下传 options', async () => {
    bridgeState.bridge = {
      showDialogOpen: vi.fn().mockResolvedValue('D:/work/codeMUX'),
      showDialogSave: vi.fn(),
    };

    const result = await openDialog({ directory: true, multiple: false, title: '选择项目文件夹' });

    expect(result).toBe('D:/work/codeMUX');
    expect(bridgeState.bridge.showDialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '选择项目文件夹',
    });
  });

  it('saveDialog 走壳桥', async () => {
    bridgeState.bridge = {
      showDialogOpen: vi.fn(),
      showDialogSave: vi.fn().mockResolvedValue('D:/out/snapshot.json'),
    };

    const result = await saveDialog({
      defaultPath: 'codemux-perf.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    expect(result).toBe('D:/out/snapshot.json');
    expect(bridgeState.bridge.showDialogSave).toHaveBeenCalledWith({
      defaultPath: 'codemux-perf.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
  });

  it('桥缺失时显式报错(不再有 plugin-dialog 回退)', async () => {
    bridgeState.bridge = undefined;

    await expect(openDialog({ directory: true, multiple: false })).rejects.toThrow('codemuxDesktop 桥不可用');
    await expect(saveDialog({})).rejects.toThrow('codemuxDesktop 桥不可用');
  });

  it('取消(桥返回 null)原样透传', async () => {
    bridgeState.bridge = {
      showDialogOpen: vi.fn().mockResolvedValue(null),
      showDialogSave: vi.fn().mockResolvedValue(null),
    };

    await expect(openDialog({ directory: true })).resolves.toBeNull();
    await expect(saveDialog()).resolves.toBeNull();
  });

  it('multiple 返回数组形状原样透传', async () => {
    bridgeState.bridge = {
      showDialogOpen: vi.fn().mockResolvedValue(['D:/a', 'D:/b']),
      showDialogSave: vi.fn(),
    };

    await expect(openDialog({ multiple: true })).resolves.toEqual(['D:/a', 'D:/b']);
  });
});
