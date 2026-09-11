import { browserPageTitle } from './browserPage';
import { browserScopeFromPanelTabId } from './browserPanelTab';
import {
  onElectronBrowserNewWindow,
  onElectronBrowserPage,
} from './browser/electronBrowserHost';
import {
  type BrowserNewWindowPayload,
  type BrowserPagePatch,
} from './browserHost';
import { desktopBridge } from './desktop-bridge';
import { createLogger } from './logger';
import { useBrowserStore } from '../stores/browserStore';
import { useSidePanelStore } from '../stores/sidePanelStore';

const logger = createLogger('browserHostBridge');

export type { BrowserNewWindowPayload } from './browserHost';

function openBrowserTabInScope(scopeId: string, url?: string) {
  const sidePanel = useSidePanelStore.getState();
  if (sidePanel.activeScopeId !== scopeId) {
    sidePanel.setScope(scopeId);
  }
  sidePanel.openBrowserTab(url);
}

/** 页面事件分发(payload 形状见 ../lib/browserHost.ts)。 */
export function dispatchBrowserPagePatch(patch?: BrowserPagePatch): void {
  if (!patch?.browserId) {
    logger.warn('Ignored browser page event without browserId');
    return;
  }
  useBrowserStore.getState().applyHostPatch({
    ...patch,
    lastError: patch.lastError === '' ? null : patch.lastError,
  });

  const page = useBrowserStore.getState().pages[patch.browserId];
  if (!page || !patch.title?.trim()) return;
  useSidePanelStore.getState().updateBrowserTabTitle(
    page.panelTabId,
    browserPageTitle(patch.title, patch.url ?? page.url),
  );
}

/** 弹窗(新标签)事件分发。 */
export function dispatchBrowserNewWindow(payload?: BrowserNewWindowPayload): void {
  const { sourceBrowserId, url } = payload ?? {};
  if (!sourceBrowserId || !url) {
    logger.warn('Ignored browser new-window event without sourceBrowserId or url');
    return;
  }
  const page = useBrowserStore.getState().pages[sourceBrowserId];
  const scopeId = page ? browserScopeFromPanelTabId(page.panelTabId) : useSidePanelStore.getState().activeScopeId;
  openBrowserTabInScope(scopeId, url);
}

/**
 * 浏览器宿主事件桥(工单 09 终态):页面事件来自渲染层 <webview> 的本地
 * 事件总线;弹窗兜底经 main setWindowOpenHandler 转发(preload onBrowserNewWindow)。
 * Tauri emit 通道随壳退役移除。
 */
export function initBrowserHostBridge(): void {
  onElectronBrowserPage(dispatchBrowserPagePatch);
  onElectronBrowserNewWindow(dispatchBrowserNewWindow);
  desktopBridge?.onBrowserNewWindow((payload) => {
    let sourceBrowserId = payload.sourceBrowserId ?? '';
    if (!sourceBrowserId) {
      // main 侧无法定位来源时,回落到当前可见浏览器页。
      const visibleTabId = useBrowserStore.getState().lastVisibleBrowserTabId;
      sourceBrowserId = visibleTabId
        ? useBrowserStore.getState().activePageIdByPanel[visibleTabId] ?? ''
        : '';
    }
    dispatchBrowserNewWindow({ sourceBrowserId, url: payload.url ?? '' });
  });
}
