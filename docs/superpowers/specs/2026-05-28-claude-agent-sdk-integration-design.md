# Claude Agent SDK Integration Design

## Overview

将 codeMUX 从简单聊天客户端升级为 AI Agent 编码平台，通过集成 `@anthropic-ai/claude-agent-sdk` TypeScript SDK，让用户可以在 codeMUX 中启动 Claude Agent 进行自主编码任务。

## Goals

- 用户在 codeMUX 中手动选择 Claude Agent 作为 AI 后端
- 完全交互式体验：实时流式展示思考过程、工具调用、diff、命令执行
- 项目工作区模式：Agent 在用户打开的项目目录下工作
- 先集成 Claude Agent，后续扩展 Codex CLI

## Architecture

### 整体架构

```
┌─────────────────────────────────────────────────┐
│                  codeMUX Frontend (React)        │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ ChatPanel │ │ Preview  │ │ AgentEventPanel  │ │
│  │ (existing)│ │ (existing)│ │ (NEW)            │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│         │                        ▲               │
│         │ Tauri IPC              │ Tauri IPC     │
│         ▼                        │               │
│  ┌──────────────────────────────────────────────┐│
│  │           Rust Backend (Tauri Commands)       ││
│  │  ┌─────────────┐  ┌───────────────────────┐  ││
│  │  │ AgentRunner  │  │ Existing Provider     │  ││
│  │  │ (NEW)        │  │ (OpenAI Compat)       │  ││
│  │  └──────┬──────┘  └───────────────────────┘  ││
│  │         │                                     ││
│  │         │ spawn Node.js sidecar               ││
│  │         ▼                                     ││
│  │  ┌──────────────────────────────────────────┐ ││
│  │  │ Node.js Sidecar Process                  │ ││
│  │  │ @anthropic-ai/claude-agent-sdk           │ ││
│  │  │ query() → AsyncGenerator<SDKMessage>     │ ││
│  │  └──────────────────────────────────────────┘ ││
│  └──────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

### 数据流

1. 用户在前端输入任务描述，选择 "Claude Agent" 模式
2. 前端通过 Tauri IPC 调用 `start_agent_session` 命令
3. Rust 后端启动 Node.js sidecar 进程，传入项目目录和任务
4. Sidecar 中的 `query()` 流式返回 `SDKMessage` 事件
5. Rust 层将事件转发到前端 via Tauri Channel
6. 前端根据消息类型渲染不同 UI 组件

### SDK Message 处理映射

| SDKMessage 类型 | 前端展示 |
|---|---|
| `SDKSystemMessage` (subtype: init) | 显示 session 信息、可用工具列表 |
| `SDKAssistantMessage` (content: thinking) | 思考过程流式展示 |
| `SDKAssistantMessage` (content: text) | Markdown 渲染回复 |
| `SDKAssistantMessage` (content: tool_use) | 工具调用卡片（名称、参数） |
| `SDKUserMessage` (tool_result) | 工具执行结果展示 |
| `SDKResultMessage` | 任务完成摘要（耗时、费用、token） |
| `SDKPartialAssistantMessage` | 流式 token 增量更新 |
| `SDKHookStartedMessage` / `SDKHookResponseMessage` | Hook 生命周期展示 |
| `SDKTaskStartedMessage` / `SDKTaskProgressMessage` | 子任务进度 |
| `SDKPermissionDeniedMessage` | 权限拒绝提示 |

## Implementation Plan

### Phase 1: Node.js Sidecar 基础设施

**Rust 侧：**
- 新增 `src-tauri/src/agent/` 模块
- `mod.rs` — Agent trait 和消息类型定义
- `claude_agent.rs` — Claude Agent SDK sidecar 管理
- `commands.rs` — Tauri commands: `start_agent_session`, `send_agent_message`, `interrupt_agent`, `list_agent_sessions`

**Node.js Sidecar：**
- 新增 `src-tauri/sidecar/` 目录
- `package.json` — 依赖 `@anthropic-ai/claude-agent-sdk`
- `agent.ts` — 主入口，监听 stdin 命令，流式输出 SDKMessage 到 stdout
- 通信协议：Rust 通过 stdin 发送 JSON 命令，sidecar 通过 stdout 输出 NDJSON 事件

**Tauri 配置：**
- 在 `tauri.conf.json` 中配置 sidecar binary
- 或使用 `tauri-plugin-shell` 的 sidecar 功能

### Phase 2: 前端 Agent 交互 UI

**新组件：**
- `src/components/agent/AgentPanel.tsx` — Agent 主面板
- `src/components/agent/AgentMessageList.tsx` — 事件流列表
- `src/components/agent/ThinkingBlock.tsx` — 思考过程展示（可折叠）
- `src/components/agent/ToolCallCard.tsx` — 工具调用卡片
- `src/components/agent/DiffViewer.tsx` — 文件 diff 审查（accept/reject）
- `src/components/agent/TerminalOutput.tsx` — 命令执行输出
- `src/components/agent/AgentStatusBar.tsx` — 状态栏（session、费用、token）

**Store：**
- `src/stores/agentStore.ts` — Agent session 状态管理

### Phase 3: 交互控制

- 用户中断 Agent（interrupt）
- 工具调用审批（canUseTool callback）
- Session 恢复（resume）
- 权限模式切换

### Phase 4: 多 Provider 统一入口

- 将现有聊天和 Agent 模式统一到同一个输入框
- 用户可选择 "Chat" 模式（现有 Provider）或 "Agent" 模式（Claude Agent）
- 后续扩展 Codex Agent

## Key Design Decisions

### 1. Sidecar vs CLI subprocess

选择 Sidecar 模式而非 CLI subprocess，因为：
- SDK 的 `query()` 返回强类型 `AsyncGenerator<SDKMessage>`，无需解析 NDJSON
- 支持双向通信（interrupt、resume、setPermissionMode）
- SDK 自带原生二进制，不需要用户单独安装 CLI

### 2. 通信协议

Rust ↔ Sidecar 通过 stdin/stdout 通信：
- **Rust → Sidecar (stdin):** JSON 命令 `{ "type": "start", "prompt": "...", "cwd": "..." }`
- **Sidecar → Rust (stdout):** NDJSON 事件流，每行一个 SDKMessage
- **Rust → Frontend:** Tauri Channel 推送序列化消息

### 3. 前端渲染策略

- thinking 和 text 消息：增量追加到同一个 assistant 气泡
- tool_use：显示为可展开的卡片，包含工具名和参数
- tool_result：显示执行结果，文件类工具展示 diff
- 流式消息：使用 `SDKPartialAssistantMessage` 实现打字机效果

## Dependencies

### 新增前端依赖
- 无（复用现有 react-markdown、diff、highlight.js）

### 新增 Rust 依赖
- 无（复用现有 tokio、serde_json）

### 新增 Sidecar 依赖
- `@anthropic-ai/claude-agent-sdk`
- `typescript`（编译 sidecar 代码）

### 环境要求
- Node.js runtime（Tauri sidecar 需要）
- `ANTHROPIC_API_KEY` 环境变量（或用户在设置中配置）

## Scope

### In Scope (全部完成)
- Node.js Sidecar 基础设施（Rust 通信层 + sidecar 进程）
- Claude Agent SDK 集成（query() 流式消息）
- 前端 Agent 交互 UI（thinking、text、tool_use、tool_result、diff、terminal）
- 工具调用审批（canUseTool callback + UI）
- Session 管理（创建、恢复、列表）
- 交互控制（interrupt、权限模式切换）
- 多 Provider 统一入口（Chat / Agent 模式切换）

### Out of Scope
- Codex CLI 集成（后续独立项目）
- 自定义 Agent 定义
- MCP Server 配置 UI
