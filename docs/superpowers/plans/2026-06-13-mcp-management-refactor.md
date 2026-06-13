# MCP Unified Management Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 codeMUX 现有的 Claude-only MCP 管理重构为以数据库为唯一真相源的统一 MCP 管理系统，支持 Claude、Codex、Gemini、OpenCode 的 per-tool 启用、导入、同步和按需探测。

**Architecture:** 后端把 `McpServer` 从强类型 `transport + enabled` 改为 `server JSON + apps flags`，并通过 `McpService` 统一调度 SQLite、adapter 和 Tauri commands。前端把设置页改成 per-tool 开关和按需探测模型；Claude sidecar 只接收当前工具启用的 `mcpServers`，启动探测和 `mcpServerInstructions` 缓存全部移除。

**Tech Stack:** Rust (`rusqlite`, `serde_json`, `reqwest`, `toml_edit`), Tauri 2 IPC, React, Zustand, Vitest, TypeScript

---

## File Structure

### Backend Rust

- `src-tauri/src/mcp/types.rs`
  统一 MCP 数据结构：`McpApps`、`McpServer`、宽松 `server` JSON。
- `src-tauri/src/mcp/db.rs`
  SQLite 读写、按 app 查询、单 app 启用切换。
- `src-tauri/src/mcp/validation.rs`
  `server` JSON 的最小校验规则。
- `src-tauri/src/mcp/service.rs`
  同步调度层：upsert、delete、toggleApp、import、按工具筛选。
- `src-tauri/src/mcp/adapters/mod.rs`
  adapter trait、dispatch、共享 helper。
- `src-tauri/src/mcp/adapters/claude.rs`
  `~/.claude.json` 读写与转换。
- `src-tauri/src/mcp/adapters/codex.rs`
  `~/.codex/config.toml` 读写与 JSON/TOML 转换。
- `src-tauri/src/mcp/adapters/gemini.rs`
  `~/.gemini/settings.json` 读写与 `url` / `httpUrl` 转换。
- `src-tauri/src/mcp/adapters/opencode.rs`
  `opencode.json` 读写与 `stdio/http/sse` ↔ `local/remote` 转换。
- `src-tauri/src/commands/mcp.rs`
  对外 Tauri commands，调用 `McpService` 和 probe helper。
- `src-tauri/src/agent/commands.rs`
  只为当前 agent tool 注入启用的 MCP 配置。
- `src-tauri/src/db/schema.rs`
  `mcp_servers` 表迁移到新 schema。
- `src-tauri/src/lib.rs`
  移除启动探测缓存，注册新 MCP commands。

### Sidecar

- `src-tauri/sidecar/src/types.ts`
  sidecar command 类型，删掉 `mcpServerInstructions`。
- `src-tauri/sidecar/src/index.ts`
  Claude runtime bootstrap，不再拼 MCP 指令附加文本。
- `src-tauri/sidecar/src/sessionRuntimeHelpers.ts`
  收敛 MCP prompt helper。
- `src-tauri/sidecar/src/codexRuntime.ts`
  移除运行时写 `.mcp.json` 的临时投影逻辑。

### Frontend

- `src/types/mcp.ts`
  与后端对齐的 `McpApps` / `McpServerSpec` / `McpServer`。
- `src/lib/tauri.ts`
  `toggleApp`、`probe`、`importFromApps` API 封装。
- `src/stores/mcpStore.ts`
  per-tool toggle、单项 probe、导入、列表刷新。
- `src/stores/agentStore.ts`
  不再把 session runtime MCP 状态混写到设置页 store。
- `src/components/settings/McpSettings.tsx`
  per-tool 开关、导入按钮、刷新按钮、JSON 编辑器。

### Tests

- `src-tauri/src/db/schema.rs`
  schema migration tests。
- `src-tauri/src/mcp/db.rs`
  CRUD / app toggle tests。
- `src-tauri/src/mcp/validation.rs`
  server spec validation tests。
- `src-tauri/src/mcp/adapters/*.rs`
  per-adapter round-trip tests。
- `src-tauri/src/mcp/service.rs`
  app diff / import merge tests。
- `src-tauri/src/agent/commands.rs`
  agent-kind MCP payload filtering test。
- `src/sidecarSessionHelpers.test.ts`
  sidecar helper behavior test。
- `src/stores/mcpStore.test.ts`
  store contract tests。
- `src/components/settings/McpSettings.test.tsx`
  settings panel interaction tests。

---

### Task 1: Data Contract And Schema Migration

**Files:**
- Modify: `src-tauri/src/mcp/types.rs`
- Modify: `src/types/mcp.ts`
- Modify: `src-tauri/src/db/schema.rs`
- Test: `src-tauri/src/db/schema.rs`

- [ ] **Step 1: Write the failing migration test**

```rust
#[test]
fn migrates_legacy_mcp_rows_to_per_app_columns() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE mcp_servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            transport_type TEXT NOT NULL,
            transport_config TEXT NOT NULL,
            always_load INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            subtitle TEXT DEFAULT ''
        );

        INSERT INTO mcp_servers (
            id, name, description, transport_type, transport_config,
            always_load, enabled, created_at, updated_at, subtitle
        ) VALUES (
            'fetch',
            'fetch',
            'legacy row',
            'stdio',
            '{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-fetch"]}',
            1,
            1,
            '2026-06-01T00:00:00Z',
            '2026-06-01T00:00:00Z',
            'old subtitle'
        );
        "#,
    )
    .unwrap();

    initialize_database(&conn).unwrap();

    let row = conn
        .query_row(
            "SELECT server_config, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode
             FROM mcp_servers WHERE id = 'fetch'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .unwrap();

    assert_eq!(
        row.0,
        r#"{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-fetch"]}"#
    );
    assert_eq!(row.1, 1);
    assert_eq!(row.2, 0);
    assert_eq!(row.3, 0);
    assert_eq!(row.4, 0);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test migrates_legacy_mcp_rows_to_per_app_columns -- --exact`

Expected: FAIL with `no such column: server_config` or legacy table left unchanged.

- [ ] **Step 3: Write the minimal implementation**

```rust
// src-tauri/src/mcp/types.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpApps {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub opencode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub server: serde_json::Value,
    pub apps: McpApps,
}
```

```typescript
// src/types/mcp.ts
export interface McpApps {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  opencode: boolean;
}

export type McpServerSpec = {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};

export interface McpServer {
  id: string;
  name: string;
  server: McpServerSpec;
  apps: McpApps;
}
```

```rust
// src-tauri/src/db/schema.rs
fn migrate_mcp_servers_table(conn: &Connection) -> Result<()> {
    let has_server_config = conn.prepare("SELECT server_config FROM mcp_servers LIMIT 0").is_ok();
    if has_server_config {
        return Ok(());
    }

    let has_legacy_enabled = conn.prepare("SELECT enabled FROM mcp_servers LIMIT 0").is_ok();
    if !has_legacy_enabled {
        return Ok(());
    }

    conn.execute_batch(
        r#"
        ALTER TABLE mcp_servers RENAME TO mcp_servers_legacy;

        CREATE TABLE mcp_servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            server_config TEXT NOT NULL,
            enabled_claude INTEGER NOT NULL DEFAULT 0,
            enabled_codex INTEGER NOT NULL DEFAULT 0,
            enabled_gemini INTEGER NOT NULL DEFAULT 0,
            enabled_opencode INTEGER NOT NULL DEFAULT 0
        );

        INSERT INTO mcp_servers (
            id, name, server_config,
            enabled_claude, enabled_codex, enabled_gemini, enabled_opencode
        )
        SELECT
            id,
            name,
            transport_config,
            CASE WHEN enabled = 1 THEN 1 ELSE 0 END,
            0,
            0,
            0
        FROM mcp_servers_legacy;

        DROP TABLE mcp_servers_legacy;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
        "#,
    )?;

    Ok(())
}
```

- [ ] **Step 4: Run tests to verify the migration and type contract**

Run: `cd src-tauri && cargo test migrates_legacy_mcp_rows_to_per_app_columns -- --exact`

Expected: PASS

Run: `cd D:\project\ai-code\codeMUX && npm exec tsc --noEmit`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/types.rs src/types/mcp.ts src-tauri/src/db/schema.rs
git commit -m "refactor(mcp): migrate data model to per-app server config"
```

### Task 2: Database DAO And Validation

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`
- Modify: `src-tauri/src/mcp/db.rs`
- Create: `src-tauri/src/mcp/validation.rs`
- Test: `src-tauri/src/mcp/db.rs`
- Test: `src-tauri/src/mcp/validation.rs`

- [ ] **Step 1: Write the failing DAO and validation tests**

```rust
#[test]
fn set_mcp_app_enabled_updates_only_the_target_app() {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::schema::initialize_database(&conn).unwrap();

    let server = McpServer {
        id: "fetch".into(),
        name: "fetch".into(),
        server: serde_json::json!({
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-fetch"]
        }),
        apps: McpApps {
            claude: true,
            codex: false,
            gemini: false,
            opencode: false,
        },
    };

    upsert_mcp_server(&conn, &server).unwrap();
    set_mcp_app_enabled(&conn, "fetch", "codex", true).unwrap();

    let updated = get_mcp_server(&conn, "fetch").unwrap().unwrap();
    assert!(updated.apps.claude);
    assert!(updated.apps.codex);
    assert!(!updated.apps.gemini);
    assert!(!updated.apps.opencode);
}

#[test]
fn validate_server_spec_requires_command_or_url() {
    assert!(validate_server_spec(&serde_json::json!({"type":"stdio"})).is_err());
    assert!(validate_server_spec(&serde_json::json!({"type":"http"})).is_err());
    assert!(validate_server_spec(&serde_json::json!({"type":"sse","url":"https://mcp.example.com"})).is_ok());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test set_mcp_app_enabled_updates_only_the_target_app validate_server_spec_requires_command_or_url`

Expected: FAIL because `set_mcp_app_enabled` and `validate_server_spec` do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

```rust
// src-tauri/src/mcp/mod.rs
pub mod adapter;
pub mod adapters;
pub mod db;
pub mod service;
pub mod types;
pub mod validation;
```

```rust
// src-tauri/src/mcp/validation.rs
pub fn validate_server_spec(spec: &serde_json::Value) -> Result<(), String> {
    let server_type = spec.get("type").and_then(|value| value.as_str()).unwrap_or("stdio");
    match server_type {
        "stdio" => {
            if spec.get("command").and_then(|value| value.as_str()).is_none_or(str::is_empty) {
                return Err("stdio 类型必须提供 command".into());
            }
        }
        "http" | "sse" => {
            if spec.get("url").and_then(|value| value.as_str()).is_none_or(str::is_empty) {
                return Err(format!("{server_type} 类型必须提供 url"));
            }
        }
        other => return Err(format!("不支持的 type: {other}")),
    }
    Ok(())
}
```

```rust
// src-tauri/src/mcp/db.rs
fn row_to_mcp_server(row: &rusqlite::Row<'_>) -> rusqlite::Result<McpServer> {
    Ok(McpServer {
        id: row.get(0)?,
        name: row.get(1)?,
        server: serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(2)?)
            .map_err(|error| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error)))?,
        apps: McpApps {
            claude: row.get::<_, i64>(3)? != 0,
            codex: row.get::<_, i64>(4)? != 0,
            gemini: row.get::<_, i64>(5)? != 0,
            opencode: row.get::<_, i64>(6)? != 0,
        },
    })
}

pub fn set_mcp_app_enabled(conn: &Connection, id: &str, app: &str, enabled: bool) -> Result<()> {
    let column = match app {
        "claude" => "enabled_claude",
        "codex" => "enabled_codex",
        "gemini" => "enabled_gemini",
        "opencode" => "enabled_opencode",
        _ => return Err(rusqlite::Error::InvalidParameterName(app.to_string())),
    };

    let sql = format!("UPDATE mcp_servers SET {column} = ?1 WHERE id = ?2");
    conn.execute(&sql, rusqlite::params![if enabled { 1 } else { 0 }, id])?;
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify the DAO contract**

Run: `cd src-tauri && cargo test set_mcp_app_enabled_updates_only_the_target_app validate_server_spec_requires_command_or_url`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/mod.rs src-tauri/src/mcp/db.rs src-tauri/src/mcp/validation.rs
git commit -m "refactor(mcp): add app-aware dao and server validation"
```

### Task 3: Adapter Trait And Native Config Projections

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/mcp/adapters/mod.rs`
- Modify: `src-tauri/src/mcp/adapters/claude.rs`
- Create: `src-tauri/src/mcp/adapters/codex.rs`
- Create: `src-tauri/src/mcp/adapters/gemini.rs`
- Create: `src-tauri/src/mcp/adapters/opencode.rs`
- Test: `src-tauri/src/mcp/adapters/claude.rs`
- Test: `src-tauri/src/mcp/adapters/codex.rs`
- Test: `src-tauri/src/mcp/adapters/gemini.rs`
- Test: `src-tauri/src/mcp/adapters/opencode.rs`

- [ ] **Step 1: Write the failing adapter round-trip tests**

```rust
#[test]
fn codex_adapter_maps_headers_to_http_headers() {
    let spec = serde_json::json!({
        "type": "http",
        "url": "https://mcp.example.com",
        "headers": { "Authorization": "Bearer token" }
    });

    let table = codex::json_server_to_toml_table(&spec).unwrap();
    assert_eq!(table["type"].as_str(), Some("http"));
    assert_eq!(table["url"].as_str(), Some("https://mcp.example.com"));
    assert_eq!(table["http_headers"]["Authorization"].as_str(), Some("Bearer token"));
}

#[test]
fn gemini_adapter_maps_http_url_both_directions() {
    let imported = gemini::convert_from_gemini_server(&serde_json::json!({
        "httpUrl": "https://mcp.example.com",
        "headers": { "X-Test": "1" }
    }))
    .unwrap();

    assert_eq!(imported["type"], "http");
    assert_eq!(imported["url"], "https://mcp.example.com");

    let exported = gemini::convert_to_gemini_server(&imported).unwrap();
    assert_eq!(exported["httpUrl"], "https://mcp.example.com");
    assert!(exported.get("type").is_none());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test codex_adapter_maps_headers_to_http_headers gemini_adapter_maps_http_url_both_directions`

Expected: FAIL because the new adapter helpers and files do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

```toml
# src-tauri/Cargo.toml
toml_edit = "0.22"
```

```rust
// src-tauri/src/mcp/adapters/mod.rs
pub type McpAdapterResult<T> = Result<T, String>;

pub trait McpAdapter: Sync {
    fn should_sync(&self) -> bool;
    fn sync_single_server(&self, id: &str, server_spec: &serde_json::Value) -> McpAdapterResult<()>;
    fn remove_server(&self, id: &str) -> McpAdapterResult<()>;
    fn import_from_tool(&self) -> McpAdapterResult<Vec<(String, serde_json::Value)>>;
}

pub fn get_adapter(app: &str) -> Option<&'static dyn McpAdapter> {
    match app {
        "claude" => Some(&claude::ClaudeAdapter),
        "codex" => Some(&codex::CodexAdapter),
        "gemini" => Some(&gemini::GeminiAdapter),
        "opencode" => Some(&opencode::OpenCodeAdapter),
        _ => None,
    }
}

pub fn all_apps() -> [&'static str; 4] {
    ["claude", "codex", "gemini", "opencode"]
}
```

```rust
// src-tauri/src/mcp/adapters/codex.rs
pub fn json_server_to_toml_table(spec: &serde_json::Value) -> Result<toml_edit::Table, String> {
    let mut table = toml_edit::Table::new();
    let server_type = spec.get("type").and_then(|value| value.as_str()).unwrap_or("stdio");
    table["type"] = toml_edit::value(server_type);

    match server_type {
        "stdio" => {
            table["command"] = toml_edit::value(spec["command"].as_str().unwrap_or_default());
            if let Some(args) = spec.get("args").and_then(|value| value.as_array()) {
                table["args"] = toml_edit::value(
                    args.iter().filter_map(|value| value.as_str().map(str::to_string)).collect::<Vec<_>>()
                );
            }
        }
        "http" | "sse" => {
            table["url"] = toml_edit::value(spec["url"].as_str().unwrap_or_default());
            if let Some(headers) = spec.get("headers").and_then(|value| value.as_object()) {
                let mut headers_table = toml_edit::Table::new();
                for (key, value) in headers {
                    headers_table[key] = toml_edit::value(value.as_str().unwrap_or_default());
                }
                table["http_headers"] = toml_edit::Item::Table(headers_table);
            }
        }
        other => return Err(format!("unsupported codex type: {other}")),
    }

    Ok(table)
}
```

```rust
// src-tauri/src/mcp/adapters/gemini.rs
pub fn convert_to_gemini_server(spec: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut obj = spec.as_object().cloned().ok_or("server spec must be an object")?;
    if obj.get("type").and_then(|value| value.as_str()) == Some("http") {
        if let Some(url) = obj.remove("url") {
            obj.insert("httpUrl".into(), url);
        }
    }
    obj.remove("type");
    Ok(serde_json::Value::Object(obj))
}

pub fn convert_from_gemini_server(spec: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut obj = spec.as_object().cloned().ok_or("gemini server must be an object")?;
    if let Some(url) = obj.remove("httpUrl") {
        obj.insert("type".into(), serde_json::Value::String("http".into()));
        obj.insert("url".into(), url);
    } else if obj.contains_key("url") {
        obj.insert("type".into(), serde_json::Value::String("sse".into()));
    } else {
        obj.insert("type".into(), serde_json::Value::String("stdio".into()));
    }
    Ok(serde_json::Value::Object(obj))
}
```

```rust
// src-tauri/src/mcp/adapters/opencode.rs
pub fn convert_to_opencode_server(spec: &serde_json::Value) -> Result<serde_json::Value, String> {
    let server_type = spec.get("type").and_then(|value| value.as_str()).unwrap_or("stdio");
    match server_type {
        "stdio" => Ok(serde_json::json!({
            "type": "local",
            "command": std::iter::once(spec["command"].as_str().unwrap_or_default().to_string())
                .chain(
                    spec.get("args")
                        .and_then(|value| value.as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(|value| value.as_str().map(str::to_string))
                )
                .collect::<Vec<_>>(),
            "environment": spec.get("env").cloned().unwrap_or_else(|| serde_json::json!({}))
        })),
        "http" | "sse" => Ok(serde_json::json!({
            "type": "remote",
            "url": spec["url"].clone(),
            "headers": spec.get("headers").cloned().unwrap_or_else(|| serde_json::json!({}))
        })),
        other => Err(format!("unsupported opencode type: {other}")),
    }
}
```

- [ ] **Step 4: Run tests to verify the adapter conversions**

Run: `cd src-tauri && cargo test mcp::adapters`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/mcp/adapters
git commit -m "refactor(mcp): add native config adapters for all supported tools"
```

### Task 4: MCP Service Layer And Tauri Commands

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`
- Create: `src-tauri/src/mcp/service.rs`
- Modify: `src-tauri/src/commands/mcp.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/mcp/service.rs`

- [ ] **Step 1: Write the failing service orchestration tests**

```rust
#[test]
fn diff_apps_reports_enable_and_disable_sets() {
    let previous = McpApps { claude: true, codex: false, gemini: true, opencode: false };
    let next = McpApps { claude: false, codex: true, gemini: true, opencode: false };

    let diff = diff_apps(&previous, &next);

    assert_eq!(diff.disable, vec!["claude"]);
    assert_eq!(diff.enable, vec!["codex"]);
}

#[test]
fn merge_imported_server_only_enables_the_source_app_for_existing_rows() {
    let existing = McpServer {
        id: "fetch".into(),
        name: "fetch".into(),
        server: serde_json::json!({"type":"stdio","command":"npx"}),
        apps: McpApps { claude: true, codex: false, gemini: false, opencode: false },
    };

    let merged = merge_imported_server(existing, "codex");
    assert!(merged.apps.claude);
    assert!(merged.apps.codex);
    assert!(!merged.apps.gemini);
    assert!(!merged.apps.opencode);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test diff_apps_reports_enable_and_disable_sets merge_imported_server_only_enables_the_source_app_for_existing_rows`

Expected: FAIL because `service.rs` and helpers do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

```rust
// src-tauri/src/mcp/service.rs
pub struct AppDiff {
    pub enable: Vec<&'static str>,
    pub disable: Vec<&'static str>,
}

pub fn diff_apps(previous: &McpApps, next: &McpApps) -> AppDiff {
    let mut enable = Vec::new();
    let mut disable = Vec::new();

    for (app, before, after) in [
        ("claude", previous.claude, next.claude),
        ("codex", previous.codex, next.codex),
        ("gemini", previous.gemini, next.gemini),
        ("opencode", previous.opencode, next.opencode),
    ] {
        if before && !after {
            disable.push(app);
        }
        if !before && after {
            enable.push(app);
        }
    }

    AppDiff { enable, disable }
}

pub fn merge_imported_server(mut server: McpServer, app: &str) -> McpServer {
    match app {
        "claude" => server.apps.claude = true,
        "codex" => server.apps.codex = true,
        "gemini" => server.apps.gemini = true,
        "opencode" => server.apps.opencode = true,
        _ => {}
    }
    server
}
```

```rust
// src-tauri/src/commands/mcp.rs
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpProbeResult {
    pub connected: bool,
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportResult {
    pub claude: usize,
    pub codex: usize,
    pub gemini: usize,
    pub opencode: usize,
    pub total: usize,
}

#[tauri::command]
pub fn toggle_mcp_app(
    state: State<'_, AppState>,
    server_id: String,
    app: String,
    enabled: bool,
) -> Result<(), String> {
    crate::mcp::service::toggle_app(state.inner(), &server_id, &app, enabled)
}

#[tauri::command]
pub async fn probe_mcp_server(
    state: State<'_, AppState>,
    id: String,
) -> Result<McpProbeResult, String> {
    let server = {
        let db = state.db.lock().unwrap();
        crate::mcp::db::get_mcp_server(&db, &id).map_err(|error| error.to_string())?
    }
    .ok_or_else(|| format!("Unknown MCP server: {id}"))?;

    let result = probe_servers(&[server]).await;
    let (_, probe) = result.into_iter().next().ok_or("Probe returned no result")?;
    Ok(McpProbeResult {
        connected: probe.connected,
        instructions: probe.instructions,
    })
}

#[tauri::command]
pub fn import_mcp_from_apps(state: State<'_, AppState>) -> Result<ImportResult, String> {
    crate::mcp::service::import_from_apps(state.inner())
}
```

- [ ] **Step 4: Run tests to verify the service contract**

Run: `cd src-tauri && cargo test diff_apps_reports_enable_and_disable_sets merge_imported_server_only_enables_the_source_app_for_existing_rows`

Expected: PASS

Run: `cd src-tauri && cargo check`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/mod.rs src-tauri/src/mcp/service.rs src-tauri/src/commands/mcp.rs src-tauri/src/lib.rs
git commit -m "refactor(mcp): add unified service layer and app-scoped commands"
```

### Task 5: Remove Startup Probe And Filter Session MCP Injection By Agent

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/agent/commands.rs`
- Test: `src-tauri/src/agent/commands.rs`

- [ ] **Step 1: Write the failing agent MCP payload test**

```rust
#[test]
fn build_session_mcp_payload_filters_servers_by_agent_kind() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::schema::initialize_database(&conn).unwrap();

    crate::mcp::db::upsert_mcp_server(
        &conn,
        &crate::mcp::types::McpServer {
            id: "fetch".into(),
            name: "fetch".into(),
            server: serde_json::json!({"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-fetch"]}),
            apps: crate::mcp::types::McpApps { claude: true, codex: false, gemini: false, opencode: false },
        },
    )
    .unwrap();

    crate::mcp::db::upsert_mcp_server(
        &conn,
        &crate::mcp::types::McpServer {
            id: "context7".into(),
            name: "context7".into(),
            server: serde_json::json!({"type":"http","url":"https://mcp.example.com"}),
            apps: crate::mcp::types::McpApps { claude: false, codex: true, gemini: false, opencode: false },
        },
    )
    .unwrap();

    let state = crate::AppState {
        db: std::sync::Mutex::new(conn),
        config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
        app_data_dir: std::path::PathBuf::new(),
    };

    let payload = build_session_mcp_payload(&state, "claude_code").unwrap();
    assert!(payload.get("fetch").is_some());
    assert!(payload.get("context7").is_none());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test build_session_mcp_payload_filters_servers_by_agent_kind -- --exact`

Expected: FAIL because `build_session_mcp_payload` does not exist and `AppState` still depends on startup probe caches.

- [ ] **Step 3: Write the minimal implementation**

```rust
// src-tauri/src/lib.rs
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<config::types::AppConfig>,
    pub app_data_dir: std::path::PathBuf,
}
```

```rust
// src-tauri/src/agent/commands.rs
fn tool_name_for_agent_kind(agent_kind: &str) -> Option<&'static str> {
    match agent_kind {
        "claude_code" => Some("claude"),
        "codex" => Some("codex"),
        _ => None,
    }
}

fn build_session_mcp_payload(
    state: &crate::AppState,
    agent_kind: &str,
) -> Option<serde_json::Value> {
    let app = tool_name_for_agent_kind(agent_kind)?;
    // 当前只有 Claude sidecar 直接消费 Rust 注入的 mcpServers。
    // Codex 通过 ~/.codex/config.toml 投影读取，Gemini/OpenCode 还未接入 agent runtime。
    if app != "claude" {
        return None;
    }

    let db = state.db.lock().unwrap();
    let servers = crate::mcp::db::get_servers_enabled_for_app(&db, app).ok()?;
    let payload = crate::mcp::adapters::claude::to_sdk_config(&servers);
    payload.as_object().filter(|entries| !entries.is_empty())?;
    Some(payload)
}

if let Some(mcp_payload) = build_session_mcp_payload(state, agent_kind) {
    cmd["mcpServers"] = mcp_payload;
}
```

- [ ] **Step 4: Run tests to verify startup probe removal did not break session bootstrap**

Run: `cd src-tauri && cargo test build_session_mcp_payload_filters_servers_by_agent_kind -- --exact`

Expected: PASS

Run: `cd src-tauri && cargo check`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/agent/commands.rs
git commit -m "refactor(mcp): remove startup probe cache and filter session payloads by tool"
```

### Task 6: Sidecar MCP Cleanup

**Files:**
- Modify: `src-tauri/sidecar/src/types.ts`
- Modify: `src-tauri/sidecar/src/index.ts`
- Modify: `src-tauri/sidecar/src/sessionRuntimeHelpers.ts`
- Modify: `src-tauri/sidecar/src/codexRuntime.ts`
- Test: `src/sidecarSessionHelpers.test.ts`

- [ ] **Step 1: Write the failing sidecar helper test**

```typescript
import { buildMcpInstructions } from '../src-tauri/sidecar/src/sessionRuntimeHelpers';

describe('buildMcpInstructions', () => {
  it('stops appending probe-derived MCP instructions to Claude prompts', () => {
    expect(
      buildMcpInstructions(
        { fetch: { command: 'npx' } },
        { fetch: 'Use this special private instruction' },
        false,
      ),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\project\ai-code\codeMUX && npm exec vitest run src/sidecarSessionHelpers.test.ts`

Expected: FAIL because the helper still emits probe-derived prompt text.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src-tauri/sidecar/src/types.ts
export type SidecarCommand =
  | { type: 'ensure_session'; agentKind?: string; cwd: string; sessionId?: string; agentSessionId?: string; apiKey?: string; baseUrl?: string; model?: string; proxyBaseUrl?: string; mcpServers?: Record<string, unknown>; skills?: string[] }
  | { type: 'send_input'; prompt: string }
  | { type: 'reset_session'; sessionId: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' }
  | { type: 'tool_response'; toolUseId: string; response: unknown }
  | { type: 'start_proxy'; apiKey: string; baseUrl: string }
  | { type: 'stop_proxy' }
  | { type: 'proxy_status' };
```

```typescript
// src-tauri/sidecar/src/sessionRuntimeHelpers.ts
export function buildMcpInstructions(): undefined {
  return undefined;
}
```

```typescript
// src-tauri/sidecar/src/index.ts
type SessionBootstrap = {
  sessionId?: string;
  agentSessionId?: string;
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  mcpServers?: Record<string, unknown>;
  skills?: string[];
};

const mcpInstructions = undefined;
```

```typescript
// src-tauri/sidecar/src/codexRuntime.ts
// Delete syncMcpServersToConfigToml() and the ensure() block that writes .mcp.json.
// Codex MCP config now comes from the Rust adapter projection into ~/.codex/config.toml.
```

- [ ] **Step 4: Run tests and sidecar build**

Run: `cd D:\project\ai-code\codeMUX && npm exec vitest run src/sidecarSessionHelpers.test.ts`

Expected: PASS

Run: `cd src-tauri/sidecar && npm run build`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/types.ts src-tauri/sidecar/src/index.ts src-tauri/sidecar/src/sessionRuntimeHelpers.ts src-tauri/sidecar/src/codexRuntime.ts src/sidecarSessionHelpers.test.ts
git commit -m "refactor(sidecar): remove probe-derived MCP prompt injection"
```

### Task 7: Frontend API And Store Refactor

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/stores/mcpStore.ts`
- Modify: `src/stores/agentStore.ts`
- Test: `src/stores/mcpStore.test.ts`

- [ ] **Step 1: Write the failing store test**

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/tauri', () => ({
  mcpApi: {
    getAll: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    toggleApp: vi.fn(),
    probe: vi.fn(),
    importFromApps: vi.fn(),
  },
}));

describe('mcpStore', () => {
  beforeEach(() => {
    useMcpStore.setState({
      servers: [{
        id: 'fetch',
        name: 'fetch',
        server: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
        apps: { claude: true, codex: false, gemini: false, opencode: false },
      }],
      probeStatus: {},
      isLoading: false,
      error: null,
    });
  });

  it('updates only one app flag when toggleApp succeeds', async () => {
    vi.mocked(mcpApi.toggleApp).mockResolvedValue();

    await useMcpStore.getState().toggleApp('fetch', 'codex', true);

    expect(useMcpStore.getState().servers[0].apps).toEqual({
      claude: true,
      codex: true,
      gemini: false,
      opencode: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\project\ai-code\codeMUX && npm exec vitest run src/stores/mcpStore.test.ts`

Expected: FAIL because `toggleApp`, `probe`, and `importFromApps` do not exist in the store or API.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/lib/tauri.ts
export const mcpApi = {
  getAll: (): Promise<McpServer[]> => invokeLogged('get_mcp_servers'),
  upsert: (server: McpServer): Promise<void> => invokeLogged('upsert_mcp_server', { server }),
  delete: (id: string): Promise<void> => invokeLogged('delete_mcp_server', { id }),
  toggleApp: (serverId: string, app: keyof McpApps, enabled: boolean): Promise<void> =>
    invokeLogged('toggle_mcp_app', { serverId, app, enabled }),
  probe: (id: string): Promise<{ connected: boolean; instructions?: string | null }> =>
    invokeLogged('probe_mcp_server', { id }),
  importFromApps: (): Promise<{ total: number }> => invokeLogged('import_mcp_from_apps'),
};
```

```typescript
// src/stores/mcpStore.ts
interface McpStore {
  servers: McpServer[];
  probeStatus: Record<string, 'idle' | 'pending' | 'connected' | 'failed'>;
  isLoading: boolean;
  error: string | null;
  fetchServers: () => Promise<void>;
  upsertServer: (server: McpServer) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  toggleApp: (serverId: string, app: keyof McpApps, enabled: boolean) => Promise<void>;
  probeServer: (id: string) => Promise<void>;
  importFromApps: () => Promise<void>;
}
```

```typescript
// src/stores/agentStore.ts
// Delete the useMcpStore.getState().updateConnectionStatus(...) calls.
// Session runtime MCP status stays local to agentStore.mcpRuntimeStatus.
```

- [ ] **Step 4: Run the store test and TypeScript check**

Run: `cd D:\project\ai-code\codeMUX && npm exec vitest run src/stores/mcpStore.test.ts`

Expected: PASS

Run: `cd D:\project\ai-code\codeMUX && npm exec tsc --noEmit`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/tauri.ts src/stores/mcpStore.ts src/stores/agentStore.ts src/stores/mcpStore.test.ts
git commit -m "refactor(mcp-ui): add app-scoped api and store actions"
```

### Task 8: Settings UI Refactor

**Files:**
- Modify: `src/components/settings/McpSettings.tsx`
- Test: `src/components/settings/McpSettings.test.tsx`

- [ ] **Step 1: Write the failing component test**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const toggleApp = vi.fn();
const importFromApps = vi.fn();

vi.mock('../../stores/mcpStore', () => ({
  useMcpStore: () => ({
    servers: [{
      id: 'fetch',
      name: 'fetch',
      server: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
      apps: { claude: true, codex: false, gemini: false, opencode: false },
    }],
    probeStatus: { fetch: 'idle' },
    isLoading: false,
    fetchServers: vi.fn(),
    upsertServer: vi.fn(),
    deleteServer: vi.fn(),
    toggleApp,
    probeServer: vi.fn(),
    importFromApps,
  }),
}));

describe('McpSettingsPanel', () => {
  it('renders per-tool toggles and import button', async () => {
    render(<McpSettingsPanel />);

    fireEvent.click(screen.getByText('从工具导入'));
    expect(importFromApps).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('toggle-fetch-codex'));
    expect(toggleApp).toHaveBeenCalledWith('fetch', 'codex', true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\project\ai-code\codeMUX && npm exec vitest run src/components/settings/McpSettings.test.tsx`

Expected: FAIL because the panel still renders a single global switch and has no import button.

- [ ] **Step 3: Write the minimal implementation**

```tsx
// src/components/settings/McpSettings.tsx
const APP_ORDER: Array<keyof McpApps> = ['claude', 'codex', 'gemini', 'opencode'];

function summarizeServer(server: McpServer): string {
  const type = (server.server.type ?? 'stdio') as string;
  if (type === 'stdio') {
    const command = typeof server.server.command === 'string' ? server.server.command : '';
    const args = Array.isArray(server.server.args) ? server.server.args.join(' ') : '';
    return `${type}: ${[command, args].filter(Boolean).join(' ')}`;
  }
  return `${type}: ${typeof server.server.url === 'string' ? server.server.url : ''}`;
}

<div className="flex items-center gap-2">
  <Button size="sm" variant="outline" onClick={() => importFromApps()}>
    从工具导入
  </Button>
  <Button size="sm" variant="ghost" onClick={() => probeServer(server.id)}>
    刷新探测
  </Button>
</div>

{APP_ORDER.map((app) => (
  <button
    key={app}
    aria-label={`toggle-${server.id}-${app}`}
    onClick={() => toggleApp(server.id, app, !server.apps[app])}
    className={cn(
      'rounded-md px-2 py-1 text-xs border',
      server.apps[app] ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground',
    )}
  >
    {app}
  </button>
))}
```

- [ ] **Step 4: Run UI test and production build**

Run: `cd D:\project\ai-code\codeMUX && npm exec vitest run src/components/settings/McpSettings.test.tsx`

Expected: PASS

Run: `cd D:\project\ai-code\codeMUX && npm run build`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/McpSettings.tsx src/components/settings/McpSettings.test.tsx
git commit -m "refactor(settings): add per-tool MCP controls and import flow"
```

### Task 9: Full Verification

**Files:**
- Test: `src-tauri/src/**`
- Test: `src-tauri/sidecar/src/**`
- Test: `src/**`

- [ ] **Step 1: Run backend verification**

Run: `cd src-tauri && cargo test`

Expected: PASS

Run: `cd src-tauri && cargo check`

Expected: PASS

- [ ] **Step 2: Run sidecar and frontend verification**

Run: `cd src-tauri/sidecar && npm run build`

Expected: PASS

Run: `cd D:\project\ai-code\codeMUX && npm exec vitest run src/stores/mcpStore.test.ts src/components/settings/McpSettings.test.tsx src/sidecarSessionHelpers.test.ts`

Expected: PASS

Run: `cd D:\project\ai-code\codeMUX && npm run build`

Expected: PASS

- [ ] **Step 3: Run manual smoke checks**

Run: `cd D:\project\ai-code\codeMUX && npm run tauri dev`

Expected: app launches without startup MCP probe logs

Manual checklist:

- 打开设置页的 `MCP` 标签，能看到 `从工具导入` 和 `刷新探测`。
- 新建一个 `stdio` MCP，分别切换 `Claude` 和 `Codex` 开关，数据库列表刷新后状态保留。
- 检查 `~/.claude.json`，只有启用到 Claude 的条目写入 `mcpServers`。
- 检查 `~/.codex/config.toml`，只有启用到 Codex 的条目写入 `[mcp_servers]`。
- 点击导入后，已有 `~/.claude.json` / `~/.codex/config.toml` 配置被拉入列表，不覆盖已存在的 `server` JSON。
- 启动 Claude 会话，sidecar stdin 只携带 Claude-enabled `mcpServers`。
- 启动 Codex 会话，项目目录下不再生成新的 `.mcp.json`。

- [ ] **Step 4: Final Commit**

```bash
git add -A
git commit -m "refactor(mcp): unify multi-tool MCP management"
```
