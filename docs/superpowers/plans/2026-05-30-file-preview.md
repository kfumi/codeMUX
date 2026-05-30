# File Preview & Code Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Agent 对话面板中实现点击文件路径打开右侧面板预览文件内容，支持项目文件树浏览和修改前后代码对比（Unified Diff）。

**Architecture:** 增强现有 `previewStore` + `PreviewPanel` 基础设施，新增文件树组件和 Tab 管理。Rust 后端新增 `list_directory` 命令。ToolCallCard 文件路径变为可点击链接，连接对话流与预览面板。

**Tech Stack:** React 18, Zustand, Tailwind CSS, highlight.js, diff, lucide-react, Tauri v2 (Rust)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/src/commands/file.rs` | Modify | 新增 `list_directory` 命令 |
| `src-tauri/src/lib.rs` | Modify | 注册新命令 |
| `src/lib/tauri.ts` | Modify | 新增 `fileApi.listDirectory` |
| `src/stores/previewStore.ts` | Rewrite | 多文件 Tab、文件树、面板宽度、修改追踪 |
| `src/components/preview/FileView.tsx` | Rewrite | 语法高亮、主题适配 |
| `src/components/preview/DiffView.tsx` | Rewrite | 主题变量、行号、统计头 |
| `src/components/preview/FileTree.tsx` | Create | 文件树组件 |
| `src/components/preview/PreviewPanel.tsx` | Rewrite | 文件树 + Tab + 内容区双栏布局 |
| `src/components/agent/ToolCallCard.tsx` | Modify | 结构化 summary、可点击文件路径 |
| `src/components/agent/AgentMessageList.tsx` | Modify | 传入 `onFileClick` 回调 |
| `src/components/agent/AgentPanel.tsx` | Modify | 添加预览面板切换按钮 |
| `src/components/layout/MainLayout.tsx` | Modify | 预览面板可拖拽宽度 |

---

### Task 1: Rust — 新增 `list_directory` 命令

**Files:**
- Modify: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 `file.rs` 中添加 `FileNode` 结构体和 `list_directory` 命令**

在 `src-tauri/src/commands/file.rs` 末尾追加：

```rust
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

/// List directory contents as a tree structure.
/// Excludes common large/hidden directories. Default depth = 2.
#[tauri::command]
pub fn list_directory(path: String, depth: Option<u32>) -> Result<Vec<FileNode>, String> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let max_depth = depth.unwrap_or(2);
    list_dir_recursive(&dir, max_depth)
}

fn list_dir_recursive(dir: &std::path::Path, remaining_depth: u32) -> Result<Vec<FileNode>, String> {
    let excluded = [
        ".git", "node_modules", "target", ".next", "dist",
        ".venv", "__pycache__", ".turbo", ".cache", "build",
    ];

    let mut entries: Vec<FileNode> = Vec::new();
    let read_dir = std::fs::read_dir(dir).map_err(|e| format!("Failed to read dir: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        if excluded.contains(&file_name.as_str()) {
            continue;
        }
        // Skip hidden files/dirs (starting with .)
        if file_name.starts_with('.') && file_name != ".env" {
            continue;
        }

        let path = entry.path();
        let is_dir = path.is_dir();
        let path_str = path.to_string_lossy().to_string();

        let children = if is_dir && remaining_depth > 0 {
            Some(list_dir_recursive(&path, remaining_depth - 1)?)
        } else {
            None
        };

        entries.push(FileNode {
            name: file_name,
            path: path_str,
            is_dir,
            children,
        });
    }

    // Sort: directories first, then files, each alphabetically
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}
```

- [ ] **Step 2: 在 `lib.rs` 中注册新命令**

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中，`commands::file::open_in_explorer` 后面添加：

```rust
commands::file::list_directory,
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo build`
Expected: 编译成功，无错误

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/file.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add list_directory command for file tree"
```

---

### Task 2: 前端 API — 新增 `listDirectory`

**Files:**
- Modify: `src/lib/tauri.ts:67-69`

- [ ] **Step 1: 扩展 `fileApi`**

将 `src/lib/tauri.ts` 中的 `fileApi` 对象替换为：

```typescript
export const fileApi = {
  readFile: (path: string): Promise<string> => invoke('read_file', { path }),
  listDirectory: (path: string, depth?: number): Promise<FileTreeNode[]> =>
    invoke('list_directory', { path, depth }),
};
```

在文件顶部的 import 区域之后，添加类型定义：

```typescript
export interface FileTreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileTreeNode[];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(api): add listDirectory to fileApi"
```

---

### Task 3: previewStore 重构

**Files:**
- Rewrite: `src/stores/previewStore.ts`

- [ ] **Step 1: 重写 previewStore**

将 `src/stores/previewStore.ts` 整体替换为：

```typescript
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

  // Actions
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

export const usePreviewStore = create<PreviewState>((set, get) => ({
  isOpen: false,
  panelWidth: PANEL_WIDTH_DEFAULT,
  showFileTree: true,

  openFiles: [],
  activeFilePath: null,
  viewMode: 'file',

  treeRoot: null,
  treeRootPath: null,

  openFile: async (path: string, originalContent?: string) => {
    const state = get();

    // If file is already open, just switch to it
    const existing = state.openFiles.find((f) => f.path === path);
    if (existing) {
      const hasOriginal = originalContent ?? existing.originalContent;
      const currentContent = existing.currentContent;
      const shouldDiff = hasOriginal && currentContent && hasOriginal !== currentContent;
      set({
        activeFilePath: path,
        viewMode: shouldDiff ? 'diff' : 'file',
        isOpen: true,
      });
      // Update originalContent if newly provided
      if (originalContent && originalContent !== existing.originalContent) {
        set({
          openFiles: state.openFiles.map((f) =>
            f.path === path ? { ...f, originalContent } : f
          ),
        });
      }
      return;
    }

    // Add new file entry with loading state
    const newFile: OpenFile = { path, originalContent, isLoading: true };
    set({
      openFiles: [...state.openFiles, newFile],
      activeFilePath: path,
      isOpen: true,
    });

    // Load file content from disk
    try {
      const content = await fileApi.readFile(path);
      const shouldDiff = originalContent && originalContent !== content;
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path ? { ...f, currentContent: content, isLoading: false } : f
        ),
        viewMode: shouldDiff ? 'diff' : 'file',
      }));
    } catch (error) {
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path
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
      const nodes = await fileApi.listDirectory(rootPath, 2);
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
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `cd d:\project\ai-code\codeMUX && npx tsc --noEmit`
Expected: 无类型错误（可能有其他文件的警告，但 previewStore 相关无错）

- [ ] **Step 3: Commit**

```bash
git add src/stores/previewStore.ts
git commit -m "feat(store): refactor previewStore with multi-tab, file tree, and diff tracking"
```

---

### Task 4: FileView 升级 — 语法高亮

**Files:**
- Rewrite: `src/components/preview/FileView.tsx`

- [ ] **Step 1: 重写 FileView**

将 `src/components/preview/FileView.tsx` 整体替换为：

```typescript
import { useMemo } from 'react';
import hljs from 'highlight.js';

interface FileViewProps {
  content: string;
  filePath?: string;
}

function getLangFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const ext = filePath.split('.').pop()?.toLowerCase();
  const extMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    rs: 'rust', py: 'python', go: 'go', rb: 'ruby', java: 'java',
    css: 'css', scss: 'scss', html: 'html', json: 'json', yaml: 'yaml',
    yml: 'yaml', md: 'markdown', sh: 'bash', sql: 'sql', toml: 'toml',
    xml: 'xml', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  };
  return ext ? extMap[ext] : undefined;
}

export function FileView({ content, filePath }: FileViewProps) {
  const highlighted = useMemo(() => {
    const lang = getLangFromPath(filePath);
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(content, { language: lang }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch {
      return content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  }, [content, filePath]);

  const lines = useMemo(() => highlighted.split('\n'), [highlighted]);

  return (
    <div className="font-mono text-sm leading-relaxed">
      {lines.map((line, index) => (
        <div key={index} className="px-4 hover:bg-muted/30 transition-colors">
          <span className="text-muted-foreground/40 select-none mr-4 inline-block w-8 text-right">
            {index + 1}
          </span>
          <span dangerouslySetInnerHTML={{ __html: line || ' ' }} />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/preview/FileView.tsx
git commit -m "feat(preview): upgrade FileView with highlight.js syntax highlighting"
```

---

### Task 5: DiffView 升级 — 主题变量、行号、统计

**Files:**
- Rewrite: `src/components/preview/DiffView.tsx`

- [ ] **Step 1: 重写 DiffView**

将 `src/components/preview/DiffView.tsx` 整体替换为：

```typescript
import { useMemo } from 'react';
import { diffLines, Change } from 'diff';

interface DiffViewProps {
  oldContent: string;
  newContent: string;
}

export function DiffView({ oldContent, newContent }: DiffViewProps) {
  const changes: Change[] = useMemo(() => diffLines(oldContent, newContent), [oldContent, newContent]);

  const stats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const change of changes) {
      const lines = change.value.split('\n').filter((l, i, arr) =>
        i < arr.length - 1 || arr[arr.length - 1] !== ''
      );
      if (change.added) additions += lines.length;
      if (change.removed) deletions += lines.length;
    }
    return { additions, deletions };
  }, [changes]);

  // Build lines with line numbers
  const diffLines = useMemo(() => {
    const result: Array<{
      type: 'added' | 'removed' | 'unchanged';
      content: string;
      oldLineNum: number | null;
      newLineNum: number | null;
    }> = [];

    let oldLine = 1;
    let newLine = 1;

    for (const change of changes) {
      const lines = change.value.split('\n').filter((l, i, arr) =>
        i < arr.length - 1 || arr[arr.length - 1] !== ''
      );
      for (const line of lines) {
        if (change.added) {
          result.push({ type: 'added', content: line, oldLineNum: null, newLineNum: newLine++ });
        } else if (change.removed) {
          result.push({ type: 'removed', content: line, oldLineNum: oldLine++, newLineNum: null });
        } else {
          result.push({ type: 'unchanged', content: line, oldLineNum: oldLine++, newLineNum: newLine++ });
        }
      }
    }

    return result;
  }, [changes]);

  return (
    <div className="font-mono text-sm">
      {/* Stats header */}
      <div className="px-4 py-2 border-b border-border/30 text-xs text-muted-foreground/60 flex gap-3">
        <span className="text-green-500">+{stats.additions}</span>
        <span className="text-red-500">-{stats.deletions}</span>
      </div>

      {/* Diff lines */}
      <div className="leading-relaxed">
        {diffLines.map((line, index) => {
          const bgClass =
            line.type === 'added'
              ? 'bg-green-500/10'
              : line.type === 'removed'
                ? 'bg-red-500/10'
                : '';

          const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';

          return (
            <div key={index} className={`px-4 ${bgClass}`}>
              <span className="text-muted-foreground/40 select-none inline-block w-10 text-right mr-1">
                {line.oldLineNum ?? ''}
              </span>
              <span className="text-muted-foreground/40 select-none inline-block w-10 text-right mr-2">
                {line.newLineNum ?? ''}
              </span>
              <span className="text-muted-foreground/50 select-none mr-1">{prefix}</span>
              <span>{line.content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/preview/DiffView.tsx
git commit -m "feat(preview): upgrade DiffView with theme-aware colors, line numbers, and stats"
```

---

### Task 6: FileTree 组件

**Files:**
- Create: `src/components/preview/FileTree.tsx`

- [ ] **Step 1: 创建 FileTree 组件**

```typescript
import { useState, useCallback, useEffect } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileCode } from 'lucide-react';
import { usePreviewStore, type FileTreeNodeData } from '../../stores/previewStore';
import { cn } from '../../lib/utils';

interface FileTreeProps {
  nodes: FileTreeNodeData[];
  onFileClick: (path: string) => void;
  level?: number;
}

function TreeNode({ node, onFileClick, level = 0 }: { node: FileTreeNodeData; onFileClick: (path: string) => void; level: number }) {
  const [expanded, setExpanded] = useState(level < 1);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      setExpanded((prev) => !prev);
    } else {
      onFileClick(node.path);
    }
  }, [node, onFileClick]);

  return (
    <div>
      <button
        className={cn(
          'flex items-center gap-1.5 w-full px-2 py-0.5 text-xs hover:bg-muted/40 transition-colors text-left',
          'text-foreground/70 hover:text-foreground'
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={handleClick}
      >
        {node.isDir ? (
          <>
            {expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            )}
            {expanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-yellow-500/70" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-yellow-500/70" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {node.isDir && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} onFileClick={onFileClick} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree() {
  const treeRoot = usePreviewStore((s) => s.treeRoot);
  const openFile = usePreviewStore((s) => s.openFile);

  const handleFileClick = useCallback(
    (path: string) => {
      openFile(path);
    },
    [openFile]
  );

  if (!treeRoot || treeRoot.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/40 text-xs p-4 text-center">
        暂无文件<br />请先选择项目
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto py-1">
      {treeRoot.map((node) => (
        <TreeNode key={node.path} node={node} onFileClick={handleFileClick} level={0} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/preview/FileTree.tsx
git commit -m "feat(preview): add FileTree component"
```

---

### Task 7: PreviewPanel 重构 — 双栏布局

**Files:**
- Rewrite: `src/components/preview/PreviewPanel.tsx`

- [ ] **Step 1: 重写 PreviewPanel**

将 `src/components/preview/PreviewPanel.tsx` 整体替换为：

```typescript
import { useCallback, useRef } from 'react';
import { usePreviewStore } from '../../stores/previewStore';
import { DiffView } from './DiffView';
import { FileView } from './FileView';
import { FileTree } from './FileTree';
import { X, FileCode, GitCompare, PanelLeft, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export function PreviewPanel() {
  const {
    isOpen, panelWidth, showFileTree, openFiles, activeFilePath, viewMode,
    setOpen, setActiveFile, setViewMode, closeFile, toggleFileTree, setPanelWidth,
  } = usePreviewStore();

  const activeFile = openFiles.find((f) => f.path === activeFilePath);
  const hasOriginal = !!activeFile?.originalContent;
  const isModified = hasOriginal && activeFile?.currentContent && activeFile.originalContent !== activeFile.currentContent;

  if (!isOpen) return null;

  return (
    <div
      className="border-l border-border/50 bg-muted/20 flex flex-col h-full shrink-0"
      style={{ width: panelWidth }}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
        <div className="flex items-center gap-1">
          <button
            onClick={toggleFileTree}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              showFileTree ? 'bg-muted text-foreground' : 'text-muted-foreground/50 hover:text-muted-foreground/70'
            )}
            title="文件树"
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex gap-0.5">
          <button
            onClick={() => setViewMode('diff')}
            disabled={!hasOriginal}
            className={cn(
              'px-2.5 py-1 text-xs rounded-md transition-colors',
              viewMode === 'diff'
                ? 'bg-background text-foreground/80 shadow-sm'
                : hasOriginal
                  ? 'text-muted-foreground/50 hover:text-muted-foreground/70'
                  : 'text-muted-foreground/20 cursor-not-allowed'
            )}
            title={!hasOriginal ? '此文件未被修改' : undefined}
          >
            <GitCompare className="h-3 w-3 inline mr-1" />
            Diff
          </button>
          <button
            onClick={() => setViewMode('file')}
            className={cn(
              'px-2.5 py-1 text-xs rounded-md transition-colors',
              viewMode === 'file'
                ? 'bg-background text-foreground/80 shadow-sm'
                : 'text-muted-foreground/50 hover:text-muted-foreground/70'
            )}
          >
            <FileCode className="h-3 w-3 inline mr-1" />
            文件
          </button>
        </div>

        <button
          onClick={() => setOpen(false)}
          className="text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Main content: optional file tree + tab/content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        {showFileTree && (
          <div className="w-[200px] border-r border-border/30 overflow-hidden shrink-0">
            <FileTree />
          </div>
        )}

        {/* Tab + content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tabs */}
          {openFiles.length > 0 && (
            <div className="flex overflow-x-auto border-b border-border/30 shrink-0">
              {openFiles.map((file) => {
                const fileName = file.path.split(/[/\\]/).pop() || file.path;
                const isActive = file.path === activeFilePath;
                const fileIsModified = file.originalContent && file.currentContent && file.originalContent !== file.currentContent;

                return (
                  <div
                    key={file.path}
                    className={cn(
                      'flex items-center gap-1 px-3 py-1.5 text-xs font-mono whitespace-nowrap border-r border-border/20 transition-colors cursor-pointer',
                      isActive
                        ? 'bg-background text-foreground/80'
                        : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30'
                    )}
                    onClick={() => setActiveFile(file.path)}
                  >
                    <span className="truncate max-w-[120px]">{fileName}</span>
                    {fileIsModified && <span className="text-yellow-500 text-[10px]">●</span>}
                    <button
                      className="ml-1 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeFile(file.path);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-auto">
            {activeFile ? (
              activeFile.isLoading ? (
                <div className="flex items-center justify-center h-full text-muted-foreground/50">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  <span className="text-sm">加载中...</span>
                </div>
              ) : activeFile.error ? (
                <div className="flex items-center justify-center h-full text-red-500 text-sm p-4 text-center">
                  {activeFile.error}
                </div>
              ) : activeFile.currentContent ? (
                viewMode === 'diff' && activeFile.originalContent ? (
                  <DiffView oldContent={activeFile.originalContent} newContent={activeFile.currentContent} />
                ) : (
                  <FileView content={activeFile.currentContent} filePath={activeFile.path} />
                )
              ) : null
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground/40 text-sm">
                点击文件路径预览内容
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/preview/PreviewPanel.tsx
git commit -m "feat(preview): refactor PreviewPanel with file tree, tabs, and content area"
```

---

### Task 8: ToolCallCard — 可点击文件路径

**Files:**
- Modify: `src/components/agent/ToolCallCard.tsx`

- [ ] **Step 1: 重写 ToolCallCard**

将 `src/components/agent/ToolCallCard.tsx` 整体替换为：

```typescript
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface ToolCallCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  status?: 'pending' | 'running' | 'done' | 'error';
  onFileClick?: (path: string, originalContent?: string) => void;
}

interface ToolSummaryPart {
  type: 'text' | 'file-link';
  content: string;
  filePath?: string;
  originalContent?: string;
}

/** Normalize double backslashes to single */
function normalizePath(p: string): string {
  return p.replace(/\\\\/g, '\\');
}

function getToolSummaryData(toolName: string, input: Record<string, unknown>): ToolSummaryPart[] {
  switch (toolName) {
    case 'Read': {
      const path = normalizePath(String(input.file_path || ''));
      return [{ type: 'file-link', content: path, filePath: path }];
    }
    case 'Write': {
      const path = normalizePath(String(input.file_path || ''));
      return [{ type: 'file-link', content: path, filePath: path }];
    }
    case 'Edit': {
      const path = normalizePath(String(input.file_path || ''));
      const oldString = typeof input.old_string === 'string' ? input.old_string : undefined;
      return [{ type: 'file-link', content: path, filePath: path, originalContent: oldString }];
    }
    case 'Glob':
      return [{ type: 'text', content: String(input.pattern || '') }];
    case 'Grep': {
      const pattern = String(input.pattern || '');
      const path = input.path ? normalizePath(String(input.path)) : '';
      return [{ type: 'text', content: path ? `${pattern} (in ${path})` : pattern }];
    }
    case 'Bash':
      return [{ type: 'text', content: String(input.description || input.command || '') }];
    case 'WebSearch':
      return [{ type: 'text', content: String(input.query || '') }];
    case 'WebFetch':
      return [{ type: 'text', content: String(input.url || '') }];
    case 'Agent':
    case 'subagent':
      return [{ type: 'text', content: String(input.description || input.prompt || '').slice(0, 100) }];
    default:
      return [{ type: 'text', content: String(input.description || input.prompt || JSON.stringify(input).slice(0, 80)) }];
  }
}

export function ToolCallCard({ toolName, input, result, status, onFileClick }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const summaryParts = getToolSummaryData(toolName, input);

  const dotColor = {
    pending: 'bg-muted-foreground/40',
    running: 'bg-yellow-500 animate-pulse',
    done: 'bg-green-500',
    error: 'bg-red-500',
  };

  return (
    <div className="border rounded-md my-2 bg-muted/20">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {status && <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor[status]}`} />}
        <span className="font-medium">{toolName}</span>
        <span className="text-muted-foreground truncate flex-1 text-left text-xs">
          {summaryParts.map((part, i) =>
            part.type === 'file-link' ? (
              <button
                key={i}
                className="text-primary hover:underline cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onFileClick?.(part.filePath!, part.originalContent);
                }}
              >
                {part.content}
              </button>
            ) : (
              <span key={i}>{part.content}</span>
            )
          )}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t px-3 py-2 space-y-2">
          <div>
            <div className="text-xs text-muted-foreground mb-1">参数</div>
            <pre className="text-xs bg-muted/50 rounded p-2 overflow-auto max-h-40">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {result && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">结果</div>
              <pre className="text-xs bg-muted/50 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/ToolCallCard.tsx
git commit -m "feat(agent): make file paths in ToolCallCard clickable"
```

---

### Task 9: AgentMessageList — 连接 onFileClick

**Files:**
- Modify: `src/components/agent/AgentMessageList.tsx`

- [ ] **Step 1: 导入 previewStore 并传入 onFileClick**

在 `src/components/agent/AgentMessageList.tsx` 顶部的 import 区域添加：

```typescript
import { usePreviewStore } from '../../stores/previewStore';
```

在 `renderEvent` 函数签名中添加 `onFileClick` 参数。将函数签名改为：

```typescript
function renderEvent(
  msg: AgentMessage,
  resultMap: Record<string, ToolResultEntry>,
  provider: Provider | null,
  onFileClick: (path: string, originalContent?: string) => void
) {
```

在 `case 'assistant'` 中的 `ToolCallCard` 渲染处（约第 118-125 行），添加 `onFileClick` prop：

```tsx
<ToolCallCard
  key={i}
  toolName={block.name}
  input={block.input || {}}
  result={entry?.content}
  status={status}
  onFileClick={onFileClick}
/>
```

在 `AgentEventItem` 组件中（约第 15 行），添加 `onFileClick` prop 并传递：

```typescript
function AgentEventItem({ msg, resultMap, provider, onFileClick }: {
  msg: AgentMessage;
  resultMap: Record<string, ToolResultEntry>;
  provider: Provider | null;
  onFileClick: (path: string, originalContent?: string) => void;
}) {
  try {
    return renderEvent(msg, resultMap, provider, onFileClick);
  } catch (err) {
    // ... existing error handling
  }
}
```

在 `AgentMessageList` 组件中，创建 `onFileClick` 回调并传给 `AgentEventItem`：

```typescript
const openFile = usePreviewStore((s) => s.openFile);
const handleFileClick = useCallback(
  (path: string, originalContent?: string) => {
    openFile(path, originalContent);
  },
  [openFile]
);
```

在 events.map 中传入：

```tsx
<AgentEventItem key={i} msg={msg} resultMap={resultMap} provider={provider} onFileClick={handleFileClick} />
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/AgentMessageList.tsx
git commit -m "feat(agent): wire onFileClick from AgentMessageList to ToolCallCard"
```

---

### Task 10: AgentPanel — 预览面板切换按钮

**Files:**
- Modify: `src/components/agent/AgentPanel.tsx`

- [ ] **Step 1: 添加预览面板切换按钮**

在 `src/components/agent/AgentPanel.tsx` 顶部 import 区域添加：

```typescript
import { usePreviewStore } from '../../stores/previewStore';
import { PanelRightOpen, PanelRightClose } from 'lucide-react';
```

在 `AgentPanel` 组件内部（约第 24 行之后），添加 store hook：

```typescript
const { isOpen: previewOpen, togglePanel: togglePreview } = usePreviewStore();
```

在 header 区域的 `{project && (` 之前（约第 91 行），添加切换按钮：

```tsx
<button
  onClick={togglePreview}
  className={cn(
    'p-1.5 rounded-md transition-colors',
    previewOpen
      ? 'bg-muted text-foreground'
      : 'text-muted-foreground hover:text-foreground'
  )}
  title={previewOpen ? '收起预览面板' : '展开预览面板'}
>
  {previewOpen ? (
    <PanelRightClose className="h-4 w-4" />
  ) : (
    <PanelRightOpen className="h-4 w-4" />
  )}
</button>
```

确保 `cn` 已从 `../../lib/utils` 导入。检查文件顶部是否有该导入，若没有则添加：

```typescript
import { cn } from '../../lib/utils';
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/AgentPanel.tsx
git commit -m "feat(agent): add preview panel toggle button to AgentPanel header"
```

---

### Task 11: MainLayout — 预览面板可拖拽宽度

**Files:**
- Modify: `src/components/layout/MainLayout.tsx`

- [ ] **Step 1: 添加预览面板拖拽调整宽度**

将 `src/components/layout/MainLayout.tsx` 整体替换为：

```typescript
import { ReactNode, useCallback, useRef, useState } from 'react';
import { TitleBar } from './TitleBar';
import { usePreviewStore } from '../../stores/previewStore';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 260;

interface MainLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  preview?: ReactNode;
}

export function MainLayout({ sidebar, children, preview }: MainLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const sidebarDragging = useRef(false);

  const { isOpen: previewOpen, panelWidth: previewWidth, setPanelWidth: setPreviewWidth } = usePreviewStore();
  const previewDragging = useRef(false);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragging.current) return;
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX));
      setSidebarWidth(w);
    };

    const onUp = () => {
      sidebarDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const handlePreviewMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    previewDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const startX = e.clientX;
    const startWidth = previewWidth;

    const onMove = (ev: MouseEvent) => {
      if (!previewDragging.current) return;
      const delta = startX - ev.clientX;
      const newWidth = Math.min(800, Math.max(300, startWidth + delta));
      setPreviewWidth(newWidth);
    };

    const onUp = () => {
      previewDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [previewWidth, setPreviewWidth]);

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Title bar — spans full width, window controls on far right */}
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — follows theme */}
        <aside
          className="flex flex-col bg-[hsl(var(--sidebar-bg))] border-r border-[hsl(var(--sidebar-border))] shrink-0 relative sidebar-grain rounded-tr-2xl rounded-br-2xl"
          style={{ width: sidebarWidth }}
        >
          <div className="relative z-10 flex flex-col h-full">
            {sidebar}
          </div>
        </aside>

        {/* Sidebar drag handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize group relative"
          onMouseDown={handleSidebarMouseDown}
        >
          <div className="absolute inset-y-0 -left-0.5 w-2 group-hover:bg-primary/20 transition-colors" />
        </div>

        {/* Main content area */}
        <main className="flex-1 flex overflow-hidden bg-background">
          <div className="flex-1 flex flex-col min-w-0">
            {children}
          </div>
          {preview && previewOpen && (
            <>
              {/* Preview drag handle */}
              <div
                className="w-1 shrink-0 cursor-col-resize group relative"
                onMouseDown={handlePreviewMouseDown}
              >
                <div className="absolute inset-y-0 -left-0.5 w-2 group-hover:bg-primary/20 transition-colors" />
              </div>
              {preview}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/MainLayout.tsx
git commit -m "feat(layout): add resizable preview panel with drag handle"
```

---

### Task 12: 集成 — 连接文件树加载与项目路径

**Files:**
- Modify: `src/components/agent/AgentPanel.tsx`

- [ ] **Step 1: 在 AgentPanel 中加载文件树**

在 `AgentPanel` 组件中，当项目路径可用时自动加载文件树。

在已有的 `useEffect` 附近（约第 48-51 行的 `loadSessionMessages` 之后），添加：

```typescript
const loadFileTree = usePreviewStore((s) => s.loadFileTree);

useEffect(() => {
  if (project?.path) {
    loadFileTree(project.path);
  }
}, [project?.path, loadFileTree]);
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/AgentPanel.tsx
git commit -m "feat(agent): auto-load file tree when project path is available"
```

---

### Task 13: 全局验证与收尾

- [ ] **Step 1: 完整 TypeScript 编译**

Run: `cd d:\project\ai-code\codeMUX && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 2: 开发服务器启动验证**

Run: `cd d:\project\ai-code\codeMUX && npm run dev`
Expected: 应用启动无白屏，控制台无关键错误

- [ ] **Step 3: 功能验证清单**

手动验证以下场景：
1. 对话中出现 Read 工具调用 → 文件路径显示为蓝色可点击链接
2. 点击 Read 文件路径 → 右侧面板打开，显示文件内容（有语法高亮）
3. 对话中出现 Edit 工具调用 → 点击文件路径 → 面板自动切 Diff 模式
4. 面板左侧显示文件树（项目目录结构），点击文件树中的文件 → 新 Tab 打开
5. 多个文件打开时显示 Tab 标签，可切换、可关闭
6. 面板宽度可拖拽调整（300px-800px）
7. 文件树可展开/收起
8. Diff 视图显示行号和统计信息
9. File 视图有语法高亮
10. AgentPanel header 有预览面板切换按钮

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A && git commit -m "fix: file preview integration fixes"
```
