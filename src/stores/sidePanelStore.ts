import { create } from 'zustand';

import { useNavigationStore, type SidePanelNavigationState } from './navigationStore';

export type SidePanelTabKind = 'review' | 'terminal' | 'plan' | 'diff';

export interface SidePanelTab {
  id: string;
  kind: SidePanelTabKind;
  title: string;
  projectPath?: string;
  terminalId?: string;
  planFilePath?: string;
  planContent?: string;
  diffFilePath?: string;
  diffOldContent?: string;
  diffNewContent?: string;
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
  openPlanTab: (planFilePath: string, planContent: string) => void;
  openDiffTab: (filePath: string, oldContent: string, newContent: string) => void;
  closePanel: () => void;
  setActiveTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  setPanelWidth: (width: number, splitContainerWidth?: number) => void;
  setResizing: (isResizing: boolean) => void;
  setTerminalId: (tabId: string, terminalId: string) => void;
  restoreNavigation: (navigation: SidePanelNavigationState) => void;
  reset: () => void;
}

const PANEL_WIDTH_MIN = 320;
const PANEL_WIDTH_MAX = 820;
const PANEL_WIDTH_DEFAULT = 520;
const MAIN_CONTENT_WIDTH_MIN = 440;
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

function tabId(scopeId: string, kind: SidePanelTabKind, targetPath: string) {
  return `${scopeId}:${kind}:${targetPath}`;
}

function createTab(scopeId: string, kind: SidePanelTabKind, projectPath: string): SidePanelTab {
  return {
    id: tabId(scopeId, kind, projectPath),
    kind,
    title: kind === 'review' ? '审查' : kind === 'terminal' ? '终端' : '计划',
    projectPath,
  };
}

function createPlanTab(scopeId: string, planFilePath: string, planContent: string): SidePanelTab {
  return {
    id: tabId(scopeId, 'plan', planFilePath),
    kind: 'plan',
    title: getFileName(planFilePath) || '计划',
    planFilePath,
    planContent,
  };
}

function createDiffTab(scopeId: string, filePath: string, oldContent: string, newContent: string): SidePanelTab {
  return {
    id: tabId(scopeId, 'diff', filePath),
    kind: 'diff',
    title: getFileName(filePath) || filePath,
    diffFilePath: filePath,
    diffOldContent: oldContent,
    diffNewContent: newContent,
  };
}

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

function recordNavigation(state: Pick<SidePanelState, 'activeScopeId' | 'isOpen' | 'activeTabId'>): void {
  if (useNavigationStore.getState().isRestoring) return;

  useNavigationStore.getState().recordSidePanelNavigation({
    scopeId: state.activeScopeId,
    isOpen: state.isOpen,
    activeTabId: state.activeTabId,
  });
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

  openPanel: () => {
    set({ isOpen: true });
    recordNavigation(get());
  },

  openReviewTab: (projectPath: string) => {
    const id = tabId(get().activeScopeId, 'review', projectPath);
    set((state) => ({
      isOpen: true,
      tabs: state.tabs.some((tab) => tab.id === id) ? state.tabs : [...state.tabs, createTab(state.activeScopeId, 'review', projectPath)],
      activeTabId: id,
    }));
    recordNavigation(get());
  },

  openTerminalTab: (projectPath: string) => {
    const id = tabId(get().activeScopeId, 'terminal', projectPath);
    set((state) => ({
      isOpen: true,
      tabs: state.tabs.some((tab) => tab.id === id) ? state.tabs : [...state.tabs, createTab(state.activeScopeId, 'terminal', projectPath)],
      activeTabId: id,
    }));
    recordNavigation(get());
  },

  openPlanTab: (planFilePath: string, planContent: string) => {
    const id = tabId(get().activeScopeId, 'plan', planFilePath);
    set((state) => ({
      isOpen: true,
      tabs: state.tabs.some((tab) => tab.id === id)
        ? state.tabs.map((tab) => (tab.id === id ? { ...tab, planContent } : tab))
        : [...state.tabs, createPlanTab(state.activeScopeId, planFilePath, planContent)],
      activeTabId: id,
    }));
    recordNavigation(get());
  },

  openDiffTab: (filePath: string, oldContent: string, newContent: string) => {
    const id = tabId(get().activeScopeId, 'diff', filePath);
    set((state) => ({
      isOpen: true,
      tabs: state.tabs.some((tab) => tab.id === id)
        ? state.tabs.map((tab) => (tab.id === id ? { ...tab, diffOldContent: oldContent, diffNewContent: newContent } : tab))
        : [...state.tabs, createDiffTab(state.activeScopeId, filePath, oldContent, newContent)],
      activeTabId: id,
    }));
    recordNavigation(get());
  },

  closePanel: () => {
    set({ isOpen: false });
    recordNavigation(get());
  },

  setActiveTab: (tabId: string) => {
    if (get().tabs.some((tab) => tab.id === tabId)) {
      set({ isOpen: true, activeTabId: tabId });
      recordNavigation(get());
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
    recordNavigation(get());
  },

  setPanelWidth: (width: number, splitContainerWidth?: number) => {
    const availableWidth = splitContainerWidth ?? (typeof window === 'undefined' ? PANEL_WIDTH_MAX : window.innerWidth);
    const dynamicMax = Math.max(PANEL_WIDTH_MIN, availableWidth - MAIN_CONTENT_WIDTH_MIN);
    set({ panelWidth: Math.min(dynamicMax, Math.max(PANEL_WIDTH_MIN, width)) });
  },

  setResizing: (isResizing: boolean) => set({ isResizing }),

  setTerminalId: (tabId: string, terminalId: string) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, terminalId } : tab)),
    }));
  },

  restoreNavigation: (navigation: SidePanelNavigationState) => {
    set((state) => {
      const nextScopeId = navigation.scopeId || DEFAULT_SCOPE_ID;
      const scopes = state.activeScopeId === nextScopeId
        ? state.scopes
        : {
            ...state.scopes,
            [state.activeScopeId]: snapshotFromState(state),
          };
      const next = scopes[nextScopeId] ?? defaultSnapshot();
      const activeTabId = navigation.activeTabId && next.tabs.some((tab) => tab.id === navigation.activeTabId)
        ? navigation.activeTabId
        : null;

      return {
        ...next,
        scopes,
        activeScopeId: nextScopeId,
        isOpen: navigation.isOpen,
        activeTabId,
        isResizing: false,
      };
    });
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
