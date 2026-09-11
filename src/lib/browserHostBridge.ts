import { listen } from '@tauri-apps/api/event';

import { browserPageTitle } from './browserPage';
import { browserScopeFromPanelTabId } from './browserPanelTab';
import {
  onElectronBrowserNewWindow,
  onElectronBrowserPage,
} from './browser/electronBrowserHost';
import {
  BROWSER_NEW_WINDOW_EVENT,
  BROWSER_PAGE_EVENT,
  type BrowserNewWindowPayload,
  type BrowserPagePatch,
} from './browserHost';
import { desktopBridge, isElectronDesktop } from './desktop-bridge';
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

/** 页面事件分发(Tauri/Electron 共用;payload 形状见 ../lib/browserHost.ts)。 */
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

/** 弹窗(新标签)事件分发(Tauri/Electron 共用)。 */
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

export function initBrowserHostBridge(): void {
  if (isElectronDesktop()) {
    // Electron(工单 07):页面事件来自渲染层 <webview> 的本地事件总线,
    // 弹窗兜底经 main setWindowOpenHandler 转发(preload onBrowserNewWindow)。
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
    return;
  }

  void listen<BrowserPagePatch>(BROWSER_PAGE_EVENT, (event) => {
    dispatchBrowserPagePatch(event.payload);
  });

  void listen<BrowserNewWindowPayload>(BROWSER_NEW_WINDOW_EVENT, (event) => {
    dispatchBrowserNewWindow(event.payload);
  });
}
