import { create } from 'zustand';

import { browserApi } from '../lib/tauri';
import { normalizeBrowserUrl } from '../lib/browserUrl';
import { createBrowserId } from '../lib/browserPage';
import { browserViewportBounds, hostBoundsForViewportTransition, type BrowserViewportMode } from '../lib/browserViewport';
import type { BrowserPageBounds, BrowserPagePatch } from '../lib/browserHost';
import { createLogger, serializeError } from '../lib/logger';

const logger = createLogger('browserStore');
const FALLBACK_BOUNDS: BrowserPageBounds = { x: 0, y: 0, width: 1, height: 1 };

function hasUsableBounds(bounds: BrowserPageBounds): boolean {
  return bounds.width >= 2 && bounds.height >= 2;
}

export interface BrowserPage {
  id: string;
  panelTabId: string;
  url: string;
  addressDraft: string;
  title: string;
  faviconUrl: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lastError: string | null;
  hostAttached: boolean;
}

interface BrowserState {
  pages: Record<string, BrowserPage>;
  pageIdsByPanel: Record<string, string[]>;
  activePageIdByPanel: Record<string, string | null>;
  boundsByPanel: Record<string, BrowserPageBounds>;
  viewportModeByPanel: Record<string, BrowserViewportMode>;
  previewByPanel: Record<string, boolean>;
  inspectingPageId: string | null;
  inspectError: string | null;
  ensureBlankPage: (panelTabId: string) => string;
  addPage: (panelTabId: string) => string;
  closePage: (pageId: string) => Promise<{ panelEmpty: boolean; panelTabId: string }>;
  setActivePage: (panelTabId: string, pageId: string) => Promise<void>;
  setAddressDraft: (pageId: string, value: string) => void;
  navigate: (pageId: string, input?: string) => Promise<void>;
  back: (pageId: string) => Promise<void>;
  forward: (pageId: string) => Promise<void>;
  reload: (pageId: string) => Promise<void>;
  setPanelBounds: (panelTabId: string, bounds: BrowserPageBounds) => Promise<void>;
  setViewportMode: (panelTabId: string, mode: BrowserViewportMode) => Promise<void>;
  setViewportPreview: (panelTabId: string, preview: boolean) => Promise<void>;
  syncVisibility: (panelTabId: string, visiblePageId: string | null) => Promise<void>;
  applyHostPatch: (patch: BrowserPagePatch) => void;
  startInspect: (pageId: string) => void;
  stopInspect: () => void;
  setInspectError: (message: string | null) => void;
  destroyPanel: (panelTabId: string) => Promise<void>;
  reset: () => void;
}

function createBlankPage(panelTabId: string): BrowserPage {
  return {
    id: createBrowserId(),
    panelTabId,
    url: '',
    addressDraft: '',
    title: '',
    faviconUrl: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    lastError: null,
    hostAttached: false,
  };
}

async function hidePage(page: BrowserPage | undefined): Promise<void> {
  if (!page?.hostAttached) return;
  try {
    await browserApi.hide(page.id);
  } catch (error) {
    logger.warn('Failed to hide browser page', { browserId: page.id }, serializeError(error));
  }
}

function viewportBoundsForPanel(
  boundsByPanel: Record<string, BrowserPageBounds>,
  viewportModeByPanel: Record<string, BrowserViewportMode>,
  previewByPanel: Record<string, boolean>,
  panelTabId: string,
): BrowserPageBounds {
  const host = boundsByPanel[panelTabId] ?? FALLBACK_BOUNDS;
  const mode = viewportModeByPanel[panelTabId] ?? 'fit';
  const previewActive = previewByPanel[panelTabId] ?? false;
  return browserViewportBounds(host, mode, previewActive);
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  pages: {},
  pageIdsByPanel: {},
  activePageIdByPanel: {},
  boundsByPanel: {},
  viewportModeByPanel: {},
  previewByPanel: {},
  inspectingPageId: null,
  inspectError: null,

  ensureBlankPage: (panelTabId) => {
    const existing = get().pageIdsByPanel[panelTabId] ?? [];
    if (existing.length > 0) {
      return get().activePageIdByPanel[panelTabId] ?? existing[0];
    }
    const page = createBlankPage(panelTabId);
    set((state) => ({
      pages: { ...state.pages, [page.id]: page },
      pageIdsByPanel: { ...state.pageIdsByPanel, [panelTabId]: [page.id] },
      activePageIdByPanel: { ...state.activePageIdByPanel, [panelTabId]: page.id },
    }));
    return page.id;
  },

  addPage: (panelTabId) => {
    const page = createBlankPage(panelTabId);
    const previousId = get().activePageIdByPanel[panelTabId];
    set((state) => ({
      pages: { ...state.pages, [page.id]: page },
      pageIdsByPanel: {
        ...state.pageIdsByPanel,
        [panelTabId]: [...(state.pageIdsByPanel[panelTabId] ?? []), page.id],
      },
      activePageIdByPanel: { ...state.activePageIdByPanel, [panelTabId]: page.id },
      inspectingPageId: state.inspectingPageId === previousId ? null : state.inspectingPageId,
    }));
    void hidePage(previousId ? get().pages[previousId] : undefined);
    return page.id;
  },

  closePage: async (pageId) => {
    const page = get().pages[pageId];
    if (!page) {
      return { panelEmpty: true, panelTabId: '' };
    }
    const panelTabId = page.panelTabId;
    if (page.hostAttached) {
      try {
        await browserApi.destroy(pageId);
      } catch (error) {
        logger.warn('Failed to destroy browser page', { browserId: pageId }, serializeError(error));
      }
    }

    const ids = (get().pageIdsByPanel[panelTabId] ?? []).filter((id) => id !== pageId);
    const closedIndex = (get().pageIdsByPanel[panelTabId] ?? []).indexOf(pageId);
    const nextActive = ids.length === 0
      ? null
      : ids[Math.min(Math.max(closedIndex, 0), ids.length - 1)];

    set((state) => {
      const { [pageId]: _removed, ...pages } = state.pages;
      return {
        pages,
        pageIdsByPanel: { ...state.pageIdsByPanel, [panelTabId]: ids },
        activePageIdByPanel: { ...state.activePageIdByPanel, [panelTabId]: nextActive },
        inspectingPageId: state.inspectingPageId === pageId ? null : state.inspectingPageId,
      };
    });

    if (nextActive) {
      const next = get().pages[nextActive];
      if (next?.hostAttached) {
        try {
          await browserApi.show(nextActive);
        } catch (error) {
          logger.warn('Failed to show neighboring browser page', { browserId: nextActive }, serializeError(error));
        }
      }
    }

    return { panelEmpty: ids.length === 0, panelTabId };
  },

  setActivePage: async (panelTabId, pageId) => {
    const page = get().pages[pageId];
    if (!page || page.panelTabId !== panelTabId) return;
    const previousId = get().activePageIdByPanel[panelTabId];
    if (previousId === pageId) return;
    set((state) => ({
      activePageIdByPanel: { ...state.activePageIdByPanel, [panelTabId]: pageId },
      inspectingPageId: null,
    }));
    await hidePage(previousId ? get().pages[previousId] : undefined);
    if (page.hostAttached) {
      try {
        await browserApi.show(pageId);
      } catch (error) {
        logger.warn('Failed to show browser page', { browserId: pageId }, serializeError(error));
      }
    }
  },

  setAddressDraft: (pageId, value) => {
    set((state) => ({
      pages: state.pages[pageId]
        ? { ...state.pages, [pageId]: { ...state.pages[pageId], addressDraft: value } }
        : state.pages,
    }));
  },

  navigate: async (pageId, input) => {
    const page = get().pages[pageId];
    if (!page) return;
    const raw = input ?? page.addressDraft;
    const result = normalizeBrowserUrl(raw);
    if (!result.ok) {
      set((state) => ({
        pages: {
          ...state.pages,
          [pageId]: { ...state.pages[pageId], lastError: result.error, isLoading: false },
        },
      }));
      return;
    }

    const hostBounds = get().boundsByPanel[page.panelTabId] ?? FALLBACK_BOUNDS;
    const viewportBounds = viewportBoundsForPanel(
      get().boundsByPanel,
      get().viewportModeByPanel,
      get().previewByPanel,
      page.panelTabId,
    );
    set((state) => ({
      pages: {
        ...state.pages,
        [pageId]: {
          ...state.pages[pageId],
          addressDraft: result.url,
          url: result.url,
          lastError: null,
          isLoading: true,
        },
      },
      inspectingPageId: state.inspectingPageId === pageId ? null : state.inspectingPageId,
    }));

    try {
      if (!get().pages[pageId].hostAttached) {
        if (!hasUsableBounds(hostBounds)) {
          return;
        }
        await browserApi.create(pageId, result.url, viewportBounds);
        set((state) => ({
          pages: state.pages[pageId]
            ? { ...state.pages, [pageId]: { ...state.pages[pageId], hostAttached: true } }
            : state.pages,
        }));
      } else {
        await browserApi.navigate(pageId, result.url);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to navigate browser page', { browserId: pageId, url: result.url }, serializeError(error));
      set((state) => ({
        pages: state.pages[pageId]
          ? {
              ...state.pages,
              [pageId]: { ...state.pages[pageId], lastError: message, isLoading: false },
            }
          : state.pages,
      }));
    }
  },

  back: async (pageId) => {
    const page = get().pages[pageId];
    if (!page?.hostAttached || !page.canGoBack) return;
    try {
      await browserApi.back(pageId);
    } catch (error) {
      logger.warn('Failed to go back', { browserId: pageId }, serializeError(error));
    }
  },

  forward: async (pageId) => {
    const page = get().pages[pageId];
    if (!page?.hostAttached || !page.canGoForward) return;
    try {
      await browserApi.forward(pageId);
    } catch (error) {
      logger.warn('Failed to go forward', { browserId: pageId }, serializeError(error));
    }
  },

  reload: async (pageId) => {
    const page = get().pages[pageId];
    if (!page?.hostAttached) return;
    try {
      await browserApi.reload(pageId);
    } catch (error) {
      logger.warn('Failed to reload browser page', { browserId: pageId }, serializeError(error));
    }
  },

  setPanelBounds: async (panelTabId, bounds) => {
    set((state) => ({
      boundsByPanel: { ...state.boundsByPanel, [panelTabId]: bounds },
    }));
    const activeId = get().activePageIdByPanel[panelTabId];
    const page = activeId ? get().pages[activeId] : undefined;
    if (!page) return;
    if (!page.hostAttached) {
      if (!page.url || !hasUsableBounds(bounds)) return;
      const viewportBounds = viewportBoundsForPanel(
        { ...get().boundsByPanel, [panelTabId]: bounds },
        get().viewportModeByPanel,
        get().previewByPanel,
        panelTabId,
      );
      try {
        await browserApi.create(page.id, page.url, viewportBounds);
        set((state) => ({
          pages: state.pages[page.id]
            ? { ...state.pages, [page.id]: { ...state.pages[page.id], hostAttached: true } }
            : state.pages,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to create browser page after layout', { browserId: page.id }, serializeError(error));
        set((state) => ({
          pages: state.pages[page.id]
            ? { ...state.pages, [page.id]: { ...state.pages[page.id], lastError: message, isLoading: false } }
            : state.pages,
        }));
      }
      return;
    }
    try {
      const viewportBounds = viewportBoundsForPanel(
        get().boundsByPanel,
        get().viewportModeByPanel,
        get().previewByPanel,
        panelTabId,
      );
      await browserApi.setBounds(page.id, viewportBounds);
    } catch (error) {
      logger.warn('Failed to set browser bounds', { browserId: page.id }, serializeError(error));
    }
  },

  setViewportMode: async (panelTabId, mode) => {
    set((state) => ({
      viewportModeByPanel: { ...state.viewportModeByPanel, [panelTabId]: mode },
    }));

    const previewActive = get().previewByPanel[panelTabId] ?? false;
    if (!previewActive) return;

    const storedBounds = get().boundsByPanel[panelTabId];
    const activeId = get().activePageIdByPanel[panelTabId];
    const page = activeId ? get().pages[activeId] : undefined;
    if (!page?.hostAttached || !storedBounds || !hasUsableBounds(storedBounds)) return;

    const viewportBounds = viewportBoundsForPanel(
      get().boundsByPanel,
      get().viewportModeByPanel,
      get().previewByPanel,
      panelTabId,
    );
    try {
      await browserApi.setBounds(page.id, viewportBounds);
    } catch (error) {
      logger.warn('Failed to apply viewport bounds', { browserId: page.id }, serializeError(error));
    }
  },

  setViewportPreview: async (panelTabId, preview) => {
    const previousPreview = get().previewByPanel[panelTabId] ?? false;
    if (previousPreview === preview) return;

    set((state) => ({
      previewByPanel: { ...state.previewByPanel, [panelTabId]: preview },
    }));

    const storedBounds = get().boundsByPanel[panelTabId];
    const activeId = get().activePageIdByPanel[panelTabId];
    const page = activeId ? get().pages[activeId] : undefined;
    if (!page?.hostAttached || !storedBounds || !hasUsableBounds(storedBounds)) return;

    const host = hostBoundsForViewportTransition(storedBounds, previousPreview, preview);
    const mode = get().viewportModeByPanel[panelTabId] ?? 'fit';
    const viewportBounds = browserViewportBounds(host, mode, preview);
    try {
      await browserApi.setBounds(page.id, viewportBounds);
    } catch (error) {
      logger.warn('Failed to apply viewport bounds', { browserId: page.id }, serializeError(error));
    }
  },

  syncVisibility: async (panelTabId, visiblePageId) => {
    const inspectingId = get().inspectingPageId;
    if (inspectingId && inspectingId !== visiblePageId) {
      get().stopInspect();
    }
    const ids = get().pageIdsByPanel[panelTabId] ?? [];
    await Promise.all(ids.map(async (id) => {
      const page = get().pages[id];
      if (!page?.hostAttached) return;
      try {
        if (id === visiblePageId) {
          await browserApi.show(id);
        } else {
          await browserApi.hide(id);
        }
      } catch (error) {
        logger.warn('Failed to sync browser visibility', { browserId: id }, serializeError(error));
      }
    }));
  },

  applyHostPatch: (patch) => {
    set((state) => {
      const page = state.pages[patch.browserId];
      if (!page) return state;
      return {
        pages: {
          ...state.pages,
          [patch.browserId]: {
            ...page,
            url: patch.url ?? page.url,
            addressDraft: patch.url ?? page.addressDraft,
            title: patch.title ?? page.title,
            faviconUrl: patch.faviconUrl === undefined ? page.faviconUrl : patch.faviconUrl,
            isLoading: patch.isLoading ?? page.isLoading,
            canGoBack: patch.canGoBack ?? page.canGoBack,
            canGoForward: patch.canGoForward ?? page.canGoForward,
            lastError: patch.lastError === undefined ? page.lastError : patch.lastError,
          },
        },
        inspectingPageId: patch.isLoading && state.inspectingPageId === patch.browserId
          ? null
          : state.inspectingPageId,
      };
    });
  },

  startInspect: (pageId) => {
    if (!get().pages[pageId]) return;
    set({ inspectingPageId: pageId, inspectError: null });
  },

  stopInspect: () => set({ inspectingPageId: null, inspectError: null }),

  setInspectError: (message) => set({ inspectError: message }),

  destroyPanel: async (panelTabId) => {
    const ids = get().pageIdsByPanel[panelTabId] ?? [];
    await Promise.all(ids.map(async (id) => {
      const page = get().pages[id];
      if (!page?.hostAttached) return;
      try {
        await browserApi.destroy(id);
      } catch (error) {
        logger.warn('Failed to destroy browser page', { browserId: id }, serializeError(error));
      }
    }));
    set((state) => {
      const pages = { ...state.pages };
      for (const id of ids) {
        delete pages[id];
      }
      const pageIdsByPanel = { ...state.pageIdsByPanel };
      const activePageIdByPanel = { ...state.activePageIdByPanel };
      const boundsByPanel = { ...state.boundsByPanel };
      const viewportModeByPanel = { ...state.viewportModeByPanel };
      const previewByPanel = { ...state.previewByPanel };
      delete pageIdsByPanel[panelTabId];
      delete activePageIdByPanel[panelTabId];
      delete boundsByPanel[panelTabId];
      delete viewportModeByPanel[panelTabId];
      delete previewByPanel[panelTabId];
      return {
        pages,
        pageIdsByPanel,
        activePageIdByPanel,
        boundsByPanel,
        viewportModeByPanel,
        previewByPanel,
        inspectingPageId: ids.includes(state.inspectingPageId ?? '') ? null : state.inspectingPageId,
      };
    });
  },

  reset: () => set({
    pages: {},
    pageIdsByPanel: {},
    activePageIdByPanel: {},
    boundsByPanel: {},
    viewportModeByPanel: {},
    previewByPanel: {},
    inspectingPageId: null,
    inspectError: null,
  }),
}));
