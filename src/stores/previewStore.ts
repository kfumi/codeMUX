import { create } from 'zustand';
import { fileApi } from '../lib/tauri';

export interface FileEntry {
  path: string;
  additions?: number;
  deletions?: number;
}

interface PreviewState {
  isOpen: boolean;
  files: FileEntry[];
  activeFile: string | null;
  fileContent: string | null;
  viewMode: 'diff' | 'file';
  setOpen: (open: boolean) => void;
  setFiles: (files: FileEntry[]) => void;
  selectFile: (path: string) => Promise<void>;
  setViewMode: (mode: 'diff' | 'file') => void;
  togglePanel: () => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  isOpen: false,
  files: [],
  activeFile: null,
  fileContent: null,
  viewMode: 'diff',

  setOpen: (open: boolean) => set({ isOpen: open }),

  setFiles: (files: FileEntry[]) => set({ files }),

  selectFile: async (path: string) => {
    set({ activeFile: path, fileContent: null });
    try {
      const content = await fileApi.readFile(path);
      set({ fileContent: content });
    } catch (error) {
      set({ fileContent: `// Error reading file: ${error}` });
    }
  },

  setViewMode: (mode: 'diff' | 'file') => set({ viewMode: mode }),

  togglePanel: () => set((state) => ({ isOpen: !state.isOpen })),
}));
