/**
 * 兼容导出(工单 02):引导逻辑迁到 [`lib/bootstrap`](./bootstrap/index.ts),
 * 三宿主形态(桌面壳 / 浏览器 / 移动)统一从那一个入口解析连接。
 *
 * 保留本文件是为了不打断既有调用点(SessionList 的「重试」入口等)。
 */
export {
  bootstrapDaemonConnection as initDaemonClient,
  getDaemonStartupError,
  disconnectBrowserConnection,
  submitRemotePairing,
  startLoopbackPairing,
} from './bootstrap';
