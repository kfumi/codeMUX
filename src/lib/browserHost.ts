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
  clearData: (scope: BrowserDataScope) => Promise<void>;
}

export const BROWSER_PAGE_EVENT = 'browser-page-event';
