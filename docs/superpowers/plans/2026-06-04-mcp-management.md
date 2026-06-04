# MCP Server 管理功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 codeMUX 中实现 MCP server 的 CRUD 管理、启用/禁用开关，并通过 sidecar 协议将配置传递给 Claude Agent SDK。

**Architecture:** SQLite 存储 MCP server 定义，Adapter trait 提供多工具扩展能力。Claude 适配器负责格式转换和双写（~/.claude.json）。配置通过 sidecar 协议的 `mcpServers` 字段传递给 SDK。

**Tech Stack:** Rust (rusqlite, serde_json), TypeScript (React, Zustand, shadcn/ui), Tauri 2 IPC

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src-tauri/src/mcp/mod.rs` | MCP 模块入口，re-export |
| `src-tauri/src/mcp/types.rs` | McpServer, McpTransport Rust 类型 |
| `src-tauri/src/mcp/db.rs` | SQLite CRUD 操作 |
| `src-tauri/src/mcp/adapter.rs` | McpAdapter trait 定义 |
| `src-tauri/src/mcp/adapters/mod.rs` | 适配器模块入口 |
| `src-tauri/src/mcp/adapters/claude.rs` | Claude Code 适配器（格式转换 + 双写） |
| `src-tauri/src/commands/mcp.rs` | Tauri 命令处理器 |
| `src/types/mcp.ts` | TypeScript MCP 类型定义 |
| `src/stores/mcpStore.ts` | Zustand 状态管理 |
| `src/components/settings/McpSettings.tsx` | MCP 设置面板 + 表单弹窗 |
| `src/components/ui/switch.tsx` | shadcn/ui Switch 组件 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src-tauri/src/lib.rs` | 添加 `mod mcp`，注册 MCP 命令 |
| `src-tauri/src/db/schema.rs` | 添加 `mcp_servers` 表创建 |
| `src-tauri/src/commands/mod.rs` | 添加 `pub mod mcp` |
| `src-tauri/src/agent/commands.rs` | `start_agent_session` 读取 MCP 配置并传递 |
| `src-tauri/sidecar/src/types.ts` | start 命令类型添加 `mcpServers` 字段 |
| `src-tauri/sidecar/src/index.ts` | `handleStart` 将 mcpServers 传给 SDK |
| `src/lib/tauri.ts` | 添加 `mcpApi` 封装 |
| `src/components/settings/SettingsDialog.tsx` | 添加 MCP 标签页 |
| `package.json` | 添加 `@radix-ui/react-switch` 依赖 |

---

## Task 1: Rust 类型定义

**Files:**
- Create: `src-tauri/src/mcp/mod.rs`
- Create: `src-tauri/src/mcp/types.rs`

- [ ] **Step 1: 创建 MCP 模块入口**

```rust
// src-tauri/src/mcp/mod.rs
pub mod types;
pub mod db;
pub mod adapter;
pub mod adapters;
```

- [ ] **Step 2: 创建类型定义文件**

```rust
// src-tauri/src/mcp/types.rs
use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub description: String,
    pub transport: McpTransport,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum McpTransport {
    #[serde(rename = "stdio")]
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    #[serde(rename = "http")]
    Http {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    #[serde(rename = "sse")]
    Sse {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

impl McpTransport {
    pub fn transport_type(&self) -> &'static str {
        match self {
            McpTransport::Stdio { .. } => "stdio",
            McpTransport::Http { .. } => "http",
            McpTransport::Sse { .. } => "sse",
        }
    }

    pub fn to_config_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}
```

- [ ] **Step 3: 在 lib.rs 中添加模块声明**

在 `src-tauri/src/lib.rs` 的 `mod agent;` 后面添加：

```rust
mod mcp;
```

- [ ] **Step 4: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译成功（可能有 unused warning，正常）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/mod.rs src-tauri/src/mcp/types.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): add MCP types and module structure"
```

---

## Task 2: 数据库 Schema

**Files:**
- Modify: `src-tauri/src/db/schema.rs`

- [ ] **Step 1: 在 `initialize_database` 中添加 mcp_servers 表**

在 `src-tauri/src/db/schema.rs` 的 `execute_batch` 中（`CREATE TABLE IF NOT EXISTS tool_calls` 之后），追加：

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    transport_type TEXT NOT NULL,
    transport_config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
```

完整修改位置：在 `schema.rs` 的第一个 `execute_batch` 调用的 SQL 字符串末尾，`tool_calls` 表定义之后，闭合引号 `";` 之前，追加上面的 SQL。

- [ ] **Step 2: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/schema.rs
git commit -m "feat(mcp): add mcp_servers table to database schema"
```

---

## Task 3: 数据库 CRUD 操作

**Files:**
- Create: `src-tauri/src/mcp/db.rs`

- [ ] **Step 1: 实现全部 CRUD 操作**

```rust
// src-tauri/src/mcp/db.rs
use rusqlite::{Connection, Result, params};
use uuid::Uuid;
use chrono::Utc;

use super::types::{McpServer, McpTransport};

/// 从数据库行构建 McpServer
fn row_to_mcp_server(row: &rusqlite::Row) -> rusqlite::Result<McpServer> {
    let transport_type: String = row.get(3)?;
    let transport_config: String = row.get(4)?;
    let enabled: i32 = row.get(5)?;

    let transport: McpTransport = serde_json::from_str(&transport_config)
        .unwrap_or(McpTransport::Stdio {
            command: String::new(),
            args: vec![],
            env: std::collections::HashMap::new(),
        });

    Ok(McpServer {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        transport,
        enabled: enabled != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub fn get_all_mcp_servers(conn: &Connection) -> Result<Vec<McpServer>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, transport_type, transport_config, enabled, created_at, updated_at
         FROM mcp_servers ORDER BY name ASC"
    )?;

    let servers = stmt.query_map([], |row| row_to_mcp_server(row))?
        .collect::<Result<Vec<_>>>()?;
    Ok(servers)
}

pub fn get_enabled_mcp_servers(conn: &Connection) -> Result<Vec<McpServer>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, transport_type, transport_config, enabled, created_at, updated_at
         FROM mcp_servers WHERE enabled = 1 ORDER BY name ASC"
    )?;

    let servers = stmt.query_map([], |row| row_to_mcp_server(row))?
        .collect::<Result<Vec<_>>>()?;
    Ok(servers)
}

pub fn upsert_mcp_server(conn: &Connection, server: &McpServer) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let transport_config = server.transport.to_config_json().to_string();
    let transport_type = server.transport.transport_type();
    let enabled: i32 = if server.enabled { 1 } else { 0 };

    conn.execute(
        "INSERT INTO mcp_servers (id, name, description, transport_type, transport_config, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             transport_type = excluded.transport_type,
             transport_config = excluded.transport_config,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at",
        params![server.id, server.name, server.description, transport_type, transport_config, enabled,
                server.created_at, now],
    )?;
    Ok(())
}

pub fn delete_mcp_server(conn: &Connection, id: &str) -> Result<bool> {
    let rows = conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
    Ok(rows > 0)
}

pub fn toggle_mcp_server(conn: &Connection, id: &str) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE mcp_servers SET enabled = NOT enabled, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;

    let enabled: bool = conn.query_row(
        "SELECT enabled FROM mcp_servers WHERE id = ?1",
        params![id],
        |row| {
            let v: i32 = row.get(0)?;
            Ok(v != 0)
        },
    )?;
    Ok(enabled)
}

pub fn create_mcp_server(conn: &Connection, name: &str, description: &str, transport: &McpTransport) -> Result<McpServer> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let server = McpServer {
        id,
        name: name.to_string(),
        description: description.to_string(),
        transport: transport.clone(),
        enabled: true,
        created_at: now.clone(),
        updated_at: now,
    };
    upsert_mcp_server(conn, &server)?;
    Ok(server)
}
```

- [ ] **Step 2: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/mcp/db.rs
git commit -m "feat(mcp): implement SQLite CRUD operations for MCP servers"
```

---

## Task 4: Adapter Trait + Claude 适配器

**Files:**
- Create: `src-tauri/src/mcp/adapter.rs`
- Create: `src-tauri/src/mcp/adapters/mod.rs`
- Create: `src-tauri/src/mcp/adapters/claude.rs`

- [ ] **Step 1: 定义 Adapter Trait**

```rust
// src-tauri/src/mcp/adapter.rs
use super::types::McpServer;

pub trait McpAdapter {
    /// 将统一格式转为目标工具配置 JSON
    fn to_config(&self, servers: &[McpServer]) -> Result<serde_json::Value, String>;
    /// 从目标工具配置导入
    fn import_from_config(&self, config: &serde_json::Value) -> Result<Vec<McpServer>, String>;
    /// 同步启用的 servers 到目标工具配置文件
    fn sync_to_config_file(&self, servers: &[McpServer]) -> Result<(), String>;
}
```

- [ ] **Step 2: 创建适配器模块入口**

```rust
// src-tauri/src/mcp/adapters/mod.rs
pub mod claude;
```

- [ ] **Step 3: 实现 Claude 适配器**

```rust
// src-tauri/src/mcp/adapters/claude.rs
use std::collections::HashMap;
use std::path::PathBuf;
use crate::mcp::types::{McpServer, McpTransport};
use crate::mcp::adapter::McpAdapter;

fn claude_config_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".claude.json")
}

/// 将 McpServer 列表转为 Claude SDK mcpServers 格式
pub fn to_sdk_config(servers: &[McpServer]) -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> = servers
        .iter()
        .map(|s| {
            let mut config = s.transport.to_config_json();
            // Claude SDK 不需要顶层 type 字段（stdio 除外）
            if let serde_json::Value::Object(ref mut obj) = config {
                // stdio 不显式设置 type（SDK 默认就是 stdio）
                if matches!(&s.transport, McpTransport::Stdio { .. }) {
                    obj.remove("type");
                }
            }
            (s.name.clone(), config)
        })
        .collect();
    serde_json::Value::Object(map)
}

pub struct ClaudeAdapter;

impl McpAdapter for ClaudeAdapter {
    fn to_config(&self, servers: &[McpServer]) -> Result<serde_json::Value, String> {
        Ok(to_sdk_config(servers))
    }

    fn import_from_config(&self, config: &serde_json::Value) -> Result<Vec<McpServer>, String> {
        let mcp_servers = config.get("mcpServers")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        let mut result = Vec::new();
        for (name, server_config) in mcp_servers {
            let transport: McpTransport = serde_json::from_value(server_config.clone())
                .map_err(|e| format!("Failed to parse MCP server '{}': {}", name, e))?;

            let now = chrono::Utc::now().to_rfc3339();
            result.push(McpServer {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                description: String::new(),
                transport,
                enabled: true,
                created_at: now.clone(),
                updated_at: now,
            });
        }
        Ok(result)
    }

    fn sync_to_config_file(&self, servers: &[McpServer]) -> Result<(), String> {
        let path = claude_config_path();

        // 读取现有配置（如果存在）
        let mut config: serde_json::Value = if path.exists() {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read ~/.claude.json: {}", e))?;
            serde_json::from_str(&content)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
        } else {
            serde_json::Value::Object(serde_json::Map::new())
        };

        // 更新 mcpServers 字段
        let mcp_config = self.to_config(servers)?;
        if let serde_json::Value::Object(ref mut obj) = config {
            if mcp_config.as_object().map_or(true, |m| m.is_empty()) {
                obj.remove("mcpServers");
            } else {
                obj.insert("mcpServers".to_string(), mcp_config);
            }
        }

        // 写回文件
        let content = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write ~/.claude.json: {}", e))?;

        Ok(())
    }
}
```

- [ ] **Step 4: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译成功

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/adapter.rs src-tauri/src/mcp/adapters/
git commit -m "feat(mcp): add McpAdapter trait and Claude adapter with dual-write"
```

---

## Task 5: Tauri 命令

**Files:**
- Create: `src-tauri/src/commands/mcp.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 实现 Tauri 命令**

```rust
// src-tauri/src/commands/mcp.rs
use tauri::State;
use crate::AppState;
use crate::mcp::types::McpServer;
use crate::mcp::{db, adapters};

#[tauri::command]
pub fn get_mcp_servers(state: State<'_, AppState>) -> Result<Vec<McpServer>, String> {
    let db = state.db.lock().unwrap();
    db::get_all_mcp_servers(&db).map_err(|e| format!("Failed to get MCP servers: {}", e))
}

#[tauri::command]
pub fn upsert_mcp_server(state: State<'_, AppState>, server: McpServer) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db::upsert_mcp_server(&db, &server).map_err(|e| format!("Failed to save MCP server: {}", e))?;

    // 双写到 ~/.claude.json
    let all_servers = db::get_enabled_mcp_servers(&db)
        .map_err(|e| format!("Failed to get enabled servers: {}", e))?;
    drop(db);

    let adapter = adapters::claude::ClaudeAdapter;
    adapter.sync_to_config_file(&all_servers)?;
    Ok(())
}

#[tauri::command]
pub fn delete_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db::delete_mcp_server(&db, &id).map_err(|e| format!("Failed to delete MCP server: {}", e))?;

    // 双写
    let all_servers = db::get_enabled_mcp_servers(&db)
        .map_err(|e| format!("Failed to get enabled servers: {}", e))?;
    drop(db);

    let adapter = adapters::claude::ClaudeAdapter;
    adapter.sync_to_config_file(&all_servers)?;
    Ok(())
}

#[tauri::command]
pub fn toggle_mcp_server(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let db = state.db.lock().unwrap();
    let new_state = db::toggle_mcp_server(&db, &id)
        .map_err(|e| format!("Failed to toggle MCP server: {}", e))?;

    // 双写
    let all_servers = db::get_enabled_mcp_servers(&db)
        .map_err(|e| format!("Failed to get enabled servers: {}", e))?;
    drop(db);

    let adapter = adapters::claude::ClaudeAdapter;
    adapter.sync_to_config_file(&all_servers)?;
    Ok(new_state)
}
```

- [ ] **Step 2: 注册命令模块**

在 `src-tauri/src/commands/mod.rs` 中添加：

```rust
pub mod mcp;
```

- [ ] **Step 3: 在 lib.rs 中注册命令**

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中添加（在 `commands::file::list_directory,` 之后）：

```rust
            commands::mcp::get_mcp_servers,
            commands::mcp::upsert_mcp_server,
            commands::mcp::delete_mcp_server,
            commands::mcp::toggle_mcp_server,
```

- [ ] **Step 4: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译成功

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/mcp.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): add Tauri commands for MCP server CRUD"
```

---

## Task 6: Sidecar 集成

**Files:**
- Modify: `src-tauri/sidecar/src/types.ts`
- Modify: `src-tauri/sidecar/src/index.ts`
- Modify: `src-tauri/src/agent/commands.rs`

- [ ] **Step 1: 扩展 SidecarCommand 类型**

修改 `src-tauri/sidecar/src/types.ts` 的 `SidecarCommand`，在 start 类型中添加 `mcpServers` 字段：

```typescript
export type SidecarCommand =
  | { type: 'start'; prompt: string; cwd: string; sessionId?: string; apiKey?: string; baseUrl?: string; model?: string; mcpServers?: Record<string, unknown> }
  | { type: 'reset_session'; sessionId: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' }
  | { type: 'tool_response'; toolUseId: string; response: unknown };
```

- [ ] **Step 2: 在 sidecar handleStart 中传递 mcpServers**

修改 `src-tauri/sidecar/src/index.ts` 的 `handleStart` 函数。在 `const options = {` 对象中（约第 141 行），在 `env: subprocessEnv,` 之后添加：

```typescript
            mcpServers: cmd.mcpServers || undefined,
```

- [ ] **Step 3: 在 Rust 端读取 MCP 配置并传递**

修改 `src-tauri/src/agent/commands.rs` 的 `start_agent_session` 函数。

首先，在函数签名中添加 `AppState` 参数（在 `app: AppHandle,` 之后）：

```rust
pub async fn start_agent_session(
    app: AppHandle,
    state: State<'_, crate::AppState>,  // 新增
    agent_state: State<'_, AgentState>,
    session_id: String,
    // ...其余参数不变
```

在文件顶部添加 import：
```rust
use crate::AppState;
```

然后，在 `let mut cmd = serde_json::json!({` 之前（约第 73 行），添加读取 MCP 配置的逻辑：

```rust
    // 读取启用的 MCP servers
    let mcp_servers = {
        let db = state.db.lock().unwrap();
        crate::mcp::db::get_enabled_mcp_servers(&db).unwrap_or_default()
    };
```

在 `if let Some(m) = model {` 块之后（约第 88 行），添加：

```rust
    if !mcp_servers.is_empty() {
        let mcp_config = crate::mcp::adapters::claude::to_sdk_config(&mcp_servers);
        if !mcp_config.as_object().map_or(true, |o| o.is_empty()) {
            cmd["mcpServers"] = mcp_config;
        }
    }
```

- [ ] **Step 4: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译成功

- [ ] **Step 5: 构建 sidecar**

Run: `cd src-tauri/sidecar && npx tsc`
Expected: 编译成功

- [ ] **Step 6: Commit**

```bash
git add src-tauri/sidecar/src/types.ts src-tauri/sidecar/src/index.ts src-tauri/src/agent/commands.rs src-tauri/sidecar/dist/
git commit -m "feat(mcp): pass MCP config to Claude Agent SDK via sidecar protocol"
```

---

## Task 7: 前端 TypeScript 类型 + API

**Files:**
- Create: `src/types/mcp.ts`
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: 创建 TypeScript 类型**

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

- [ ] **Step 2: 在 tauri.ts 中添加 mcpApi**

在 `src/lib/tauri.ts` 的末尾（`export const fileApi = {` 块之后），添加：

```typescript
export const mcpApi = {
  getAll: (): Promise<McpServer[]> => invoke('get_mcp_servers'),
  upsert: (server: McpServer): Promise<void> => invoke('upsert_mcp_server', { server }),
  delete: (id: string): Promise<void> => invoke('delete_mcp_server', { id }),
  toggle: (id: string): Promise<boolean> => invoke('toggle_mcp_server', { id }),
};
```

同时在文件顶部的 import 区域添加：

```typescript
import type { McpServer } from '../types/mcp';
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `cd d:\project\ai-code\codeMUX && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/types/mcp.ts src/lib/tauri.ts
git commit -m "feat(mcp): add TypeScript types and Tauri API for MCP management"
```

---

## Task 8: Zustand Store

**Files:**
- Create: `src/stores/mcpStore.ts`

- [ ] **Step 1: 实现 MCP Store**

```typescript
// src/stores/mcpStore.ts
import { create } from 'zustand';
import type { McpServer } from '../types/mcp';
import { mcpApi } from '../lib/tauri';

interface McpStore {
  servers: McpServer[];
  isLoading: boolean;
  error: string | null;
  fetchServers: () => Promise<void>;
  upsertServer: (server: McpServer) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  toggleServer: (id: string) => Promise<void>;
}

export const useMcpStore = create<McpStore>((set) => ({
  servers: [],
  isLoading: false,
  error: null,

  fetchServers: async () => {
    set({ isLoading: true, error: null });
    try {
      const servers = await mcpApi.getAll();
      set({ servers, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  upsertServer: async (server: McpServer) => {
    try {
      await mcpApi.upsert(server);
      set((state) => {
        const exists = state.servers.some((s) => s.id === server.id);
        const servers = exists
          ? state.servers.map((s) => (s.id === server.id ? server : s))
          : [...state.servers, server];
        return { servers };
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteServer: async (id: string) => {
    try {
      await mcpApi.delete(id);
      set((state) => ({
        servers: state.servers.filter((s) => s.id !== id),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  toggleServer: async (id: string) => {
    try {
      const newEnabled = await mcpApi.toggle(id);
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === id ? { ...s, enabled: newEnabled } : s
        ),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
}));
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd d:\project\ai-code\codeMUX && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/stores/mcpStore.ts
git commit -m "feat(mcp): add Zustand store for MCP server state management"
```

---

## Task 9: UI 组件 — Switch + Badge

**Files:**
- Modify: `package.json`（添加 @radix-ui/react-switch）
- Create: `src/components/ui/switch.tsx`

- [ ] **Step 1: 安装 Switch 依赖**

Run: `cd d:\project\ai-code\codeMUX && npm install @radix-ui/react-switch`
Expected: 安装成功

- [ ] **Step 2: 创建 Switch 组件**

```tsx
// src/components/ui/switch.tsx
import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { cn } from "../../lib/utils"

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
      )}
    />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName

export { Switch }
```

- [ ] **Step 3: 验证编译**

Run: `cd d:\project\ai-code\codeMUX && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/components/ui/switch.tsx
git commit -m "feat(ui): add Switch component from shadcn/ui"
```

---

## Task 10: MCP 设置面板

**Files:**
- Create: `src/components/settings/McpSettings.tsx`

- [ ] **Step 1: 实现 MCP 设置面板（含列表 + 表单弹窗）**

```tsx
// src/components/settings/McpSettings.tsx
import { useState, useEffect } from 'react';
import { useMcpStore } from '../../stores/mcpStore';
import type { McpServer, McpTransport, McpTransportType } from '../../types/mcp';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { Plus, Pencil, Trash2, Loader2, Server } from 'lucide-react';

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function defaultTransport(type: McpTransportType): McpTransport {
  switch (type) {
    case 'stdio':
      return { type: 'stdio', command: '', args: [], env: {} };
    case 'http':
      return { type: 'http', url: '', headers: {} };
    case 'sse':
      return { type: 'sse', url: '', headers: {} };
  }
}

export function McpSettingsPanel() {
  const { servers, isLoading, fetchServers, upsertServer, deleteServer, toggleServer } = useMcpStore();
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const openNew = () => {
    const now = new Date().toISOString();
    setEditing({
      id: generateId(),
      name: '',
      description: '',
      transport: defaultTransport('stdio'),
      enabled: true,
      created_at: now,
      updated_at: now,
    });
    setIsNew(true);
    setSaveError('');
    setDeleteConfirm(false);
  };

  const openEdit = (server: McpServer) => {
    setEditing({ ...server });
    setIsNew(false);
    setSaveError('');
    setDeleteConfirm(false);
  };

  const closeModal = () => {
    setEditing(null);
    setSaveError('');
    setDeleteConfirm(false);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaveError('');

    // 校验
    if (!editing.name.trim()) {
      setSaveError('请填写名称');
      return;
    }
    const t = editing.transport;
    if (t.type === 'stdio' && !t.command.trim()) {
      setSaveError('请填写 command');
      return;
    }
    if ((t.type === 'http' || t.type === 'sse') && !t.url.trim()) {
      setSaveError('请填写 url');
      return;
    }

    // 检查名称重复（排除自身）
    const nameExists = servers.some(
      (s) => s.name === editing.name.trim() && s.id !== editing.id
    );
    if (nameExists) {
      setSaveError('名称已存在');
      return;
    }

    try {
      await upsertServer({ ...editing, name: editing.name.trim() });
      closeModal();
    } catch {
      setSaveError('保存失败');
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    try {
      await deleteServer(editing.id);
      closeModal();
    } catch {
      // error handled by store
    }
  };

  const handleToggle = async (id: string) => {
    await toggleServer(id);
  };

  const updateTransportType = (type: McpTransportType) => {
    if (!editing) return;
    setEditing({ ...editing, transport: defaultTransport(type) });
  };

  const updateTransportField = (field: string, value: string) => {
    if (!editing) return;
    setEditing({
      ...editing,
      transport: { ...editing.transport, [field]: value } as McpTransport,
    });
  };

  // Args 管理（stdio）
  const updateArgs = (argsStr: string) => {
    if (!editing || editing.transport.type !== 'stdio') return;
    const args = argsStr.split('\n').filter((a) => a.trim());
    setEditing({
      ...editing,
      transport: { ...editing.transport, args },
    });
  };

  // Headers/Env 管理
  const updateKeyValue = (field: 'headers' | 'env', raw: string) => {
    if (!editing) return;
    const obj: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    setEditing({
      ...editing,
      transport: { ...editing.transport, [field]: obj } as McpTransport,
    });
  };

  const transportBadge = (type: McpTransportType) => {
    const colors = {
      stdio: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      http: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      sse: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
    };
    return (
      <span className={`text-xs px-1.5 py-0.5 rounded ${colors[type]}`}>
        {type}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">MCP Servers</h3>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" />
          添加
        </Button>
      </div>

      {isLoading && servers.length === 0 && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          加载中...
        </div>
      )}

      {!isLoading && servers.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <Server className="h-8 w-8 mb-2 opacity-50" />
          <p className="text-sm">暂无 MCP Server</p>
          <p className="text-xs">点击上方按钮添加</p>
        </div>
      )}

      <div className="space-y-2">
        {servers.map((server) => (
          <div
            key={server.id}
            className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">{server.name}</span>
                {transportBadge(server.transport.type)}
              </div>
              {server.description && (
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {server.description}
                </p>
              )}
            </div>
            <Switch
              checked={server.enabled}
              onCheckedChange={() => handleToggle(server.id)}
            />
            <Button variant="ghost" size="sm" onClick={() => openEdit(server)}>
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* 编辑/新建弹窗 */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{isNew ? '添加 MCP Server' : '编辑 MCP Server'}</DialogTitle>
          </DialogHeader>

          {editing && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">名称</label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="例如 context7"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">描述</label>
                <Input
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  placeholder="可选"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">传输类型</label>
                <Select
                  value={editing.transport.type}
                  onValueChange={(v) => updateTransportType(v as McpTransportType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">stdio（本地进程）</SelectItem>
                    <SelectItem value="http">HTTP Streaming</SelectItem>
                    <SelectItem value="sse">SSE（Server-Sent Events）</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* stdio 字段 */}
              {editing.transport.type === 'stdio' && (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Command</label>
                    <Input
                      value={editing.transport.command}
                      onChange={(e) => updateTransportField('command', e.target.value)}
                      placeholder="例如 npx"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Args（每行一个）</label>
                    <textarea
                      className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      value={(editing.transport.args || []).join('\n')}
                      onChange={(e) => updateArgs(e.target.value)}
                      placeholder={"-y\n@upstash/context7-mcp@latest"}
                      rows={3}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">环境变量（KEY=VALUE，每行一个）</label>
                    <textarea
                      className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      value={Object.entries(editing.transport.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')}
                      onChange={(e) => updateKeyValue('env', e.target.value)}
                      placeholder={"API_KEY=xxx"}
                      rows={2}
                    />
                  </div>
                </>
              )}

              {/* http/sse 字段 */}
              {(editing.transport.type === 'http' || editing.transport.type === 'sse') && (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">URL</label>
                    <Input
                      value={editing.transport.url}
                      onChange={(e) => updateTransportField('url', e.target.value)}
                      placeholder="https://example.com/mcp"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Headers（KEY=VALUE，每行一个）</label>
                    <textarea
                      className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      value={Object.entries(editing.transport.headers || {}).map(([k, v]) => `${k}=${v}`).join('\n')}
                      onChange={(e) => updateKeyValue('headers', e.target.value)}
                      placeholder={"Authorization=Bearer xxx"}
                      rows={2}
                    />
                  </div>
                </>
              )}

              {saveError && (
                <p className="text-sm text-destructive">{saveError}</p>
              )}
            </div>
          )}

          <DialogFooter className="flex justify-between">
            {!isNew && (
              <>
                {deleteConfirm ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-destructive">确认删除？</span>
                    <Button variant="destructive" size="sm" onClick={handleDelete}>
                      删除
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(false)}>
                      取消
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(true)}>
                    <Trash2 className="h-4 w-4 mr-1" />
                    删除
                  </Button>
                )}
              </>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={closeModal}>
                取消
              </Button>
              <Button onClick={handleSave}>
                {isNew ? '添加' : '保存'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd d:\project\ai-code\codeMUX && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/McpSettings.tsx
git commit -m "feat(mcp): add MCP settings panel with form and list UI"
```

---

## Task 11: 集成到设置对话框

**Files:**
- Modify: `src/components/settings/SettingsDialog.tsx`

- [ ] **Step 1: 添加 MCP 标签页**

修改 `src/components/settings/SettingsDialog.tsx`：

1. 添加 import：
```typescript
import { McpSettingsPanel } from './McpSettings';
import { Server } from 'lucide-react';  // 添加到已有的 lucide-react import
```

2. 修改 `SettingsTab` 类型：
```typescript
type SettingsTab = 'general' | 'appearance' | 'provider' | 'mcp';
```

3. 在 `tabs` 数组中（`provider` 之后）添加：
```typescript
    { id: 'mcp' as SettingsTab, label: 'MCP', icon: Server },
```

4. 在内容区域（`{activeTab === 'provider' && <ProviderConfigPanel />}` 之后）添加：
```typescript
            {activeTab === 'mcp' && <McpSettingsPanel />}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd d:\project\ai-code\codeMUX && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/SettingsDialog.tsx
git commit -m "feat(mcp): integrate MCP settings into settings dialog"
```

---

## Task 12: 端到端验证

- [ ] **Step 1: 完整构建验证**

Run: `cd d:\project\ai-code\codeMUX && npm run build`
Expected: 前端构建成功

Run: `cd d:\project\ai-code\codeMUX\src-tauri && cargo build`
Expected: Rust 编译成功

- [ ] **Step 2: 启动应用验证**

Run: `cd d:\project\ai-code\codeMUX && npm run tauri dev`
Expected: 应用启动成功

- [ ] **Step 3: 功能验证清单**

在应用中验证：
1. 打开设置 → 看到 MCP 标签页
2. 点击「添加」→ 弹出表单
3. 填写 stdio 类型 MCP server（如 name=context7, command=npx, args=-y\n@upstash/context7-mcp@latest）→ 保存成功
4. 列表中显示刚添加的 server，有 stdio badge
5. 切换启用/禁用开关 → 状态切换
6. 编辑已有 server → 修改后保存
7. 删除 server → 确认后删除
8. 检查 `~/.claude.json` 文件 → mcpServers 字段已更新
9. 启动一个 Agent 会话 → sidecar 日志中应显示 MCP 配置已传递

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "feat: complete MCP server management feature"
```
