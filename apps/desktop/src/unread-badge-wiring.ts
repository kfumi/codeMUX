import os from 'node:os';

import type { BrowserWindow, NativeImage, Tray } from 'electron';

import {
  applyUnreadBadgeForPlatform,
  createTaskbarOverlayApplier,
  createTrayBadgeApplier,
  renderTaskbarOverlayDot,
  resolveTaskbarOverlayLayout,
  supportsTrayUnreadBadge,
  TASKBAR_OVERLAY_LOGICAL_SIZE,
  TRAY_LOGICAL_SIZE,
} from './unread-badge';

/**
 * 未读角标与 Electron 的接线(spec: docs/specs/2026-10-21-desktop-unread-badge.md)。
 *
 * 纯像素与平台分叉在 `unread-badge.ts`,这里只把壳能力(nativeImage /
 * BrowserWindow / Tray / app)注入进去,并保存最近一次同步的计数 —— 渲染层是
 * 未读的唯一真值源,壳只负责最后一公里。
 */
export interface UnreadBadgeSyncDeps {
  platform: NodeJS.Platform;
  getAllWindows: () => Iterable<BrowserWindow>;
  /** `nativeImage.createEmpty`。 */
  createImage: () => NativeImage;
  /** `app.setBadgeCount`。 */
  setBadgeCount: (count: number) => void;
  getTray: () => Tray | null;
  /** 托盘原始图标:合成红点后靠它恢复原样。 */
  getTrayBaseImage: () => NativeImage | null;
}

export interface UnreadBadgeSync {
  /** 渲染层同步未读数(IPC `codemux:syncUnreadBadgeCount`)的唯一出口。 */
  sync: (count: number) => void;
  /** 当前未读数:窗口重建、托盘晚建时补齐用。 */
  count: () => number;
  /** 窗口首次可显示时补一次当前值(渲染层可能早于窗口就绪就同步过)。 */
  reapply: () => void;
  /** 托盘创建后补一次当前值。只补托盘:overlay / 应用级角标走各自时机,避免同一值被应用两次。 */
  reapplyToTray: () => void;
}

export function createUnreadBadgeSync(deps: UnreadBadgeSyncDeps): UnreadBadgeSync {
  let count = 0;
  const overlayLayout = resolveTaskbarOverlayLayout(os.release());

  // Windows 固定把 overlay 显示为 16×16。直接传硬边 32px 圆再让 Shell 缩放会发糊、
  // 边缘像缺口;这里提供原生 1x(16px) + 2x(32px) 纯红抗锯齿表示。只画红点,
  // 数量在无障碍描述里。
  const applyOverlay = createTaskbarOverlayApplier({
    getAllWindows: deps.getAllWindows,
    createBadgeImage: () => {
      const image = deps.createImage();
      image.addRepresentation({
        scaleFactor: 1,
        width: TASKBAR_OVERLAY_LOGICAL_SIZE,
        height: TASKBAR_OVERLAY_LOGICAL_SIZE,
        buffer: Buffer.from(renderTaskbarOverlayDot(1, overlayLayout)),
      });
      image.addRepresentation({
        scaleFactor: 2,
        width: TASKBAR_OVERLAY_LOGICAL_SIZE * 2,
        height: TASKBAR_OVERLAY_LOGICAL_SIZE * 2,
        buffer: Buffer.from(renderTaskbarOverlayDot(2, overlayLayout)),
      });
      return image;
    },
  });

  const applyTrayBadge = createTrayBadgeApplier({
    getTray: deps.getTray,
    getBaseImage: deps.getTrayBaseImage,
    createBadgeImage: (oneX, twoX) => {
      const image = deps.createImage();
      image.addRepresentation({
        scaleFactor: 1,
        width: TRAY_LOGICAL_SIZE,
        height: TRAY_LOGICAL_SIZE,
        buffer: oneX,
      });
      image.addRepresentation({
        scaleFactor: 2,
        width: TRAY_LOGICAL_SIZE * 2,
        height: TRAY_LOGICAL_SIZE * 2,
        buffer: twoX,
      });
      return image;
    },
  });

  const sync = (next: number): void => {
    count = next;
    // Windows 走任务栏 overlay + 托盘,macOS / Linux 走应用级角标(Linux 另有托盘兜底)。
    applyUnreadBadgeForPlatform({
      platform: deps.platform,
      totalUnreadCount: next,
      setBadgeCount: deps.setBadgeCount,
      applyOverlay,
      applyTrayBadge,
    });
  };

  return {
    sync,
    count: () => count,
    reapply: () => {
      if (count > 0) sync(count);
    },
    reapplyToTray: () => {
      // macOS 虽也会建托盘,但托盘角标只在 Windows / Linux 上生效(Dock 角标承担 macOS)。
      if (count > 0 && supportsTrayUnreadBadge(deps.platform)) {
        applyTrayBadge(count);
      }
    },
  };
}
