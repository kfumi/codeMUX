import { listen } from '@tauri-apps/api/event';

import { browserPageTitle } from './browserPage';
import { browserScopeFromPanelTabId } from './browserPanelTab';
import { BROWSER_NEW_WINDOW_EVENT, BROWSER_PAGE_EVENT, type BrowserPagePatch } from './browserHost';
import { createLogger } from './logger';
import { useBrowserStore } from '../stores/browserStore';
import { useSidePanelStore } from '../stores/sidePanelStore';

const logger = createLogger('browserHostBridge');

export interface BrowserNewWindowPayload {
  sourceBrowserId: string;
  url: string;
}

function openBrowserTabInScope(scopeId: string, url?: string) {
  const sidePanel = useSidePanelStore.getState();
  if (sidePanel.activeScopeId !== scopeId) {
    sidePanel.setScope(scopeId);
  }
  sidePanel.openBrowserTab(url);
}

export function initBrowserHostBridge() {
  void listen<BrowserPagePatch>(BROWSER_PAGE_EVENT, (event) => {
    if (!event.payload?.browserId) {
      logger.warn('Ignored browser page event without browserId');
      return;
    }
    const patch = event.payload;
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
  });

  void listen<BrowserNewWindowPayload>(BROWSER_NEW_WINDOW_EVENT, (event) => {
    const { sourceBrowserId, url } = event.payload ?? {};
    if (!sourceBrowserId || !url) {
      logger.warn('Ignored browser new-window event without sourceBrowserId or url');
      return;
    }
    const page = useBrowserStore.getState().pages[sourceBrowserId];
    const scopeId = page ? browserScopeFromPanelTabId(page.panelTabId) : useSidePanelStore.getState().activeScopeId;
    openBrowserTabInScope(scopeId, url);
  });
}
