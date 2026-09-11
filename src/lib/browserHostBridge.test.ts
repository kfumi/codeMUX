import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeState = vi.hoisted(() => ({
  bridge: undefined as { onBrowserNewWindow: ReturnType<typeof vi.fn> } | undefined,
}));
const electronBusMocks = vi.hoisted(() => ({
  page: vi.fn(),
  newWindow: vi.fn(),
}));

vi.mock('./desktop-bridge', async () => {
  const actual = await vi.importActual<typeof import('./desktop-bridge')>('./desktop-bridge');
  return {
    ...actual,
    get desktopBridge() {
      return bridgeState.bridge;
    },
  };
});

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
import { useBrowserStore } from '../stores/browserStore';
import { useSidePanelStore } from '../stores/sidePanelStore';

describe('browserHostBridge', () => {
  beforeEach(() => {
    bridgeState.bridge = { onBrowserNewWindow: vi.fn(() => () => {}) };
    electronBusMocks.page.mockClear();
    electronBusMocks.newWindow.mockClear();
    useBrowserStore.getState().reset();
    useSidePanelStore.getState().reset();
  });

  it('订阅本地 webview 事件总线与 main 弹窗兜底通道(工单 09 终态)', () => {
    initBrowserHostBridge();
    expect(electronBusMocks.page).toHaveBeenCalledWith(expect.any(Function));
    expect(electronBusMocks.newWindow).toHaveBeenCalledWith(expect.any(Function));
    expect(bridgeState.bridge?.onBrowserNewWindow).toHaveBeenCalledWith(expect.any(Function));
  });

  it('webview 页面补丁经本地总线等价分发进 store', () => {
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

  it('main 弹窗兜底转发,来源已知时直接开新标签', () => {
    initBrowserHostBridge();
    const captured: {
      handler?: (payload: { sourceBrowserId?: string | null; url?: string }) => void;
    } = {};
    bridgeState.bridge = {
      onBrowserNewWindow: vi.fn((callback: typeof captured.handler) => {
        captured.handler = callback;
        return () => {};
      }),
    };

    initBrowserHostBridge();
    expect(captured.handler).toBeTypeOf('function');

    useSidePanelStore.getState().setScope('session-a');
    const sourceTabId = useSidePanelStore.getState().openBrowserTab();
    const pageId = useBrowserStore.getState().ensureBlankPage(sourceTabId);

    captured.handler?.({ sourceBrowserId: pageId, url: 'https://example.com/docs' });

    const state = useSidePanelStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1].id);
    expect(state.tabs[1]).toMatchObject({
      kind: 'browser',
      browserInitialUrl: 'https://example.com/docs',
    });
  });

  it('main 弹窗兜底转发,来源未知时回落当前可见浏览器页', () => {
    initBrowserHostBridge();
    const captured: {
      handler?: (payload: { sourceBrowserId?: string | null; url?: string }) => void;
    } = {};
    bridgeState.bridge = {
      onBrowserNewWindow: vi.fn((callback: typeof captured.handler) => {
        captured.handler = callback;
        return () => {};
      }),
    };

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
