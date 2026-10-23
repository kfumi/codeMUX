/**
 * 「放大/缩小/恢复界面缩放」三条命令的执行面。
 *
 * 缩放是 webContents 级的窗口状态，必须交给壳侧处理：渲染层的 CSS `zoom`
 * 会改变布局盒子，和 Chromium 的页面缩放不是一回事；而且焦点在内置浏览器的
 * `<webview>` 里时改写文档样式也碰不到正确的对象。浏览器宿主没有壳桥，
 * 这里保持空操作（Ctrl+= / Ctrl+- / Ctrl+0 由浏览器自身的页面缩放负责）。
 */
import { desktopBridge } from '../desktop-bridge';

/** 与 Electron 默认 zoomIn/zoomOut 菜单角色相同的步进（1 个 zoom level = 1.2 倍）。 */
export const APP_ZOOM_STEP = 0.5;

export async function zoomInApp(): Promise<void> {
  await adjust(APP_ZOOM_STEP);
}

export async function zoomOutApp(): Promise<void> {
  await adjust(-APP_ZOOM_STEP);
}

export async function resetAppZoom(): Promise<void> {
  const bridge = desktopBridge;
  if (!bridge) return;
  try {
    await bridge.resetAppZoom();
  } catch (error) {
    // 缩放失败不该让快捷键抛错；主进程不可用时也不该产生未处理的 rejection。
    console.warn('[app-zoom] reset failed', error);
  }
}

async function adjust(delta: number): Promise<void> {
  const bridge = desktopBridge;
  if (!bridge) return;
  try {
    await bridge.adjustAppZoom(delta);
  } catch (error) {
    console.warn('[app-zoom] adjust failed', error);
  }
}
