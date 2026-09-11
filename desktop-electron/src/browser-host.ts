//! Browser Host(工单 07)main 侧配套:Chromium 重写后的内置浏览。
//! 页面托管在渲染层(沙箱 <webview> + 独立会话 partition),main 只保留三件事:
//! 1. 附挂校验:will-attach-webview 剥 preload / 禁 Node / partition 必须带 cmx- 前缀;
//! 2. 弹窗兜底:guest setWindowOpenHandler 一律 deny,http/https 同步渲染层开新标签
//!    (对齐 Tauri manager.rs on_new_window:Deny + emit browser-new-window-event);
//! 3. 数据面:独立 partition 的 clearStorageData / clearCache(对齐 Rust clear_data)。

import { session, webContents, type WebContents } from 'electron';

/** 内置浏览专用独立会话 partition(persist → 登录态跨标签切换/关壳重开保留)。 */
export const BROWSER_PARTITION = 'persist:cmx-browser';

export type BrowserDataScope = 'cache' | 'all';

/**
 * partition 校验:允许 `cmx-*` 或持久化形态 `persist:cmx-*`,其余一律拒绝
 * (guest 只能用本应用的内置浏览会话,禁止借用默认会话或其它分区)。
 */
export function isAllowedBrowserPartition(partition: string | undefined | null): boolean {
  if (!partition) return false;
  const bare = partition.startsWith('persist:') ? partition.slice('persist:'.length) : partition;
  return bare.startsWith('cmx-');
}

interface WebviewAttachPreferences {
  preload?: unknown;
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
}

/**
 * will-attach-webview 纯校验:就地消毒 guest preferences 并返回是否允许附挂
 * (false 时调用方应 event.preventDefault() 销毁 guest)。
 * guest 页面不得携带任何应用桥:剥 preload、禁 Node、强制 contextIsolation。
 */
export function guardWebviewAttach(
  webPreferences: WebviewAttachPreferences,
  params: { partition?: string },
): boolean {
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  return isAllowedBrowserPartition(params?.partition);
}

export interface BrowserGuestTracker {
  /** app.on('web-contents-created') 处理器:为每个 webview guest 注册弹窗拒绝与清理。 */
  onWebContentsCreated: (event: unknown, contents: WebContents) => void;
  /** 渲染层在 webview did-attach 后上报 guest webContentsId → browserId。 */
  register: (webContentsId: number, browserId: string) => void;
  lookup: (webContentsId: number) => string | undefined;
  /**
   * 自动化接缝(工单 08):按 browserId 反查仍存活的 guest webContents
   * (daemon 自动化请求的执行目标;找不到返回 undefined)。
   */
  resolveTarget: (browserId: string) => WebContents | undefined;
}

/**
 * guest 登记表:setWindowOpenHandler 触发时按 guest webContentsId 回填
 * sourceBrowserId(无法定位时为空串,由渲染层回落到当前可见浏览器页)。
 */
export function createBrowserGuestTracker(deps: {
  sendToRenderer: (channel: string, payload: unknown) => void;
}): BrowserGuestTracker {
  const guests = new Map<number, string>();
  return {
    onWebContentsCreated: (_event, contents) => {
      if (contents.getType() !== 'webview') return;
      contents.setWindowOpenHandler(({ url }) => {
        // 一律拒绝弹窗;http/https 转发渲染层开内置新标签(对齐 Tauri 行为)。
        if (url.startsWith('http://') || url.startsWith('https://')) {
          deps.sendToRenderer('browser-new-window', {
            sourceBrowserId: guests.get(contents.id) ?? '',
            url,
          });
        }
        return { action: 'deny' };
      });
      contents.once('destroyed', () => {
        guests.delete(contents.id);
      });
    },
    register: (webContentsId, browserId) => {
      guests.set(webContentsId, browserId);
    },
    lookup: (webContentsId) => guests.get(webContentsId),
    resolveTarget: (browserId) => {
      if (!browserId) return undefined;
      for (const [id, mapped] of guests) {
        if (mapped !== browserId) continue;
        const found = webContents.getAllWebContents().find((item) => item.id === id);
        if (found) return found;
      }
      return undefined;
    },
  };
}

/**
 * 清内置浏览器资料(独立 partition session)。
 * 对齐 Rust clear_data:'all' = 全部资料(cookies/本地存储/缓存/Service Worker),
 * 'cache' = 仅 HTTP 缓存 + CacheStorage + Service Worker(保留登录态)。
 */
export async function clearBrowserProfileData(scope: BrowserDataScope): Promise<void> {
  if (scope !== 'cache' && scope !== 'all') {
    throw new Error(`未知的清除范围: ${scope}`);
  }
  const profile = session.fromPartition(BROWSER_PARTITION);
  if (scope === 'all') {
    await profile.clearStorageData();
    await profile.clearCache();
    await profile.clearCodeCaches({});
    return;
  }
  await profile.clearCache();
  await profile.clearCodeCaches({});
  await profile.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] });
}
