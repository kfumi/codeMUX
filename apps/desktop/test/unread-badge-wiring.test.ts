// 壳侧未读角标接线(工单 01/02/03):把 Electron 能力注入后,计数保存、
// 启动补齐(ready-to-show)与托盘补齐的时机都能在 Node 里断言。
import { describe, expect, it, vi } from 'vitest';

import { createUnreadBadgeSync, type UnreadBadgeSyncDeps } from '../src/unread-badge-wiring';

function fakeWindow() {
  return { isDestroyed: () => false, setOverlayIcon: vi.fn() };
}

function fakeTray() {
  return { setImage: vi.fn() };
}

/** 托盘合成会按请求尺寸 toBitmap,所以假图标必须按 width/height 产出位图。 */
function fakeBaseImage() {
  return {
    resize: ({ width, height }: { width: number; height: number }) => ({
      toBitmap: () => new Uint8Array(width * height * 4).fill(0x40),
    }),
  };
}

function makeSync(platform: NodeJS.Platform) {
  const win = fakeWindow();
  const tray = fakeTray();
  const setBadgeCount = vi.fn();
  const deps: UnreadBadgeSyncDeps = {
    platform,
    getAllWindows: () => [win],
    createImage: () => ({ addRepresentation: vi.fn() }) as never,
    setBadgeCount,
    getTray: () => tray as never,
    getTrayBaseImage: () => fakeBaseImage() as never,
  };
  return { sync: createUnreadBadgeSync(deps), win, tray, setBadgeCount };
}

describe('createUnreadBadgeSync', () => {
  it('sync 记下计数,并按平台分叉应用(macOS 走应用级角标,不碰托盘)', () => {
    const { sync, setBadgeCount, tray, win } = makeSync('darwin');

    sync.sync(3);

    expect(sync.count()).toBe(3);
    expect(setBadgeCount).toHaveBeenCalledWith(3);
    expect(tray.setImage).not.toHaveBeenCalled();
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
  });

  it('sync 归零时清掉应用级角标', () => {
    const { sync, setBadgeCount } = makeSync('darwin');

    sync.sync(2);
    sync.sync(0);

    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(sync.count()).toBe(0);
  });

  it('Windows 同时走任务栏 overlay 与托盘', () => {
    const { sync, tray, win, setBadgeCount } = makeSync('win32');

    sync.sync(1);

    expect(win.setOverlayIcon).toHaveBeenCalledWith(expect.anything(), '1 个对话未读');
    expect(tray.setImage).toHaveBeenCalled();
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it('reapply 只在已有未读时补一次(渲染层早于窗口就绪同步的时序)', () => {
    const { sync, setBadgeCount } = makeSync('darwin');

    sync.reapply();
    expect(setBadgeCount).not.toHaveBeenCalled();

    sync.sync(2);
    setBadgeCount.mockClear();
    sync.reapply();

    expect(setBadgeCount).toHaveBeenCalledWith(2);
  });

  it('reapplyToTray 只在 Windows / Linux 且已有未读时补托盘', () => {
    const mac = makeSync('darwin');
    mac.sync.sync(2);
    mac.sync.reapplyToTray();
    expect(mac.tray.setImage).not.toHaveBeenCalled();

    const linux = makeSync('linux');
    linux.sync.sync(2);
    linux.tray.setImage.mockClear();
    linux.sync.reapplyToTray();
    expect(linux.tray.setImage).toHaveBeenCalled();

    const empty = makeSync('linux');
    empty.sync.reapplyToTray();
    expect(empty.tray.setImage).not.toHaveBeenCalled();
  });
});
