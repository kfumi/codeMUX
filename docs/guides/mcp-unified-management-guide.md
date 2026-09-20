# MCP 统一管理实现指导说明

> 基于 CC Switch 项目分析，面向需要实现多工具（Claude Code、Codex、Gemini CLI 等）MCP 统一管理的场景。

---

## 目录

- [一、整体架构](#一整体架构)
- [二、数据模型设计](#二数据模型设计)
- [三、各工具原生 MCP 配置格式对照](#三各工具原生-mcp-配置格式对照)
- [四、格式转换层实现](#四格式转换层实现)
- [五、同步服务层（核心调度逻辑）](#五同步服务层核心调度逻辑)
- [六、导入机制（从各工具迁移已有配置）](#六导入机制从各工具迁移已有配置)
- [七、Proxy 接管时的 MCP 保护](#七proxy-接管时的-mcp-保护)
- [八、前端 UI 设计](#八前端-ui-设计)
- [九、平台适配细节](#九平台适配细节)
- [十、接入建议与参考文件清单](#十接入建议与参考文件清单)

---

## 一、整体架构

### 1.1 核心设计理念

**数据库是唯一真相源（Single Source of Truth），各工具的原生配置文件是投影（Projection）。**

```
                    ┌──────────────────────┐
                    │   统一数据库 (SQLite)  │
                    │   mcp_servers 表      │
                    │   id + server_config  │
                    │   + enabled_claude    │
                    │   + enabled_codex     │
                    │   + enabled_gemini    │
                    │   + enabled_opencode  │
                    │   + enabled_hermes    │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │ 同步服务层     │                 │
              │ (McpService)   │                 │
              ▼                ▼                 ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  Claude 适配  │  │  Codex 适配   │  │  Gemini 适配  │
   │  JSON 格式    │  │  TOML 格式    │  │  JSON 格式    │
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          ▼                 ▼                 ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │~/.claude.json│  │~/.codex/     │  │~/.gemini/    │
   │ mcpServers   │  │ config.toml  │  │ settings.json│
   │              │  │ [mcp_servers]│  │ mcpServers   │
   └──────────────┘  └──────────────┘  └──────────────┘
```

### 1.2 支持的工具列表

| 工具 | 原生配置格式 | 配置文件路径 | MCP 存储键 | 状态 |
|------|------------|------------|-----------|------|
| **Claude Code** | JSON | `~/.claude.json` | `mcpServers` | ✅ 完整支持 |
| **Codex CLI** | TOML | `~/.codex/config.toml` | `[mcp_servers]` | ✅ 完整支持 |
| **Gemini CLI** | JSON | `~/.gemini/settings.json` | `mcpServers` | ✅ 完整支持 |
| **OpenCode** | JSON | opencode.json | `mcp` | ✅ 完整支持 |
| **Hermes** | YAML | `~/.hermes/config.yaml` | `mcp_servers` | ✅ 完整支持 |
| Claude Desktop | — | — | — | ⏭️ 跳过（3P profiles 不同步） |
| OpenClaw | — | — | — | ⏭️ 跳过（MCP 尚在开发中） |

---

## 二、数据模型设计

### 2.1 统一数据结构

```typescript
// ========= 前端 TypeScript 定义 =========

// MCP 服务器连接参数（宽松类型：允许任意扩展字段）
interface McpServerSpec {
  type?: "stdio" | "http" | "sse";  // 可省略，默认 stdio
  // stdio 字段
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http/sse 字段
  url?: string;
  headers?: Record<string, string>;
  // 允许任意扩展字段（如 Hermes 的 timeout、tools 等）
  [key: string]: any;
}

// 应用启用状态
interface McpApps {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  opencode: boolean;
  hermes: boolean;
}

// MCP 服务器完整定义
interface McpServer {
  id: string;            // 唯一标识符（通常是服务器名）
  name: string;          // 显示名称
  server: McpServerSpec; // 实际的 MCP 连接规范
  apps: McpApps;         // 哪些工具启用了此服务器
  description?: string;  // 描述
  homepage?: string;     // 主页 URL
  docs?: string;         // 文档 URL
  tags?: string[];       // 标签
}

// MCP 服务器映射（id → McpServer）
type McpServersMap = Record<string, McpServer>;
```

```rust
// ========= 后端 Rust 定义 =========

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpApps {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub opencode: bool,
    pub hermes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub server: serde_json::Value,  // 松散 JSON 对象，不强制 schema
    pub apps: McpApps,
    pub description: Option<String>,
    pub homepage: Option<String>,
    pub docs: Option<String>,
    pub tags: Vec<String>,
}
```

> **关键设计决策**：`server` 字段使用松散的 `serde_json::Value` 而非强类型结构体，这样可以透传任意工具的扩展字段（如 Hermes 的 `timeout`、`tools`、`sampling`、`auth` 等），不需要为每个工具的特殊字段修改数据模型。

### 2.2 数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    server_config   TEXT NOT NULL,           -- JSON 序列化的 McpServerSpec
    description     TEXT,
    homepage        TEXT,
    docs            TEXT,
    tags            TEXT NOT NULL DEFAULT '[]',  -- JSON 序列化的字符串数组
    enabled_claude  BOOLEAN NOT NULL DEFAULT 0,
    enabled_codex   BOOLEAN NOT NULL DEFAULT 0,
    enabled_gemini  BOOLEAN NOT NULL DEFAULT 0,
    enabled_opencode BOOLEAN NOT NULL DEFAULT 0,
    enabled_hermes  BOOLEAN NOT NULL DEFAULT 0
);
```

> **设计要点**：每个工具有独立的 `enabled_*` 布尔列，而非用 JSON 数组存储。这样可以高效查询"哪些服务器启用了 Claude"且不需要解析 JSON。新增工具时通过 `ALTER TABLE ADD COLUMN` 迁移即可。

### 2.3 数据库 CRUD 操作

```rust
// DAO 层提供三个核心操作：

impl Database {
    /// 获取所有 MCP 服务器（按 name 排序）
    pub fn get_all_mcp_servers(&self) -> Result<IndexMap<String, McpServer>> {
        // SELECT id, name, server_config, ..., enabled_claude, ...
        // FROM mcp_servers ORDER BY name ASC, id ASC
    }

    /// 保存（INSERT OR REPLACE）
    pub fn save_mcp_server(&self, server: &McpServer) -> Result<()> {
        // INSERT OR REPLACE INTO mcp_servers (...)
    }

    /// 删除
    pub fn delete_mcp_server(&self, id: &str) -> Result<()> {
        // DELETE FROM mcp_servers WHERE id = ?
    }
}
```

---

## 三、各工具原生 MCP 配置格式对照

### 3.1 格式对照表

| 维度 | Claude Code | Codex CLI | Gemini CLI | OpenCode | Hermes |
|------|------------|-----------|------------|---------|--------|
| **文件格式** | JSON | TOML | JSON | JSON | YAML |
| **存储键** | `mcpServers` | `[mcp_servers]` | `mcpServers` | `mcp` | `mcp_servers` |
| **type 字段** | 显式 `"stdio"` | 显式 `"stdio"` | ❌ 无（推断） | `"local"/"remote"` | ❌ 无（推断） |
| **stdio 命令** | `command` + `args` 分离 | `command` + `args` 分离 | `command` + `args` 分离 | `command: [cmd, ...args]` 合并 | `command` + `args` 分离 |
| **环境变量** | `env: {}` | `[env]` TOML 表 | `env: {}` | `environment: {}` | `env: {}` |
| **HTTP URL** | `url` + `type: "http"` | `url` + `type: "http"` | `httpUrl`（不是 `url`） | `url` + `type: "remote"` | `url`（推断） |
| **SSE URL** | `url` + `type: "sse"` | `url` + `type: "sse"` | `url`（推断） | — | `url`（推断） |
| **HTTP Headers** | `headers: {}` | `[http_headers]` TOML 表 | `headers: {}` | `headers: {}` | `headers: {}` |
| **工作目录** | `cwd` | `cwd` | — | — | — |
| **超时配置** | `startup_timeout_sec` / `tool_timeout_sec` | `startup_timeout_sec` / `tool_timeout_sec` | `timeout`（毫秒） | — | `timeout` / `connect_timeout` |
| **扩展字段** | — | 扩展字段透传 | — | — | `enabled`, `tools`, `sampling`, `roots`, `auth` |

### 3.2 同一 MCP 服务器在各工具中的写法

**stdio 类型（以 `@modelcontextprotocol/server-fetch` 为例）：**

```jsonc
// Claude Code (~/.claude.json)
{
  "mcpServers": {
    "fetch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "env": {}
    }
  }
}
```

```toml
# Codex CLI (~/.codex/config.toml)
[mcp_servers.fetch]
type = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-fetch"]
```

```json
// Gemini CLI (~/.gemini/settings.json)
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    }
  }
}
```

```yaml
# Hermes (~/.hermes/config.yaml)
mcp_servers:
  fetch:
    command: npx
    args:
      - "-y"
      - "@modelcontextprotocol/server-fetch"
    enabled: true
```

```jsonc
// OpenCode (opencode.json)
{
  "mcp": {
    "fetch": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-fetch"],
      "enabled": true
    }
  }
}
```

**http 类型（以远程 MCP 服务器为例）：**

```jsonc
// Claude Code
{ "type": "http", "url": "https://mcp.example.com/api", "headers": { "Authorization": "Bearer xxx" } }

// Codex CLI (TOML)
[mcp_servers.remote]
type = "http"
url = "https://mcp.example.com/api"
[mcp_servers.remote.http_headers]
Authorization = "Bearer xxx"

// Gemini CLI
{ "httpUrl": "https://mcp.example.com/api", "headers": { "Authorization": "Bearer xxx" } }

// OpenCode
{ "type": "remote", "url": "https://mcp.example.com/api", "headers": { "Authorization": "Bearer xxx" } }

// Hermes
{ "url": "https://mcp.example.com/api", "headers": { "Authorization": "Bearer xxx" } }
```

---

## 四、格式转换层实现

每个工具有独立的格式转换模块，负责 **统一格式 ↔ 工具原生格式** 的双向转换。

### 4.1 核心接口（每个工具需实现）

```typescript
interface ToolMcpAdapter {
  // 同步单个服务器到工具的原生配置
  syncSingleServer(id: string, serverSpec: McpServerSpec): void;

  // 从工具的原生配置中移除单个服务器
  removeServer(id: string): void;

  // 从工具的原生配置导入服务器到统一数据库
  importFromTool(): McpServer[];

  // 检查工具是否已安装（配置目录是否存在）
  shouldSync(): boolean;
}
```

### 4.2 Claude Code 适配器（最简单，格式基本兼容）

Claude 的 `~/.claude.json` 中的 `mcpServers` 格式与统一格式几乎一致，是最简单的适配器。

```typescript
// 格式转换：统一格式 → Claude 格式
// 几乎不需要转换，只需在写入时剥离 UI 辅助字段
function convertToClaudeFormat(spec: McpServerSpec): any {
  const result = { ...spec };
  // 移除 UI 辅助字段
  delete result.enabled;
  delete result.source;
  delete result.id;
  delete result.name;
  delete result.description;
  delete result.tags;
  delete result.homepage;
  delete result.docs;
  return result;
}
```

**Windows 平台特殊处理**：`npx`/`npm`/`yarn`/`pnpm`/`node`/`bun`/`deno` 命令需要包装为 `cmd /c`：

```typescript
function wrapCommandForWindows(obj: McpServerSpec): void {
  if (obj.type && obj.type !== "stdio") return;
  if (!obj.command) return;

  const cmdName = path.basename(obj.command, path.extname(obj.command));
  const WINDOWS_WRAP_COMMANDS = ["npx", "npm", "yarn", "pnpm", "node", "bun", "deno"];

  if (!WINDOWS_WRAP_COMMANDS.some(c => cmdName.toLowerCase() === c)) return;
  if (cmdName.toLowerCase() === "cmd") return; // 已包装

  // "npx args..." → "cmd /c npx args..."
  obj.args = ["/c", obj.command, ...(obj.args ?? [])];
  obj.command = "cmd";
}
```

### 4.3 Codex CLI 适配器（TOML 转换，最复杂）

Codex 使用 TOML 格式，需要 JSON ↔ TOML 的双向转换。

#### 统一格式 → Codex TOML

```typescript
// JSON → TOML 转换规则
function jsonServerToTomlTable(spec: McpServerSpec): TomlTable {
  const table = new TomlTable();
  const type = spec.type ?? "stdio";

  switch (type) {
    case "stdio":
      table.set("type", "stdio");
      if (spec.command) table.set("command", spec.command);
      if (spec.args?.length) table.set("args", spec.args); // TOML 数组
      if (spec.cwd) table.set("cwd", spec.cwd);
      if (spec.env && Object.keys(spec.env).length > 0) {
        // env → TOML 子表
        // [mcp_servers.myserver.env]
        // KEY = "value"
        const envTable = new TomlTable();
        for (const [k, v] of Object.entries(spec.env)) {
          envTable.set(k, v);
        }
        table.set("env", envTable);
      }
      break;

    case "http":
    case "sse":
      table.set("type", type);
      if (spec.url) table.set("url", spec.url);
      if (spec.headers && Object.keys(spec.headers).length > 0) {
        // headers → [mcp_servers.myserver.http_headers]
        // 注意：Codex 使用 http_headers 而非 headers
        const headersTable = new TomlTable();
        for (const [k, v] of Object.entries(spec.headers)) {
          headersTable.set(k, v);
        }
        table.set("http_headers", headersTable);
      }
      break;
  }

  // 透传扩展字段（如 timeout、debug、retry 等）
  for (const [key, value] of Object.entries(spec)) {
    if (["type", "command", "args", "env", "cwd", "url", "headers"].includes(key)) continue;
    // 仅支持简单类型：string/number/boolean/string[]
    if (isSimpleTomlValue(value)) {
      table.set(key, value);
    }
  }

  return table;
}
```

#### Codex TOML → 统一格式

```typescript
function tomlEntryToServerSpec(entry: TomlTable): McpServerSpec {
  const spec: McpServerSpec = {};
  const type = entry.get("type") ?? "stdio";

  spec.type = type;

  switch (type) {
    case "stdio":
      spec.command = entry.get("command");
      spec.args = entry.get("args")?.map(String);
      spec.cwd = entry.get("cwd");
      if (entry.has("env")) {
        spec.env = {};
        for (const [k, v] of entry.getTable("env").entries()) {
          spec.env[k] = String(v);
        }
      }
      break;

    case "http":
    case "sse":
      spec.url = entry.get("url");
      // http_headers 或 headers（兼容旧格式）
      const headers = entry.getTable("http_headers") ?? entry.getTable("headers");
      if (headers) {
        spec.headers = {};
        for (const [k, v] of headers.entries()) {
          spec.headers[k] = String(v);
        }
      }
      break;
  }

  // 透传扩展字段
  for (const [key, value] of entry.entries()) {
    if (["type", "command", "args", "env", "cwd", "url", "http_headers", "headers"].includes(key)) continue;
    spec[key] = convertTomlValue(value);
  }

  return spec;
}
```

#### Codex TOML 文件操作（使用格式保留编辑）

```typescript
// 使用 toml_edit（保留注释、空行、格式）
// 写入单个服务器到 config.toml
function syncSingleServerToCodex(id: string, spec: McpServerSpec): void {
  const configPath = getCodexConfigPath();
  const doc = TomlDocument.parse(readFileSync(configPath, "utf-8"));

  // 清理可能存在的错误格式 [mcp.servers]（历史遗留 bug）
  if (doc.has("mcp", "servers")) {
    doc.remove("mcp", "servers");
    console.warn("检测到错误的 MCP 格式 [mcp.servers]，已迁移到 [mcp_servers]");
  }

  // 确保 [mcp_servers] 顶层表存在
  if (!doc.has("mcp_servers")) {
    doc.set("mcp_servers", new TomlTable());
  }

  // 写入服务器
  const tomlTable = jsonServerToTomlTable(spec);
  doc.set(`mcp_servers.${id}`, tomlTable);

  // 写回（保留未修改区域的注释和格式）
  writeFileSync(configPath, doc.toString());
}
```

### 4.4 Gemini CLI 适配器（字段名映射）

Gemini 的关键差异：不使用 `type` 字段，HTTP 使用 `httpUrl` 而非 `url`。

```typescript
// ========= 统一格式 → Gemini 格式 =========
function convertToGeminiFormat(spec: McpServerSpec): any {
  const result = { ...spec };
  const type = spec.type ?? "stdio";

  // 移除 type 字段（Gemini 通过字段名推断）
  delete result.type;

  // 移除 UI 辅助字段
  delete result.enabled;
  delete result.source;

  if (type === "http" && result.url) {
    // HTTP: url → httpUrl
    result.httpUrl = result.url;
    delete result.url;
  }
  // SSE: 保持 url 不变

  // 超时转换：startup_timeout_sec + tool_timeout_sec → timeout（毫秒）
  if (result.startup_timeout_sec || result.tool_timeout_sec) {
    const startupMs = (result.startup_timeout_sec ?? 10) * 1000;
    const toolMs = (result.tool_timeout_sec ?? 60) * 1000;
    result.timeout = Math.max(startupMs, toolMs);
    delete result.startup_timeout_sec;
    delete result.tool_timeout_sec;
  }

  return result;
}

// ========= Gemini 格式 → 统一格式 =========
function convertFromGeminiFormat(spec: any): McpServerSpec {
  const result = { ...spec };

  // httpUrl → url + type: "http"
  if (result.httpUrl) {
    result.url = result.httpUrl;
    delete result.httpUrl;
    result.type = "http";
  }

  // 补齐 type 字段
  if (!result.type) {
    if (result.command) result.type = "stdio";
    else if (result.url) result.type = "sse";
  }

  return result;
}
```

### 4.5 OpenCode 适配器（类型名和命令格式转换）

```typescript
// ========= 统一格式 → OpenCode 格式 =========
function convertToOpenCodeFormat(spec: McpServerSpec): any {
  const result: any = {};
  const type = spec.type ?? "stdio";

  switch (type) {
    case "stdio":
      result.type = "local";  // stdio → local
      // command + args 合并为 command 数组
      // "npx" + ["-y", "fetch"] → ["npx", "-y", "fetch"]
      result.command = [spec.command, ...(spec.args ?? [])];
      if (spec.env) result.environment = spec.env; // env → environment
      result.enabled = true;
      break;

    case "sse":
    case "http":
      result.type = "remote";  // sse/http → remote
      result.url = spec.url;
      if (spec.headers) result.headers = spec.headers;
      result.enabled = true;
      break;
  }

  return result;
}

// ========= OpenCode 格式 → 统一格式 =========
function convertFromOpenCodeFormat(spec: any): McpServerSpec {
  const result: McpServerSpec = {};
  const type = spec.type ?? "local";

  switch (type) {
    case "local":
      result.type = "stdio";
      // command 数组拆分为 command + args
      // ["npx", "-y", "fetch"] → command="npx", args=["-y", "fetch"]
      const cmdArr = spec.command ?? [];
      result.command = cmdArr[0] ?? "";
      result.args = cmdArr.slice(1);
      if (spec.environment) result.env = spec.environment;
      break;

    case "remote":
      result.type = "sse";
      result.url = spec.url;
      if (spec.headers) result.headers = spec.headers;
      break;
  }

  return result;
}
```

### 4.6 Hermes 适配器（合并写入策略）

Hermes 的关键差异：无 `type` 字段，有额外的扩展字段，**写入时需要保留 Hermes 原有字段**。

```typescript
// Hermes 特有字段（导入时剥离，写入时保留）
const HERMES_EXTRA_FIELDS = [
  "enabled", "timeout", "connect_timeout",
  "tools", "sampling", "roots", "auth"
];

// ========= 统一格式 → Hermes 格式 =========
function convertToHermesFormat(spec: McpServerSpec): any {
  const result: any = {};
  const type = spec.type ?? "stdio";

  // 不输出 type 字段（Hermes 通过字段名推断）
  switch (type) {
    case "stdio":
      if (spec.command) result.command = spec.command;
      if (spec.args?.length) result.args = spec.args;
      if (spec.env && Object.keys(spec.env).length > 0) result.env = spec.env;
      break;

    case "sse":
    case "http":
      if (spec.url) result.url = spec.url;
      if (spec.headers && Object.keys(spec.headers).length > 0) result.headers = spec.headers;
      break;
  }

  result.enabled = true;
  return result;
}

// ========= 合并写入（关键差异）============
// Hermes 有 extra fields（timeout, tools, sampling 等），写入时不能覆盖
function mergeForHermesWrite(
  existingHermesConfig: any,    // Hermes 中已有的该服务器配置
  newUnifiedSpec: McpServerSpec // 从统一数据库准备写入的配置
): any {
  const newHermesFormat = convertToHermesFormat(newUnifiedSpec);

  // 从现有配置中提取 Hermes 特有字段
  const preserved: any = {};
  for (const field of HERMES_EXTRA_FIELDS) {
    if (existingHermesConfig[field] !== undefined) {
      preserved[field] = existingHermesConfig[field];
    }
  }

  // 合并：新配置 + 保留的特有字段
  return { ...newHermesFormat, ...preserved };
}
```

---

## 五、同步服务层（核心调度逻辑）

### 5.1 服务层职责

同步服务层是整个 MCP 管理的核心调度中心，负责协调数据库与各工具原生配置之间的一致性。

```typescript
class McpService {

  // ─── CRUD 操作 ───

  /// 获取所有 MCP 服务器
  getAllServers(): McpServersMap {
    return db.getAllMcpServers();
  }

  /// 添加或更新（核心方法）
  upsertServer(server: McpServer): void {
    // 1. 读取旧状态（检测哪些 app 被取消勾选）
    const prevApps = db.getAllMcpServers().get(server.id)?.apps;

    // 2. 写入数据库
    db.saveMcpServer(server);

    // 3. 处理取消勾选：从对应工具的原生配置中移除
    if (prevApps?.claude && !server.apps.claude) {
      mcpClaude.removeServer(server.id);
    }
    if (prevApps?.codex && !server.apps.codex) {
      mcpCodex.removeServer(server.id);
    }
    if (prevApps?.gemini && !server.apps.gemini) {
      mcpGemini.removeServer(server.id);
    }
    if (prevApps?.opencode && !server.apps.opencode) {
      mcpOpenCode.removeServer(server.id);
    }
    if (prevApps?.hermes && !server.apps.hermes) {
      mcpHermes.removeServer(server.id);
    }

    // 4. 同步到所有启用的工具
    for (const app of server.apps.enabledApps()) {
      syncServerToApp(server, app);
    }
  }

  /// 删除
  deleteServer(id: string): void {
    const server = db.getAllMcpServers().get(id);
    if (!server) return;

    // 1. 从数据库删除
    db.deleteMcpServer(id);

    // 2. 从所有曾启用的工具中移除
    for (const app of server.apps.enabledApps()) {
      removeServerFromApp(id, app);
    }
  }

  /// 切换单个工具的启用状态
  toggleApp(serverId: string, app: AppType, enabled: boolean): void {
    const servers = db.getAllMcpServers();
    const server = servers.get(serverId);
    if (!server) return;

    // 1. 更新数据库
    server.apps.setEnabledFor(app, enabled);
    db.saveMcpServer(server);

    // 2. 同步或移除
    if (enabled) {
      syncServerToApp(server, app);
    } else {
      removeServerFromApp(serverId, app);
    }
  }

  // ─── 同步分发 ───

  private syncServerToApp(server: McpServer, app: AppType): void {
    switch (app) {
      case "claude":
        mcpClaude.syncSingleServer(server.id, server.server);
        break;
      case "codex":
        mcpCodex.syncSingleServer(server.id, server.server);
        break;
      case "gemini":
        mcpGemini.syncSingleServer(server.id, server.server);
        break;
      case "opencode":
        mcpOpenCode.syncSingleServer(server.id, server.server);
        break;
      case "hermes":
        mcpHermes.syncSingleServer(server.id, server.server);
        break;
    }
  }

  private removeServerFromApp(id: string, app: AppType): void {
    switch (app) {
      case "claude":   mcpClaude.removeServer(id); break;
      case "codex":    mcpCodex.removeServer(id); break;
      case "gemini":   mcpGemini.removeServer(id); break;
      case "opencode": mcpOpenCode.removeServer(id); break;
      case "hermes":   mcpHermes.removeServer(id); break;
    }
  }

  // ─── 全量同步（启动时或手动触发）───

  syncAllEnabled(): void {
    for (const app of AppType.all()) {
      for (const server of db.getAllMcpServers().values()) {
        if (server.apps.isEnabledFor(app)) {
          this.syncServerToApp(server, app);
        } else {
          this.removeServerFromApp(server.id, app);
        }
      }
    }
  }
}
```

### 5.2 操作时序图

#### 添加/编辑 MCP 服务器

```
用户在 UI 点击保存
  │
  ▼
mcpApi.upsertUnifiedServer(server)
  │
  ▼
McpService.upsert_server(server)
  │
  ├── 读取旧 apps 状态
  ├── 写入数据库 (save_mcp_server)
  │
  ├── 对比新旧 apps，找出被取消勾选的工具
  │   └── 从各工具原生配置移除
  │       ├── claude: remove_server_from_claude(id)
  │       │   └── 读 ~/.claude.json → 删除 mcpServers[id] → 写回
  │       ├── codex: remove_server_from_codex(id)
  │       │   └── 读 config.toml → 删除 [mcp_servers.id] → 写回
  │       └── ...
  │
  └── 对所有新启用的工具，同步写入
      ├── claude: sync_single_server_to_claude(id, spec)
      │   └── 读 ~/.claude.json → 设置 mcpServers[id] = spec → 写回
      ├── codex: sync_single_server_to_codex(id, spec)
      │   └── 读 config.toml → JSON→TOML 转换 → 设置 [mcp_servers.id] → 写回
      ├── gemini: sync_single_server_to_gemini(id, spec)
      │   └── 读 settings.json → url→httpUrl 转换 → 设置 mcpServers[id] → 写回
      └── ...
```

#### 切换单个工具启用

```
用户点击 Claude 开关（关闭）
  │
  ▼
mcpApi.toggleApp(serverId, "claude", false)
  │
  ▼
McpService.toggle_app(serverId, "claude", false)
  │
  ├── 更新数据库: server.apps.claude = false → save_mcp_server
  │
  └── 从 Claude 原生配置移除
      └── mcp::remove_server_from_claude(serverId)
          ├── 读 ~/.claude.json
          ├── delete mcpServers[serverId]
          └── 写回 ~/.claude.json
```

---

## 六、导入机制（从各工具迁移已有配置）

### 6.1 导入设计原则

1. **不覆盖已有数据**：如果数据库中已存在同名服务器，只启用对应的工具标记，不修改 `server` 配置和其他 `apps` 标记
2. **单项失败不中止**：某个条目校验失败时记录警告，继续处理其他条目
3. **校验后写入**：导入前必须通过 `validate_server_spec()` 校验

### 6.2 通用导入流程

```typescript
function importFromTool(
  readNativeConfig: () => Record<string, any>,  // 读取工具原生配置
  convertToUnified: (id: string, spec: any) => McpServerSpec, // 格式转换
  targetApp: AppType  // 标记为哪个工具
): number {
  const nativeMap = readNativeConfig();
  const servers = db.getAllMcpServers(); // 统一数据库
  let changed = 0;

  for (const [id, nativeSpec] of Object.entries(nativeMap)) {
    // 1. 格式转换
    const unifiedSpec = convertToUnified(id, nativeSpec);

    // 2. 校验
    if (!validateServerSpec(unifiedSpec)) continue;

    // 3. 检查是否已存在
    if (servers.has(id)) {
      // 已存在：仅启用对应工具（不覆盖其他字段）
      const existing = servers.get(id)!;
      if (!existing.apps.isEnabledFor(targetApp)) {
        existing.apps.setEnabledFor(targetApp, true);
        db.saveMcpServer(existing);
        changed++;
      }
    } else {
      // 新建：默认仅启用导入来源的工具
      const newServer: McpServer = {
        id,
        name: id,
        server: unifiedSpec,
        apps: { claude: false, codex: false, gemini: false, opencode: false, hermes: false },
      };
      newServer.apps.setEnabledFor(targetApp, true);
      db.saveMcpServer(newServer);
      changed++;
    }
  }

  return changed;
}
```

### 6.3 全量导入（一键从所有已安装工具导入）

```typescript
function importFromAllApps(): number {
  let total = 0;

  // 每个工具独立判断是否已安装
  if (shouldSyncClaude())   total += importFromTool(readClaudeConfig,   convertFromClaudeFormat,   "claude");
  if (shouldSyncCodex())    total += importFromTool(readCodexConfig,    convertFromCodexFormat,    "codex");
  if (shouldSyncGemini())   total += importFromTool(readGeminiConfig,   convertFromGeminiFormat,   "gemini");
  if (shouldSyncOpenCode()) total += importFromTool(readOpenCodeConfig, convertFromOpenCodeFormat, "opencode");
  if (shouldSyncHermes())   total += importFromTool(readHermesConfig,   convertFromHermesFormat,   "hermes");

  return total;
}
```

---

## 七、Proxy 接管时的 MCP 保护

当代理系统接管工具配置时（替换 API 端点和认证信息），必须保护已有的 MCP 服务器配置不被覆盖。

### 7.1 问题场景

代理接管 Codex 配置时需要修改 `config.toml` 中的 `base_url` 和认证信息，但如果简单地重写整个文件，会丢失 `[mcp_servers]` 部分。

### 7.2 解决方案

```typescript
function preserveCodexMcpServersDuringTakeover(
  originalConfig: TomlDocument,
  backupConfig: TomlDocument
): void {
  // 从原始配置中提取 [mcp_servers]
  const mcpServers = originalConfig.get("mcp_servers");

  if (mcpServers) {
    // 合并到备份配置中（不覆盖已有条目）
    if (!backupConfig.has("mcp_servers")) {
      backupConfig.set("mcp_servers", new TomlTable());
    }

    const backupMcp = backupConfig.getTable("mcp_servers");
    for (const [id, server] of mcpServers.entries()) {
      if (!backupMcp.has(id)) {
        backupMcp.set(id, server);
      }
    }
  }

  // 同时清理可能存在的错误格式 [mcp.servers]
  if (originalConfig.has("mcp", "servers")) {
    originalConfig.remove("mcp", "servers");
  }
}
```

### 7.3 Gemini 的特殊处理

Gemini 的 MCP 配置在 `settings.json` 中，而代理只需要修改 `.env` 文件，因此**不需要动 `settings.json`**，MCP 配置天然安全。

---

## 八、前端 UI 设计

### 8.1 核心组件

```
UnifiedMcpPanel              ← 主面板：服务器列表 + 每行的应用开关
├── McpFormModal             ← 添加/编辑表单（JSON/TOML 输入 + 实时校验）
│   └── McpWizardModal       ← 分步向导（类型选择 → 参数填写 → 预览）
└── AppToggleGroup           ← 每行的应用启停开关组件
```

### 8.2 React Query Hooks

```typescript
// 查询所有 MCP 服务器
function useAllMcpServers() {
  return useQuery({
    queryKey: ["mcp", "all"],
    queryFn: () => mcpApi.getAllServers(),
  });
}

// 添加/更新（乐观更新）
function useUpsertMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (server: McpServer) => mcpApi.upsertUnifiedServer(server),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp", "all"] }),
  });
}

// 切换单个应用
function useToggleMcpApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, app, enabled }: {
      serverId: string; app: AppId; enabled: boolean;
    }) => mcpApi.toggleApp(serverId, app, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp", "all"] }),
  });
}

// 从所有工具导入
function useImportMcpFromApps() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => mcpApi.importFromApps(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp", "all"] }),
  });
}
```

### 8.3 校验逻辑

```typescript
// 基础校验规则
function validateServerSpec(spec: McpServerSpec): string | null {
  const type = spec.type ?? "stdio";

  switch (type) {
    case "stdio":
      if (!spec.command?.trim()) return "stdio 类型必须提供 command";
      break;
    case "http":
      if (!spec.url?.trim()) return "http 类型必须提供 url";
      break;
    case "sse":
      if (!spec.url?.trim()) return "sse 类型必须提供 url";
      break;
    default:
      return `不支持的 type: ${type}（仅支持 stdio/http/sse）`;
  }

  return null; // 校验通过
}
```

---

## 九、平台适配细节

### 9.1 工具存在性检测（守卫函数）

每个适配器在执行任何文件操作前，必须检查工具是否已安装。如果工具未安装，静默跳过（不创建任何文件或目录）。

```typescript
function shouldSyncClaude(): boolean {
  // ~/.claude 目录存在 或 ~/.claude.json 存在
  return existsSync("~/.claude") || existsSync("~/.claude.json");
}

function shouldSyncCodex(): boolean {
  // ~/.codex 目录存在
  return existsSync("~/.codex");
}

function shouldSyncGemini(): boolean {
  // ~/.gemini 目录存在
  return existsSync("~/.gemini");
}
```

### 9.2 文件写入策略

| 工具 | 写入方式 | 原子写入 | 格式保留 | 并发保护 |
|------|---------|---------|---------|---------|
| Claude | 读→改→写 | ✅ atomic_write | N/A (JSON) | — |
| Codex | toml_edit 读→改→写 | ✅ write_text_file | ✅ 保留注释/空白 | — |
| Gemini | 读→改→写 | ✅ atomic_write | N/A (JSON) | — |
| OpenCode | 读→改→写 | ✅ atomic_write | N/A (JSON) | — |
| Hermes | 读→合并→写 | ✅ atomic_write | N/A (YAML) | ✅ write_lock |

### 9.3 Hermes 写入锁

Hermes 使用写锁防止 TOCTOU 竞态（多个操作同时读→改→写同一文件）：

```typescript
const hermesWriteLock = new Mutex();

async function syncSingleServerToHermes(id: string, spec: McpServerSpec): Promise<void> {
  await hermesWriteLock.acquire();
  try {
    // 读取现有配置
    const current = readHermesConfig();

    // 合并写入（保留 Hermes 特有字段）
    const existing = current.mcp_servers?.[id] ?? {};
    current.mcp_servers[id] = mergeForHermesWrite(existing, spec);

    // 写回
    writeHermesConfig(current);
  } finally {
    hermesWriteLock.release();
  }
}
```

### 9.4 TOML JSON 值转换限制

JSON → TOML 转换有类型限制，不支持的类型会被静默跳过并记录警告：

| JSON 类型 | TOML 类型 | 支持 |
|-----------|----------|------|
| `string` | String | ✅ |
| `number` (整数) | Integer | ✅ |
| `number` (浮点) | Float | ✅ |
| `boolean` | Boolean | ✅ |
| `string[]` | Array | ✅ |
| `number[]` | Array | ✅ |
| `boolean[]` | Array | ✅ |
| `object`（全字符串值） | Inline Table | ✅ |
| `null` | — | ❌ 跳过 |
| 混合类型数组 | — | ❌ 跳过 |
| 深度嵌套对象 | — | ❌ 跳过 |

---

## 十、接入建议与参考文件清单

### 10.1 如果你要接入新的工具

假设你要接入一个新工具 "MyTool"，步骤如下：

```
Step 1: 数据模型扩展
  ├── McpApps 添加 mytool: boolean 字段
  ├── AppType 枚举添加 MyTool 变体
  └── 数据库 mcp_servers 表添加 enabled_mytool 列（ALTER TABLE migration）

Step 2: 实现格式适配器 (mcp/mytool.rs)
  ├── shouldSyncMyTool() → 检测工具是否已安装
  ├── convertToMyToolFormat() → 统一格式 → 工具原生格式
  ├── convertFromMyToolFormat() → 工具原生格式 → 统一格式
  ├── syncSingleServerToMyTool() → 写入单个服务器到工具配置
  ├── removeServerFromMyTool() → 从工具配置移除单个服务器
  └── importFromMyTool() → 从工具配置导入到统一数据库

Step 3: 注册到同步服务层 (services/mcp.rs)
  ├── upsert_server() 中添加 MyTool 的 enabled 检查
  ├── sync_server_to_app() 中添加 MyTool 分支
  └── remove_server_from_app() 中添加 MyTool 分支

Step 4: 前端适配
  ├── types.ts 中 McpApps 添加 mytool 字段
  ├── UnifiedMcpPanel 中添加 MyTool 的开关
  └── McpFormModal 中添加 MyTool 的启用复选框
```

### 10.2 最小可行版本（MVP）

| 优先级 | 模块 | 说明 |
|--------|------|------|
| P0 | 统一数据模型 | `McpServer` + `McpApps` + SQLite 表 |
| P0 | 两个工具的格式适配器 | 以 Claude + Codex 为例，覆盖 JSON 和 TOML 两种格式 |
| P0 | 同步服务层 | `upsert` / `delete` / `toggle` 三个核心操作 |
| P1 | 导入机制 | 从已有工具配置迁移到统一数据库 |
| P1 | 前端 UI | 列表 + 添加/编辑表单 + 应用开关 |
| P2 | 更多工具 | Gemini / OpenCode / Hermes 逐个接入 |
| P2 | 向导模式 | McpWizard 分步创建 |
| P2 | Deep Link 批量导入 | 通过 URL scheme 批量添加 |

### 10.3 CC Switch 项目参考文件清单

**核心实现（必读）：**

| 文件 | 说明 |
|------|------|
| `src-tauri/src/app_config.rs` | 数据模型：`McpServer`, `McpApps`, `AppType`, `McpRoot` + 迁移逻辑 |
| `src-tauri/src/services/mcp.rs` | **同步服务层**：upsert/delete/toggle/syncAllEnabled 核心调度 |
| `src-tauri/src/database/dao/mcp.rs` | DAO 层：SQLite CRUD 操作 |
| `src-tauri/src/mcp/validation.rs` | 通用校验：`validate_server_spec()`, `extract_server_spec()` |

**各工具适配器：**

| 文件 | 说明 |
|------|------|
| `src-tauri/src/mcp/claude.rs` | Claude 同步/导入/移除（最简单的适配器） |
| `src-tauri/src/mcp/codex.rs` | Codex 同步/导入/移除 + **JSON↔TOML 转换**（最复杂） |
| `src-tauri/src/mcp/gemini.rs` | Gemini 同步/导入/移除 |
| `src-tauri/src/mcp/opencode.rs` | OpenCode 同步/导入/移除 + `local/remote` 类型转换 |
| `src-tauri/src/mcp/hermes.rs` | Hermes 同步/导入/移除 + **合并写入策略** + 写锁 |

**工具原生配置读写：**

| 文件 | 说明 |
|------|------|
| `src-tauri/src/claude_mcp.rs` | Claude `~/.claude.json` 读写 + **Windows cmd /c 包装** |
| `src-tauri/src/gemini_mcp.rs` | Gemini `~/.gemini/settings.json` 读写 + **httpUrl↔url 转换** |
| `src-tauri/src/codex_config.rs` | Codex `~/.codex/config.toml` 路径解析 |
| `src-tauri/src/hermes_config.rs` | Hermes `~/.hermes/config.yaml` 路径解析 |
| `src-tauri/src/opencode_config.rs` | OpenCode 配置路径解析 |

**前端：**

| 文件 | 说明 |
|------|------|
| `src/types.ts` (L426-483) | TypeScript 类型定义 |
| `src/lib/api/mcp.ts` | Tauri IPC API 封装 |
| `src/hooks/useMcp.ts` | React Query Hooks |
| `src/components/mcp/UnifiedMcpPanel.tsx` | 主面板 UI |
| `src/components/mcp/McpFormModal.tsx` | 添加/编辑表单 |
| `src/components/mcp/McpWizardModal.tsx` | 分步创建向导 |
| `src/components/mcp/useMcpValidation.ts` | 校验逻辑 |
| `src/config/mcpPresets.ts` | 内置预设（fetch/time/memory 等） |

**数据库 Schema 与迁移：**

| 文件 | 说明 |
|------|------|
| `src-tauri/src/database/schema.rs` (L64-70) | 建表 SQL |
| `src-tauri/src/database/schema.rs` (L480-495) | 迁移：添加 description/homepage/docs/tags 列 |
| `src-tauri/src/database/schema.rs` (L966-984) | 迁移：v3→v4 添加 enabled_opencode |
| `src-tauri/src/database/schema.rs` (L1182-1200) | 迁移：v9→v10 添加 enabled_hermes |

**Proxy MCP 保护：**

| 文件 | 说明 |
|------|------|
| `src-tauri/src/services/proxy.rs` (L1879) | `preserve_codex_mcp_servers_in_backup()` 接管时保护 MCP |
