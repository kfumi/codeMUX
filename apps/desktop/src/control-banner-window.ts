//! 控制中提示条的 Electron 实现(工单 10):一个置顶、点击穿透、不抢焦点的小条。
//!
//! 纯逻辑(文案/尺寸/页面/状态机)在 control-banner.ts;这里只做 Electron 那一层。
//! 位置取主屏工作区顶部下方 28px 并水平居中(工单 15),与参考实现(ZCode)的顶部
//! 指示条同位 —— 一眼看得见它在,又不压住标题栏与工具栏。

import { BrowserWindow, screen } from 'electron';

import {
  bannerDataUrl,
  bannerWindowOptions,
  type ControlBannerHandle,
} from './control-banner';

/** 周期性重申置顶:全屏应用或别的置顶窗会把它压下去(与 PI 提示条同样处理)。 */
const KEEP_TOP_INTERVAL_MS = 2000;

export function openControlBannerWindow(): ControlBannerHandle {
  const window = new BrowserWindow({
    ...bannerWindowOptions(screen.getPrimaryDisplay().workArea),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });
  // 点击穿透:提示条不能挡住用户或智能体的鼠标操作。
  window.setIgnoreMouseEvents(true);
  // 内容保护(工单 10 跟进):Windows 10 2004+ 走 WDA_EXCLUDEFROMCAPTURE,
  // 提示条从所有截屏里被排除 —— driver 的 computer_screenshot 拍不到它。
  // 工单 15 起提示条常驻整个操作过程(不再 1s 自动收起),这条内容保护就是
  // 「截图里没有提示条」的全部依靠,不再有时序余量可用。
  window.setContentProtection(true);
  window.setAlwaysOnTop(true, 'screen-saver');

  const keepTop = setInterval(() => {
    if (window.isDestroyed()) return;
    window.setAlwaysOnTop(true, 'screen-saver');
  }, KEEP_TOP_INTERVAL_MS);

  const stopKeepTop = () => clearInterval(keepTop);
  window.on('closed', stopKeepTop);

  void window.loadURL(bannerDataUrl());
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return;
    // showInactive:显示但不激活 —— 不能把用户正在输入的窗口切走。
    window.showInactive();
  });

  return {
    close() {
      stopKeepTop();
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
