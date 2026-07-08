# 流式输出 + Markdown 渲染 + 代码预览面板 设计文档

## 概述

为 CodeMUX 实现三个核心功能：流式输出（token-by-token 显示 AI 响应）、Markdown 渲染（代码高亮、富文本展示）、三栏布局代码预览面板（文件链接 + 内联 Diff 视图）。

## 功能一：流式输出

### 架构

使用 Tauri v2 Channel API 实现端到端流式传输。

```
前端 ChatInput
  → chatStore.sendMessage(sessionId, content)
    → Tauri invoke('send_message_stream', { sessionId, content, channel })
      → Rust 命令: provider.send_message_stream()
        → SSE 解析 → mpsc::Receiver<String>
          → 循环读取 chunk → channel.send(token)
            → 前端逐 token 更新 streamingContent UI
              → 流完成 → 写入数据库保存完整消息
```

### 后端变更

**新增 Tauri 命令 `send_message_stream`**（`src-tauri/src/commands/chat.rs`）：

- 参数：`session_id: String`, `content: String`, `channel: Channel<String>`
- 流程：
  1. 从 `AppState` 读取活跃供应商配置
  2. 加载会话历史消息
  3. 保存用户消息到数据库
  4. 创建 provider，调用 `send_message_stream(messages, model)`
  5. 循环 `receiver.recv()` 读取 token，通过 `channel.send(token)` 发送到前端
  6. 流结束后，拼接完整响应，保存 assistant 消息到数据库
  7. 返回 `Ok(())`
- 错误处理：流中断时将已接收内容保存为部分回复

**Channel 类型**：`use tauri::ipc::Channel;`

### 前端变更

**chatStore 新增状态**：

```typescript
streamingContent: Record<string, string>;  // sessionId → 累积的流式文本
```

**chatStore.sendMessage 重写**：

1. 添加乐观 user message
2. 设置 `isStreaming = true`, `streamingContent[sessionId] = ''`
3. 创建 `new Channel<string>()`，监听 `onmessage` 回调
4. 每次收到 chunk → `streamingContent[sessionId] += chunk`
5. 流完成（`onmessage` 结束或命令返回）→
   - 将 streamingContent 保存为 assistant message
   - 清空 streamingContent
   - 调用 `fetchMessages` 从 DB 刷新
   - 设置 `isStreaming = false`

**tauri.ts 新增**：

```typescript
chatApi.sendMessageStream: (sessionId: string, content: string, channel: Channel<string>) =>
  invoke('send_message_stream', { sessionId, content, channel }),
```

### 降级策略

保留原 `send_message` 命令，当 Channel 不可用时降级为非流式调用。

---

## 功能二：Markdown 渲染

### 技术栈

- `react-markdown` — Markdown 解析为 React 组件
- `rehype-highlight` — 代码块语法高亮（基于 highlight.js）
- `rehype-raw` — 支持 markdown 中的原始 HTML
- `highlight.js` — 语法高亮引擎

### 样式

- 代码高亮主题：`highlight.js/styles/github-dark.css`
- 适配深色/浅色模式（代码块始终使用暗色背景）

### MessageItem 改造

- **assistant 消息**：用 `<ReactMarkdown>` 替代纯文本 `<div>`
- **用户消息**：保持纯文本（不渲染 markdown）
- **代码块**：添加复制按钮（轻量实现，CSS 定位在代码块右上角）
- **流式过程中**：`react-markdown` 对不完整 markdown 有良好容错，未闭合代码块会正常显示为代码块样式

### Markdown 渲染配置

```tsx
<ReactMarkdown
  rehypePlugins={[rehypeHighlight, rehypeRaw]}
  components={{
    // 自定义代码块：添加复制按钮
    pre: ({ children, ...props }) => (
      <div className="code-block-wrapper">
        <button className="copy-button" onClick={handleCopy}>复制</button>
        <pre {...props}>{children}</pre>
      </div>
    ),
  }}
>
  {content}
</ReactMarkdown>
```

---

## 功能三：三栏布局 + 代码预览面板

### 布局结构

```
┌──────────────┬─────────────────────────┬───────────────────────┐
│              │                         │  文件 │ Diff │  ✕     │
│   会话列表   │       对话区域           │                      │
│              │                         │  src/auth/jwt.ts      │
│  - 新建      │  AI: 修改了以下文件:     │                      │
│  - 会话1     │  [📄 src/auth/jwt.ts]   │  + import jwt ...     │
│  - 会话2     │  [📄 src/middleware.ts]  │  - return session...  │
│              │                         │  + return jwt.sign... │
│              │                         │                      │
│  当前模型    │  ─────────────────────  │                      │
│              │  输入区域               │                      │
└──────────────┴─────────────────────────┴───────────────────────┘
```

- 左侧会话列表宽度：固定 240px（现有）
- 中间对话区域：flex-1 自适应
- 右侧代码预览面板：固定 400px，可折叠
- 面板折叠时中间区域自动扩展

### 文件链接渲染

AI 消息中的文件路径渲染为可点击链接。通过自定义 `react-markdown` 组件实现：

- 检测 AI 消息中是否包含文件路径引用
- 文件路径以 `📄` 图标 + 路径文本 + 变更统计展示
- 样式：蓝色背景 pill，等宽字体，hover 高亮

**实现方式**：在 `<ReactMarkdown>` 的自定义组件中，对特定 pattern（如 `` `src/xxx.ts` `` 或 AI 显式标记的文件）渲染为可点击链接。

### 代码预览面板

**状态管理**（chatStore 或新建 previewStore）：

```typescript
interface PreviewState {
  isOpen: boolean;
  files: FileEntry[];      // AI 回复中引用的文件列表
  activeFile: string | null; // 当前选中的文件路径
  viewMode: 'diff' | 'file'; // 视图模式
}

interface FileEntry {
  path: string;
  additions?: number;
  deletions?: number;
}
```

**文件内容获取**：

新增 Tauri 命令 `read_file`（`src-tauri/src/commands/`）：

- 参数：`path: String`（相对于项目根目录的路径）
- 返回：文件内容字符串
- 安全：限制在项目目录内，防止路径遍历

**Diff 计算**：

- 前端使用 `diff` 库（`diffLines`）计算变更
- AI 消息中的文件变更前内容从对话历史或快照获取
- 变更后内容从文件系统读取
- 简化方案：如果无法获取变更前内容，仅展示文件内容 + 高亮

**视图模式**：

- **Diff 模式（默认）**：内联 diff，增行绿色背景（`#1e6f50`），删行红色背景（`#7f1d1d`），保持行号对齐
- **文件模式**：完整文件内容，代码高亮，变更行侧边标记
- 顶部 Tab 切换两种模式

### 面板折叠

- 右侧面板默认折叠（首次有文件引用时自动展开）
- 折叠/展开按钮在面板顶部
- 折叠后显示一个小型文件图标按钮，点击重新展开

---

## 依赖变更

### 前端新增依赖

```json
{
  "react-markdown": "^9.0.0",
  "rehype-highlight": "^7.0.0",
  "rehype-raw": "^7.0.0",
  "highlight.js": "^11.0.0",
  "diff": "^5.0.0"
}
```

### 后端依赖

无需新增依赖。Tauri v2 的 `Channel` 类型已内置。

---

## 文件变更清单

### 新增文件

- `src/components/chat/MarkdownRenderer.tsx` — Markdown 渲染组件
- `src/components/preview/PreviewPanel.tsx` — 代码预览面板
- `src/components/preview/DiffView.tsx` — Diff 视图组件
- `src/components/preview/FileView.tsx` — 文件视图组件
- `src/components/preview/FileTree.tsx` — 文件列表组件
- `src/stores/previewStore.ts` — 预览面板状态管理

### 修改文件

- `src/stores/chatStore.ts` — 新增 streamingContent 状态，重写 sendMessage
- `src/lib/tauri.ts` — 新增 chatApi.sendMessageStream, fileApi.readFile
- `src/components/chat/MessageItem.tsx` — assistant 消息使用 MarkdownRenderer
- `src/components/chat/MessageList.tsx` — 流式过程中显示 streamingContent
- `src/components/chat/ChatPanel.tsx` — 传递 preview 相关 props
- `src/components/layout/MainLayout.tsx` — 从两栏改为三栏布局
- `src-tauri/src/commands/chat.rs` — 新增 send_message_stream 命令
- `src-tauri/src/lib.rs` — 注册新命令

---

## 测试要点

1. 流式输出：发送消息后逐 token 显示，不丢失内容
2. 流式中断：网络断开时已接收内容正确保存
3. Markdown 渲染：代码块高亮、列表、表格、链接正常显示
4. 代码块复制：点击复制按钮成功复制内容
5. 文件链接：点击文件链接右侧面板正确加载
6. Diff 视图：增删行正确着色
7. 面板折叠：折叠/展开不影响对话区域布局
8. 深色/浅色模式：所有组件主题一致
