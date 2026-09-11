export interface BrowserPageBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserDataScope = 'cache' | 'all';

export interface BrowserPagePatch {
  browserId: string;
  url?: string;
  title?: string;
  faviconUrl?: string | null;
  isLoading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  lastError?: string | null;
}

/** 弹窗转发载荷(与 Rust BrowserNewWindowEvent 同形;工单 07 起 Electron 侧复用)。 */
export interface BrowserNewWindowPayload {
  sourceBrowserId: string;
  url: string;
}

/** BrowserHost 完整方法契约清单(契约守护/能力清单测试断言用)。 */
export const BROWSER_HOST_METHODS = [
  'create',
  'destroy',
  'navigate',
  'back',
  'forward',
  'reload',
  'setBounds',
  'show',
  'hide',
  'evaluate',
  'openDevtools',
  'setZoom',
  'clearData',
] as const;

export type BrowserHostMethod = (typeof BROWSER_HOST_METHODS)[number];

export interface BrowserHost {
  create: (browserId: string, url: string, bounds: BrowserPageBounds) => Promise<void>;
  destroy: (browserId: string) => Promise<void>;
  navigate: (browserId: string, url: string) => Promise<void>;
  back: (browserId: string) => Promise<void>;
  forward: (browserId: string) => Promise<void>;
  reload: (browserId: string) => Promise<void>;
  setBounds: (browserId: string, bounds: BrowserPageBounds) => Promise<void>;
  show: (browserId: string) => Promise<void>;
  hide: (browserId: string) => Promise<void>;
  evaluate: (browserId: string, script: string) => Promise<string>;
  openDevtools: (browserId: string) => Promise<void>;
  setZoom: (browserId: string, factor: number) => Promise<void>;
  clearData: (scope: BrowserDataScope) => Promise<void>;
}

export const BROWSER_PAGE_EVENT = 'browser-page-event';
export const BROWSER_NEW_WINDOW_EVENT = 'browser-new-window-event';
