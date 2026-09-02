import { listen } from '@tauri-apps/api/event';

import { BROWSER_PAGE_EVENT, type BrowserPagePatch } from './browserHost';
import { createLogger } from './logger';
import { useBrowserStore } from '../stores/browserStore';

const logger = createLogger('browserHostBridge');

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
  });
}
