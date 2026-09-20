# Changed Files Panel Design

## Overview

在 AgentPanel 中新增"改动列表"功能，追踪 agent 通过 Write/Edit 工具修改的文件，提供查看差异、单文件撤销、全部撤销和全部保存的能力。

## 数据模型

### ChangedFile 类型（`src/types/agent.ts`）

```typescript
interface ChangedFile {
  path: string;              // 文件绝对路径
  isNew: boolean;            // 是否为 agent 新创建的文件
  originalContent?: string;  // 修改前内容（isNew=false 时有值）
  currentContent: string;    // 修改后内容（即 agent 写入的内容）
  additions: number;         // 新增行数
  deletions: number;         // 删除行数
}
```

## 状态管理

### agentStore 扩展（`src/stores/agentStore.ts`）

- 新增状态字段：`changedFiles: Record<string, ChangedFile[]>`，按 sessionId 隔离
- 新增纯函数 `extractChangedFilesFromEvents(events: AgentMessage[]): ChangedFile[]`
  - 遍历事件流，解析 `tool_use` 中的 `Write` 和 `Edit` 工具调用
  - Write 工具：提取 `file_path` + `content`，标记为新文件或覆盖文件
  - Edit 工具：提取 `file_path` + `old_string` + `new_string`，用 `diff` 库计算行数变化
  - 同一文件多次修改时，`originalContent` 保留第一次修改前的值，`currentContent` 更新为最后一次写入的内容，diff 数据重新计算
- 在事件处理逻辑中（与 `extractTodosFromEvents` 同一位置），调用此函数更新 `changedFiles`

### 事件解析规则

Write 工具调用：
```
tool_use.name === 'Write'
tool_use.input.file_path → 文件路径
tool_use.input.content → 文件内容
```
- 若该文件在 changedFiles 中不存在 → 标记 `isNew=true`，`originalContent` 为空
- 若已存在 → 更新 `currentContent` 和 diff 数据

Edit 工具调用：
```
tool_use.name === 'Edit'
tool_use.input.file_path → 文件路径
tool_use.input.old_string → 原始文本
tool_use.input.new_string → 替换文本
```
- Edit 是替换操作：在当前 `currentContent` 中找到 `old_string` 并替换为 `new_string`
- 多次 Edit 同一文件时，依次替换，累积计算最终内容
- 若该文件在 changedFiles 中不存在 → 先读取磁盘内容作为 `originalContent`（通过 tool_result 中的文件内容，或标记为需要回读）

### 如何判断文件是否为"新建"

- Write 工具：检查文件在 changedFiles 中是否已有记录。若无记录且该文件之前不存在于磁盘，则为新建
- 简化方案：统一在第一次记录时读取磁盘文件，若文件不存在则 `isNew=true`，`originalContent` 为空字符串

## UI 设计

### 按钮位置

AgentPanel 顶部 header 区域，放在 ContextProgress 和项目路径之间。

### 按钮样式

- 默认显示：`改动列表` 文字 + `+N -N` 数字（绿色/红色）
- 无改动时：数字为 `+0 -0`，点击后显示"暂无文件改动"
- 有改动时：数字区域带有微弱背景色高亮

### 下拉面板

```
┌─────────────────────────────────────────────┐
│  改动列表            [撤销全部]  [保存全部]   │  ← 顶部操作栏
├─────────────────────────────────────────────┤
│  📄 src/App.tsx        +12  -3              │  ← 文件行
│     [查看差异] [撤销]                         │
│  📄 src/store.ts       +45  -8              │
│     [查看差异] [撤销]                         │
│  🆕 src/newFile.ts     +20  -0              │
│     [查看差异] [撤销]                         │
├─────────────────────────────────────────────┤
│  共 3 个文件  +77  -11                       │  ← 底部统计
└─────────────────────────────────────────────┘
```

- 面板宽度固定 380px，最大高度 400px，超出滚动
- 使用 absolute 定位，参考 TodoList 的 dropdown 实现

### 交互行为

| 操作 | 行为 |
|------|------|
| 点击文件名 | 在预览面板打开该文件（调用 `previewStore.openFile`） |
| 查看差异 | 打开预览面板并切换到 diff 模式（传入 originalContent 和 currentContent） |
| 撤销单个文件 | 确认弹窗后执行还原，从列表中移除 |
| 撤销全部 | 确认弹窗后还原所有文件，清空列表 |
| 保存全部 | 直接清空列表（文件已在磁盘，无需额外操作） |

### 撤销逻辑

- `isNew=true` → 删除文件（调用 `fileApi.deleteFile`）
- `isNew=false` → 用 `originalContent` 覆盖文件（调用 `fileApi.writeFile`）

## 后端支持

### 新增 Tauri 命令 `delete_file`

- 接收文件路径参数
- 删除指定文件
- 返回成功/失败

### 新增 Tauri 命令 `write_file`

- 接收文件路径和内容参数
- 将内容写入指定文件（用于撤销时还原 originalContent）
- 返回成功/失败

### 前端 API 扩展（`src/lib/tauri.ts`）

```typescript
fileApi.deleteFile: (path: string, basePath?: string) => Promise<void>
fileApi.writeFile: (path: string, content: string, basePath?: string) => Promise<void>
```

## 边界情况处理

| 场景 | 处理方式 |
|------|----------|
| 文件被多次修改 | 保留最早的 originalContent，currentContent 更新为最后一次内容 |
| 撤销时文件已被外部删除 | 弹出提示"文件不存在，已从列表移除" |
| 保存全部后 agent 继续修改 | 新改动正常出现在列表中 |
| 会话切换 | changedFiles 按 sessionId 隔离，自动显示对应列表 |
| 大文件 | 使用现有 `diff` 库，与 DiffView 一致 |

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/types/agent.ts` | 修改 | 新增 ChangedFile 类型定义 |
| `src/stores/agentStore.ts` | 修改 | 新增 changedFiles 状态和 extractChangedFilesFromEvents |
| `src/components/agent/ChangedFilesList.tsx` | 新建 | 改动列表组件 |
| `src/components/agent/AgentPanel.tsx` | 修改 | 集成 ChangedFilesList 到 header |
| `src/lib/tauri.ts` | 修改 | 新增 fileApi.deleteFile 和 fileApi.writeFile |
| `src-tauri/src/` (Rust) | 修改 | 新增 delete_file 和 write_file 命令 |
