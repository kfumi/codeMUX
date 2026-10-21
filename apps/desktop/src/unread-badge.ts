//! 未读角标的像素与平台分叉(工单 01;spec 见 docs/specs/2026-10-21-desktop-unread-badge.md)。
//!
//! 本文件**不 import electron**:徽章图是纯像素计算,平台判断只吃字符串,
//! 所以圆点几何、预乘 alpha 合成、Windows 版本分叉都能在 Node 里单测。
//! Electron 侧(nativeImage / BrowserWindow / Tray)由 main.ts 注入。
//!
//! Windows 的 `app.setBadgeCount` 是 no-op,任务栏角标只能走窗口级
//! `setOverlayIcon`;overlay 由 Shell 固定画在任务栏按钮右下角,不负责渲染数字,
//! 所以生产上只画红点,数量只进无障碍描述。

/** 任务栏 overlay 在 100% DPI 下的显示尺寸;1x/2x 表示分别产出 16/32。 */
export const TASKBAR_OVERLAY_LOGICAL_SIZE = 16;

/** 托盘图标在通知区域的实际显示尺寸;红点尺寸独立于任务栏。 */
export const TRAY_LOGICAL_SIZE = 16;
/** 托盘红点画布:贴到图标右上角,不铺满。 */
export const TRAY_DOT_CANVAS_SIZE = 9;
/** 托盘红点半径:直径 7px,与任务栏角标同一观感(约 8px)。 */
export const TRAY_DOT_RADIUS = 3.5;

/**
 * 红点颜色取 `--destructive-vivid` 的浅色种子(#dc2626)。任务栏/托盘不属于应用
 * 表面,无法读 CSS 变量,所以这里固定为语义种子值;`unread-badge.test.ts` 有一条
 * 对账用例直接比对 `SEMANTIC_SEEDS.light.destructiveVivid`,改派生公式会立刻失败。
 */
export const UNREAD_DOT_COLOR = { red: 220, green: 38, blue: 38 } as const;

/** 非法载荷(非整数、负数、非数字)一律返回 null,由调用方拒绝。 */
export function parseUnreadBadgeCount(payload: unknown): number | null {
  if (typeof payload !== 'number' || !Number.isInteger(payload) || payload < 0) {
    return null;
  }
  return payload;
}

/** 0 = 移除角标;非零 = 画红点(数量只进无障碍描述,不进图像)。 */
export function hasUnreadBadge(totalUnreadCount: number): boolean {
  return Number.isInteger(totalUnreadCount) && totalUnreadCount > 0;
}

/** overlay 的无障碍描述。壳侧没有 i18n 管线,与托盘菜单、控制提示条一样写中文。 */
export function describeUnreadBadge(totalUnreadCount: number): string {
  return hasUnreadBadge(totalUnreadCount) ? `${totalUnreadCount} 个对话未读` : '';
}

export type TaskbarOverlayLayout = 'windows-10' | 'windows-11';

/**
 * Windows 两代 Shell 对 16×16 overlay 的落点不同:Win11 已把整张 overlay 放到
 * 图标角上,画布内应居中;Win10 需要画布内右下锚定来补偿。阈值取 build 22000
 * (Win11 首个正式版)。版本号认不出时按 Win11 处理 —— 新系统是当前主流。
 */
export function resolveTaskbarOverlayLayout(osRelease: string): TaskbarOverlayLayout {
  const build = Number.parseInt(osRelease.split('.')[2] ?? '', 10);
  return Number.isFinite(build) && build < 22000 ? 'windows-10' : 'windows-11';
}

/** 托盘角标只在 Windows / Linux 上存在;macOS 由 Dock 角标承担。 */
export function supportsTrayUnreadBadge(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'linux';
}

export interface AntialiasedDotOptions {
  size: number;
  centerX: number;
  centerY: number;
  radius: number;
  /** 每像素每轴的采样数;4 次方 16 个样本已足够平滑 16px 圆点。 */
  supersample?: number;
}

/**
 * 预乘 alpha 的 BGRA 圆点(与 Electron `toBitmap` / `createFromBitmap` 契约一致)。
 * 圆内完全不透明,圆外全透明;抗锯齿边缘保持同一红色,不与底图混成白边或脏边。
 */
export function renderStatusDotPixels(options: AntialiasedDotOptions): Uint8Array {
  const supersample = options.supersample ?? 4;
  const pixels = new Uint8Array(options.size * options.size * 4);
  const samplesPerPixel = supersample * supersample;
  const radiusSquared = options.radius * options.radius;

  for (let y = 0; y < options.size; y += 1) {
    for (let x = 0; x < options.size; x += 1) {
      let coveredSamples = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const sampleX = x + (sx + 0.5) / supersample;
          const sampleY = y + (sy + 0.5) / supersample;
          const dx = sampleX - options.centerX;
          const dy = sampleY - options.centerY;
          if (dx * dx + dy * dy <= radiusSquared) coveredSamples += 1;
        }
      }
      if (coveredSamples === 0) continue;

      const coverage = coveredSamples / samplesPerPixel;
      const offset = (y * options.size + x) * 4;
      // 预乘:通道值随覆盖率等比缩放,alpha 同步,合成时不会渗出白边。
      pixels[offset] = Math.round(UNREAD_DOT_COLOR.blue * coverage);
      pixels[offset + 1] = Math.round(UNREAD_DOT_COLOR.green * coverage);
      pixels[offset + 2] = Math.round(UNREAD_DOT_COLOR.red * coverage);
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }

  return pixels;
}

/** 任务栏 overlay 红点:1x = 16px,2x = 32px 高 DPI 表示。 */
export function renderTaskbarOverlayDot(
  scale: 1 | 2 = 1,
  layout: TaskbarOverlayLayout = 'windows-11',
): Uint8Array {
  // 圆心按系统代际分叉:Win10 右下锚定(留 2px 安全边,贴边会被 Shell 采样吃掉
  // 最外圈),Win11 居中。
  const center = layout === 'windows-10' ? 11.25 : 8;
  return renderStatusDotPixels({
    size: TASKBAR_OVERLAY_LOGICAL_SIZE * scale,
    centerX: center * scale,
    centerY: center * scale,
    radius: 3.5 * scale,
  });
}

/** 托盘红点:与任务栏同一观感(约 8px 直径),合成到图标右上角。 */
export function renderTrayDot(scale: 1 | 2 = 1): Uint8Array {
  const size = TRAY_DOT_CANVAS_SIZE * scale;
  return renderStatusDotPixels({
    size,
    centerX: size / 2,
    centerY: size / 2,
    radius: TRAY_DOT_RADIUS * scale,
  });
}

/**
 * 预乘 alpha 混合:out = src + dst × (1 - srcA),base 原地修改。
 * 越界区域安全裁剪(红点可能贴到图标边缘)。
 */
export function blendBadgeIntoBitmap(options: {
  base: Uint8Array;
  size: number;
  badge: Uint8Array;
  badgeSize: number;
  originX: number;
  originY: number;
}): void {
  for (let by = 0; by < options.badgeSize; by += 1) {
    const y = options.originY + by;
    if (y < 0 || y >= options.size) continue;

    for (let bx = 0; bx < options.badgeSize; bx += 1) {
      const x = options.originX + bx;
      if (x < 0 || x >= options.size) continue;

      const srcOffset = (by * options.badgeSize + bx) * 4;
      const srcAlpha = options.badge[srcOffset + 3]!;
      if (srcAlpha === 0) continue;

      const dstOffset = (y * options.size + x) * 4;
      if (srcAlpha === 255) {
        options.base[dstOffset] = options.badge[srcOffset]!;
        options.base[dstOffset + 1] = options.badge[srcOffset + 1]!;
        options.base[dstOffset + 2] = options.badge[srcOffset + 2]!;
        options.base[dstOffset + 3] = 255;
        continue;
      }

      const keepRatio = (255 - srcAlpha) / 255;
      for (let channel = 0; channel < 4; channel += 1) {
        const src = options.badge[srcOffset + channel]!;
        const dst = options.base[dstOffset + channel]!;
        options.base[dstOffset + channel] = Math.round(src + dst * keepRatio);
      }
    }
  }
}

/** 只要求「有任务栏按钮的窗口」能力,便于单测注入假窗口。 */
export type TaskbarOverlayWindow = {
  isDestroyed(): boolean;
  setOverlayIcon(overlay: unknown, description: string): void;
};

export function applyTaskbarOverlayToWindows(options: {
  totalUnreadCount: number;
  windows: Iterable<TaskbarOverlayWindow>;
  badgeImage: unknown;
}): void {
  // 计数为 0 = 移除角标:overlay 传 null,描述清空。
  const image = hasUnreadBadge(options.totalUnreadCount) ? options.badgeImage : null;
  const description = image ? describeUnreadBadge(options.totalUnreadCount) : '';

  for (const win of options.windows) {
    if (win.isDestroyed()) continue;
    win.setOverlayIcon(image, description);
  }
}

/**
 * 角标只在 Turn 结束或用户查看会话时变化,是事件级更新;徽章图只画红点,
 * 与计数无关,所以在第一次需要时渲染一张并长期复用。
 * skipTaskbar 窗口(控制提示条)设置 overlay 无副作用,不单独排除。
 */
export function createTaskbarOverlayApplier(deps: {
  getAllWindows: () => Iterable<TaskbarOverlayWindow>;
  createBadgeImage: () => unknown;
}): (totalUnreadCount: number) => void {
  let badgeImage: unknown = null;

  return (totalUnreadCount) => {
    if (hasUnreadBadge(totalUnreadCount) && badgeImage === null) {
      badgeImage = deps.createBadgeImage();
    }
    applyTaskbarOverlayToWindows({
      totalUnreadCount,
      windows: deps.getAllWindows(),
      badgeImage,
    });
  };
}

/** 只要求 `resize` / `toBitmap` 能力,便于单测注入假图标。 */
export type TrayBaseImage = {
  resize(options: { width: number; height: number }): { toBitmap(): Buffer | Uint8Array };
};

/**
 * 把红点合成到托盘图标右上角,产出 1x / 2x 两个预乘 BGRA 位图。
 * 图标尺寸与红点尺寸都按原生分辨率生成,避免把硬边图交给 Shell 盲缩。
 */
export function composeTrayBadgeBitmap(
  baseImage: TrayBaseImage,
  scale: 1 | 2,
): Buffer | null {
  const size = TRAY_LOGICAL_SIZE * scale;
  const bitmap = baseImage.resize({ width: size, height: size }).toBitmap();
  if (bitmap.length !== size * size * 4) {
    return null;
  }

  const canvas = new Uint8Array(bitmap);
  const dotSize = TRAY_DOT_CANVAS_SIZE * scale;
  blendBadgeIntoBitmap({
    base: canvas,
    size,
    badge: renderTrayDot(scale),
    badgeSize: dotSize,
    originX: size - dotSize,
    originY: 0,
  });
  return Buffer.from(canvas);
}

/** 只要求 `setImage` 能力,便于单测注入假托盘。 */
export type UnreadTray = {
  setImage(image: unknown): void;
};

/**
 * 托盘角标:非零换合成图,归零恢复原图。合成图只画红点,与计数无关,缓存一张。
 * 没有托盘或取不到原图时是 no-op(macOS 不调用本函数)。
 */
export function createTrayBadgeApplier(deps: {
  getTray: () => UnreadTray | null;
  getBaseImage: () => TrayBaseImage | null;
  createBadgeImage: (oneX: Buffer, twoX: Buffer) => unknown;
}): (totalUnreadCount: number) => void {
  let badgeImage: unknown = null;

  return (totalUnreadCount) => {
    const tray = deps.getTray();
    if (!tray) return;

    const baseImage = deps.getBaseImage();
    if (!baseImage) return;

    if (!hasUnreadBadge(totalUnreadCount)) {
      // 归零:恢复原始图标(原始图标本身就是多分辨率 ico,不需要重新合成)。
      tray.setImage(deps.getBaseImage());
      return;
    }

    if (badgeImage === null) {
      const oneX = composeTrayBadgeBitmap(baseImage, 1);
      const twoX = composeTrayBadgeBitmap(baseImage, 2);
      if (!oneX || !twoX) return;
      badgeImage = deps.createBadgeImage(oneX, twoX);
    }
    tray.setImage(badgeImage);
  };
}

/**
 * 应用级角标(macOS Dock / Linux LauncherEntry)与 Windows overlay 的平台分叉,
 * 以及托盘角标(仅 Windows / Linux)的归属。未知平台一律 no-op:
 * 没有对应 API,静默比报错好。
 */
export function applyUnreadBadgeForPlatform(options: {
  platform: NodeJS.Platform;
  totalUnreadCount: number;
  setBadgeCount: (count: number) => void;
  applyOverlay: (totalUnreadCount: number) => void;
  applyTrayBadge: (totalUnreadCount: number) => void;
}): void {
  if (options.platform === 'win32') {
    options.applyOverlay(options.totalUnreadCount);
    options.applyTrayBadge(options.totalUnreadCount);
    return;
  }
  if (options.platform === 'darwin' || options.platform === 'linux') {
    options.setBadgeCount(options.totalUnreadCount);
    // macOS 没有托盘(由 Dock 角标承担),Linux 托盘角标作为无 badge API 时的兜底。
    if (supportsTrayUnreadBadge(options.platform)) {
      options.applyTrayBadge(options.totalUnreadCount);
    }
  }
}
