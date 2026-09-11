// @vitest-environment jsdom

// Electron BrowserHost 适配器(工单 07)契约测试:注入假 <webview> 元素,
// 覆盖 13 方法契约全量、webview DOM 事件 → Tauri 等价载荷映射、
// 切走标签停放不销毁(hide ≠ destroy)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  browserClearData: vi.fn(),
  browserRegisterGuest: vi.fn(),
}));

vi.mock('../desktop-bridge', () => ({
  desktopBridge: bridgeMock,
  requireDesktopBridge: () => bridgeMock,
  isElectronDesktop: () => true,
}));

import type { CmxWebviewElement } from './electronBrowserHost';
import {
  BLANK_LINK_INTERCEPT_SCRIPT,
  bindElectronBrowserContainer,
  electronBrowserHost,
  onElectronBrowserNewWindow,
  onElectronBrowserPage,
  resetElectronBrowserHostForTests,
  setWebviewElementFactoryForTests,
} from './electronBrowserHost';
import { BROWSER_HOST_METHODS, type BrowserNewWindowPayload, type BrowserPagePatch } from '../browserHost';

type FakeWebview = CmxWebviewElement & {
  __listeners: Map<string, Array<(event: Event) => void>>;
};

const instances: FakeWebview[] = [];

function makeFakeWebview(): CmxWebviewElement {
  const el = document.createElement('div') as HTMLElement & Record<string, unknown>;
  const listeners = new Map<string, Array<(event: Event) => void>>();
  el.addEventListener = (type: string, handler: EventListenerOrEventListenerObject) => {
    const list = listeners.get(type) ?? [];
    list.push(handler as (event: Event) => void);
    listeners.set(type, list);
  };
  el.dispatchEvent = (event: Event): boolean => {
    for (const handler of listeners.get(event.type) ?? []) handler(event);
    return true;
  };
  el.loadURL = vi.fn().mockResolvedValue(undefined);
  el.getURL = vi.fn(() => '');
  el.reload = vi.fn();
  el.goBack = vi.fn();
  el.goForward = vi.fn();
  el.canGoBack = vi.fn(() => false);
  el.canGoForward = vi.fn(() => false);
  el.setZoomFactor = vi.fn();
  el.openDevTools = vi.fn();
  el.executeJavaScript = vi.fn().mockResolvedValue(null);
  el.getWebContentsId = vi.fn(() => 1000 + instances.length);
  const fake = el as unknown as FakeWebview;
  fake.__listeners = listeners;
  instances.push(fake);
  return fake;
}

function fireGuestEvent(el: CmxWebviewElement, type: string, props: Record<string, unknown> = {}): Event {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, props);
  el.dispatchEvent(event);
  return event;
}

function lastWebview(): FakeWebview {
  expect(instances.length).toBeGreaterThan(0);
  return instances[instances.length - 1];
}

async function createAttachedPage(pageId: string, url = 'https://example.com/'): Promise<FakeWebview> {
  await electronBrowserHost.create(pageId, url, { x: 10, y: 20, width: 300, height: 200 });
  const el = lastWebview();
  fireGuestEvent(el, 'did-attach');
  await Promise.resolve();
  return el;
}

describe('electronBrowserHost(工单 07)', () => {
  const patches: BrowserPagePatch[] = [];
  const newWindows: BrowserNewWindowPayload[] = [];
  let container: HTMLElement;

  beforeEach(() => {
    resetElectronBrowserHostForTests();
    instances.length = 0;
    setWebviewElementFactoryForTests(makeFakeWebview);
    bridgeMock.browserClearData.mockReset().mockResolvedValue(undefined);
    bridgeMock.browserRegisterGuest.mockReset().mockResolvedValue(undefined);
    patches.length = 0;
    newWindows.length = 0;
    onElectronBrowserPage((patch) => patches.push(patch));
    onElectronBrowserNewWindow((payload) => newWindows.push(payload));
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    resetElectronBrowserHostForTests();
    container.remove();
  });

  it('实现完整 13 方法契约(与 BrowserHost 一一对应)', () => {
    for (const method of BROWSER_HOST_METHODS) {
      expect(typeof electronBrowserHost[method]).toBe('function');
    }
  });

  it('create:独立 partition、关弹窗、src 正常化、挂载容器、初始隐藏与定位、初始事件', async () => {
    bindElectronBrowserContainer('p1', container);
    await electronBrowserHost.create('p1', 'example.com', { x: 10, y: 20, width: 300, height: 200 });

    const el = lastWebview();
    expect(instances).toHaveLength(1);
    expect(el.getAttribute('partition')).toBe('persist:cmx-browser');
    expect(el.getAttribute('allowpopups')).toBe('false');
    expect(el.getAttribute('src')).toBe('https://example.com/');
    expect(el.parentElement).toBe(container);
    expect(el.style.display).toBe('none');
    expect(el.style.position).toBe('fixed');
    expect(el.style.left).toBe('10px');
    expect(el.style.top).toBe('20px');
    expect(el.style.width).toBe('300px');
    expect(el.style.height).toBe('200px');

    expect(patches).toEqual([
      { browserId: 'p1', url: 'https://example.com/', isLoading: true, canGoBack: false, canGoForward: false },
    ]);
  });

  it('create:非法协议拒绝且不创建元素', async () => {
    bindElectronBrowserContainer('p1', container);
    await expect(
      electronBrowserHost.create('p1', 'ftp://example.com', { x: 0, y: 0, width: 10, height: 10 }),
    ).rejects.toThrow('只允许 http 或 https 地址');
    expect(instances).toHaveLength(0);
  });

  it('create:同 id 复用现有 webview,等价导航而非新建', async () => {
    bindElectronBrowserContainer('p1', container);
    await electronBrowserHost.create('p1', 'https://example.com/', { x: 0, y: 0, width: 10, height: 10 });
    const el = lastWebview();
    fireGuestEvent(el, 'did-attach');

    await electronBrowserHost.create('p1', 'https://example.com/other', { x: 0, y: 0, width: 10, height: 10 });

    expect(instances).toHaveLength(1);
    expect(el.loadURL).toHaveBeenCalledWith('https://example.com/other');
  });

  it('did-attach:向 main 登记 guest webContentsId', async () => {
    bindElectronBrowserContainer('p1', container);
    await electronBrowserHost.create('p1', 'https://example.com/', { x: 0, y: 0, width: 10, height: 10 });
    const el = lastWebview();

    fireGuestEvent(el, 'did-attach');
    await vi.waitFor(() => {
      expect(bridgeMock.browserRegisterGuest).toHaveBeenCalledWith(el.getWebContentsId(), 'p1');
    });
  });

  it('navigate:附挂后走 loadURL,未附挂回退 src 属性;页不存在拒绝', async () => {
    bindElectronBrowserContainer('p1', container);
    await electronBrowserHost.create('p1', 'https://example.com/', { x: 0, y: 0, width: 10, height: 10 });
    const el = lastWebview();
    fireGuestEvent(el, 'did-attach');

    await electronBrowserHost.navigate('p1', 'https://example.com/a');
    expect(el.loadURL).toHaveBeenCalledWith('https://example.com/a');

    await expect(electronBrowserHost.navigate('missing', 'https://example.com/')).rejects.toThrow(
      '浏览器页不存在: missing',
    );

    // 未附挂:src 属性等价导航(规避 did-attach 前的方法调用限制)。
    await electronBrowserHost.create('p2', 'https://example.com/', { x: 0, y: 0, width: 10, height: 10 });
    const el2 = lastWebview();
    await electronBrowserHost.navigate('p2', 'https://example.com/b');
    expect(el2.getAttribute('src')).toBe('https://example.com/b');
    expect(el2.loadURL).not.toHaveBeenCalled();
  });

  it('back/forward/reload/openDevtools/setZoom 在 did-attach 后转发到 webview 方法', async () => {
    bindElectronBrowserContainer('p1', container);
    await electronBrowserHost.create('p1', 'https://example.com/', { x: 0, y: 0, width: 10, height: 10 });
    const el = lastWebview();

    const pendingZoom = electronBrowserHost.setZoom('p1', 0.5);
    fireGuestEvent(el, 'did-attach');
    await pendingZoom;
    await electronBrowserHost.back('p1');
    await electronBrowserHost.forward('p1');
    await electronBrowserHost.reload('p1');
    await electronBrowserHost.openDevtools('p1');

    expect(el.goBack).toHaveBeenCalledTimes(1);
    expect(el.goForward).toHaveBeenCalledTimes(1);
    expect(el.reload).toHaveBeenCalledTimes(1);
    expect(el.openDevTools).toHaveBeenCalledTimes(1);
    expect(el.setZoomFactor).toHaveBeenCalledWith(0.5);

    await expect(electronBrowserHost.back('missing')).rejects.toThrow('浏览器页不存在: missing');
  });

  it('evaluate:executeJavaScript 结果序列化为 JSON 文本(undefined → null)', async () => {
    bindElectronBrowserContainer('p1', container);
    const el = await createAttachedPage('p1');
    el.executeJavaScript.mockResolvedValueOnce({ captured: { tag: 'div' } });
    el.executeJavaScript.mockResolvedValueOnce(undefined);

    await expect(electronBrowserHost.evaluate('p1', 'script()')).resolves.toBe('{"captured":{"tag":"div"}}');
    await expect(electronBrowserHost.evaluate('p1', 'script()')).resolves.toBe('null');
    expect(el.executeJavaScript).toHaveBeenCalledWith('script()');
  });

  it('show/hide:纯 CSS 显隐;切走停放不销毁,destroy 才移除', async () => {
    bindElectronBrowserContainer('p1', container);
    const elA = await createAttachedPage('p1');
    bindElectronBrowserContainer('p2', container);
    const elB = await createAttachedPage('p2', 'https://example.org/');

    await electronBrowserHost.show('p1');
    expect(elA.style.display).toBe('');

    // 切到 p2:p1 停放(display:none)但元素与记录都保留(登录态保留)。
    await electronBrowserHost.show('p2');
    await electronBrowserHost.hide('p1');
    expect(elA.style.display).toBe('none');
    expect(elB.style.display).toBe('');
    expect(container.contains(elA)).toBe(true);
    await expect(electronBrowserHost.setBounds('p1', { x: 1, y: 1, width: 5, height: 5 })).resolves.toBeUndefined();

    // 销毁才真正移除,后续操作拒绝。
    await electronBrowserHost.destroy('p1');
    expect(container.contains(elA)).toBe(false);
    await expect(electronBrowserHost.show('p1')).rejects.toThrow('浏览器页不存在: p1');
  });

  it('clearData:校验范围、走壳桥清独立 partition、清后重载已附挂页面', async () => {
    bindElectronBrowserContainer('p1', container);
    const el = await createAttachedPage('p1');
    await electronBrowserHost.create('p2', 'https://example.com/', { x: 0, y: 0, width: 10, height: 10 });
    const elUnattached = lastWebview();

    await electronBrowserHost.clearData('all');
    expect(bridgeMock.browserClearData).toHaveBeenCalledWith('all');
    expect(el.reload).toHaveBeenCalledTimes(1);
    expect(elUnattached.reload).not.toHaveBeenCalled();

    bridgeMock.browserClearData.mockClear();
    await electronBrowserHost.clearData('cache');
    expect(bridgeMock.browserClearData).toHaveBeenCalledWith('cache');

    bridgeMock.browserClearData.mockClear();
    await expect(electronBrowserHost.clearData('cookies' as never)).rejects.toThrow('未知的清除范围: cookies');
    expect(bridgeMock.browserClearData).not.toHaveBeenCalled();
  });

  it('事件映射:did-stop-loading / did-navigate / title / favicon → Tauri 等价补丁', async () => {
    bindElectronBrowserContainer('p1', container);
    const el = await createAttachedPage('p1');
    el.getURL.mockReturnValue('https://example.com/loaded');
    el.canGoBack.mockReturnValue(true);
    el.canGoForward.mockReturnValue(false);

    patches.length = 0;
    fireGuestEvent(el, 'did-start-loading');
    fireGuestEvent(el, 'did-navigate', { url: 'https://example.com/loaded' });
    fireGuestEvent(el, 'did-stop-loading');
    fireGuestEvent(el, 'page-title-updated', { title: 'Example' });
    fireGuestEvent(el, 'page-favicon-updated', { favicons: ['a.png', 'b.png'] });
    fireGuestEvent(el, 'did-navigate-in-page', { url: 'https://example.com/loaded#hash', isMainFrame: true });

    expect(patches).toEqual([
      { browserId: 'p1', isLoading: true },
      { browserId: 'p1', url: 'https://example.com/loaded', canGoBack: true, canGoForward: false },
      {
        browserId: 'p1',
        url: 'https://example.com/loaded',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
        lastError: '',
      },
      { browserId: 'p1', title: 'Example' },
      { browserId: 'p1', faviconUrl: 'b.png' },
      { browserId: 'p1', url: 'https://example.com/loaded#hash' },
    ]);
  });

  it('事件映射:dom-ready 注入空白链接拦截脚本', async () => {
    bindElectronBrowserContainer('p1', container);
    const el = await createAttachedPage('p1');
    el.executeJavaScript.mockClear();

    fireGuestEvent(el, 'dom-ready');
    await vi.waitFor(() => {
      expect(el.executeJavaScript).toHaveBeenCalledWith(BLANK_LINK_INTERCEPT_SCRIPT);
    });
  });

  it('事件映射:codemux 桥链拦截 → preventDefault + 新窗口事件(http/https 才转发)', async () => {
    bindElectronBrowserContainer('p1', container);
    const el = await createAttachedPage('p1');
    patches.length = 0;

    const bridgeEvent = fireGuestEvent(el, 'will-navigate', {
      url: 'codemux://browser/open?url=' + encodeURIComponent('https://example.com/docs'),
    });
    expect(bridgeEvent.defaultPrevented).toBe(true);
    expect(newWindows).toEqual([
      { sourceBrowserId: 'p1', url: 'https://example.com/docs' },
    ]);

    const deniedEvent = fireGuestEvent(el, 'will-navigate', { url: 'file:///etc/passwd' });
    expect(deniedEvent.defaultPrevented).toBe(true);
    expect(patches).toEqual([{ browserId: 'p1', lastError: '只允许 http 或 https 地址' }]);

    patches.length = 0;
    const httpEvent = fireGuestEvent(el, 'will-navigate', { url: 'https://example.com/next' });
    expect(httpEvent.defaultPrevented).toBe(false);
    expect(newWindows).toHaveLength(1);
    expect(patches).toEqual([]);
  });

  it('事件映射:非 codemux 的自定义 scheme 静默拦截(与 Rust on_navigation 对齐)', async () => {
    bindElectronBrowserContainer('p1', container);
    const el = await createAttachedPage('p1');
    patches.length = 0;

    const event = fireGuestEvent(el, 'will-navigate', { url: 'codemux://other/path' });
    expect(event.defaultPrevented).toBe(true);
    expect(newWindows).toEqual([]);
    expect(patches).toEqual([]);
  });
});
