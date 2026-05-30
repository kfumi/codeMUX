import { create } from 'zustand';
import { fileApi, type FileTreeNode } from '../lib/tauri';

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

  // 文件 Tab
  openFiles: OpenFile[];
  activeFilePath: string | null;
  viewMode: 'diff' | 'file';

  // 文件树
  treeRoot: FileTreeNodeData[] | null;
  treeRootPath: string | null;

  // 项目路径
  projectPath: string | null;

  // Actions
  setProjectPath: (path: string) => void;
  openFile: (path: string, originalContent?: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  togglePanel: () => void;
  toggleFileTree: () => void;
  setPanelWidth: (width: number) => void;
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
function normalizeFilePath(p: string): string {
  // Unix-style drive path: /d/project/... → D:\project\...
  const driveMatch = p.match(/^\/([a-zA-Z])\/(.+)$/);
  if (driveMatch) {
    return `${driveMatch[1].toUpperCase()}:\\${driveMatch[2].replace(/\//g, '\\')}`;
  }
  // Ensure forward slashes work on Windows too
  return p.replace(/\//g, '\\');
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  isOpen: false,
  panelWidth: PANEL_WIDTH_DEFAULT,
  showFileTree: true,

  openFiles: [],
  activeFilePath: null,
  viewMode: 'file',

  treeRoot: null,
  treeRootPath: null,

  projectPath: null,

  setProjectPath: (path: string) => set({ projectPath: path }),

  openFile: async (path: string, originalContent?: string) => {
    const normalizedPath = normalizeFilePath(path);
    const state = get();

    // If file is already open, just switch to it
    const existing = state.openFiles.find((f) => f.path === normalizedPath);
    if (existing) {
      const hasOriginal = originalContent ?? existing.originalContent;
      const currentContent = existing.currentContent;
      const shouldDiff = hasOriginal && currentContent && hasOriginal !== currentContent;
      set({
        activeFilePath: normalizedPath,
        viewMode: shouldDiff ? 'diff' : 'file',
        isOpen: true,
      });
      // Update originalContent if newly provided
      if (originalContent && originalContent !== existing.originalContent) {
        set({
          openFiles: state.openFiles.map((f) =>
            f.path === normalizedPath ? { ...f, originalContent } : f
          ),
        });
      }
      return;
    }

    // Add new file entry with loading state
    const newFile: OpenFile = { path: normalizedPath, originalContent, isLoading: true };
    set({
      openFiles: [...state.openFiles, newFile],
      activeFilePath: normalizedPath,
      isOpen: true,
    });

    // Load file content from disk
    try {
      const content = await fileApi.readFile(normalizedPath, state.projectPath ?? undefined);
      const shouldDiff = originalContent && originalContent !== content;
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === normalizedPath ? { ...f, currentContent: content, isLoading: false } : f
        ),
        viewMode: shouldDiff ? 'diff' : 'file',
      }));
    } catch (error) {
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === normalizedPath
            ? { ...f, isLoading: false, error: String(error) }
            : f
        ),
      }));
    }
  },

  closeFile: (path: string) => {
    const state = get();
    const remaining = state.openFiles.filter((f) => f.path !== path);
    let newActive = state.activeFilePath;

    if (state.activeFilePath === path) {
      if (remaining.length === 0) {
        newActive = null;
      } else {
        const closedIndex = state.openFiles.findIndex((f) => f.path === path);
        const nextIndex = Math.min(closedIndex, remaining.length - 1);
        newActive = remaining[nextIndex].path;
      }
    }

    set({ openFiles: remaining, activeFilePath: newActive });
  },

  setActiveFile: (path: string) => {
    const state = get();
    const file = state.openFiles.find((f) => f.path === path);
    if (!file) return;

    const hasOriginal = !!file.originalContent;
    const isModified = hasOriginal && file.currentContent && file.originalContent !== file.currentContent;

    set({
      activeFilePath: path,
      viewMode: isModified ? 'diff' : 'file',
    });
  },

  togglePanel: () => set((s) => ({ isOpen: !s.isOpen })),

  toggleFileTree: () => set((s) => ({ showFileTree: !s.showFileTree })),

  setPanelWidth: (width: number) => {
    const clamped = Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, width));
    set({ panelWidth: clamped });
  },

  setViewMode: (mode: 'diff' | 'file') => set({ viewMode: mode }),

  loadFileTree: async (rootPath: string) => {
    try {
      const nodes = await fileApi.listDirectory(rootPath, 2, rootPath);
      set({ treeRoot: convertTree(nodes), treeRootPath: rootPath });
    } catch (error) {
      console.error('Failed to load file tree:', error);
      set({ treeRoot: null });
    }
  },

  reset: () =>
    set({
      isOpen: false,
      openFiles: [],
      activeFilePath: null,
      viewMode: 'file',
      treeRoot: null,
      treeRootPath: null,
    }),
}));
