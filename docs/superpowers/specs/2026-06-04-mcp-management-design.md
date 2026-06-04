# MCP Server 管理功能设计

> **日期**: 2026-06-04
> **状态**: 设计中
> **范围**: Claude Code MCP 配置管理，架构预留多工具扩展

## 1. 背景与目标

codeMUX 目前没有任何 MCP（Model Context Protocol）管理功能。用户如果要使用 MCP server，需要手动编辑 `~/.claude.json` 文件。

**目标**：在 codeMUX 中提供 MCP server 的可视化管理界面，支持 CRUD 操作和启用/禁用开关，配置通过 sidecar 协议传递给 Claude Agent SDK。

**参考**：cc-switch 项目的架构设计（SQLite 存储 + 适配器模式）。

## 2. 需求

| 项目 | 决策 |
|------|------|
| 定位 | 先做 Claude Code，架构预留多工具扩展 |
| 作用域 | 全局（用户级），所有项目共享 |
| UI 位置 | 设置对话框中增加 MCP 标签页 |
| 功能 | CRUD 管理 + 启用/禁用开关 |
| 传输类型 | 全部三种：stdio、HTTP Streaming、SSE |
| 配置传递 | 通过 sidecar 协议传递给 Claude Agent SDK |
| 双写 | 同时写入 ~/.claude.json，保证 standalone CLI 可用 |

## 3. 数据模型

### 3.1 Rust 类型

```rust
// src-tauri/src/mcp/types.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub id: String,              // UUID
    pub name: String,            // 用户定义的名称
    pub description: String,     // 可选描述
    pub transport: McpTransport, // 传输类型及配置
    pub enabled: bool,           // 是否启用
    pub created_at: String,      // ISO 8601
    pub updated_at: String,      // ISO 8601
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum McpTransport {
    #[serde(rename = "stdio")]
    Stdio {
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
    #[serde(rename = "http")]
    Http {
        url: String,
        headers: HashMap<String, String>,
    },
    #[serde(rename = "sse")]
    Sse {
        url: String,
        headers: HashMap<String, String>,
    },
}
```

### 3.2 SQLite 表

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    transport_type TEXT NOT NULL,       -- 'stdio' | 'http' | 'sse'
    transport_config TEXT NOT NULL,     -- JSON: {command,args,env} 或 {url,headers}
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
```

`transport_config` 以 JSON 字符串存储，避免为不同传输类型的字段差异使用多列。

### 3.3 TypeScript 类型

```typescript
// src/types/mcp.ts

export type McpTransportType = 'stdio' | 'http' | 'sse';

export interface McpTransportStdio {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpTransportHttp {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface McpTransportSse {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpTransport = McpTransportStdio | McpTransportHttp | McpTransportSse;

export interface McpServer {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
```

## 4. 后端架构

### 4.1 模块结构

```
src-tauri/src/
├── mcp/
│   ├── mod.rs              # 模块入口，re-export
│   ├── types.rs            # McpServer, McpTransport 定义
│   ├── db.rs               # SQLite CRUD 操作
│   ├── adapter.rs          # McpAdapter trait 定义
│   └── adapters/
│       ├── mod.rs           # 适配器注册
│       └── claude.rs        # Claude Code 适配器
├── commands/
│   └── mcp.rs              # Tauri 命令处理器
```

### 4.2 Adapter Trait

```rust
// src-tauri/src/mcp/adapter.rs

pub trait McpAdapter {
    /// 将统一格式的 McpServer 列表转为目标工具的配置格式
    fn to_config(&self, servers: &[McpServer]) -> Result<serde_json::Value, String>;

    /// 从目标工具的配置文件导入 MCP server 列表
    fn import_from_config(&self, config: &serde_json::Value) -> Result<Vec<McpServer>, String>;

    /// 将启用的 MCP server 同步写入目标工具的配置文件
    fn sync_to_config_file(&self, servers: &[McpServer]) -> Result<(), String>;
}
```

### 4.3 Claude 适配器

Claude Code 的 MCP 配置位于 `~/.claude.json` 的 `mcpServers` 字段：

```json
{
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    },
    "remote-server": {
      "type": "sse",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

`claude.rs` 实现要点：
- `to_config()` → 将 `McpServer` 列表转为 `mcpServers` JSON 格式
- `to_sdk_config()` → 将 `McpServer` 列表转为 Claude Agent SDK 的 `Record<string, McpServerConfig>` 格式（用于 sidecar 传递）
- `import_from_config()` → 从 `~/.claude.json` 读取并转为 `McpServer`
- `sync_to_config_file()` → 读取现有 `~/.claude.json`，更新 `mcpServers` 字段，写回文件
- **双写触发时机**：在 `upsert_mcp_server`、`delete_mcp_server`、`toggle_mcp_server` 三个操作执行后，自动调用 `sync_to_config_file()` 同步到 `~/.claude.json`
- Windows 特殊处理：stdio 类型在 Windows 下需要 `cmd /c` 包装（参考 cc-switch 经验）

### 4.4 数据库操作

```rust
// src-tauri/src/mcp/db.rs

pub fn init_mcp_table(db: &Connection) -> Result<(), String>;
pub fn get_all_mcp_servers(db: &Connection) -> Result<Vec<McpServer>, String>;
pub fn get_mcp_server(db: &Connection, id: &str) -> Result<Option<McpServer>, String>;
pub fn upsert_mcp_server(db: &Connection, server: &McpServer) -> Result<(), String>;
pub fn delete_mcp_server(db: &Connection, id: &str) -> Result<bool, String>;
pub fn toggle_mcp_server(db: &Connection, id: &str) -> Result<bool, String>;
pub fn get_enabled_mcp_servers(db: &Connection) -> Result<Vec<McpServer>, String>;
```

### 4.5 Tauri 命令

```rust
// src-tauri/src/commands/mcp.rs

#[tauri::command]
pub async fn get_mcp_servers(state: State<'_, AppState>) -> Result<Vec<McpServer>, String>;

#[tauri::command]
pub async fn upsert_mcp_server(state: State<'_, AppState>, server: McpServer) -> Result<(), String>;

#[tauri::command]
pub async fn delete_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String>;

#[tauri::command]
pub async fn toggle_mcp_server(state: State<'_, AppState>, id: String) -> Result<bool, String>;
```

在 `lib.rs` 中注册这些命令，并在 `AppState` 中暴露数据库连接。

## 5. Sidecar 集成

### 5.1 关键发现

Claude Agent SDK 的 `query()` 函数原生支持 `mcpServers` 参数：

```typescript
// SDK Options 类型
interface Options {
  mcpServers?: Record<string, McpServerConfig>;
  // ...其他字段
}

// McpServerConfig 联合类型
type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type McpSSEServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};
```

### 5.2 数据流

```
用户在设置 UI 配置 MCP server
        ↓
SQLite 存储 (mcp_servers 表)
        ↓ (同时)
        ├→ ~/.claude.json 双写（standalone CLI 可用）
        ↓
启动 Agent 会话时
        ↓
Rust 从 SQLite 读取 enabled=true 的 MCP servers
        ↓
转换为 SDK 格式 (Record<string, McpServerConfig>)
        ↓
通过 sidecar stdin 命令传递 mcpServers 字段
        ↓
Sidecar 将 mcpServers 传给 query({ options: { mcpServers } })
        ↓
SDK 启动 MCP server 进程（stdio）或连接远程服务（http/sse）
```

### 5.3 Sidecar 协议扩展

当前 start 命令：
```json
{
  "type": "start",
  "prompt": "...",
  "cwd": "...",
  "sessionId": "...",
  "apiKey": "...",
  "baseUrl": "...",
  "model": "..."
}
```

扩展为：
```json
{
  "type": "start",
  "prompt": "...",
  "cwd": "...",
  "sessionId": "...",
  "apiKey": "...",
  "baseUrl": "...",
  "model": "...",
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    }
  }
}
```

### 5.4 Sidecar 端修改

在 `src-tauri/sidecar/src/index.ts` 的 `handleStart()` 函数中：

```typescript
// 在 options 对象中添加 mcpServers
const options = {
  cwd: cmd.cwd === '.' ? os.homedir() : cmd.cwd,
  // ...现有字段...
  mcpServers: cmd.mcpServers || undefined,  // 新增
};
```

### 5.5 Rust 端修改

在 `src-tauri/src/agent/commands.rs` 的 `start_agent_session()` 中，从数据库读取启用的 MCP servers 并添加到 start 命令（不需要修改函数签名）：

```rust
// 在构建 start 命令时，从 DB 读取启用的 MCP servers
let db = state.db.lock().await;
let mcp_servers = mcp::db::get_enabled_mcp_servers(&db)?;
drop(db);

// 转换为 SDK 格式并添加到命令
if !mcp_servers.is_empty() {
    let mcp_config = mcp::adapters::claude::to_sdk_config(&mcp_servers);
    cmd["mcpServers"] = mcp_config;
}
```

## 6. 前端架构

### 6.1 Zustand Store

```typescript
// src/stores/mcpStore.ts

interface McpStore {
  servers: McpServer[];
  loading: boolean;
  fetchServers: () => Promise<void>;
  upsertServer: (server: McpServer) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  toggleServer: (id: string) => Promise<void>;
}
```

### 6.2 Tauri API 封装

```typescript
// src/lib/tauri.ts 中新增

export const mcpApi = {
  getAll: () => invoke<McpServer[]>('get_mcp_servers'),
  upsert: (server: McpServer) => invoke<void>('upsert_mcp_server', { server }),
  delete: (id: string) => invoke<void>('delete_mcp_server', { id }),
  toggle: (id: string) => invoke<boolean>('toggle_mcp_server', { id }),
};
```

### 6.3 UI 组件

在设置对话框中增加 MCP 标签页：

```
SettingsDialog
├── 标签栏：Provider | MCP | 外观
└── MCP 标签页 (McpSettingsPanel)
    ├── 顶部：「添加 MCP Server」按钮
    ├── MCP Server 列表
    │   └── 每行：名称 | 传输类型 Badge | 启用开关(Switch) | 编辑/删除按钮
    └── McpFormModal（编辑/新建弹窗）
        ├── 名称输入 (Input)
        ├── 描述输入 (Input)
        ├── 传输类型选择 (Select: stdio / http / sse)
        └── 动态表单区域：
            ├── stdio: command (Input) + args (动态列表) + env (动态 key-value)
            ├── http: url (Input) + headers (动态 key-value)
            └── sse: url (Input) + headers (动态 key-value)
```

### 6.4 表单校验

- 名称：必填，不允许重复（前端校验 + 后端唯一索引）
- stdio：command 必填
- http/sse：url 必填，必须是有效 URL
- headers 和 env：key-value 对，均可选

## 7. 实现计划

### Phase 1：后端基础设施
1. 新建 `mcp/` 模块（types.rs, db.rs, adapter.rs）
2. 数据库迁移：创建 `mcp_servers` 表
3. 实现 Claude 适配器（claude.rs）
4. 实现 Tauri 命令（commands/mcp.rs）
5. 注册命令到 lib.rs

### Phase 2：Sidecar 集成
1. 修改 sidecar 协议类型定义
2. 修改 `handleStart()` 接收 mcpServers
3. 修改 `start_agent_session()` 传递 mcpServers
4. 双写逻辑：upsert/delete 时同步到 ~/.claude.json

### Phase 3：前端 UI
1. 定义 TypeScript 类型（types/mcp.ts）
2. 实现 Zustand Store（stores/mcpStore.ts）
3. 封装 Tauri API（lib/tauri.ts）
4. 实现 McpSettingsPanel 组件
5. 实现 McpFormModal 组件
6. 集成到 SettingsDialog

## 8. 未来扩展

架构预留了以下扩展点：

- **多工具适配器**：新增 `adapters/codex.rs`、`adapters/gemini.rs` 等实现 `McpAdapter` trait
- **项目级配置**：`mcp_servers` 表可增加 `scope` 列区分全局/项目级
- **导入功能**：利用 `McpAdapter::import_from_config()` 从各工具现有配置导入
- **内置 Presets**：在前端增加预设模板（context7、fetch、memory 等）
- **连接测试**：对 HTTP/SSE 类型的 MCP server 测试连通性
