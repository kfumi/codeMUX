/**
 * Electron Browser Host(工单 07):渲染层以沙箱 `<webview>` 标签托管内置浏览,
 * 与 Tauri browserApi(13 方法)契约逐一对齐(见 ../browserHost.ts)。
 *
 * - partition:`persist:cmx-browser` 独立会话(登录态跨标签切换/关壳重开保留);
 * - guest 无任何应用桥:不注入 preload,main 侧 will-attach-webview 强制校验
 *   (剥 preload / 禁 Node / partition 必须带 cmx- 前缀);
 * - 页面属于 DOM 布局:show/hide/setBounds 是纯 CSS(display:none = 停放不销毁);
 * - 遮挡退役:`<webview>` 参与 DOM 层级,浮层(菜单/对话框)天然遮挡,
 *   不再走 nativeViewOcclusion(Tauri 路径不受影响);
 * - 页面事件映射:Electron webview DOM 事件 → BrowserPagePatch /
 *   BrowserNewWindowPayload(与 Rust manager.rs 的事件形状等价),经本地事件
 *   总线分发给 browserHostBridge(Electron 分支),Tauri 的 tauri listen 不动。
 */
import type {
  BrowserDataScope,
  BrowserHost,
  BrowserNewWindowPayload,
  BrowserPageBounds,
  BrowserPagePatch,
} from '../browserHost';
import { normalizeBrowserUrl } from '../browserUrl';
import { desktopBridge } from '../desktop-bridge';
import { createLogger, serializeError } from '../logger';

const logger = createLogger('electronBrowserHost');

/** 内置浏览专用独立会话 partition(desktop-electron/src/browser-host.ts 同值)。 */
export const BROWSER_PARTITION = 'persist:cmx-browser';

/** 与 Rust normalize_browser_url / manager.rs 的拦截文案一致。 */
const ONLY_HTTPS_ERROR = '只允许 http 或 https 地址';

/** 与 Rust destroy/navigate 等「页不存在」错误文案一致。 */
function pageMissingError(browserId: string): string {
  return `浏览器页不存在: ${browserId}`;
}

/** 与 Rust clear_data 的未知范围文案一致。 */
function unknownScopeError(scope: string): string {
  return `未知的清除范围: ${scope}`;
}

/**
 * 空白链接拦截脚本(Tauri 版由 Rust manager.rs BLANK_LINK_INTERCEPT_SCRIPT 在
 * 每次加载后 eval 注入;Electron 版在 dom-ready 经 executeJavaScript 注入同一逻辑:
 * target=_blank / 修饰键 / 中键 / window.open → codemux://browser/open 链接点击,
 * 由 will-navigate 拦截并转「新标签打开」)。
 */
export const BLANK_LINK_INTERCEPT_SCRIPT = `(function () {
  function installBlankBridge() {
    if (window.__codemuxBrowserBlankBridge) return;
    window.__codemuxBrowserBlankBridge = true;
    function openInAppTab(url) {
      try {
        const parsed = new URL(url, window.location.href);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        const bridge = "codemux://browser/open?url=" + encodeURIComponent(parsed.href);
        const link = document.createElement("a");
        link.href = bridge;
        link.style.display = "none";
        (document.body || document.documentElement).appendChild(link);
        link.click();
        link.remove();
      } catch (error) {}
    }
    function shouldOpenInNewTab(link, event) {
      const target = (link.getAttribute("target") || "").toLowerCase();
      if (target === "_blank" || target === "_new") return true;
      if (!event) return false;
      return event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
    }
    document.addEventListener(
      "click",
      function (event) {
        const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
        if (!link || !shouldOpenInNewTab(link, event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openInAppTab(link.href);
      },
      true,
    );
    document.addEventListener(
      "auxclick",
      function (event) {
        if (event.button !== 1) return;
        const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
        if (!link) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openInAppTab(link.href);
      },
      true,
    );
    const originalOpen = window.open;
    window.open = function (url, target) {
      if (url) {
        openInAppTab(String(url));
        return null;
      }
      return originalOpen.apply(this, arguments);
    };
  }
  installBlankBridge();
})()`;

/** 渲染层用到的 Electron `<webview>` 标签方法子集(DOM 属性/事件用原生接口)。 */
export interface CmxWebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  setZoomFactor(factor: number): void;
  openDevTools(): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  getWebContentsId(): number;
}

type WebviewDomEvent = Event & {
  url?: string;
  title?: string;
  favicons?: string[];
  isMainFrame?: boolean;
};

interface WebviewRecord {
  el: CmxWebviewElement;
  bounds: BrowserPageBounds | null;
  visible: boolean;
  attached: boolean;
  attachedPromise: Promise<void>;
  resolveAttached: () => void;
  zoom: number;
  /** 主动 destroy 标记:区分「用户关页」与「guest 意外销毁」。 */
  destroying: boolean;
}

// ---------------------------------------------------------------------------
// 本地事件总线:Electron 分支的页面事件出口(browserHostBridge 订阅),
// 载荷形状与 Tauri browser-page-event / browser-new-window-event 等价。
// ---------------------------------------------------------------------------

type PageListener = (patch: BrowserPagePatch) => void;
type NewWindowListener = (payload: BrowserNewWindowPayload) => void;

const pageListeners = new Set<PageListener>();
const newWindowListeners = new Set<NewWindowListener>();

/** 订阅页面状态补丁(Electron 分支;Tauri 走 tauri listen,不经此总线)。 */
export function onElectronBrowserPage(listener: PageListener): () => void {
  pageListeners.add(listener);
  return () => {
    pageListeners.delete(listener);
  };
}

/** 订阅弹窗(新标签)请求。 */
export function onElectronBrowserNewWindow(listener: NewWindowListener): () => void {
  newWindowListeners.add(listener);
  return () => {
    newWindowListeners.delete(listener);
  };
}

function emitPage(patch: BrowserPagePatch): void {
  for (const listener of [...pageListeners]) {
    try {
      listener(patch);
    } catch (error) {
      logger.warn('browser page listener failed', {}, serializeError(error));
    }
  }
}

function emitNewWindow(payload: BrowserNewWindowPayload): void {
  for (const listener of [...newWindowListeners]) {
    try {
      listener(payload);
    } catch (error) {
      logger.warn('browser new-window listener failed', {}, serializeError(error));
    }
  }
}

// ---------------------------------------------------------------------------
// 元素工厂(测试缝):默认 document.createElement('webview'),单测注入假元素。
// ---------------------------------------------------------------------------

type WebviewElementFactory = () => CmxWebviewElement;

const defaultWebviewElementFactory: WebviewElementFactory = () =>
  document.createElement('webview') as CmxWebviewElement;

let webviewElementFactory: WebviewElementFactory = defaultWebviewElementFactory;

/** 测试缝:替换 `<webview>` 元素创建(传 null 还原默认)。 */
export function setWebviewElementFactoryForTests(factory: WebviewElementFactory | null): void {
  webviewElementFactory = factory ?? defaultWebviewElementFactory;
}

// ---------------------------------------------------------------------------
// 记录表 / 挂载容器
// ---------------------------------------------------------------------------

const records = new Map<string, WebviewRecord>();
const containers = new Map<string, HTMLElement>();

const BROWSER_LAYER_ID = 'cmx-browser-layer';

/** 兜底挂载层:容器未登记(BrowserPanel effect 未跑)时 body 级 fixed 层。 */
function ensureLayer(): HTMLElement {
  let layer = document.getElementById(BROWSER_LAYER_ID);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = BROWSER_LAYER_ID;
    layer.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:10;';
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * 登记 `<webview>` 挂载容器(BrowserPanel 面板容器,页面属 DOM 布局;
 * 已创建的元素会被移入容器)。返回解绑函数。
 */
export function bindElectronBrowserContainer(browserId: string, container: HTMLElement): () => void {
  containers.set(browserId, container);
  const record = records.get(browserId);
  if (record && !record.destroying && record.el.parentElement !== container) {
    container.appendChild(record.el);
  }
  return () => {
    if (containers.get(browserId) === container) {
      containers.delete(browserId);
    }
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function requireRecord(browserId: string): WebviewRecord {
  const record = records.get(browserId);
  if (!record) {
    throw new Error(pageMissingError(browserId));
  }
  return record;
}

function requireBridge(): NonNullable<typeof desktopBridge> {
  if (!desktopBridge) {
    throw new Error('codemuxDesktop 桥不可用(Electron preload 未注入)');
  }
  return desktopBridge;
}

function stringifyEvaluateResult(result: unknown): string {
  if (result === undefined) return 'null';
  const text = JSON.stringify(result);
  return typeof text === 'string' ? text : 'null';
}

/** codemux://browser/open?url=... 解析(与 Rust parse_codemux_open_url 对齐)。 */
function parseCodemuxOpenUrl(target: string): string | null {
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== 'codemux:') return null;
    if (parsed.hostname !== 'browser' || parsed.pathname !== '/open') return null;
    const encoded = parsed.searchParams.get('url');
    if (!encoded) return null;
    const inner = new URL(encoded);
    if (inner.protocol !== 'http:' && inner.protocol !== 'https:') return null;
    return inner.toString();
  } catch {
    return null;
  }
}

function safeGetUrl(el: CmxWebviewElement): string {
  try {
    return el.getURL();
  } catch {
    return '';
  }
}

function applyBounds(record: WebviewRecord, bounds: BrowserPageBounds): void {
  record.bounds = bounds;
  const { style } = record.el;
  style.position = 'fixed';
  style.left = `${bounds.x}px`;
  style.top = `${bounds.y}px`;
  style.width = `${Math.max(0, bounds.width)}px`;
  style.height = `${Math.max(0, bounds.height)}px`;
}

function applyVisible(record: WebviewRecord, visible: boolean): void {
  record.visible = visible;
  record.el.style.display = visible ? '' : 'none';
}

// ---------------------------------------------------------------------------
// 事件接线(webview DOM 事件 → Tauri 等价事件载荷)
// ---------------------------------------------------------------------------

function wireEvents(browserId: string, record: WebviewRecord): void {
  const { el } = record;

  el.addEventListener('did-attach', () => {
    record.attached = true;
    record.resolveAttached();
    if (record.zoom !== 1) {
      try {
        el.setZoomFactor(record.zoom);
      } catch (error) {
        logger.warn('Failed to apply zoom on attach', { browserId }, serializeError(error));
      }
    }
    try {
      // guest webContentsId → browserId 登记:main 侧弹窗拒绝转发据此回填来源。
      void requireBridge().browserRegisterGuest(el.getWebContentsId(), browserId).catch((error) => {
        logger.warn('Failed to register browser guest', { browserId }, serializeError(error));
      });
    } catch (error) {
      logger.warn('Failed to register browser guest', { browserId }, serializeError(error));
    }
  });

  // 对齐 Rust on_page_load Started。
  el.addEventListener('did-start-loading', () => {
    emitPage({ browserId, isLoading: true });
  });

  // 对齐 Rust on_page_load Finished:url + 导航标志 + lastError:''(前端清错)。
  el.addEventListener('did-stop-loading', () => {
    emitPage({
      browserId,
      url: safeGetUrl(el),
      isLoading: false,
      canGoBack: Boolean(el.canGoBack()),
      canGoForward: Boolean(el.canGoForward()),
      lastError: '',
    });
  });

  // 主框架导航完成(可能早于 stop-loading):同步 url 与导航标志。
  el.addEventListener('did-navigate', (event) => {
    const navEvent = event as WebviewDomEvent;
    emitPage({
      browserId,
      url: navEvent.url ?? safeGetUrl(el),
      canGoBack: Boolean(el.canGoBack()),
      canGoForward: Boolean(el.canGoForward()),
    });
  });

  el.addEventListener('did-navigate-in-page', (event) => {
    const navEvent = event as WebviewDomEvent;
    if (navEvent.isMainFrame === false) return;
    emitPage({ browserId, url: navEvent.url ?? safeGetUrl(el) });
  });

  // 对齐 Rust on_document_title_changed。
  el.addEventListener('page-title-updated', (event) => {
    const titleEvent = event as WebviewDomEvent;
    emitPage({ browserId, title: titleEvent.title ?? '' });
  });

  // 对齐 Rust FAVICON_SCRIPT 回传(favicon_url;null 清空)。
  el.addEventListener('page-favicon-updated', (event) => {
    const faviconEvent = event as WebviewDomEvent;
    const favicons = faviconEvent.favicons ?? [];
    emitPage({ browserId, faviconUrl: favicons.length > 0 ? favicons[favicons.length - 1] : null });
  });

  // 对齐 Rust 初始化/每次加载后的 BLANK_LINK_INTERCEPT_SCRIPT 注入。
  el.addEventListener('dom-ready', () => {
    el.executeJavaScript(BLANK_LINK_INTERCEPT_SCRIPT).catch((error) => {
      logger.warn('Failed to inject blank-link intercept script', { browserId }, serializeError(error));
    });
  });

  // 对齐 Rust on_navigation:codemux 桥链 → 弹窗转发;仅允许 http/https。
  el.addEventListener('will-navigate', (event) => {
    const navEvent = event as WebviewDomEvent;
    const url = navEvent.url ?? '';
    const openUrl = parseCodemuxOpenUrl(url);
    if (openUrl) {
      navEvent.preventDefault();
      emitNewWindow({ sourceBrowserId: browserId, url: openUrl });
      return;
    }
    if (url.startsWith('codemux:')) {
      navEvent.preventDefault();
      return;
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return;
    }
    navEvent.preventDefault();
    emitPage({ browserId, lastError: ONLY_HTTPS_ERROR });
  });

  // guest 意外销毁(元素被外部摘除等):清理记录;主动 destroy 不经此处
  // (destroy 先置 destroying 再摘元素)。
  el.addEventListener('destroyed', () => {
    if (record.destroying) return;
    record.resolveAttached();
    records.delete(browserId);
    logger.warn('Browser webview destroyed unexpectedly', { browserId });
  });
}

// ---------------------------------------------------------------------------
// BrowserHost 契约实现(13 方法,与 Tauri browserApi 语义逐一对齐)
// ---------------------------------------------------------------------------

async function createPage(browserId: string, url: string, bounds: BrowserPageBounds): Promise<void> {
  if (records.has(browserId)) {
    // 对齐 Rust create_page:同 id 复用现有 webview → 等价导航。
    await navigatePage(browserId, url);
    return;
  }
  const normalized = normalizeBrowserUrl(url);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }

  const el = webviewElementFactory();
  // 独立会话 + 关闭弹窗(弹窗由 main setWindowOpenHandler 统一拒绝并转发)。
  el.setAttribute('partition', BROWSER_PARTITION);
  el.setAttribute('allowpopups', 'false');

  const record: WebviewRecord = {
    el,
    bounds: null,
    visible: false,
    attached: false,
    attachedPromise: Promise.resolve(),
    resolveAttached: () => {},
    zoom: 1,
    destroying: false,
  };
  record.attachedPromise = new Promise<void>((resolve) => {
    record.resolveAttached = resolve;
  });
  records.set(browserId, record);
  wireEvents(browserId, record);

  applyBounds(record, bounds);
  applyVisible(record, false);

  const container = containers.get(browserId) ?? ensureLayer();
  container.appendChild(el);
  // 首次导航用 src 属性:元素附挂后自动加载,规避 did-attach 前调用方法的时序。
  el.setAttribute('src', normalized.url);

  // 对齐 Rust create_page 完成后的初始事件。
  emitPage({
    browserId,
    url: normalized.url,
    isLoading: true,
    canGoBack: false,
    canGoForward: false,
  });
}

async function destroyPage(browserId: string): Promise<void> {
  const record = records.get(browserId);
  if (!record) return;
  record.destroying = true;
  record.resolveAttached();
  records.delete(browserId);
  record.el.remove();
}

async function navigatePage(browserId: string, url: string): Promise<void> {
  const record = requireRecord(browserId);
  const normalized = normalizeBrowserUrl(url);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  if (record.attached) {
    await record.el.loadURL(normalized.url);
  } else {
    // did-attach 前:src 属性等价导航,避免未挂载即调用方法。
    record.el.setAttribute('src', normalized.url);
  }
  // 对齐 Rust navigate_page 的立即事件。
  emitPage({ browserId, url: normalized.url, isLoading: true });
}

async function backPage(browserId: string): Promise<void> {
  const record = requireRecord(browserId);
  await record.attachedPromise;
  record.el.goBack();
}

async function forwardPage(browserId: string): Promise<void> {
  const record = requireRecord(browserId);
  await record.attachedPromise;
  record.el.goForward();
}

async function reloadPage(browserId: string): Promise<void> {
  const record = requireRecord(browserId);
  await record.attachedPromise;
  record.el.reload();
}

async function setPageBounds(browserId: string, bounds: BrowserPageBounds): Promise<void> {
  const record = requireRecord(browserId);
  applyBounds(record, bounds);
}

async function showPage(browserId: string): Promise<void> {
  const record = requireRecord(browserId);
  applyVisible(record, true);
}

async function hidePage(browserId: string): Promise<void> {
  const record = requireRecord(browserId);
  applyVisible(record, false);
}

async function evaluateScript(browserId: string, script: string): Promise<string> {
  const record = requireRecord(browserId);
  await record.attachedPromise;
  // Tauri eval_with_callback 返回结果的 JSON 文本;executeJavaScript 返回值对象,
  // 这里序列化为同一形状(调用方按 JSON 文本消费)。
  const result = await record.el.executeJavaScript(script);
  return stringifyEvaluateResult(result);
}

async function openDevtools(browserId: string): Promise<void> {
  const record = requireRecord(browserId);
  await record.attachedPromise;
  record.el.openDevTools();
}

async function setPageZoom(browserId: string, factor: number): Promise<void> {
  const record = requireRecord(browserId);
  const zoom = Math.max(0.1, factor);
  record.zoom = zoom;
  await record.attachedPromise;
  record.el.setZoomFactor(zoom);
}

async function clearBrowserData(scope: BrowserDataScope): Promise<void> {
  if (scope !== 'cache' && scope !== 'all') {
    throw new Error(unknownScopeError(scope));
  }
  // main 进程清独立 partition 的 session(cookies/storage/cache,按 scope)。
  await requireBridge().browserClearData(scope);
  // 对齐 Rust clear_one:清完后重载已打开页面(未附挂的元素无页面可重载)。
  for (const record of records.values()) {
    if (!record.attached) continue;
    try {
      record.el.reload();
    } catch (error) {
      logger.warn('Failed to reload browser page after clearData', {}, serializeError(error));
    }
  }
}

/** Electron 平台的 BrowserHost 实现(渲染层 `<webview>` 托管,工单 07)。 */
export const electronBrowserHost: BrowserHost = {
  create: createPage,
  destroy: destroyPage,
  navigate: navigatePage,
  back: backPage,
  forward: forwardPage,
  reload: reloadPage,
  setBounds: setPageBounds,
  show: showPage,
  hide: hidePage,
  evaluate: evaluateScript,
  openDevtools,
  setZoom: setPageZoom,
  clearData: clearBrowserData,
};

/** 测试缝:清空记录/总线/容器(单测间隔离)。 */
export function resetElectronBrowserHostForTests(): void {
  for (const record of records.values()) {
    record.destroying = true;
    record.el.remove();
  }
  records.clear();
  containers.clear();
  pageListeners.clear();
  newWindowListeners.clear();
  document.getElementById(BROWSER_LAYER_ID)?.remove();
}
