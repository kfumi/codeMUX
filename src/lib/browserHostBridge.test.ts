import { beforeEach, describe, expect, it, vi } from 'vitest';

const listenMock = vi.hoisted(() => vi.fn());
const isElectronMock = vi.hoisted(() => vi.fn((): boolean => false));
const electronBusMocks = vi.hoisted(() => ({
  page: vi.fn(),
  newWindow: vi.fn(),
  onBrowserNewWindow: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('./desktop-bridge', () => ({
  desktopBridge: {
    onBrowserNewWindow: electronBusMocks.onBrowserNewWindow,
  },
  isElectronDesktop: isElectronMock,
}));

vi.mock('./browser/electronBrowserHost', () => ({
  onElectronBrowserPage: (listener: unknown) => {
    electronBusMocks.page(listener);
    return () => {};
  },
  onElectronBrowserNewWindow: (listener: unknown) => {
    electronBusMocks.newWindow(listener);
    return () => {};
  },
}));

import { initBrowserHostBridge } from './browserHostBridge';
import type { BrowserPagePatch } from './browserHost';
import { BROWSER_NEW_WINDOW_EVENT, BROWSER_PAGE_EVENT } from './browserHost';
import { useBrowserStore } from '../stores/browserStore';
import { useSidePanelStore } from '../stores/sidePanelStore';

describe('browserHostBridge', () => {
  beforeEach(() => {
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    isElectronMock.mockReturnValue(false);
    electronBusMocks.page.mockClear();
    electronBusMocks.newWindow.mockClear();
    electronBusMocks.onBrowserNewWindow.mockReset();
    electronBusMocks.onBrowserNewWindow.mockReturnValue(() => {});
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

  it('Electron 分支:订阅本地 webview 事件总线,不走 tauri listen', () => {
    isElectronMock.mockReturnValue(true);
    initBrowserHostBridge();
    expect(electronBusMocks.page).toHaveBeenCalledWith(expect.any(Function));
    expect(electronBusMocks.newWindow).toHaveBeenCalledWith(expect.any(Function));
    expect(listenMock).not.toHaveBeenCalled();
  });

  it('Electron 分支:webview 页面补丁经本地总线等价分发进 store', () => {
    isElectronMock.mockReturnValue(true);
    initBrowserHostBridge();
    const pageHandler = electronBusMocks.page.mock.calls[0]?.[0] as (patch: BrowserPagePatch) => void;

    useSidePanelStore.getState().setScope('session-a');
    const sourceTabId = useSidePanelStore.getState().openBrowserTab();
    const pageId = useBrowserStore.getState().ensureBlankPage(sourceTabId);

    pageHandler({
      browserId: pageId,
      url: 'https://example.com/',
      title: 'Example',
      isLoading: false,
      lastError: '',
    });

    const page = useBrowserStore.getState().pages[pageId];
    expect(page).toMatchObject({
      url: 'https://example.com/',
      title: 'Example',
      isLoading: false,
      lastError: null,
    });
  });

  it('Electron 分支:main 弹窗兜底转发,来源未知时回落当前可见浏览器页', () => {
    isElectronMock.mockReturnValue(true);
    const captured: {
      handler?: (payload: { sourceBrowserId?: string | null; url?: string }) => void;
    } = {};
    electronBusMocks.onBrowserNewWindow.mockImplementation((callback: typeof captured.handler) => {
      captured.handler = callback;
      return () => {};
    });

    initBrowserHostBridge();
    expect(captured.handler).toBeTypeOf('function');

    useSidePanelStore.getState().setScope('session-a');
    const sourceTabId = useSidePanelStore.getState().openBrowserTab();
    const pageId = useBrowserStore.getState().ensureBlankPage(sourceTabId);
    useBrowserStore.setState({
      lastVisibleBrowserTabId: sourceTabId,
      activePageIdByPanel: { ...useBrowserStore.getState().activePageIdByPanel, [sourceTabId]: pageId },
    });

    // guest 登记缺失(main 侧 sourceBrowserId 为空)→ 回落到可见浏览器页。
    captured.handler?.({ sourceBrowserId: '', url: 'https://example.com/popup' });

    const state = useSidePanelStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]).toMatchObject({
      kind: 'browser',
      browserInitialUrl: 'https://example.com/popup',
    });
  });
});
