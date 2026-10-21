// 未读角标纯模块契约测试(工单 01/02/03):载荷校验、计数 → 描述、Windows 版本圆心分叉、
// 像素渲染与预乘合成、overlay 调用(清零移除/跳过已销毁窗口/徽章图只渲染一次)、
// 托盘角标(合成/归零恢复/无托盘 no-op)、平台分叉。
// 全部走 Node,不起 Electron —— 这正是该模块刻意不 import electron 的原因。
import { describe, expect, it, vi } from 'vitest';

import { SEMANTIC_SEEDS } from '../../../src/lib/colorDerivation';
import {
  TASKBAR_OVERLAY_LOGICAL_SIZE,
  TRAY_DOT_CANVAS_SIZE,
  TRAY_LOGICAL_SIZE,
  UNREAD_DOT_COLOR,
  applyTaskbarOverlayToWindows,
  applyUnreadBadgeForPlatform,
  blendBadgeIntoBitmap,
  composeTrayBadgeBitmap,
  createTaskbarOverlayApplier,
  createTrayBadgeApplier,
  describeUnreadBadge,
  hasUnreadBadge,
  parseUnreadBadgeCount,
  renderStatusDotPixels,
  renderTaskbarOverlayDot,
  renderTrayDot,
  resolveTaskbarOverlayLayout,
  supportsTrayUnreadBadge,
  type TaskbarOverlayWindow,
  type TrayBaseImage,
} from '../src/unread-badge';

function pixelAt(pixels: Uint8Array, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4;
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}

function fakeWindow(overrides: Partial<TaskbarOverlayWindow> = {}): TaskbarOverlayWindow & {
  setOverlayIcon: ReturnType<typeof vi.fn>;
} {
  return {
    isDestroyed: () => false,
    setOverlayIcon: vi.fn(),
    ...overrides,
  } as TaskbarOverlayWindow & { setOverlayIcon: ReturnType<typeof vi.fn> };
}

/** 纯蓝底图标,便于断言红点合成位置。 */
function fakeBaseImage(fill = 0x40): TrayBaseImage & { resize: ReturnType<typeof vi.fn> } {
  return {
    resize: vi.fn(({ width, height }: { width: number; height: number }) => ({
      toBitmap: () => new Uint8Array(width * height * 4).fill(fill),
    })),
  } as TrayBaseImage & { resize: ReturnType<typeof vi.fn> };
}

function fakeTray(): { setImage: ReturnType<typeof vi.fn> } {
  return { setImage: vi.fn() };
}

describe('载荷校验', () => {
  it('接受非负整数,拒绝其余一切', () => {
    expect(parseUnreadBadgeCount(0)).toBe(0);
    expect(parseUnreadBadgeCount(7)).toBe(7);

    expect(parseUnreadBadgeCount(-1)).toBeNull();
    expect(parseUnreadBadgeCount(1.5)).toBeNull();
    expect(parseUnreadBadgeCount('3')).toBeNull();
    expect(parseUnreadBadgeCount(null)).toBeNull();
    expect(parseUnreadBadgeCount(undefined)).toBeNull();
    expect(parseUnreadBadgeCount(Number.NaN)).toBeNull();
  });

  it('0 与非正数不画角标,正数画', () => {
    expect(hasUnreadBadge(0)).toBe(false);
    expect(hasUnreadBadge(-3)).toBe(false);
    expect(hasUnreadBadge(1)).toBe(true);
  });
});

describe('无障碍描述', () => {
  it('带具体数量,清零后为空', () => {
    expect(describeUnreadBadge(3)).toBe('3 个对话未读');
    expect(describeUnreadBadge(0)).toBe('');
  });
});

describe('红点颜色', () => {
  it('与派生色板的 destructive-vivid 种子对账(改公式会立刻失败)', () => {
    const seed = SEMANTIC_SEEDS.light.destructiveVivid;
    expect(UNREAD_DOT_COLOR.red).toBe(Number.parseInt(seed.slice(1, 3), 16));
    expect(UNREAD_DOT_COLOR.green).toBe(Number.parseInt(seed.slice(3, 5), 16));
    expect(UNREAD_DOT_COLOR.blue).toBe(Number.parseInt(seed.slice(5, 7), 16));
  });
});

describe('Windows 版本圆心分叉', () => {
  it('build < 22000 视为 Win10,build ≥ 22000 与认不出的版本按 Win11', () => {
    expect(resolveTaskbarOverlayLayout('10.0.22631')).toBe('windows-11');
    expect(resolveTaskbarOverlayLayout('10.0.22000')).toBe('windows-11');
    expect(resolveTaskbarOverlayLayout('10.0.19045')).toBe('windows-10');
    expect(resolveTaskbarOverlayLayout('')).toBe('windows-11');
    expect(resolveTaskbarOverlayLayout('garbage')).toBe('windows-11');
  });

  it('Win10 的圆点锚在右下,Win11 的圆点在画布中心', () => {
    const size = TASKBAR_OVERLAY_LOGICAL_SIZE;
    const win10 = renderTaskbarOverlayDot(1, 'windows-10');
    const win11 = renderTaskbarOverlayDot(1, 'windows-11');

    // 画布中心:Win11 不透明;Win10 圆心被推到右下,左上角已出圆。
    expect(pixelAt(win11, size, 8, 8)[3]).toBeGreaterThan(0);
    expect(pixelAt(win10, size, 4, 4)[3]).toBe(0);

    // 右下区域:Win10 不透明,Win11 已出圆。
    expect(pixelAt(win10, size, 12, 12)[3]).toBeGreaterThan(0);
    expect(pixelAt(win11, size, 12, 12)[3]).toBe(0);
  });
});

describe('像素渲染', () => {
  it('圆内是纯红不透明,圆外全透明,尺寸与 BGRA 契约一致', () => {
    const size = 16;
    const pixels = renderStatusDotPixels({ size, centerX: 8, centerY: 8, radius: 3.5 });

    expect(pixels).toHaveLength(size * size * 4);
    // BGRA 顺序;圆内预乘后通道值等于原色。
    expect(pixelAt(pixels, size, 8, 8)).toEqual([
      UNREAD_DOT_COLOR.blue,
      UNREAD_DOT_COLOR.green,
      UNREAD_DOT_COLOR.red,
      255,
    ]);
    // 四角在圆外。
    expect(pixelAt(pixels, size, 0, 0)[3]).toBe(0);
    expect(pixelAt(pixels, size, 15, 15)[3]).toBe(0);
  });

  it('抗锯齿边缘是半透明,且 RGB 与 alpha 同步预乘', () => {
    const size = 16;
    const pixels = renderStatusDotPixels({ size, centerX: 8, centerY: 8, radius: 3.5 });

    const edge = pixelAt(pixels, size, 11, 8);
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(255);
    // 预乘:通道值 / alpha ≈ 原色 / 255,否则合成后会渗出白边。
    expect(edge[2]! / edge[3]!).toBeCloseTo(UNREAD_DOT_COLOR.red / 255, 1);
  });

  it('2x 表示是 1x 的两倍尺寸,几何等比', () => {
    const one = renderTaskbarOverlayDot(1, 'windows-11');
    const two = renderTaskbarOverlayDot(2, 'windows-11');

    expect(one).toHaveLength(TASKBAR_OVERLAY_LOGICAL_SIZE ** 2 * 4);
    expect(two).toHaveLength((TASKBAR_OVERLAY_LOGICAL_SIZE * 2) ** 2 * 4);
    expect(pixelAt(two, 32, 16, 16)).toEqual(pixelAt(one, 16, 8, 8));
  });

  it('托盘红点直径约 7px,与任务栏同一观感', () => {
    const size = TRAY_DOT_CANVAS_SIZE;
    const one = renderTrayDot(1);
    expect(one).toHaveLength(size * size * 4);

    // 圆心不透明;直径 7px 时圆内覆盖约 7 列。
    expect(pixelAt(one, size, 4, 4)[3]).toBeGreaterThan(0);
    expect(pixelAt(one, size, 0, 0)[3]).toBe(0);

    const covered = new Set<number>();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (pixelAt(one, size, x, y)[3]! > 128) covered.add(x);
      }
    }
    expect(covered.size).toBeGreaterThanOrEqual(6);
    expect(covered.size).toBeLessThanOrEqual(8);
  });
});

describe('预乘 alpha 合成', () => {
  it('不透明像素直接覆盖,全透明像素不改变底图', () => {
    const size = 2;
    const base = new Uint8Array(size * size * 4).fill(100);
    const badge = new Uint8Array([
      0, 0, 255, 255, // 不透明红
      0, 0, 255, 0, // 全透明,应跳过
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);

    blendBadgeIntoBitmap({ base, size, badge, badgeSize: 2, originX: 0, originY: 0 });

    expect(pixelAt(base, size, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(base, size, 1, 0)).toEqual([100, 100, 100, 100]);
  });

  it('越界区域安全裁剪,不写坏相邻像素', () => {
    const size = 2;
    const base = new Uint8Array(size * size * 4).fill(10);
    const badge = new Uint8Array(2 * 2 * 4).fill(255);

    blendBadgeIntoBitmap({ base, size, badge, badgeSize: 2, originX: 1, originY: 1 });

    expect(pixelAt(base, size, 1, 1)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(base, size, 0, 0)).toEqual([10, 10, 10, 10]);
  });
});

describe('taskbar overlay 调用', () => {
  it('清零时传 null 移除角标,并清空描述', () => {
    const win = fakeWindow();

    applyTaskbarOverlayToWindows({ totalUnreadCount: 0, windows: [win], badgeImage: 'image' });

    expect(win.setOverlayIcon).toHaveBeenCalledWith(null, '');
  });

  it('跳过已销毁的窗口', () => {
    const alive = fakeWindow();
    const destroyed = fakeWindow({ isDestroyed: () => true });

    applyTaskbarOverlayToWindows({
      totalUnreadCount: 2,
      windows: [alive, destroyed],
      badgeImage: 'image',
    });

    expect(alive.setOverlayIcon).toHaveBeenCalledWith('image', '2 个对话未读');
    expect(destroyed.setOverlayIcon).not.toHaveBeenCalled();
  });

  it('多窗口都收到同一个角标,徽章图只渲染一次', () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const createBadgeImage = vi.fn(() => 'image');
    const apply = createTaskbarOverlayApplier({
      getAllWindows: () => [first, second],
      createBadgeImage,
    });

    apply(3);
    apply(9);

    expect(first.setOverlayIcon).toHaveBeenCalledTimes(2);
    expect(second.setOverlayIcon).toHaveBeenCalledTimes(2);
    expect(createBadgeImage).toHaveBeenCalledTimes(1);
    expect(first.setOverlayIcon).toHaveBeenLastCalledWith('image', '9 个对话未读');
  });

  it('归零时移除,恢复时复用缓存的徽章图', () => {
    const win = fakeWindow();
    const createBadgeImage = vi.fn(() => 'image');
    const apply = createTaskbarOverlayApplier({
      getAllWindows: () => [win],
      createBadgeImage,
    });

    apply(2);
    apply(0);
    apply(1);

    expect(win.setOverlayIcon).toHaveBeenNthCalledWith(2, null, '');
    expect(win.setOverlayIcon).toHaveBeenNthCalledWith(3, 'image', '1 个对话未读');
    expect(createBadgeImage).toHaveBeenCalledTimes(1);
  });

  it('从未有过未读时不渲染徽章图', () => {
    const createBadgeImage = vi.fn(() => 'image');
    const apply = createTaskbarOverlayApplier({ getAllWindows: () => [], createBadgeImage });

    apply(0);

    expect(createBadgeImage).not.toHaveBeenCalled();
  });
});

describe('托盘角标(工单 02)', () => {
  it('合成图在图标右上角出现红点,左下角保持原色', () => {
    const bitmap = composeTrayBadgeBitmap(fakeBaseImage(), 1);
    expect(bitmap).not.toBeNull();

    const pixels = new Uint8Array(bitmap!);
    const size = TRAY_LOGICAL_SIZE;
    // 红点贴在右上角:画布 originX = size - dotCanvas,圆心因此落在 (size-4.5, 4.5)。
    expect(pixelAt(pixels, size, size - 5, 4)).toEqual([
      UNREAD_DOT_COLOR.blue,
      UNREAD_DOT_COLOR.green,
      UNREAD_DOT_COLOR.red,
      255,
    ]);
    // 左下角:仍是底图。
    expect(pixelAt(pixels, size, 1, size - 2)).toEqual([0x40, 0x40, 0x40, 0x40]);
  });

  it('1x 与 2x 表示尺寸各自正确', () => {
    expect(composeTrayBadgeBitmap(fakeBaseImage(), 1)).toHaveLength(TRAY_LOGICAL_SIZE ** 2 * 4);
    expect(composeTrayBadgeBitmap(fakeBaseImage(), 2)).toHaveLength((TRAY_LOGICAL_SIZE * 2) ** 2 * 4);
  });

  it('图标位图尺寸异常时放弃合成,不产出半张图', () => {
    const broken: TrayBaseImage = { resize: () => ({ toBitmap: () => new Uint8Array(3) }) };
    expect(composeTrayBadgeBitmap(broken, 1)).toBeNull();
  });

  it('未读时换成合成图,归零恢复原图,合成图只做一次', () => {
    const tray = fakeTray();
    const base = fakeBaseImage();
    const createBadgeImage = vi.fn(() => 'badge');
    const apply = createTrayBadgeApplier({
      getTray: () => tray,
      getBaseImage: () => base,
      createBadgeImage,
    });

    apply(2);
    apply(5);
    expect(tray.setImage).toHaveBeenNthCalledWith(1, 'badge');
    expect(tray.setImage).toHaveBeenNthCalledWith(2, 'badge');
    expect(createBadgeImage).toHaveBeenCalledTimes(1);

    apply(0);
    expect(tray.setImage).toHaveBeenLastCalledWith(base);
  });

  it('没有托盘或取不到原图时是 no-op', () => {
    const tray = fakeTray();
    const createBadgeImage = vi.fn(() => 'badge');

    const noTray = createTrayBadgeApplier({
      getTray: () => null,
      getBaseImage: () => fakeBaseImage(),
      createBadgeImage,
    });
    noTray(3);

    const noBase = createTrayBadgeApplier({
      getTray: () => tray,
      getBaseImage: () => null,
      createBadgeImage,
    });
    noBase(3);

    expect(tray.setImage).not.toHaveBeenCalled();
    expect(createBadgeImage).not.toHaveBeenCalled();
  });

  it('托盘只在 Windows / Linux 上存在', () => {
    expect(supportsTrayUnreadBadge('win32')).toBe(true);
    expect(supportsTrayUnreadBadge('linux')).toBe(true);
    expect(supportsTrayUnreadBadge('darwin')).toBe(false);
  });
});

describe('平台分叉(工单 03)', () => {
  const deps = () => ({
    platform: 'win32' as NodeJS.Platform,
    totalUnreadCount: 2,
    setBadgeCount: vi.fn(),
    applyOverlay: vi.fn(),
    applyTrayBadge: vi.fn(),
  });

  it('Windows 走 overlay + 托盘,不走应用级角标', () => {
    const options = deps();
    applyUnreadBadgeForPlatform(options);

    expect(options.applyOverlay).toHaveBeenCalledWith(2);
    expect(options.applyTrayBadge).toHaveBeenCalledWith(2);
    expect(options.setBadgeCount).not.toHaveBeenCalled();
  });

  it('macOS 只走应用级角标(没有托盘)', () => {
    const options = { ...deps(), platform: 'darwin' as NodeJS.Platform };
    applyUnreadBadgeForPlatform(options);

    expect(options.setBadgeCount).toHaveBeenCalledWith(2);
    expect(options.applyOverlay).not.toHaveBeenCalled();
    expect(options.applyTrayBadge).not.toHaveBeenCalled();
  });

  it('Linux 走应用级角标 + 托盘兜底', () => {
    const options = { ...deps(), platform: 'linux' as NodeJS.Platform };
    applyUnreadBadgeForPlatform(options);

    expect(options.setBadgeCount).toHaveBeenCalledWith(2);
    expect(options.applyTrayBadge).toHaveBeenCalledWith(2);
    expect(options.applyOverlay).not.toHaveBeenCalled();
  });

  it('计数归零时把应用级角标清零', () => {
    const options = { ...deps(), platform: 'darwin' as NodeJS.Platform, totalUnreadCount: 0 };
    applyUnreadBadgeForPlatform(options);

    expect(options.setBadgeCount).toHaveBeenCalledWith(0);
  });

  it('未知平台什么都不做', () => {
    const options = { ...deps(), platform: 'freebsd' as NodeJS.Platform };
    applyUnreadBadgeForPlatform(options);

    expect(options.setBadgeCount).not.toHaveBeenCalled();
    expect(options.applyOverlay).not.toHaveBeenCalled();
    expect(options.applyTrayBadge).not.toHaveBeenCalled();
  });
});
