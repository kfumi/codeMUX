import { shellFacade } from '../facades/shell-facade';
import { capabilitiesForHost } from '../host/host-capabilities';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';

/** 终端里只放行 http(s)：其它 scheme 一律不激活（OSC 8 与纯文本识别共用这条判定）。 */
export function isHttpTerminalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * 终端链接的打开策略：
 * - 壳宿主有内置浏览器能力时，开右侧浏览器标签（与消息里的链接一致）；
 * - 浏览器/移动宿主没有内置浏览器，退化为系统浏览器。
 *
 * 用 store 的 `getState()` 而不是 hook：调用方是模块级的 link provider，不在 React 树里。
 */
export function openTerminalLink(url: string): void {
  if (!isHttpTerminalUrl(url)) return;

  const hostForm = useDaemonConnectionStore.getState().hostForm;
  if (capabilitiesForHost(hostForm).has('browser.host')) {
    useSidePanelStore.getState().openBrowserTab(url);
    return;
  }

  void shellFacade.openExternal(url).catch(() => {});
}
