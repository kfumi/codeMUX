import { create } from 'zustand';

export type SidePanelTabKind = 'review' | 'terminal';

export interface SidePanelTab {
  id: string;
  kind: SidePanelTabKind;
  title: string;
  projectPath?: string;
  terminalId?: string;
}

interface SidePanelSnapshot {
  isOpen: boolean;
  panelWidth: number;
  tabs: SidePanelTab[];
  activeTabId: string | null;
}

interface SidePanelState {
  activeScopeId: string;
  scopes: Record<string, SidePanelSnapshot>;
  isOpen: boolean;
  panelWidth: number;
  isResizing: boolean;
  tabs: SidePanelTab[];
  activeTabId: string | null;
  setScope: (scopeId: string) => void;
  openPanel: () => void;
  openReviewTab: (projectPath: string) => void;
  openTerminalTab: (projectPath: string) => void;
  closePanel: () => void;
  setActiveTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  setPanelWidth: (width: number, sidebarWidth?: number) => void;
  setResizing: (isResizing: boolean) => void;
  setTerminalId: (tabId: string, terminalId: string) => void;
  reset: () => void;
}

const PANEL_WIDTH_MIN = 320;
const PANEL_WIDTH_MAX = 820;
const PANEL_WIDTH_DEFAULT = 520;
const DEFAULT_SCOPE_ID = 'global';

function defaultSnapshot(): SidePanelSnapshot {
  return {
    isOpen: false,
    panelWidth: PANEL_WIDTH_DEFAULT,
    tabs: [],
    activeTabId: null,
  };
}

function snapshotFromState(state: SidePanelState): SidePanelSnapshot {
  return {
    isOpen: state.isOpen,
    panelWidth: state.panelWidth,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
  };
}

function tabId(scopeId: string, kind: SidePanelTabKind, projectPath: string) {
  return `${scopeId}:${kind}:${projectPath}`;
}

function createTab(scopeId: string, kind: SidePanelTabKind, projectPath: string): SidePanelTab {
  return {
    id: tabId(scopeId, kind, projectPath),
    kind,
    title: kind === 'review' ? '审查' : '终端',
    projectPath,
  };
}

export const useSidePanelStore = create<SidePanelState>((set, get) => ({
  activeScopeId: DEFAULT_SCOPE_ID,
  scopes: {},
  isOpen: false,
  panelWidth: PANEL_WIDTH_DEFAULT,
  isResizing: false,
  tabs: [],
  activeTabId: null,

  setScope: (scopeId: string) => {
    const nextScopeId = scopeId || DEFAULT_SCOPE_ID;
    set((state) => {
      if (state.activeScopeId === nextScopeId) return state;

      const scopes = {
        ...state.scopes,
        [state.activeScopeId]: snapshotFromState(state),
      };
      const next = scopes[nextScopeId] ?? defaultSnapshot();

      return {
        ...next,
        scopes,
        activeScopeId: nextScopeId,
        isResizing: false,
      };
    });
  },

  openPanel: () => set({ isOpen: true }),

  openReviewTab: (projectPath: string) => {
    const id = tabId(get().activeScopeId, 'review', projectPath);
    set((state) => ({
      isOpen: true,
      tabs: state.tabs.some((tab) => tab.id === id) ? state.tabs : [...state.tabs, createTab(state.activeScopeId, 'review', projectPath)],
      activeTabId: id,
    }));
  },

  openTerminalTab: (projectPath: string) => {
    const id = tabId(get().activeScopeId, 'terminal', projectPath);
    set((state) => ({
      isOpen: true,
      tabs: state.tabs.some((tab) => tab.id === id) ? state.tabs : [...state.tabs, createTab(state.activeScopeId, 'terminal', projectPath)],
      activeTabId: id,
    }));
  },

  closePanel: () => set({ isOpen: false }),

  setActiveTab: (tabId: string) => {
    if (get().tabs.some((tab) => tab.id === tabId)) {
      set({ isOpen: true, activeTabId: tabId });
    }
  },

  closeTab: (tabId: string) => {
    const state = get();
    const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
    if (closedIndex === -1) return;

    const tabs = state.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId =
      state.activeTabId !== tabId
        ? state.activeTabId
        : tabs.length > 0
          ? tabs[Math.min(closedIndex, tabs.length - 1)].id
          : null;

    set({
      tabs,
      activeTabId,
      isOpen: true,
    });
  },

  setPanelWidth: (width: number, sidebarWidth = 0) => {
    const availableWidth = typeof window === 'undefined' ? PANEL_WIDTH_MAX : window.innerWidth - sidebarWidth;
    const dynamicMax = Math.min(PANEL_WIDTH_MAX, Math.floor(availableWidth * 0.62));
    set({ panelWidth: Math.min(dynamicMax, Math.max(PANEL_WIDTH_MIN, width)) });
  },

  setResizing: (isResizing: boolean) => set({ isResizing }),

  setTerminalId: (tabId: string, terminalId: string) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, terminalId } : tab)),
    }));
  },

  reset: () => set({
    activeScopeId: DEFAULT_SCOPE_ID,
    scopes: {},
    isOpen: false,
    panelWidth: PANEL_WIDTH_DEFAULT,
    isResizing: false,
    tabs: [],
    activeTabId: null,
  }),
}));
