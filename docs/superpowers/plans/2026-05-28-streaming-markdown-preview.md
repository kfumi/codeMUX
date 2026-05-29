# 流式输出 + Markdown 渲染 + 代码预览面板 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 codeMUX 实现流式输出、Markdown 渲染和三栏代码预览面板，让 AI 对话支持逐 token 显示、富文本渲染和文件变更预览。

**Architecture:** 后端通过 Tauri v2 Channel API 将 SSE 流式 token 推送到前端；前端用 react-markdown 渲染 AI 消息，代码块使用 highlight.js 高亮；右侧新增可折叠预览面板展示文件内容和 diff。

**Tech Stack:** Tauri v2 Channel, react-markdown, rehype-highlight, rehype-raw, highlight.js, diff, Zustand

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/components/chat/MarkdownRenderer.tsx` | Markdown 渲染组件，包裹 react-markdown + 代码复制按钮 |
| `src/components/preview/PreviewPanel.tsx` | 右侧代码预览面板容器 |
| `src/components/preview/DiffView.tsx` | 内联 Diff 视图组件 |
| `src/components/preview/FileView.tsx` | 完整文件视图组件 |
| `src/stores/previewStore.ts` | 预览面板状态管理 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `package.json` | 新增依赖 |
| `src-tauri/src/commands/chat.rs` | 新增 `send_message_stream` 命令 |
| `src-tauri/src/commands/file.rs` | 新增文件读取命令（新文件） |
| `src-tauri/src/commands/mod.rs` | 导出 file 模块 |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `src/lib/tauri.ts` | 新增 chatApi.sendMessageStream, fileApi |
| `src/stores/chatStore.ts` | 新增 streamingContent，重写 sendMessage |
| `src/components/chat/MessageItem.tsx` | assistant 消息使用 MarkdownRenderer |
| `src/components/chat/MessageList.tsx` | 流式过程中显示 streamingContent |
| `src/components/chat/ChatPanel.tsx` | 传递 preview 回调 |
| `src/components/layout/MainLayout.tsx` | 三栏布局 |
| `src/App.tsx` | 集成 PreviewPanel |

---

## Task 1: 安装依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装前端依赖**

```bash
cd d:/project/ai-code/codeMUX && npm install react-markdown rehype-highlight rehype-raw highlight.js diff && npm install -D @types/diff
```

- [ ] **Step 2: 验证 package.json 已更新**

确认 `package.json` 的 `dependencies` 中包含 `react-markdown`, `rehype-highlight`, `rehype-raw`, `highlight.js`, `diff`。

- [ ] **Step 3: 提交**

```bash
git add package.json package-lock.json
git commit -m "deps: add react-markdown, rehype-highlight, highlight.js, diff"
```

---

## Task 2: 后端 — send_message_stream 命令

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 chat.rs 中添加 send_message_stream 命令**

在 `src-tauri/src/commands/chat.rs` 末尾追加：

```rust
#[tauri::command]
pub async fn send_message_stream(
    state: State<'_, AppState>,
    session_id: String,
    content: String,
    model: Option<String>,
    channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    // 1. Resolve the active provider config
    let provider_config = {
        let config = state.config.lock().unwrap();
        let active_id = config
            .active_provider_id
            .as_deref()
            .ok_or("No active provider configured")?;
        config
            .providers
            .iter()
            .find(|p| p.id == active_id)
            .cloned()
            .ok_or_else(|| format!("Provider '{}' not found", active_id))?
    };

    // 2. Load existing message history
    let history: Vec<ChatMessage> = {
        let db = state.db.lock().unwrap();
        operations::get_messages_by_session(&db, &session_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| ChatMessage {
                role: m.role,
                content: m.content,
            })
            .collect()
    };

    // 3. Save the user message to DB
    {
        let db = state.db.lock().unwrap();
        operations::create_message(&db, &session_id, "user", &content)
            .map_err(|e| e.to_string())?;
    }

    // 4. Build the full message list
    let mut messages = history;
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: content.clone(),
    });

    // 5. Call the provider in streaming mode
    let prov = provider::create_provider(&provider_config);
    let model_str = model.as_deref().unwrap_or(&provider_config.default_model);
    let mut receiver = prov.send_message_stream(messages, model_str).await?;

    // 6. Read tokens from receiver and send through channel
    let mut full_response = String::new();
    while let Some(token) = receiver.recv().await {
        full_response.push_str(&token);
        let _ = channel.send(token);
    }

    // 7. Save the complete assistant response to DB
    {
        let db = state.db.lock().unwrap();
        operations::create_message(&db, &session_id, "assistant", &full_response)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}
```

- [ ] **Step 2: 在 lib.rs 中注册新命令**

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中，`commands::chat::send_message` 后面添加一行：

```rust
            commands::chat::send_message_stream,
```

- [ ] **Step 3: 验证编译**

```bash
cd d:/project/ai-code/codeMUX/src-tauri && cargo check
```

Expected: 编译通过，无新增 error。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/commands/chat.rs src-tauri/src/lib.rs
git commit -m "feat: add send_message_stream Tauri command with Channel"
```

---

## Task 3: 后端 — read_file 命令

**Files:**
- Create: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 创建 file.rs**

创建 `src-tauri/src/commands/file.rs`：

```rust
use std::path::PathBuf;
use tauri::AppHandle;

#[tauri::command]
pub fn read_file(app: AppHandle, path: String) -> Result<String, String> {
    // Resolve relative to the app's current working directory
    let base = std::env::current_dir().map_err(|e| e.to_string())?;
    let full_path = base.join(&path);

    // Security: ensure the resolved path is under the base directory
    let canonical = full_path
        .canonicalize()
        .map_err(|e| format!("File not found: {}", e))?;
    let canonical_base = base
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_base) {
        return Err("Access denied: path outside project directory".to_string());
    }

    std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read file: {}", e))
}
```

- [ ] **Step 2: 在 mod.rs 中导出 file 模块**

编辑 `src-tauri/src/commands/mod.rs`，添加：

```rust
pub mod file;
```

- [ ] **Step 3: 在 lib.rs 中注册命令**

在 `invoke_handler` 中添加：

```rust
            commands::file::read_file,
```

- [ ] **Step 4: 验证编译**

```bash
cd d:/project/ai-code/codeMUX/src-tauri && cargo check
```

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/file.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add read_file Tauri command for code preview"
```

---

## Task 4: 前端 — tauri.ts API 桥更新

**Files:**
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: 更新 tauri.ts**

将 `src/lib/tauri.ts` 替换为：

```typescript
import { invoke } from '@tauri-apps/api/core';
import { Channel } from '@tauri-apps/api/core';
import type { Session } from '../types/session';
import type { ChatMessage } from '../types/chat';
import type { AppConfig, ProviderConfig, Theme } from '../types/provider';

export const sessionApi = {
  create: (title: string): Promise<Session> => invoke('create_session', { title }),
  getAll: (): Promise<Session[]> => invoke('get_all_sessions'),
  delete: (sessionId: string): Promise<void> => invoke('delete_session', { sessionId }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invoke('update_session_title', { sessionId, title }),
  getMessages: (sessionId: string): Promise<ChatMessage[]> => invoke('get_messages', { sessionId }),
};

export const chatApi = {
  sendMessage: (sessionId: string, content: string): Promise<string> => invoke('send_message', { sessionId, content }),
  sendMessageStream: (sessionId: string, content: string, onChunk: (token: string) => void): Promise<void> => {
    const channel = new Channel<string>();
    channel.onmessage = (token: string) => {
      onChunk(token);
    };
    return invoke('send_message_stream', { sessionId, content, channel });
  },
};

export const configApi = {
  get: (): Promise<AppConfig> => invoke('get_config'),
  updateProvider: (provider: ProviderConfig): Promise<void> => invoke('update_provider', { provider }),
  setActiveProvider: (providerId: string): Promise<void> => invoke('set_active_provider', { providerId }),
  setTheme: (theme: Theme): Promise<void> => invoke('set_theme', { theme: theme.toLowerCase() }),
  testConnection: (provider: ProviderConfig): Promise<string> => invoke('test_connection', { provider }),
};

export const fileApi = {
  readFile: (path: string): Promise<string> => invoke('read_file', { path }),
};
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/lib/tauri.ts
git commit -m "feat: add sendMessageStream and fileApi to Tauri bridge"
```

---

## Task 5: 前端 — chatStore 流式支持

**Files:**
- Modify: `src/stores/chatStore.ts`

- [ ] **Step 1: 重写 chatStore.ts**

将 `src/stores/chatStore.ts` 替换为：

```typescript
import { create } from 'zustand';
import type { ChatMessage } from '../types/chat';
import { chatApi, sessionApi } from '../lib/tauri';

interface ChatState {
  messages: Record<string, ChatMessage[]>;
  isLoading: boolean;
  isStreaming: boolean;
  streamingContent: Record<string, string>;
  error: string | null;
  fetchMessages: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, content: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: {},
  isLoading: false,
  isStreaming: false,
  streamingContent: {},
  error: null,

  fetchMessages: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      const messages = await sessionApi.getMessages(sessionId);
      set((state) => ({
        messages: { ...state.messages, [sessionId]: messages },
        isLoading: false,
      }));
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  sendMessage: async (sessionId: string, content: string) => {
    set({ isStreaming: true, error: null, streamingContent: { ...get().streamingContent, [sessionId]: '' } });

    const tempUserMessage: ChatMessage = {
      id: `temp-${Date.now()}`,
      session_id: sessionId,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] || []), tempUserMessage],
      },
    }));

    try {
      await chatApi.sendMessageStream(sessionId, content, (token: string) => {
        set((state) => ({
          streamingContent: {
            ...state.streamingContent,
            [sessionId]: (state.streamingContent[sessionId] || '') + token,
          },
        }));
      });

      const messages = await sessionApi.getMessages(sessionId);
      set((state) => {
        const newStreamingContent = { ...state.streamingContent };
        delete newStreamingContent[sessionId];
        return {
          messages: { ...state.messages, [sessionId]: messages },
          isStreaming: false,
          streamingContent: newStreamingContent,
        };
      });
    } catch (error) {
      set({ error: String(error), isStreaming: false });
    }
  },
}));
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/stores/chatStore.ts
git commit -m "feat: add streaming support to chatStore"
```

---

## Task 6: 前端 — MarkdownRenderer 组件

**Files:**
- Create: `src/components/chat/MarkdownRenderer.tsx`

- [ ] **Step 1: 创建 MarkdownRenderer.tsx**

创建 `src/components/chat/MarkdownRenderer.tsx`：

```tsx
import { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import 'highlight.js/styles/github-dark.css';

interface MarkdownRendererProps {
  content: string;
  onFileClick?: (path: string) => void;
}

export function MarkdownRenderer({ content, onFileClick }: MarkdownRendererProps) {
  const handleCopy = useCallback((code: string) => {
    navigator.clipboard.writeText(code);
  }, []);

  return (
    <ReactMarkdown
      rehypePlugins={[rehypeHighlight, rehypeRaw]}
      components={{
        pre({ children, ...props }) {
          const codeText = extractCodeText(children);
          return (
            <div className="relative group my-2">
              <button
                onClick={() => handleCopy(codeText)}
                className="absolute top-2 right-2 px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded opacity-0 group-hover:opacity-100 transition-opacity"
              >
                复制
              </button>
              <pre {...props} className="overflow-x-auto rounded-lg bg-[#1e1e2e] p-4 text-sm">
                {children}
              </pre>
            </div>
          );
        },
        code({ children, className, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
                {children}
              </code>
            );
          }
          return <code className={className} {...props}>{children}</code>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(extractCodeText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return extractCodeText((children as React.ReactElement).props.children);
  }
  return '';
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/components/chat/MarkdownRenderer.tsx
git commit -m "feat: add MarkdownRenderer with code highlighting and copy"
```

---

## Task 7: 前端 — MessageItem 使用 MarkdownRenderer

**Files:**
- Modify: `src/components/chat/MessageItem.tsx`

- [ ] **Step 1: 更新 MessageItem.tsx**

将 `src/components/chat/MessageItem.tsx` 替换为：

```tsx
import type { ChatMessage } from '../../types/chat';
import { cn } from '../../lib/utils';
import { User, Bot } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageItemProps {
  message: ChatMessage;
  isStreaming?: boolean;
  onFileClick?: (path: string) => void;
}

export function MessageItem({ message, isStreaming, onFileClick }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Bot className="h-4 w-4 text-primary" />
        </div>
      )}
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownRenderer content={message.content} onFileClick={onFileClick} />
          </div>
        )}
        {isStreaming && !isUser && (
          <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5" />
        )}
      </div>
      {isUser && (
        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
          <User className="h-4 w-4 text-primary-foreground" />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/components/chat/MessageItem.tsx
git commit -m "feat: use MarkdownRenderer in MessageItem for assistant messages"
```

---

## Task 8: 前端 — MessageList 支持流式显示

**Files:**
- Modify: `src/components/chat/MessageList.tsx`

- [ ] **Step 1: 更新 MessageList.tsx**

将 `src/components/chat/MessageList.tsx` 替换为：

```tsx
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../types/chat';
import { MessageItem } from './MessageItem';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Bot } from 'lucide-react';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming?: boolean;
  streamingContent?: string;
  onFileClick?: (path: string) => void;
}

export function MessageList({ messages, isLoading, isStreaming, streamingContent, onFileClick }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {messages.length === 0 && !isLoading && !isStreaming && (
        <div className="text-center text-muted-foreground py-8">
          <p>发送消息开始对话</p>
        </div>
      )}
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} onFileClick={onFileClick} />
      ))}
      {isStreaming && streamingContent && (
        <div className="flex gap-3 justify-start">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <Bot className="h-4 w-4 text-primary" />
          </div>
          <div className="max-w-[80%] rounded-lg px-4 py-2 bg-muted">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownRenderer content={streamingContent} onFileClick={onFileClick} />
            </div>
            <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5" />
          </div>
        </div>
      )}
      {isLoading && !isStreaming && (
        <div className="flex justify-center">
          <div className="animate-pulse text-muted-foreground">思考中...</div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/components/chat/MessageList.tsx
git commit -m "feat: add streaming display to MessageList"
```

---

## Task 9: 前端 — previewStore 状态管理

**Files:**
- Create: `src/stores/previewStore.ts`

- [ ] **Step 1: 创建 previewStore.ts**

创建 `src/stores/previewStore.ts`：

```typescript
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

export const usePreviewStore = create<PreviewState>((set, get) => ({
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
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/stores/previewStore.ts
git commit -m "feat: add previewStore for code preview panel state"
```

---

## Task 10: 前端 — DiffView 和 FileView 组件

**Files:**
- Create: `src/components/preview/DiffView.tsx`
- Create: `src/components/preview/FileView.tsx`

- [ ] **Step 1: 创建 DiffView.tsx**

创建 `src/components/preview/DiffView.tsx`：

```tsx
import { diffLines, Change } from 'diff';

interface DiffViewProps {
  oldContent: string;
  newContent: string;
}

export function DiffView({ oldContent, newContent }: DiffViewProps) {
  const changes: Change[] = diffLines(oldContent, newContent);

  return (
    <div className="font-mono text-sm leading-relaxed">
      {changes.map((change, index) => {
        const lines = change.value.split('\n').filter((_, i, arr) =>
          i < arr.length - 1 || arr[arr.length - 1] !== ''
        );
        return lines.map((line, lineIndex) => {
          let bgClass = '';
          let prefix = ' ';
          if (change.added) {
            bgClass = 'bg-[#1e6f50]';
            prefix = '+';
          } else if (change.removed) {
            bgClass = 'bg-[#7f1d1d]';
            prefix = '-';
          }
          return (
            <div key={`${index}-${lineIndex}`} className={`px-4 ${bgClass}`}>
              <span className="text-zinc-500 select-none mr-2 inline-block w-4 text-right">{prefix}</span>
              <span className="text-zinc-300">{line}</span>
            </div>
          );
        });
      })}
    </div>
  );
}
```

- [ ] **Step 2: 创建 FileView.tsx**

创建 `src/components/preview/FileView.tsx`：

```tsx
import { useMemo } from 'react';

interface FileViewProps {
  content: string;
}

export function FileView({ content }: FileViewProps) {
  const lines = useMemo(() => content.split('\n'), [content]);

  return (
    <div className="font-mono text-sm leading-relaxed">
      {lines.map((line, index) => (
        <div key={index} className="px-4 hover:bg-zinc-800/50">
          <span className="text-zinc-600 select-none mr-4 inline-block w-8 text-right">
            {index + 1}
          </span>
          <span className="text-zinc-300">{line}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
git add src/components/preview/DiffView.tsx src/components/preview/FileView.tsx
git commit -m "feat: add DiffView and FileView components for code preview"
```

---

## Task 11: 前端 — PreviewPanel 容器

**Files:**
- Create: `src/components/preview/PreviewPanel.tsx`

- [ ] **Step 1: 创建 PreviewPanel.tsx**

创建 `src/components/preview/PreviewPanel.tsx`：

```tsx
import { usePreviewStore } from '../../stores/previewStore';
import { DiffView } from './DiffView';
import { FileView } from './FileView';
import { X, FileCode, GitCompare } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

export function PreviewPanel() {
  const { isOpen, files, activeFile, fileContent, viewMode, setOpen, selectFile, setViewMode } = usePreviewStore();

  if (!isOpen) return null;

  return (
    <div className="w-[400px] border-l bg-zinc-950 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <div className="flex gap-1">
          <button
            onClick={() => setViewMode('diff')}
            className={cn(
              'px-2 py-1 text-xs rounded',
              viewMode === 'diff' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
            )}
          >
            <GitCompare className="h-3 w-3 inline mr-1" />
            Diff
          </button>
          <button
            onClick={() => setViewMode('file')}
            className={cn(
              'px-2 py-1 text-xs rounded',
              viewMode === 'file' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
            )}
          >
            <FileCode className="h-3 w-3 inline mr-1" />
            文件
          </button>
        </div>
        <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-300">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* File tabs */}
      {files.length > 0 && (
        <div className="flex overflow-x-auto border-b border-zinc-800">
          {files.map((file) => (
            <button
              key={file.path}
              onClick={() => selectFile(file.path)}
              className={cn(
                'px-3 py-2 text-xs font-mono whitespace-nowrap border-r border-zinc-800',
                activeFile === file.path
                  ? 'bg-zinc-900 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50'
              )}
            >
              {file.path.split('/').pop()}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeFile && fileContent ? (
          viewMode === 'file' ? (
            <FileView content={fileContent} />
          ) : (
            <DiffView oldContent="" newContent={fileContent} />
          )
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            {files.length > 0 ? '选择文件查看内容' : '暂无文件引用'}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/components/preview/PreviewPanel.tsx
git commit -m "feat: add PreviewPanel container with diff/file view toggle"
```

---

## Task 12: 前端 — MainLayout 三栏布局

**Files:**
- Modify: `src/components/layout/MainLayout.tsx`

- [ ] **Step 1: 更新 MainLayout.tsx**

将 `src/components/layout/MainLayout.tsx` 替换为：

```tsx
import { ReactNode } from 'react';

interface MainLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  preview?: ReactNode;
}

export function MainLayout({ sidebar, children, preview }: MainLayoutProps) {
  return (
    <div className="flex h-screen bg-background">
      <aside className="w-64 border-r bg-muted/30 flex flex-col">
        {sidebar}
      </aside>
      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col">
          {children}
        </div>
        {preview}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/components/layout/MainLayout.tsx
git commit -m "feat: update MainLayout to three-panel with preview slot"
```

---

## Task 13: 前端 — ChatPanel 集成 preview

**Files:**
- Modify: `src/components/chat/ChatPanel.tsx`

- [ ] **Step 1: 更新 ChatPanel.tsx**

将 `src/components/chat/ChatPanel.tsx` 替换为：

```tsx
import { useEffect, useCallback } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePreviewStore } from '../../stores/previewStore';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

interface ChatPanelProps {
  sessionId: string;
}

export function ChatPanel({ sessionId }: ChatPanelProps) {
  const { messages, isLoading, isStreaming, streamingContent, fetchMessages, sendMessage } = useChatStore();
  const { sessions } = useSessionStore();
  const { setOpen, setFiles } = usePreviewStore();

  const session = sessions.find((s) => s.id === sessionId);
  const sessionMessages = messages[sessionId] || [];
  const currentStreamingContent = streamingContent[sessionId] || '';

  useEffect(() => {
    fetchMessages(sessionId);
  }, [sessionId, fetchMessages]);

  const handleSend = async (content: string) => {
    await sendMessage(sessionId, content);
  };

  const handleFileClick = useCallback((path: string) => {
    setOpen(true);
    usePreviewStore.getState().selectFile(path);
    // Add file to files list if not already present
    const currentFiles = usePreviewStore.getState().files;
    if (!currentFiles.find((f) => f.path === path)) {
      setFiles([...currentFiles, { path }]);
    }
  }, [setOpen, setFiles]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3">
        <h2 className="font-semibold">{session?.title || '对话'}</h2>
      </div>
      <MessageList
        messages={sessionMessages}
        isLoading={isLoading}
        isStreaming={isStreaming}
        streamingContent={currentStreamingContent}
        onFileClick={handleFileClick}
      />
      <ChatInput onSend={handleSend} isLoading={isLoading || isStreaming} />
    </div>
  );
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/components/chat/ChatPanel.tsx
git commit -m "feat: integrate preview panel into ChatPanel"
```

---

## Task 14: 前端 — App.tsx 集成 PreviewPanel

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 更新 App.tsx**

将 `src/App.tsx` 替换为：

```tsx
import { useEffect, useState } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { PreviewPanel } from './components/preview/PreviewPanel';
import { useSessionStore } from './stores/sessionStore';
import { useSettingsStore } from './stores/settingsStore';

function App() {
  const { createSession, activeSessionId } = useSessionStore();
  const { fetchConfig } = useSettingsStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleNewSession = async () => {
    await createSession('新对话');
  };

  return (
    <>
      <MainLayout
        sidebar={
          <Sidebar onNewSession={handleNewSession} onOpenSettings={() => setSettingsOpen(true)} />
        }
        preview={<PreviewPanel />}
      >
        {activeSessionId ? (
          <ChatPanel sessionId={activeSessionId} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2">欢迎使用 codeMUX</h2>
              <p className="text-muted-foreground">点击 "新对话" 开始</p>
            </div>
          </div>
        )}
      </MainLayout>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export default App;
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd d:/project/ai-code/codeMUX && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/App.tsx
git commit -m "feat: integrate PreviewPanel into App layout"
```

---

## Task 15: 端到端验证

- [ ] **Step 1: 启动开发服务器验证编译**

```bash
cd d:/project/ai-code/codeMUX && npm run dev
```

Expected: Vite dev server 启动成功，无编译错误。

- [ ] **Step 2: 启动 Tauri 应用验证后端**

```bash
cd d:/project/ai-code/codeMUX && npm run tauri dev
```

Expected: 应用启动成功，可以发送消息，流式显示响应，代码块有语法高亮和复制按钮。

- [ ] **Step 3: 验证三栏布局**

在应用中打开一个对话，确认三栏布局正常，右侧面板可折叠。

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "feat: complete streaming, markdown rendering, and code preview"
```
