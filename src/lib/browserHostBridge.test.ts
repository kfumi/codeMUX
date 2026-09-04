import { beforeEach, describe, expect, it, vi } from 'vitest';

const listenMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

import { initBrowserHostBridge } from './browserHostBridge';
import { BROWSER_NEW_WINDOW_EVENT, BROWSER_PAGE_EVENT } from './browserHost';
import { useBrowserStore } from '../stores/browserStore';
import { useSidePanelStore } from '../stores/sidePanelStore';

describe('browserHostBridge', () => {
  beforeEach(() => {
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    useBrowserStore.getState().reset();
    useSidePanelStore.getState().reset();
  });

  it('registers page and new-window listeners', () => {
    initBrowserHostBridge();
    expect(listenMock).toHaveBeenCalledWith(BROWSER_PAGE_EVENT, expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith(BROWSER_NEW_WINDOW_EVENT, expect.any(Function));
  });

  it('opens a browser tab in the source scope when a new window is requested', async () => {
    initBrowserHostBridge();
    const newWindowHandler = listenMock.mock.calls.find(([event]) => event === BROWSER_NEW_WINDOW_EVENT)?.[1];
    expect(newWindowHandler).toBeTypeOf('function');

    useSidePanelStore.getState().setScope('session-a');
    const sourceTabId = useSidePanelStore.getState().openBrowserTab();
    const pageId = useBrowserStore.getState().ensureBlankPage(sourceTabId);

    newWindowHandler?.({
      payload: {
        sourceBrowserId: pageId,
        url: 'https://example.com/docs',
      },
    });

    const state = useSidePanelStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1].id);
    expect(state.tabs[1]).toMatchObject({
      kind: 'browser',
      browserInitialUrl: 'https://example.com/docs',
    });
  });
});
