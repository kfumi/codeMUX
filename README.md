<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="120" alt="codeMUX Logo">
</p>

<h1 align="center">codeMUX</h1>

<p align="center">
  <strong>AI 编码工具聚合平台</strong><br>
  将 CLI AI 编码工具封装为精致的桌面应用
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/Tauri-2-ffc131?logo=tauri" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React-18-61dafb?logo=react" alt="React 18">
  <img src="https://img.shields.io/badge/Rust-2021-dea584?logo=rust" alt="Rust">
</p>

---

## 目录

- [简介](#简介)
- [功能特性](#功能特性)
- [截图](#截图)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [安装依赖](#安装依赖)
  - [开发模式](#开发模式)
  - [生产构建](#生产构建)
- [配置指南](#配置指南)
  - [AI 提供商配置](#ai-提供商配置)
  - [MCP 服务器配置](#mcp-服务器配置)
  - [Skills 技能配置](#skills-技能配置)
- [斜杠命令参考](#斜杠命令参考)
- [架构概览](#架构概览)
  - [三层架构](#三层架构)
  - [数据存储](#数据存储)
  - [数据库 Schema](#数据库-schema)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [路线图](#路线图)
- [贡献指南](#贡献指南)
- [许可证](#许可证)
- [致谢](#致谢)

---

## 简介

[codeMUX](https://github.com/vzi777/codeMUX) 是一个基于 [Tauri 2](https://v2.tauri.app/) 的跨平台桌面应用，为 AI 编码代理提供统一的可视化交互界面。

当前主流的 AI 编码工具（如 Claude Code）大多以 CLI 形式运行，codeMUX 将它们封装在一个精致的 GUI 中，提供流式对话、工具调用可视化、MCP 服务器管理、Skills 技能市场、文件预览与 Diff 对比等能力，让 AI 辅助编码的体验更加直观和高效。

### 核心理念

- **可视化优先** — 所有 AI 交互都有清晰的视觉反馈，工具调用、代码变更、终端输出一目了然
- **可扩展** — 通过 MCP 协议和 Skills 系统，轻松扩展 AI 的能力边界
- **多提供商** — 不绑定单一 AI 服务商，支持 Anthropic、OpenAI 兼容端点、DeepSeek 等
- **本地优先** — 数据存储在本地 SQLite，无需注册账号，无需云端同步

---

## 功能特性

### Agent 对话面板

完整的 AI 对话交互界面，基于 Claude Agent SDK 构建：

- **流式 Markdown 渲染** — 逐 token 实时渲染，支持 GFM 语法高亮、表格、原始 HTML
- **工具调用可视化** — 每个工具调用以卡片形式展示，包含工具名称、参数、执行结果
- **Thinking 思考块** — 可折叠的 AI 思考过程展示
- **终端输出块** — 命令执行结果以终端风格渲染
- **Diff 代码对比** — 文件修改以统一 Diff 格式展示，支持语法高亮
- **Todo 列表** — AI 生成的任务列表，实时更新进度状态
- **交互式提问** — AI 向用户提问时，支持选项选择和自由文本输入
- **上下文窗口进度条** — 可视化当前会话的上下文使用量

### 多提供商配置

灵活的 AI 服务商管理：

- 支持 **Anthropic**、**OpenAI 兼容端点**、**DeepSeek** 等多个提供商
- 每个提供商独立配置：API Key、Anthropic Base URL、OpenAI Base URL、默认模型
- 一键测试连通性，显示响应延迟
- 从 API 端点拉取可用模型列表
- Token 用量与费用统计（输入/缓存读取/输出 分别计价）
- 支持 1M 上下文窗口切换

### MCP 服务器管理

完整的 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器管理：

- 可视化增删改查界面
- 支持三种传输协议：
  - **stdio** — 本地进程（如 `npx @upstash/context7-mcp@latest`）
  - **HTTP Streaming** — HTTP 流式端点
  - **SSE** — Server-Sent Events 端点
- 配置向导 — 图形化填写参数，自动生成 JSON 配置
- 启动时自动探测连通性，实时显示连接状态（绿/黄/红指示灯）
- 双写机制 — 同时写入本地数据库和 `~/.claude.json`，兼容 Claude CLI 独立使用
- 启用/禁用开关，按需加载

### Skills 技能系统

可扩展的 AI 技能生态：

- 从 GitHub 仓库浏览和安装技能（默认源：[anthropics/skills](https://github.com/anthropics/skills)）
- 内置技能：`find-skills`（搜索技能）、`skill-creator`（创建技能）
- 通过 `/` 斒杠命令快速调用已安装的技能
- 技能内容预览（Markdown 渲染）
- 启用/禁用、卸载管理
- 安装到 `~/.claude/skills/`，兼容 Claude CLI

### 文件预览与 Diff 面板

右侧工作面板，用于查看 AI 操作的文件变更：

- **文件树浏览器** — 浏览项目目录结构
- **文件内容查看器** — 支持语法高亮的代码预览
- **统一 Diff 视图** — 查看文件修改的增删内容
- 工具调用卡片中的文件路径可点击，直接跳转到预览

### 会话与项目管理

- 多会话对话，按项目分组组织
- 会话重命名、删除
- 项目级别的上下文隔离
- 会话历史持久化（SQLite）

### 斜杠命令

丰富的内置命令：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/new` | 新建 | 创建新会话 |
| `/clear` | 清空 | 重置上下文 |
| `/compact` | 压缩 | 压缩上下文 |
| `/cost` | 费用、token | 查看 Token 用量和费用 |
| `/status` | 状态 | 查看会话状态 |
| `/init` | — | 初始化项目，生成 CLAUDE.md |
| `/review` | — | 审查最近代码变更 |
| `/code-review` | — | 代码审查 |
| `/security-review` | — | 安全审查 |
| `/debug` | — | 调试当前项目 |
| `/verify` | — | 验证代码正确性 |
| `/deep-research` | — | 深度研究 |
| `/simplify` | — | 简化代码 |
| `/explain <file>` | — | 解释代码 |
| `/test` | — | 生成/运行测试 |
| `/fix [描述]` | — | 修复问题 |
| `/refactor <目标>` | — | 重构代码 |

所有命令均支持中文别名。已安装的 Skills 也会注册为斜杠命令。

### 主题系统

- 亮色模式
- 暗色模式
- 跟随系统

---

## 截图

> TODO: 添加截图

<!-- 建议截图：
  1. 主界面 — Agent 对话面板
  2. 工具调用卡片展示
  3. Diff 代码对比
  4. MCP 服务器管理
  5. 提供商配置
-->

---

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| **前端框架** | React + TypeScript | 18.3 / 5.6 |
| **构建工具** | Vite | 6.0 |
| **状态管理** | Zustand | 5.0 |
| **样式方案** | Tailwind CSS + class-variance-authority | 3.4 |
| **UI 组件** | Radix UI（Dialog / Select / Switch / Tooltip / RadioGroup） | — |
| **Markdown 渲染** | react-markdown + remark-gfm + rehype-highlight + rehype-raw | 10.1 |
| **代码编辑器** | CodeMirror（@uiw/react-codemirror） | 4.25 |
| **图标库** | lucide-react | 0.46 |
| **Toast 通知** | sonner | 2.0 |
| **代码 Diff** | diff | 9.0 |
| **桌面框架** | Tauri | 2 |
| **后端语言** | Rust（Edition 2021） | — |
| **数据库** | SQLite（rusqlite，bundled） | 0.31 |
| **HTTP 客户端** | reqwest（json + stream） | 0.12 |
| **异步运行时** | Tokio（full） | 1 |
| **AI Agent SDK** | @anthropic-ai/claude-agent-sdk（Node.js Sidecar） | 0.3.167 |

---

## 快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| [Node.js](https://nodejs.org/) | >= 18 | 运行前端构建和 Agent Sidecar |
| [Rust](https://www.rust-lang.org/tools/install) | stable | Tauri 后端编译 |
| [Tauri 2 Prerequisites](https://v2.tauri.app/start/prerequisites/) | — | 平台相关依赖（WebView2 / Xcode 等） |

#### Windows 额外要求

- [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)（Windows 10 1803+ 通常已预装）

#### macOS 额外要求

- Xcode Command Line Tools：`xcode-select --install`

#### Linux 额外要求

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel
sudo dnf group install "C Development Tools and Libraries"
```

### 安装依赖

```bash
# 克隆项目
git clone https://github.com/vzi777/codeMUX.git
cd codeMUX

# 安装前端依赖
npm install

# 安装 Sidecar 依赖
cd src-tauri/sidecar
npm install
npm run build
cd ../..
```

### 开发模式

```bash
npm run tauri dev
```

这会同时启动：
- Vite 开发服务器（`http://localhost:1420`，支持 HMR 热更新）
- Tauri 开发窗口（自动加载前端 + Rust 后端）

Rust 代码修改会自动重新编译并重启后端。

### 生产构建

```bash
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`：

```
bundle/
├── msi/
│   └── codeMUX_0.1.0_x64_en-US.msi       # Windows MSI 安装包
└── nsis/
    └── codeMUX_0.1.0_x64-setup.exe        # Windows NSIS 安装程序
```

> macOS 生成 `.dmg`，Linux 生成 `.deb` / `.AppImage`。

### 仅构建前端

```bash
npm run build      # TypeScript 类型检查 + Vite 生产构建
npm run preview    # 预览生产构建
```

---

## 配置指南

### AI 提供商配置

1. 打开应用，点击侧边栏底部的 **设置** 图标
2. 默认进入 **供应商配置** 标签页
3. 点击 **添加供应商** 填写：
   - **名称** — 便于识别的别名
   - **API Key** — 对应服务商的 API 密钥
   - **Anthropic Base URL** — Anthropic API 地址（默认 `https://api.anthropic.com`，可改为代理地址）
   - **OpenAI Base URL** — OpenAI 兼容 API 地址（用于 DeepSeek 等兼容端点）
   - **默认模型** — 如 `claude-sonnet-4-20250514`
4. 点击 **测试连接** 验证配置
5. 点击供应商卡片的 **激活** 按钮设为当前使用

### MCP 服务器配置

1. 进入设置 → **MCP** 标签页
2. 点击 **添加服务器**
3. 可选择两种编辑模式：
   - **JSON 编辑器** — 直接编写配置 JSON
   - **配置向导** — 图形化填写参数

#### 配置示例

**stdio 类型**（本地进程）：

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@upstash/context7-mcp@latest"],
  "env": {}
}
```

**HTTP Streaming 类型**：

```json
{
  "type": "http",
  "url": "http://localhost:3000/mcp",
  "headers": {
    "Authorization": "Bearer your-token"
  }
}
```

**SSE 类型**：

```json
{
  "type": "sse",
  "url": "http://localhost:3000/sse",
  "headers": {}
}
```

配置保存后，应用会自动探测连接状态。绿色指示灯表示连接成功。

### Skills 技能配置

1. 进入设置 → **Skills** 标签页
2. 内置技能（`find-skills`、`skill-creator`）自动加载
3. 通过 `find-skills` 技能搜索更多可用技能
4. 已安装的技能可通过斜杠命令调用（如 `/find-skills`）

---

## 架构概览

### 三层架构

```
┌──────────────────────────────────────────────────┐
│            Frontend (React / TypeScript)          │
│                                                   │
│  UI 组件 · Zustand 状态管理 · Tauri IPC 调用      │
│  流式渲染 · 文件预览 · 配置管理 UI                 │
└─────────────────────────┬────────────────────────┘
                          │ Tauri IPC (invoke / listen)
┌─────────────────────────▼────────────────────────┐
│             Tauri Bridge (Rust)                   │
│                                                   │
│  SQLite 数据库 · 配置文件管理                      │
│  MCP 服务器 CRUD · Skills 管理                    │
│  Agent 会话生命周期 · 文件系统操作                  │
│  MCP 探测 · Sidecar 进程管理                      │
└─────────────────────────┬────────────────────────┘
                          │ stdin / stdout JSON lines
┌─────────────────────────▼────────────────────────┐
│           Agent Sidecar (Node.js)                 │
│                                                   │
│  @anthropic-ai/claude-agent-sdk                   │
│  MCP 进程管理 · 流式响应转发                       │
│  系统提示词构建 · 权限管理                          │
└──────────────────────────────────────────────────┘
```

**前端** 负责 UI 渲染和用户交互，通过 Tauri IPC 与 Rust 后端通信。所有状态管理使用 Zustand，组件基于 Radix UI 构建。

**Rust 后端** 是应用的核心，负责：
- 数据持久化（SQLite）：会话、消息、MCP 服务器、Skills
- 配置管理：提供商设置、主题偏好
- Agent 会话生命周期：启动/停止 Sidecar 进程
- MCP 探测：启动时验证 MCP 服务器连通性并缓存指令
- 文件操作：读取文件内容、生成 Diff

**Agent Sidecar** 是一个 Node.js 子进程，封装了 Claude Agent SDK：
- 通过 stdin/stdout JSON 行协议与 Rust 后端通信
- 管理 MCP 服务器进程的生命周期
- 构建系统提示词（包含 MCP 指令）
- 流式转发 AI 响应到前端

### 数据存储

| 数据 | 存储位置 | 说明 |
|------|---------|------|
| 会话、消息、Agent 事件 | SQLite | 主要数据存储 |
| MCP 服务器配置 | SQLite + `~/.claude.json` | 双写，兼容 Claude CLI |
| Skills 技能 | SQLite + `~/.claude/skills/` | 元数据在 DB，文件在磁盘 |
| 提供商与应用设置 | `config.json` | 应用配置文件 |

SQLite 数据库使用 `rusqlite` 的 `bundled` 特性，无需额外安装数据库服务。

### 数据库 Schema

```sql
-- 项目
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 会话
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    provider_id TEXT,
    model TEXT,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    mode TEXT NOT NULL DEFAULT 'chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 消息
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 工具调用
CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    arguments TEXT,
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- MCP 服务器
CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    subtitle TEXT,
    transport_type TEXT NOT NULL,
    transport_config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Skills 技能
CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT,
    description TEXT,
    source_repo TEXT,
    source_path TEXT,
    version TEXT,
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    disk_path TEXT
);
```

---

## 项目结构

```
codeMUX/
├── package.json                        # 前端依赖与脚本
├── tsconfig.json                       # TypeScript 配置
├── vite.config.ts                      # Vite 构建配置
├── tailwind.config.js                  # Tailwind CSS 配置
├── postcss.config.js                   # PostCSS 配置
├── index.html                          # HTML 入口
├── src/                                # React 前端源码
│   ├── main.tsx                        # 应用入口
│   ├── App.tsx                         # 根组件
│   ├── components/
│   │   ├── agent/                      # Agent 对话面板
│   │   │   ├── AgentPanel.tsx          # 主面板容器
│   │   │   ├── AgentInput.tsx          # 输入框组件
│   │   │   ├── AgentMessageList.tsx    # 消息列表
│   │   │   ├── MarkdownRenderer.tsx    # Markdown 渲染器
│   │   │   ├── ToolCallCard.tsx        # 工具调用卡片
│   │   │   ├── DiffBlock.tsx           # Diff 代码对比块
│   │   │   ├── TerminalBlock.tsx       # 终端输出块
│   │   │   ├── ThinkingBlock.tsx       # Thinking 思考块
│   │   │   ├── TodoList.tsx            # Todo 列表
│   │   │   ├── AskUserCard.tsx         # 交互式提问卡片
│   │   │   ├── SlashCommandMenu.tsx    # 斜杠命令菜单
│   │   │   └── ContextProgress.tsx     # 上下文进度条
│   │   ├── layout/                     # 布局组件
│   │   │   ├── MainLayout.tsx          # 主布局
│   │   │   ├── Sidebar.tsx             # 侧边栏
│   │   │   └── TitleBar.tsx            # 自定义标题栏
│   │   ├── preview/                    # 文件预览面板
│   │   │   ├── PreviewPanel.tsx        # 预览主面板
│   │   │   ├── FileTree.tsx            # 文件树
│   │   │   ├── FileView.tsx            # 文件内容查看
│   │   │   └── DiffView.tsx            # Diff 视图
│   │   ├── session/                    # 会话管理
│   │   │   ├── SessionList.tsx         # 会话列表
│   │   │   ├── SessionItem.tsx         # 会话条目
│   │   │   └── ProjectGroup.tsx        # 项目分组
│   │   ├── settings/                   # 设置面板
│   │   │   ├── SettingsDialog.tsx      # 设置对话框（5 个标签页）
│   │   │   ├── ProviderConfig.tsx      # 提供商配置
│   │   │   ├── McpSettings.tsx         # MCP 服务器管理
│   │   │   ├── SkillsSettings.tsx      # Skills 技能管理
│   │   │   └── ThemeToggle.tsx         # 主题切换
│   │   └── ui/                         # 基础 UI 组件
│   │       ├── button.tsx
│   │       ├── input.tsx
│   │       ├── dialog.tsx
│   │       ├── select.tsx
│   │       ├── switch.tsx
│   │       ├── tooltip.tsx
│   │       └── ...
│   ├── stores/                         # Zustand 状态管理
│   │   ├── agentStore.ts               # Agent 会话状态
│   │   ├── sessionStore.ts             # 会话列表状态
│   │   ├── settingsStore.ts            # 应用设置状态
│   │   ├── projectStore.ts             # 项目管理状态
│   │   ├── mcpStore.ts                 # MCP 服务器状态
│   │   ├── skillStore.ts               # Skills 技能状态
│   │   └── previewStore.ts             # 文件预览状态
│   ├── types/                          # TypeScript 类型定义
│   │   ├── agent.ts                    # Agent 事件与消息类型
│   │   ├── session.ts                  # 会话类型
│   │   ├── provider.ts                 # 提供商类型
│   │   ├── project.ts                  # 项目类型
│   │   ├── mcp.ts                      # MCP 类型
│   │   └── skill.ts                    # Skill 类型
│   ├── lib/                            # 工具函数
│   │   ├── tauri.ts                    # Tauri IPC API 封装
│   │   ├── slashCommands.ts            # 斜杠命令注册
│   │   ├── pricing.ts                  # Token 费用计算
│   │   └── utils.ts                    # 通用工具函数
│   └── hooks/
│       └── useTheme.ts                 # 主题 Hook
├── src-tauri/                          # Rust 后端
│   ├── Cargo.toml                      # Rust 依赖配置
│   ├── tauri.conf.json                 # Tauri 应用配置
│   ├── build.rs                        # 构建脚本
│   ├── icons/                          # 应用图标
│   ├── src/
│   │   ├── main.rs                     # Rust 入口
│   │   ├── lib.rs                      # AppState 定义、命令注册
│   │   ├── agent/
│   │   │   ├── mod.rs                  # Sidecar 进程管理
│   │   │   └── commands.rs             # Agent Tauri 命令
│   │   ├── commands/
│   │   │   ├── provider.rs             # 提供商命令
│   │   │   ├── session.rs              # 会话命令
│   │   │   ├── project.rs              # 项目命令
│   │   │   ├── file.rs                 # 文件操作命令
│   │   │   └── mcp.rs                  # MCP 命令（探测、CRUD）
│   │   ├── config/
│   │   │   └── mod.rs                  # AppConfig 定义与加载
│   │   ├── db/
│   │   │   ├── mod.rs                  # 数据库初始化
│   │   │   ├── schema.rs               # Schema 定义与迁移
│   │   │   └── mod.rs                  # 数据库操作
│   │   ├── mcp/
│   │   │   ├── types.rs                # MCP 类型定义
│   │   │   ├── db.rs                   # MCP 数据库操作
│   │   │   ├── adapter.rs              # 适配器 Trait
│   │   │   └── adapters/
│   │   │       └── claude.rs           # Claude 适配器（SDK 配置 + 双写）
│   │   └── skills/
│   │       ├── types.rs                # Skill 类型定义
│   │       ├── db.rs                   # Skill 数据库操作
│   │       ├── commands.rs             # Skill Tauri 命令
│   │       └── builtin.rs              # 内置技能定义
│   └── sidecar/                        # Node.js Agent Sidecar
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                # Sidecar 主逻辑（stdin/stdout 通信）
│           └── types.ts                # SidecarCommand 类型定义
└── docs/                               # 项目文档
    └── superpowers/
        ├── plans/                      # 实现计划
        └── specs/                      # 设计规格文档
```

---

## 常见问题

### 应用启动后白屏

确保已安装 [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)（Windows 10 1803+ 通常已预装）。

### `npm run tauri dev` 报错 Rust 编译失败

确认 Rust 工具链已正确安装：

```bash
rustc --version
cargo --version
```

如未安装，请访问 https://www.rust-lang.org/tools/install

### Node.js 版本过低

codeMUX 要求 Node.js >= 18。使用 [nvm](https://github.com/nvm-sh/nvm) 管理多版本：

```bash
nvm install 18
nvm use 18
```

### MCP 服务器连接失败

1. 检查 MCP 服务器配置中的命令/URL 是否正确
2. 对于 stdio 类型，确保依赖已安装（如 `npx -y` 会自动下载）
3. 点击 MCP 设置页面的刷新按钮重新探测
4. 检查网络代理设置

### Sidecar 启动失败

Sidecar 是 Node.js 子进程，确保：
1. `src-tauri/sidecar/node_modules` 已安装（`cd src-tauri/sidecar && npm install`）
2. `src-tauri/sidecar/dist/` 已构建（`npm run build`）
3. Node.js 可在系统 PATH 中找到

### macOS 提示"无法验证开发者"

```bash
xattr -cr /Applications/codeMUX.app
```

### Linux 缺少依赖

参见 [环境要求](#linux-额外要求) 中的包安装命令。

---

## 路线图

- [ ] 多 Agent 后端支持（OpenAI Codex、Gemini CLI 等）
- [ ] 内置终端集成
- [ ] 插件系统
- [ ] 国际化（i18n）
- [ ] CI/CD 自动构建与发布
- [ ] 更多内置 Skills
- [ ] 协作模式
- [ ] 移动端适配

---

## 贡献指南

欢迎贡献代码、报告问题或提出建议！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解完整的贡献流程、Commit 规范和代码规范。

### 快速参与

1. **Fork** 本仓库
2. 创建你的特性分支：`git checkout -b feature/amazing-feature`
3. 提交你的修改：`git commit -m 'feat: add amazing feature'`
4. 推送到分支：`git push origin feature/amazing-feature`
5. 打开一个 **Pull Request**（请使用 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)）

### 报告问题

使用 [GitHub Issues](https://github.com/vzi777/codeMUX/issues) 报告问题，我们会提供 Bug 报告、功能建议和提问三种模板。

详细的变更日志请查看 [CHANGELOG.md](CHANGELOG.md)。

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

---

## 致谢

- [Tauri](https://tauri.app/) — 跨平台桌面应用框架
- [Anthropic](https://www.anthropic.com/) — Claude Agent SDK
- [Model Context Protocol](https://modelcontextprotocol.io/) — MCP 协议规范
- [Radix UI](https://www.radix-ui.com/) — 无样式 UI 组件库
- [Tailwind CSS](https://tailwindcss.com/) — 实用优先的 CSS 框架
- [Zustand](https://zustand-demo.pmnd.rs/) — 轻量状态管理

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/vzi777">vzi777</a>
</p>
