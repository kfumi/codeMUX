import { browserPageTitle } from './browserPage';
import { browserScopeFromPanelTabId } from './browserPanelTab';
import {
  onElectronBrowserNewWindow,
  onElectronBrowserPage,
} from './browser/electronBrowserHost';
import {
  type BrowserNewWindowPayload,
  type BrowserPagePatch,
} from './browserHost';
import type { DesktopBrowserAgentOpenPayload } from './desktop-bridge';
import { desktopBridge } from './desktop-bridge';
import { normalizeBrowserUrl } from './browserUrl';
import { createLogger } from './logger';
import { useBrowserStore } from '../stores/browserStore';
import { useSidePanelStore } from '../stores/sidePanelStore';

const logger = createLogger('browserHostBridge');

/** browser-agent-open:等 openBrowserTab 后页面 id 落库的上限(面板挂载在亚秒级)。 */
const AGENT_OPEN_PAGE_WAIT_MS = 3_000;
const AGENT_OPEN_PAGE_POLL_MS = 50;

export type { BrowserNewWindowPayload } from './browserHost';

function openBrowserTabInScope(scopeId: string, url?: string) {
  const sidePanel = useSidePanelStore.getState();
  if (sidePanel.activeScopeId !== scopeId) {
    sidePanel.setScope(scopeId);
  }
  sidePanel.openBrowserTab(url);
}

/**
 * browser_open(自举对)的渲染层执行面:开一个浏览器页并导航到 url。
 *
 * 落点策略:侧面板正显示浏览器标签 → 在该标签里开新页(当前是空白页则复用,
 * 不叠空白);否则 openBrowserTab 新开一个浏览器标签(面板随之打开并激活)。
 * 返回新页的 browserId —— main 侧拿到后会等 guest 登记,再回给模型。
 */
export async function openAgentBrowserPage(url: string): Promise<{ browserId: string } | { error: string }> {
  const normalized = normalizeBrowserUrl(url);
  if (!normalized.ok) {
    return { error: `URL 无效(${normalized.error}):必须是 http/https 地址` };
  }

  const sidePanel = useSidePanelStore.getState();
  const activeTab = sidePanel.tabs.find((tab) => tab.id === sidePanel.activeTabId);
  let panelTabId: string | null = null;
  if (sidePanel.isOpen && activeTab?.kind === 'browser') {
    panelTabId = activeTab.id;
  }

  if (panelTabId !== null) {
    const store = useBrowserStore.getState();
    const activeId = store.activePageIdByPanel[panelTabId] ?? null;
    const active = activeId ? store.pages[activeId] : undefined;
    // 当前是没动过的空白页就复用,不另叠一个空白(browser_open 语义是「打开这个地址」)。
    const pageId = activeId !== null && active?.url === '' && !active.hostAttached && !active.isLoading
      ? activeId
      : store.addPage(panelTabId);
    void useBrowserStore.getState().navigate(pageId, normalized.url);
    return { browserId: pageId };
  }

  const newTabId = sidePanel.openBrowserTab(normalized.url);
  // 新标签的页面由 BrowserPanel 挂载时的 ensureBlankPage 创建,effect 在下一次
  // 提交里跑 —— 有界轮询等它出现,拿到了才能把 browserId 报回 main。
  const deadline = Date.now() + AGENT_OPEN_PAGE_WAIT_MS;
  for (;;) {
    const pageId = useBrowserStore.getState().activePageIdByPanel[newTabId] ?? null;
    if (pageId) {
      return { browserId: pageId };
    }
    if (Date.now() > deadline) {
      return { error: '浏览器面板未能创建页面(3s 内没有出现页面),面板可能未挂载' };
    }
    await new Promise((resolve) => setTimeout(resolve, AGENT_OPEN_PAGE_POLL_MS));
  }
}

/** browser-agent-open 事件分发(自举对):开页并把结果按 requestId 回 main。 */
export async function dispatchBrowserAgentOpen(payload?: DesktopBrowserAgentOpenPayload): Promise<void> {
  const { requestId, url } = payload ?? {};
  if (!requestId || !url) {
    logger.warn('Ignored browser agent-open event without requestId or url');
    return;
  }
  const reply = await openAgentBrowserPage(url);
  // 可选调用:与 initBrowserHostBridge 的订阅侧同款容忍(旧 preload 缺方法时
  // 不抛错 —— 抛了只会让 main 侧白等满超时)。
  if ('browserId' in reply) {
    void desktopBridge?.browserAgentOpenResult?.({ requestId, browserId: reply.browserId });
    return;
  }
  void desktopBridge?.browserAgentOpenResult?.({ requestId, error: reply.error });
}

/** 页面事件分发(payload 形状见 ../lib/browserHost.ts)。 */
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

/** 弹窗(新标签)事件分发。 */
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

/**
 * 浏览器宿主事件桥(工单 09 终态):页面事件来自渲染层 <webview> 的本地
 * 事件总线;弹窗兜底经 main setWindowOpenHandler 转发(preload onBrowserNewWindow)。
 * Tauri emit 通道随壳退役移除。
 */
export function initBrowserHostBridge(): void {
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
  // browser_open(自举对):main 的协调器经 browser-agent-open 事件请渲染层开页,
  // 结果按 requestId 回 browserAgentOpenResult。纯浏览器宿主没有这条桥,
  // main 侧按超时收口。可选调用:旧 preload(没有 onDesktopEvent)不至于让整座桥挂掉。
  desktopBridge?.onDesktopEvent?.('browser-agent-open', (payload) => {
    void dispatchBrowserAgentOpen(payload as DesktopBrowserAgentOpenPayload);
  });
}
