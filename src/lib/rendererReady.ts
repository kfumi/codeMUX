/**
 * 渲染层就绪上报:App 挂载后通知 Electron 壳「首屏可交互」,壳据此转正主窗口
 * 并关闭启动 splash(desktop-electron/src/splash.ts)。
 *
 * - 时机取「App 挂载 + 双 RAF」:首个 RAF 后 React 已提交 DOM,但 WebView 可能
 *   尚未完成该帧的合成绘制;再等一帧确保 splash 关闭时主窗口画面已在屏上,
 *   避免露出空背景帧;
 * - 非 Electron 形态(浏览器/移动)无壳,调用为 no-op;
 * - 失败静默:上报只是性能/体验优化,壳侧另有超时兜底,不应打扰用户。
 */
import { desktopBridge } from './desktop-bridge';

/** 双 RAF 等待合成绘制;RAF 不可用(如测试环境)时退化为微任务。 */
function nextPaintFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** 幂等上报(模块级 once 语义:StrictMode 双挂载 / 热重载不会重复发)。 */
let notified = false;

export function notifyRendererReady(): void {
  if (notified) return;
  notified = true;

  void nextPaintFrame().then(() => {
    desktopBridge?.notifyRendererReady().catch(() => {
      // 壳侧失败(如已退出)忽略:超时兜底自会收掉 splash。
    });
  });
}
