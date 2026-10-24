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

import { initBrowserHostBridge, openAgentBrowserPage, dispatchBrowserAgentOpen } from './browserHostBridge';
import type { BrowserPagePatch } from './browserHost';
import { useBrowserStore } from '../stores/browserStore';
import { useSidePanelStore } from '../stores/sidePanelStore';

describe('browserHostBridge', () => {
  beforeEach(() => {
    bridgeState.bridge = {
      onBrowserNewWindow: vi.fn(() => () => {}),
      onDesktopEvent: vi.fn(() => () => {}),
    };
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
    // browser_open(自举对):main 的开页请求经 browser-agent-open 事件进来。
    expect(bridgeState.bridge?.onDesktopEvent).toHaveBeenCalledWith('browser-agent-open', expect.any(Function));
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

describe('browser-agent-open(自举对)渲染层执行面', () => {
  beforeEach(() => {
    bridgeState.bridge = {
      onBrowserNewWindow: vi.fn(() => () => {}),
      onDesktopEvent: vi.fn(() => () => {}),
    };
    useBrowserStore.getState().reset();
    useSidePanelStore.getState().reset();
  });

  it('面板正显示浏览器标签:复用空白页并导航,返回该页 browserId', async () => {
    useSidePanelStore.getState().setScope('session-a');
    const tabId = useSidePanelStore.getState().openBrowserTab();
    const blankId = useBrowserStore.getState().ensureBlankPage(tabId);

    const result = await openAgentBrowserPage('https://github.com/search?q=magpie');

    expect('browserId' in result).toBe(true);
    if ('browserId' in result) {
      // 复用的是那张空白页,不是另叠一张。
      expect(result.browserId).toBe(blankId);
      const page = useBrowserStore.getState().pages[blankId];
      expect(page?.url).toBe('https://github.com/search?q=magpie');
    }
  });

  it('当前浏览器标签已有内容:开新页再导航(browser_open 语义是新开)', async () => {
    useSidePanelStore.getState().setScope('session-a');
    const tabId = useSidePanelStore.getState().openBrowserTab();
    const existingId = useBrowserStore.getState().ensureBlankPage(tabId);
    useBrowserStore.setState((state) => ({
      pages: {
        ...state.pages,
        [existingId]: { ...state.pages[existingId], url: 'https://already.open/' },
      },
    }));

    const result = await openAgentBrowserPage('https://example.com/agent');

    expect('browserId' in result).toBe(true);
    if ('browserId' in result) {
      expect(result.browserId).not.toBe(existingId);
      expect(useBrowserStore.getState().activePageIdByPanel[tabId]).toBe(result.browserId);
    }
  });

  it('面板没有浏览器标签:新开浏览器标签并等页面出现后回 browserId', async () => {
    useSidePanelStore.getState().setScope('session-a');
    useSidePanelStore.getState().openTerminalTab('D:/work/app');

    const pending = openAgentBrowserPage('https://example.com/agent');
    // 模拟 BrowserPanel 挂载后的 ensureBlankPage(下一次宏任务创建页面)。
    setTimeout(() => {
      const tabs = useSidePanelStore.getState().tabs;
      const browserTab = tabs[tabs.length - 1];
      expect(browserTab.kind).toBe('browser');
      expect(browserTab.browserInitialUrl).toBe('https://example.com/agent');
      useBrowserStore.getState().ensureBlankPage(browserTab.id);
    }, 60);

    const result = await pending;
    expect('browserId' in result).toBe(true);
    if ('browserId' in result) {
      const tabs = useSidePanelStore.getState().tabs;
      const browserTab = tabs[tabs.length - 1];
      expect(useBrowserStore.getState().activePageIdByPanel[browserTab.id]).toBe(result.browserId);
    }
  });

  it('非 http(s) 地址直接失败,不开任何标签', async () => {
    const result = await openAgentBrowserPage('file:///C:/Windows/win.ini');
    expect('error' in result).toBe(true);
    expect(useSidePanelStore.getState().tabs.every((tab) => tab.kind !== 'browser')).toBe(true);
  });

  it('dispatchBrowserAgentOpen:成功回 browserId,失败回 error(按 requestId)', async () => {
    const replies: Array<{ requestId: string; browserId?: string; error?: string }> = [];
    bridgeState.bridge = {
      onBrowserNewWindow: vi.fn(() => () => {}),
      onDesktopEvent: vi.fn(() => () => {}),
      browserAgentOpenResult: vi.fn((payload: { requestId: string; browserId?: string; error?: string }) => {
        replies.push(payload);
        return Promise.resolve(true);
      }),
    };
    // 成功路径的前置:面板正显示一张空白浏览器页(复用分支,无需等面板挂载)。
    useSidePanelStore.getState().setScope('session-a');
    const tabId = useSidePanelStore.getState().openBrowserTab();
    useBrowserStore.getState().ensureBlankPage(tabId);

    await dispatchBrowserAgentOpen({ requestId: 'req-ok', url: 'https://example.com/ok' });
    await dispatchBrowserAgentOpen({ requestId: 'req-bad', url: 'not a url' });

    expect(replies).toHaveLength(2);
    expect(replies[0].requestId).toBe('req-ok');
    expect(typeof replies[0].browserId).toBe('string');
    expect(replies[1].requestId).toBe('req-bad');
    expect(replies[1].error).toBeTruthy();
  });
});
