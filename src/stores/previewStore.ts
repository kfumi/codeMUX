import { create } from 'zustand';
import { fileApi, type FileTreeNode } from '../lib/tauri';
import { createLogger, serializeError } from '../lib/logger';

const logger = createLogger('previewStore');

export interface OpenFile {
  path: string;
  originalContent?: string;  // 修改前内容（Write/Edit 传入）
  currentContent?: string;   // 当前磁盘内容
  isLoading: boolean;
  error?: string;
}

export interface FileTreeNodeData {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNodeData[];
}

interface PreviewState {
  // 面板状态
  isOpen: boolean;
  panelWidth: number;
  showFileTree: boolean;
  fileTreeWidth: number;

  // Diff Tab（通过改动列表打开的文件）
  diffFiles: OpenFile[];
  activeDiffPath: string | null;

  // 文件 Tab（通过文件树或其他方式打开的文件）
  openFiles: OpenFile[];
  activeFilePath: string | null;

  viewMode: 'diff' | 'file';

  // 拖拽调整大小状态
  isResizing: boolean;

  // 文件树
  treeRoot: FileTreeNodeData[] | null;
  treeRootPath: string | null;
  fileTreeLoading: boolean;

  // 项目路径
  projectPath: string | null;

  // Actions
  setProjectPath: (path: string | null) => void;
  openFile: (path: string, originalContent?: string) => Promise<void>;
  closeFile: (path: string) => void;
  closeOtherFiles: (path: string) => void;
  closeAllFiles: () => void;
  setActiveFile: (path: string) => void;
  togglePanel: () => void;
  toggleFileTree: () => void;
  setPanelWidth: (width: number, sidebarWidth?: number) => void;
  setFileTreeWidth: (width: number) => void;
  setResizing: (resizing: boolean) => void;
  setViewMode: (mode: 'diff' | 'file') => void;
  loadFileTree: (rootPath: string) => Promise<void>;
  reset: () => void;
}

const PANEL_WIDTH_MIN = 300;
const PANEL_WIDTH_MAX = 800;
const PANEL_WIDTH_DEFAULT = 400;

function convertTree(nodes: FileTreeNode[]): FileTreeNodeData[] {
  return nodes.map((n) => ({
    name: n.name,
    path: n.path,
    isDir: n.is_dir,
    children: n.children ? convertTree(n.children) : undefined,
  }));
}

/** Normalize file paths from various formats to OS-native paths */
export function normalizeFilePath(p: string): string {
  // Strip Windows extended-length prefix: //?/ or \\?\
  let path = p.replace(/^\/\/\?\//, '').replace(/^\\\\\?\\/, '');
  // Unix-style drive path: /d/project/... → D:\project\...
  const driveMatch = path.match(/^\/([a-zA-Z])\/(.+)$/);
  if (driveMatch) {
    return `${driveMatch[1].toUpperCase()}:\\${driveMatch[2].replace(/\//g, '\\')}`;
  }
  // Ensure forward slashes work on Windows too
  return path.replace(/\//g, '\\');
}

const FILE_TREE_WIDTH_MIN = 150;
const FILE_TREE_WIDTH_MAX = 350;
const FILE_TREE_WIDTH_DEFAULT = 200;

export const usePreviewStore = create<PreviewState>((set, get) => ({
  isOpen: false,
  panelWidth: PANEL_WIDTH_DEFAULT,
  showFileTree: true,
  fileTreeWidth: FILE_TREE_WIDTH_DEFAULT,
  isResizing: false,

  diffFiles: [],
  activeDiffPath: null,
  openFiles: [],
  activeFilePath: null,
  viewMode: 'file',

  treeRoot: null,
  treeRootPath: null,
  fileTreeLoading: false,

  projectPath: null,

  setProjectPath: (path: string | null) => set({ projectPath: path }),

  openFile: async (path: string, originalContent?: string) => {
    const normalizedPath = normalizeFilePath(path);
    const state = get();
    const isDiffMode = originalContent !== undefined;

    // Check if file is already open in the appropriate list
    const existingList = isDiffMode ? state.diffFiles : state.openFiles;
    const existing = existingList.find((f) => normalizeFilePath(f.path) === normalizedPath);

    if (existing) {
      // File already open, just switch to it
      if (isDiffMode) {
        set({
          activeDiffPath: normalizedPath,
          viewMode: 'diff',
          isOpen: true,
        });
        // Update originalContent if newly provided
        if (originalContent && originalContent !== existing.originalContent) {
          set({
            diffFiles: state.diffFiles.map((f) =>
              normalizeFilePath(f.path) === normalizedPath ? { ...f, originalContent } : f
            ),
          });
        }
      } else {
        set({
          activeFilePath: normalizedPath,
          viewMode: 'file',
          isOpen: true,
        });
      }
      return;
    }

    // Add new file entry with loading state
    const newFile: OpenFile = { path: normalizedPath, originalContent, isLoading: true };

    if (isDiffMode) {
      set({
        diffFiles: [...state.diffFiles, newFile],
        activeDiffPath: normalizedPath,
        viewMode: 'diff',
        isOpen: true,
      });
    } else {
      set({
        openFiles: [...state.openFiles, newFile],
        activeFilePath: normalizedPath,
        viewMode: 'file',
        isOpen: true,
      });
    }

    // Load file content from disk
    try {
      const content = await fileApi.readFile(normalizedPath, state.projectPath ?? undefined);
      if (isDiffMode) {
        set((s) => ({
          diffFiles: s.diffFiles.map((f) =>
            normalizeFilePath(f.path) === normalizedPath ? { ...f, currentContent: content, isLoading: false } : f
          ),
        }));
      } else {
        set((s) => ({
          openFiles: s.openFiles.map((f) =>
            normalizeFilePath(f.path) === normalizedPath ? { ...f, currentContent: content, isLoading: false } : f
          ),
        }));
      }
    } catch (error) {
      if (isDiffMode) {
        set((s) => ({
          diffFiles: s.diffFiles.map((f) =>
            normalizeFilePath(f.path) === normalizedPath
              ? { ...f, isLoading: false, error: String(error) }
              : f
          ),
        }));
      } else {
        set((s) => ({
          openFiles: s.openFiles.map((f) =>
            normalizeFilePath(f.path) === normalizedPath
              ? { ...f, isLoading: false, error: String(error) }
              : f
          ),
        }));
      }
    }
  },

  closeFile: (path: string) => {
    const normalizedPath = normalizeFilePath(path);
    const state = get();

    // Check if it's a diff file
    const isDiffFile = state.diffFiles.some((f) => normalizeFilePath(f.path) === normalizedPath);

    if (isDiffFile) {
      const remaining = state.diffFiles.filter((f) => normalizeFilePath(f.path) !== normalizedPath);
      let newActive = state.activeDiffPath;

      if (state.activeDiffPath && normalizeFilePath(state.activeDiffPath) === normalizedPath) {
        if (remaining.length === 0) {
          newActive = null;
        } else {
          const closedIndex = state.diffFiles.findIndex((f) => normalizeFilePath(f.path) === normalizedPath);
          const nextIndex = Math.min(closedIndex, remaining.length - 1);
          newActive = remaining[nextIndex].path;
        }
      }

      set({ diffFiles: remaining, activeDiffPath: newActive });
    } else {
      const remaining = state.openFiles.filter((f) => normalizeFilePath(f.path) !== normalizedPath);
      let newActive = state.activeFilePath;

      if (state.activeFilePath && normalizeFilePath(state.activeFilePath) === normalizedPath) {
        if (remaining.length === 0) {
          newActive = null;
        } else {
          const closedIndex = state.openFiles.findIndex((f) => normalizeFilePath(f.path) === normalizedPath);
          const nextIndex = Math.min(closedIndex, remaining.length - 1);
          newActive = remaining[nextIndex].path;
        }
      }

      set({ openFiles: remaining, activeFilePath: newActive });
    }
  },

  closeOtherFiles: (path: string) => {
    const normalizedPath = normalizeFilePath(path);
    const state = get();

    // Check if it's a diff file
    const isDiffFile = state.diffFiles.some((f) => normalizeFilePath(f.path) === normalizedPath);

    if (isDiffFile) {
      const kept = state.diffFiles.filter((f) => normalizeFilePath(f.path) === normalizedPath);
      set({ diffFiles: kept, activeDiffPath: kept.length > 0 ? kept[0].path : null });
    } else {
      const kept = state.openFiles.filter((f) => normalizeFilePath(f.path) === normalizedPath);
      set({ openFiles: kept, activeFilePath: kept.length > 0 ? kept[0].path : null });
    }
  },

  closeAllFiles: () => {
    set({ diffFiles: [], activeDiffPath: null, openFiles: [], activeFilePath: null });
  },

  setActiveFile: (path: string) => {
    const normalizedPath = normalizeFilePath(path);
    const state = get();

    // Check if it's a diff file
    const diffFile = state.diffFiles.find((f) => normalizeFilePath(f.path) === normalizedPath);
    if (diffFile) {
      set({
        activeDiffPath: diffFile.path,
        viewMode: 'diff',
      });
      return;
    }

    const file = state.openFiles.find((f) => normalizeFilePath(f.path) === normalizedPath);
    if (!file) return;

    set({
      activeFilePath: file.path,
      viewMode: 'file',
    });
  },

  togglePanel: () => set((s) => ({ isOpen: !s.isOpen })),

  toggleFileTree: () => set((s) => ({ showFileTree: !s.showFileTree })),

  setPanelWidth: (width: number, sidebarWidth = 0) => {
    const availableWidth = window.innerWidth - sidebarWidth;
    const dynamicMax = Math.min(PANEL_WIDTH_MAX, Math.floor(availableWidth / 2));
    const clamped = Math.min(dynamicMax, Math.max(PANEL_WIDTH_MIN, width));
    set({ panelWidth: clamped });
  },

  setFileTreeWidth: (width: number) => {
    const clamped = Math.min(FILE_TREE_WIDTH_MAX, Math.max(FILE_TREE_WIDTH_MIN, width));
    set({ fileTreeWidth: clamped });
  },

  setResizing: (resizing: boolean) => set({ isResizing: resizing }),

  setViewMode: (mode: 'diff' | 'file') => set({ viewMode: mode }),

  loadFileTree: async (rootPath: string) => {
    set({ fileTreeLoading: true });
    try {
      const nodes = await fileApi.listDirectory(rootPath, 3, rootPath);
      set({ treeRoot: convertTree(nodes), treeRootPath: rootPath, fileTreeLoading: false });
    } catch (error) {
      logger.error('Failed to load file tree', { rootPath }, serializeError(error));
      set({ treeRoot: null, fileTreeLoading: false });
    }
  },

  reset: () =>
    set({
      isOpen: false,
      diffFiles: [],
      activeDiffPath: null,
      openFiles: [],
      activeFilePath: null,
      viewMode: 'file',
      treeRoot: null,
      treeRootPath: null,
      fileTreeLoading: false,
    }),
}));
