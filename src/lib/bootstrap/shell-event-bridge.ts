/**
 * 壳事件订阅薄适配(工单 02):浏览器形态没有壳桥,订阅退化为 no-op,
 * 组件不必各自 `if (desktopBridge)` 判空。
 */
import { desktopBridge } from '../desktop-bridge';

export interface ShellEventSource {
  subscribe: (name: string, handler: (payload: unknown) => void) => () => void;
  available: boolean;
}

export const shellEventBridge: ShellEventSource = {
  available: Boolean(desktopBridge),
  subscribe(name, handler) {
    if (!desktopBridge) return () => {};
    return desktopBridge.onDesktopEvent(name, handler);
  },
};
