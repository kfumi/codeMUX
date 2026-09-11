// Browser Host(工单 07)main 侧契约测试:electron 以最小 mock 替身注入,
// 覆盖 partition 附挂校验、guest 弹窗拒绝转发、独立 partition 清资料的范围语义。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appMock = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
}));

const sessionMock = vi.hoisted(() => ({
  fromPartition: vi.fn(),
}));

vi.mock('electron', () => ({
  app: appMock,
  session: sessionMock,
}));

import {
  BROWSER_PARTITION,
  clearBrowserProfileData,
  createBrowserGuestTracker,
  guardWebviewAttach,
  isAllowedBrowserPartition,
} from '../src/browser-host';

type OpenHandler = (details: { url: string }) => { action: 'deny' | 'allow' };

function makeFakeGuestContents(id = 42) {
  const openHandlers: OpenHandler[] = [];
  const destroyedHandlers: Array<() => void> = [];
  return {
    id,
    getType: () => 'webview',
    setWindowOpenHandler: (handler: OpenHandler) => {
      openHandlers.push(handler);
    },
    once: (event: string, handler: () => void) => {
      if (event === 'destroyed') destroyedHandlers.push(handler);
    },
    openHandlers,
    destroyedHandlers,
  };
}

describe('browser-host(工单 07 main 侧)', () => {
  beforeEach(() => {
    appMock.on.mockClear();
    appMock.off.mockClear();
    sessionMock.fromPartition.mockReset();
  });

  it('partition 校验:接受 cmx- 与 persist:cmx- 形态,拒绝其余', () => {
    expect(isAllowedBrowserPartition('cmx-browser')).toBe(true);
    expect(isAllowedBrowserPartition('persist:cmx-browser')).toBe(true);
    expect(isAllowedBrowserPartition('persist:evil')).toBe(false);
    expect(isAllowedBrowserPartition('evil')).toBe(false);
    expect(isAllowedBrowserPartition('')).toBe(false);
    expect(isAllowedBrowserPartition(undefined)).toBe(false);
    expect(isAllowedBrowserPartition(null)).toBe(false);
  });

  it('guardWebviewAttach:剥 preload、禁 Node、强制 contextIsolation,partition 非法则拒绝', () => {
    const preferences: { preload?: unknown; nodeIntegration?: boolean; contextIsolation?: boolean } = {
      preload: '/evil/preload.js',
      nodeIntegration: true,
      contextIsolation: false,
    };
    expect(guardWebviewAttach(preferences, { partition: 'persist:cmx-browser' })).toBe(true);
    expect(preferences.preload).toBeUndefined();
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.contextIsolation).toBe(true);

    expect(guardWebviewAttach({}, { partition: 'persist:evil' })).toBe(false);
    expect(guardWebviewAttach({}, {})).toBe(false);
  });

  it('guest 弹窗:一律 deny,http/https 转发渲染层并回填 sourceBrowserId', () => {
    const sendToRenderer = vi.fn();
    const tracker = createBrowserGuestTracker({ sendToRenderer });
    const contents = makeFakeGuestContents();

    tracker.onWebContentsCreated(null as never, contents as never);
    expect(contents.openHandlers).toHaveLength(1);

    tracker.register(42, 'page-a');
    const handler = contents.openHandlers[0];

    expect(handler({ url: 'https://example.com/next' })).toEqual({ action: 'deny' });
    expect(sendToRenderer).toHaveBeenCalledWith('browser-new-window', {
      sourceBrowserId: 'page-a',
      url: 'https://example.com/next',
    });

    sendToRenderer.mockClear();
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(sendToRenderer).not.toHaveBeenCalled();

    // guest 销毁后清理登记。
    expect(tracker.lookup(42)).toBe('page-a');
    contents.destroyedHandlers.forEach((fn) => fn());
    expect(tracker.lookup(42)).toBeUndefined();
  });

  it('非 webview 类型的 webContents 不注册弹窗处理器', () => {
    const tracker = createBrowserGuestTracker({ sendToRenderer: vi.fn() });
    const contents = {
      getType: () => 'window',
      setWindowOpenHandler: vi.fn(),
      once: vi.fn(),
    };
    tracker.onWebContentsCreated(null as never, contents as never);
    expect(contents.setWindowOpenHandler).not.toHaveBeenCalled();
  });

  it('clearBrowserProfileData:all 清全部资料,cache 只清缓存与 Service Worker', async () => {
    const profile = {
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      clearCodeCaches: vi.fn().mockResolvedValue(undefined),
    };
    sessionMock.fromPartition.mockReturnValue(profile);

    await clearBrowserProfileData('all');
    expect(sessionMock.fromPartition).toHaveBeenCalledWith(BROWSER_PARTITION);
    expect(profile.clearStorageData).toHaveBeenCalledWith();
    expect(profile.clearCache).toHaveBeenCalled();
    expect(profile.clearCodeCaches).toHaveBeenCalledWith({});

    profile.clearStorageData.mockClear();
    profile.clearCache.mockClear();
    profile.clearCodeCaches.mockClear();

    await clearBrowserProfileData('cache');
    expect(profile.clearCache).toHaveBeenCalled();
    expect(profile.clearCodeCaches).toHaveBeenCalledWith({});
    expect(profile.clearStorageData).toHaveBeenCalledWith({
      storages: ['cachestorage', 'serviceworkers'],
    });
  });

  it('clearBrowserProfileData:未知范围抛错且不触碰 session', async () => {
    const profile = { clearStorageData: vi.fn(), clearCache: vi.fn(), clearCodeCaches: vi.fn() };
    sessionMock.fromPartition.mockReturnValue(profile);
    await expect(clearBrowserProfileData('cookies' as never)).rejects.toThrow('未知的清除范围: cookies');
    expect(sessionMock.fromPartition).not.toHaveBeenCalled();
  });
});
