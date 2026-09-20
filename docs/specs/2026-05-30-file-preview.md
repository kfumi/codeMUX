# File Preview & Code Diff Design Spec

**Date:** 2026-05-30
**Status:** Approved
**Scope:** 文件预览面板、可点击文件路径、代码 Diff 对比、项目文件树

---

## Overview

在 CodeMUX 的 Agent 对话面板中，实现点击文件路径打开右侧面板预览文件内容，支持项目文件树浏览和修改前后代码对比（Unified Diff）。

### 用户故事

1. 用户看到 Read/Write/Edit 工具调用时，点击文件路径 → 右侧面板打开并展示文件内容
2. 对于 Edit/Write 修改过的文件，面板自动切换到 Diff 视图展示修改前后对比
3. 用户可以通过右侧面板的文件树浏览项目中的任意文件
4. 用户可以拖拽调整右侧面板宽度，或收起/展开面板

---

## Architecture

### 改动模块总览

| 模块 | 文件 | 改动类型 |
|------|------|----------|
| Store | `src/stores/previewStore.ts` | 重构 |
| Component | `src/components/agent/ToolCallCard.tsx` | 增强 |
| Component | `src/components/preview/PreviewPanel.tsx` | 重构 |
| Component | `src/components/preview/FileView.tsx` | 升级 |
| Component | `src/components/preview/DiffView.tsx` | 升级 |
| Component | `src/components/layout/MainLayout.tsx` | 增强 |
| Component | `src/components/agent/AgentPanel.tsx` | 增强 |
| Component | `src/components/agent/AgentMessageList.tsx` | 增强 |
| Backend | `src-tauri/src/commands/file.rs` | 新增命令 |
| API | `src/lib/tauri.ts` | 新增 API |
| Component | `src/components/preview/FileTree.tsx` | 新建 |

---

## 1. previewStore 重构

### 新增类型

```typescript
interface OpenFile {
  path: string;
  originalContent?: string;  // 修改前内容（Write/Edit 传入，用于 Diff）
  currentContent?: string;   // 当前磁盘内容
  isLoading: boolean;
  error?: string;
}

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
}
```

### State 结构

```typescript
interface PreviewState {
  // 面板状态
  isOpen: boolean;
  panelWidth: number;           // 默认 400，范围 300-800
  showFileTree: boolean;        // 文件树展开/收起

  // 文件 Tab
  openFiles: OpenFile[];
  activeFilePath: string | null;
  viewMode: 'diff' | 'file';

  // 文件树
  treeRoot: FileTreeNode | null;
  treeRootPath: string | null;  // 项目 cwd

  // Actions
  openFile: (path: string, originalContent?: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  togglePanel: () => void;
  toggleFileTree: () => void;
  setPanelWidth: (width: number) => void;
  setViewMode: (mode: 'diff' | 'file') => void;
  loadFileTree: (rootPath: string) => Promise<void>;
}
```

### 关键行为

- `openFile(path, originalContent?)`：若文件已在 `openFiles` 中仅切换 activeFile；否则加入列表并调用 `fileApi.readFile` 加载。传入 `originalContent` 且与 `currentContent` 不同时自动设 `viewMode='diff'`。
- `closeFile(path)`：从 `openFiles` 移除，若关闭的是 activeFile 则切换到相邻 Tab 或清空。
- `setActiveFile(path)`：切换 Tab，若该文件有 `originalContent` 且内容不同，自动切 Diff。
- `loadFileTree(rootPath)`：调用 Rust `list_directory` 命令加载目录树，排除 `.git`、`node_modules`、`target`、`.next`、`dist`。

---

## 2. ToolCallCard 可点击文件路径

### 改动

- `getToolSummary()` 改为 `getToolSummaryData()`，返回结构化数据：

```typescript
interface ToolSummaryPart {
  type: 'text' | 'file-link';
  content: string;
  filePath?: string;
  originalContent?: string;
}
```

- 各工具映射：
  - **Read** → `file-link`，无 originalContent（纯预览）
  - **Write** → `file-link`，无 originalContent（纯预览，无法获取旧内容）
  - **Edit** → `file-link`，携带 `originalContent`（通过 `input.old_string` 构造修改前内容片段，用于 Diff 对比）
  - **Glob / Grep / Bash / 其他** → 全部 `text`

- `ToolCallCard` 新增 `onFileClick?: (path: string, originalContent?: string) => void` prop
- Edit 工具的 `originalContent` 取自 `input.old_string`（修改前的文件片段）

- 渲染时 `file-link` 类型渲染为可点击按钮，点击时调用 `onFileClick` 并阻止事件冒泡（不触发卡片展开/收起）

---

## 3. PreviewPanel 重构

### 布局结构

```
┌──────────────────────────────────────────────────┐
│ [文件树图标]  │  Diff | 文件               [✕]  │ ← 工具栏
├──────┬───────────────────────────────────────────┤
│ 文件 │  src/App.tsx  src/main.tsx         [×][×]│ ← Tab 标签栏
│ 树   ├───────────────────────────────────────────┤
│      │                                           │
│📁src │  1  import { useState } from 'react'      │ ← 内容区
│ 📁co │  2  export function App() {               │
│  App │  3    ...                                 │
│  main│                                           │
│📁lib │                                           │
└──────┴───────────────────────────────────────────┘
```

### 工具栏

- 左侧：文件树展开/收起按钮（`PanelLeft` 图标 from lucide-react）
- 中间：Diff / 文件 切换按钮（保留现有设计）
- 右侧：关闭面板按钮（`X` 图标）

### Tab 标签栏

- 水平滚动，显示文件名（不含路径前缀）
- 修改过的文件 Tab 名旁显示小圆点 `●`（即有 originalContent 且内容不同）
- 活跃 Tab 高亮背景
- 每个 Tab 可单独关闭（`×` 按钮）

### 文件树区域（可折叠）

- 固定宽度 200px，与内容区之间有拖拽手柄（min 150px, max 350px）
- 树状结构：文件夹可展开/收起，文件可点击
- 点击文件 → `openFile(path)` 并激活 Tab
- 排除目录：`.git`、`node_modules`、`target`、`.next`、`dist`、`.venv`、`__pycache__`

### 内容区

- `viewMode === 'file'`：渲染升级后的 `FileView`
- `viewMode === 'diff'`：渲染升级后的 `DiffView`
- 无 `originalContent` 时 Diff 按钮禁用（灰色 + tooltip "此文件未被修改"）

---

## 4. FileView 升级

当前 `FileView` 无语法高亮，颜色硬编码暗色主题。

### 改动

- 使用 `highlight.js` 的 `highlightAuto` 根据文件扩展名自动检测语言并高亮
- 使用 `dangerouslySetInnerHTML` 渲染高亮后的 HTML（与 `MarkdownRenderer` 的 `pre` 组件一致）
- 行号颜色跟随主题：`text-muted-foreground/40`
- hover 行背景：`hover:bg-muted/30`

---

## 5. DiffView 升级

当前 `DiffView` 使用硬编码暗色背景（`bg-[#1e6f50]`、`bg-[#7f1d1d]`）。

### 改动

- 使用 Tailwind 主题变量：`bg-green-500/10`（新增行）、`bg-red-500/10`（删除行）
- 添加行号列（左列为旧文件行号，右列为新文件行号）
- 添加 Diff 统计头：`+N additions, -M deletions`
- 响应 light/dark 主题

---

## 6. MainLayout 改动

- 预览面板左侧添加拖拽手柄，逻辑与现有 Sidebar 拖拽一致
- 拖拽时实时更新 `previewStore.panelWidth`
- 面板收起时宽度动画过渡（`transition-[width]` CSS transition）
- 最小宽度 300px，最大宽度 800px

---

## 7. AgentPanel 改动

在 header 区域（项目路径左侧）添加预览面板切换按钮：

- 图标：`PanelRightOpen`（展开）/ `PanelRightClose`（收起）
- 点击调用 `previewStore.togglePanel()`
- 面板打开时按钮高亮

---

## 8. AgentMessageList 改动

在 `renderEvent` 的 `'assistant'` 分支中，为 `ToolCallCard` 传入 `onFileClick` 回调：

```tsx
<ToolCallCard
  toolName={block.name}
  input={block.input}
  result={...}
  status={...}
  onFileClick={(path, originalContent) => {
    previewStore.openFile(path, originalContent);
  }}
/>
```

---

## 9. Rust 后端新增命令

### `list_directory(path, depth?)`

返回目录结构的树形数据：

```rust
#[derive(Serialize, Clone)]
pub struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<FileNode>>,
}
```

- `depth` 参数默认 2，控制递归深度
- 排除隐藏目录（`.git`、`.next`）和常见大目录（`node_modules`、`target`、`dist`）
- 排序：文件夹在前，文件在后，各自按字母排序

### `read_file` 兼容性

保持现有接口不变（使用 `std::env::current_dir()` 作为 base）。前端传入的 path 需要是相对于项目 cwd 的路径或绝对路径。

---

## 10. lib/tauri.ts 新增 API

```typescript
export const fileApi = {
  readFile: (path: string): Promise<string> => invoke('read_file', { path }),
  listDirectory: (path: string, depth?: number): Promise<FileTreeNode[]> =>
    invoke('list_directory', { path, depth }),
};
```

---

## Data Flow

### 点击文件路径 → 打开预览

```
用户点击 Read 工具的文件路径
  → ToolCallCard.onFileClick(path)
  → previewStore.openFile(path)
  → fileApi.readFile(path)
  → 添加到 openFiles，设置 activeFile
  → isOpen = true
  → PreviewPanel 渲染 FileView
```

### 点击 Edit 工具路径 → Diff 对比

```
用户点击 Edit 工具的文件路径
  → ToolCallCard.onFileClick(path, oldString)
  → previewStore.openFile(path, oldString)
  → fileApi.readFile(path) 获取 currentContent（磁盘已修改后的内容）
  → oldString !== currentContent → 自动切 Diff 模式
  → DiffView 展示 oldString 片段 vs currentContent 的对比
```

注意：Edit 工具的 `input.old_string` 仅是被替换的文件片段，不是完整文件。
DiffView 需支持"片段 vs 完整文件"的对比模式，或者读取同一会话中该文件
的上一次 Read 结果作为完整 originalContent（优先方案：直接用 old_string 作为
原始内容片段进行局部 Diff）。

### 打开面板 → 浏览文件树

```
用户点击 AgentPanel 的面板切换按钮
  → previewStore.togglePanel()
  → isOpen = true, showFileTree = true
  → previewStore.loadFileTree(cwd)
  → fileApi.listDirectory(cwd)
  → 渲染 FileTree 组件
  → 用户点击文件树中的文件 → openFile(path)
```

---

## Non-Goals

- 不引入 Monaco Editor（过重）
- 不实现实时文件监听（Tauri watcher）— 仅在点击时读取
- 不实现文件编辑功能（仅预览）
- 不实现文件搜索/过滤（文件树仅展示结构）

---

## Dependencies

- `highlight.js`（已有）— FileView 语法高亮
- `diff`（已有）— DiffView 计算
- `lucide-react`（已有）— 图标

无需新增第三方依赖。
