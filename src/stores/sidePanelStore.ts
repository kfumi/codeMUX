import { create } from 'zustand';

import { fileApi } from '../lib/tauri';
import { useNavigationStore, type SidePanelNavigationState } from './navigationStore';

export type SidePanelTabKind = 'review' | 'terminal' | 'plan' | 'diff' | 'file' | 'subagent';

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
  filePath?: string;
  fileContent?: string;
  fileOriginalContent?: string;
  fileLoading?: boolean;
  fileError?: string;
  fileSaveState?: 'idle' | 'saving' | 'saved' | 'error';
  /** kind: 'subagent' — which session owns the track and which subagent it shows. */
  subagentId?: string;
  subagentSessionId?: string;
  subagentStatus?: 'running' | 'completed' | 'failed' | 'canceled';
}

interface SidePanelSnapshot {
  isOpen: boolean;
  isExpanded: boolean;
  panelWidth: number;
  tabs: SidePanelTab[];
  activeTabId: string | null;
}

interface SidePanelState {
  activeScopeId: string;
  scopes: Record<string, SidePanelSnapshot>;
  isOpen: boolean;
  isExpanded: boolean;
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
  openSubagentTab: (sessionId: string, subagentId: string, title: string, status?: SidePanelTab['subagentStatus']) => void;
  openFileTab: (projectPath: string | undefined, filePath: string) => Promise<void>;
  updateFileContent: (tabId: string, content: string) => void;
  saveFileTab: (tabId: string) => Promise<void>;
  closePanel: () => void;
  toggleExpanded: () => void;
  setActiveTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeAllTabs: () => void;
  setPanelWidth: (width: number, splitContainerWidth?: number) => void;
  setResizing: (isResizing: boolean) => void;
  setTerminalId: (tabId: string, terminalId: string) => void;
  isTabPresent: (tabId: string) => boolean;
  restoreNavigation: (navigation: SidePanelNavigationState) => void;
  reset: () => void;
}

const PANEL_WIDTH_MIN = 320;
const PANEL_WIDTH_MAX = 820;
const PANEL_WIDTH_DEFAULT = 520;
const MAIN_CONTENT_WIDTH_MIN = 440;
const DEFAULT_SCOPE_ID = 'global';
let terminalTabSequence = 0;

function defaultSnapshot(): SidePanelSnapshot {
  return {
    isOpen: false,
    isExpanded: false,
    panelWidth: PANEL_WIDTH_DEFAULT,
    tabs: [],
    activeTabId: null,
  };
}

function snapshotFromState(state: SidePanelState): SidePanelSnapshot {
  return {
    isOpen: state.isOpen,
    isExpanded: state.isExpanded,
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

function createTerminalTab(scopeId: string, projectPath: string): SidePanelTab {
  terminalTabSequence += 1;
  return {
    ...createTab(scopeId, 'terminal', projectPath),
    id: `${tabId(scopeId, 'terminal', projectPath)}:${terminalTabSequence}`,
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

function createSubagentTab(scopeId: string, subagentId: string, title: string, status?: SidePanelTab['subagentStatus']): SidePanelTab {
  return {
    id: `${scopeId}:subagent:${subagentId}`,
    kind: 'subagent',
    title: title || '子智能体',
    subagentId,
    subagentSessionId: scopeId,
    subagentStatus: status,
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

function createFileTab(scopeId: string, projectPath: string | undefined, filePath: string): SidePanelTab {
  return {
    id: tabId(scopeId, 'file', fileTabKey(projectPath, filePath)),
    kind: 'file',
    title: getFileName(filePath) || '文件',
    projectPath,
    filePath,
    fileLoading: true,
    fileSaveState: 'idle',
  };
}

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

function fileTabKey(projectPath: string | undefined, filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  const normalizedProjectPath = projectPath?.replace(/\\/g, '/').replace(/\/+$/, '');
  const isAbsolute = normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath);
  const resolvedPath = !isAbsolute && normalizedProjectPath
    ? `${normalizedProjectPath}/${normalizedPath.replace(/^\/+/, '')}`
    : normalizedPath;

  return /^[A-Za-z]:\//.test(resolvedPath) ? resolvedPath.toLowerCase() : resolvedPath;
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
  isExpanded: false,
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
    set((state) => {
      const existingTab = state.tabs.find((tab) => tab.kind === 'terminal' && tab.projectPath === projectPath);
      const tab = existingTab ?? createTerminalTab(state.activeScopeId, projectPath);
      return {
        isOpen: true,
        tabs: existingTab ? state.tabs : [...state.tabs, tab],
        activeTabId: tab.id,
      };
    });
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

  openSubagentTab: (sessionId: string, subagentId: string, title: string, status?: SidePanelTab['subagentStatus']) => {
    const scopeId = sessionId || get().activeScopeId;
    const id = `${scopeId}:subagent:${subagentId}`;
    set((state) => {
      if (state.activeScopeId !== scopeId) {
        // Persist the current scope, then switch to the session scope so the
        // tab lands next to that session's other panels.
        const scopes = {
          ...state.scopes,
          [state.activeScopeId]: snapshotFromState(state),
        };
        const next = scopes[scopeId] ?? defaultSnapshot();
        const tabs = next.tabs.some((tab) => tab.id === id)
          ? next.tabs.map((tab) => (tab.id === id ? { ...tab, title, subagentStatus: status } : tab))
          : [...next.tabs, createSubagentTab(scopeId, subagentId, title, status)];
        return {
          ...next,
          tabs,
          scopes,
          activeScopeId: scopeId,
          isOpen: true,
          activeTabId: id,
          isResizing: false,
        };
      }
      return {
        isOpen: true,
        tabs: state.tabs.some((tab) => tab.id === id)
          ? state.tabs.map((tab) => (tab.id === id ? { ...tab, title, subagentStatus: status } : tab))
          : [...state.tabs, createSubagentTab(scopeId, subagentId, title, status)],
        activeTabId: id,
      };
    });
    recordNavigation(get());
  },

  openFileTab: async (projectPath: string | undefined, filePath: string) => {
    const id = tabId(get().activeScopeId, 'file', fileTabKey(projectPath, filePath));
    const existingTab = get().tabs.find((tab) => tab.id === id);

    if (existingTab) {
      set({ isOpen: true, activeTabId: id });
      recordNavigation(get());
      return;
    }

    const tab = createFileTab(get().activeScopeId, projectPath, filePath);
    set((state) => ({
      isOpen: true,
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    recordNavigation(get());

    try {
      const content = await fileApi.readFile(filePath, projectPath);
      set((state) => ({
        tabs: state.tabs.map((entry) => (
          entry.id === id
            ? {
                ...entry,
                fileContent: content,
                fileOriginalContent: content,
                fileLoading: false,
                fileError: undefined,
                fileSaveState: 'idle',
              }
            : entry
        )),
      }));
    } catch (error) {
      set((state) => ({
        tabs: state.tabs.map((entry) => (
          entry.id === id
            ? {
                ...entry,
                fileLoading: false,
                fileError: error instanceof Error ? error.message : String(error),
                fileSaveState: 'error',
              }
            : entry
        )),
      }));
    }
  },

  updateFileContent: (tabId: string, content: string) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (
        tab.id === tabId
          ? { ...tab, fileContent: content, fileSaveState: 'idle', fileError: undefined }
          : tab
      )),
    }));
  },

  saveFileTab: async (tabId: string) => {
    const tab = get().tabs.find((entry) => entry.id === tabId);
    if (
      !tab
      || tab.kind !== 'file'
      || !tab.filePath
      || tab.fileContent === undefined
      || tab.fileContent === tab.fileOriginalContent
    ) {
      return;
    }

    const contentToSave = tab.fileContent;
    set((state) => ({
      tabs: state.tabs.map((entry) => (
        entry.id === tabId ? { ...entry, fileSaveState: 'saving', fileError: undefined } : entry
      )),
    }));

    try {
      await fileApi.writeFile(tab.filePath, contentToSave, tab.projectPath);
      set((state) => ({
        tabs: state.tabs.map((entry) => (
          entry.id === tabId
            ? {
                ...entry,
                fileOriginalContent: contentToSave,
                fileSaveState: entry.fileContent === contentToSave ? 'saved' : 'idle',
              }
            : entry
        )),
      }));
    } catch (error) {
      set((state) => ({
        tabs: state.tabs.map((entry) => (
          entry.id === tabId
            ? {
                ...entry,
                fileSaveState: 'error',
                fileError: error instanceof Error ? error.message : String(error),
              }
            : entry
        )),
      }));
    }
  },

  closePanel: () => {
    set({ isOpen: false, isExpanded: false });
    recordNavigation(get());
  },

  toggleExpanded: () => set((state) => ({ isExpanded: !state.isExpanded })),

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

  closeOtherTabs: (tabId: string) => {
    const state = get();
    if (!state.tabs.some((tab) => tab.id === tabId)) return;

    set({
      tabs: state.tabs.filter((tab) => tab.id === tabId),
      activeTabId: tabId,
      isOpen: true,
    });
    recordNavigation(get());
  },

  closeAllTabs: () => {
    set({
      tabs: [],
      activeTabId: null,
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

  isTabPresent: (tabId: string) => {
    const state = get();
    return state.tabs.some((tab) => tab.id === tabId)
      || Object.entries(state.scopes).some(([scopeId, snapshot]) =>
        scopeId !== state.activeScopeId && snapshot.tabs.some((tab) => tab.id === tabId),
      );
  },

  restoreNavigation: (navigation: SidePanelNavigationState) => {
    set((state) => {
      const nextScopeId = navigation.scopeId || DEFAULT_SCOPE_ID;
      const isSameScope = state.activeScopeId === nextScopeId;
      const scopes = isSameScope
        ? state.scopes
        : {
            ...state.scopes,
            [state.activeScopeId]: snapshotFromState(state),
          };
      const next = isSameScope
        ? snapshotFromState(state)
        : scopes[nextScopeId] ?? defaultSnapshot();
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
    isExpanded: false,
    panelWidth: PANEL_WIDTH_DEFAULT,
    isResizing: false,
    tabs: [],
    activeTabId: null,
  }),
}));
