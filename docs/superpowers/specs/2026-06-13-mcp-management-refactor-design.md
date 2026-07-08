# MCP 统一管理重构设计

> 将 CodeMUX 的 MCP 管理功能重构为 per-tool 启用控制 + 多工具配置同步架构，对齐 CC Switch 项目的 MCP 统一管理指导文档。

---

## 一、背景与目标

### 1.1 当前问题

CodeMUX 现有的 MCP 管理存在以下限制：

1. **单一启用开关**：`enabled: boolean` 无法区分"哪些工具使用这个 MCP 服务器"
2. **仅 Claude 适配**：所有变更只同步到 `~/.claude.json`，不支持 Codex/Gemini/OpenCode
3. **强类型 Transport**：`McpTransport` enum 无法透传各工具的扩展字段
4. **启动探测开销**：启动时并发探测所有 MCP 服务器，增加启动时间

### 1.2 目标

- 数据库是唯一真相源，各工具的原生配置文件是投影
- 支持 4 个工具：**Claude Code、Codex CLI、Gemini CLI、OpenCode**
- 每个 MCP 服务器可独立启用/禁用到任意工具组合
- 按需探测（进入列表/刷新），移除启动探测

### 1.3 参考文档

`docs/mcp-unified-management-guide.md`（从 CC Switch 项目总结的实现指导）

---

## 二、数据模型

### 2.1 Rust 类型定义

```rust
// src-tauri/src/mcp/types.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpApps {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub opencode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub id: String,               // 唯一标识（通常是服务器名）
    pub name: String,             // 显示名称
    pub server: serde_json::Value, // 松散 JSON，透传任意字段（McpServerSpec）
    pub apps: McpApps,            // per-tool 启用状态
}
```

### 2.2 TypeScript 类型定义

```typescript
// src/types/mcp.ts

interface McpApps {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  opencode: boolean;
}

interface McpServer {
  id: string;
  name: string;
  server: Record<string, any>;  // 松散 JSON，透传任意字段
  apps: McpApps;
}

type McpServersMap = Record<string, McpServer>;
```

### 2.3 `server` 字段格式（McpServerSpec）

`server` 字段是松散 JSON，核心字段如下：

```typescript
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
  // 允许任意扩展字段
  [key: string]: any;
}
```

### 2.4 SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    server_config   TEXT NOT NULL,           -- JSON 序列化的 McpServerSpec
    enabled_claude  BOOLEAN NOT NULL DEFAULT 0,
    enabled_codex   BOOLEAN NOT NULL DEFAULT 0,
    enabled_gemini  BOOLEAN NOT NULL DEFAULT 0,
    enabled_opencode BOOLEAN NOT NULL DEFAULT 0
);
```

### 2.5 数据库迁移

从旧 schema 直接迁移：

1. 创建新表 `mcp_servers_new`
2. 迁移数据：`enabled=true` → `enabled_claude=true`，将 `transport` 字段序列化为 JSON 写入 `server_config`
3. 删除旧表，重命名新表
4. 删除不再需要的列：`description`、`subtitle`、`always_load`、`enabled`、`transport_type`、`transport_config`、`created_at`、`updated_at`

---

## 三、Adapter Trait 与格式转换

### 3.1 Trait 定义

```rust
// src-tauri/src/mcp/adapters/mod.rs

pub trait McpAdapter {
    /// 工具是否已安装（配置目录/文件是否存在）
    fn should_sync(&self) -> bool;

    /// 将统一 McpServerSpec 写入工具的原生配置
    fn sync_single_server(&self, id: &str, server_spec: &serde_json::Value) -> Result<()>;

    /// 从工具的原生配置中移除单个服务器
    fn remove_server(&self, id: &str) -> Result<()>;

    /// 从工具的原生配置导入服务器到统一格式
    /// 返回 Vec<(server_id, McpServerSpec_json)>
    fn import_from_tool(&self) -> Result<Vec<(String, serde_json::Value)>>;
}
```

### 3.2 Dispatch 函数

```rust
// src-tauri/src/mcp/adapters/mod.rs

pub fn get_adapter(app: &str) -> Option<&'static dyn McpAdapter> {
    match app {
        "claude"   => Some(&ClaudeAdapter),
        "codex"    => Some(&CodexAdapter),
        "gemini"   => Some(&GeminiAdapter),
        "opencode" => Some(&OpenCodeAdapter),
        _ => None,
    }
}

pub fn all_apps() -> &[&str] {
    &["claude", "codex", "gemini", "opencode"]
}
```

### 3.3 各 Adapter 要点

#### ClaudeAdapter（`adapters/claude.rs`）

- **配置文件**：`~/.claude.json` → `mcpServers` 节点
- **守卫**：`~/.claude.json` 或 `~/.claude` 目录存在
- **格式转换**：几乎透传，写入前剥离 UI 辅助字段
- **特殊处理**：Windows 平台 `cmd /c` 包装 npx/npm/yarn/pnpm/node/bun/deno 命令
- **写入策略**：读 → 改 → 原子写（temp + rename）

#### CodexAdapter（`adapters/codex.rs`）

- **配置文件**：`~/.codex/config.toml` → `[mcp_servers]` 表
- **守卫**：`~/.codex` 目录存在
- **格式转换**：
  - 统一 → Codex：`headers` → `http_headers`（TOML 子表）
  - Codex → 统一：`http_headers` → `headers`
- **TOML 结构**：
  ```toml
  [mcp_servers.fetch]
  type = "stdio"
  command = "npx"
  args = ["-y", "@modelcontextprotocol/server-fetch"]
  ```
- **写入策略**：`toml_edit` 读 → 改 → 写（保留注释和格式）
- **Windows 适配**：同 ClaudeAdapter 的 `cmd /c` 包装

#### GeminiAdapter（`adapters/gemini.rs`）

- **配置文件**：`~/.gemini/settings.json` → `mcpServers` 节点
- **守卫**：`~/.gemini` 目录存在
- **格式转换**：
  - 统一 → Gemini：`url` → `httpUrl`（http 类型）；移除 `type` 字段
  - Gemini → 统一：`httpUrl` → `url` + `type: "http"`；通过字段名推断 type
- **写入策略**：读 → 改 → 原子写

#### OpenCodeAdapter（`adapters/opencode.rs`）

- **配置文件**：`opencode.json`（项目根目录）→ `mcp` 节点
- **守卫**：项目根目录下 `opencode.json` 存在
- **格式转换**：
  - 统一 → OpenCode：`stdio` → `local`，`http/sse` → `remote`；`command + args` 合并为 `command` 数组；`env` → `environment`
  - OpenCode → 统一：`local` → `stdio`，`remote` → `sse`；`command` 数组拆分；`environment` → `env`
- **写入策略**：读 → 改 → 原子写

---

## 四、同步服务层

### 4.1 核心操作

#### `upsert_server(server: McpServer)`

```
1. 读取旧 apps 状态（从 DB 查询当前记录）
2. 写入数据库（INSERT OR REPLACE）
3. 对比新旧 apps：
   - 旧=enabled, 新=disabled → removeServerFromApp(id, app)
   - 旧=disabled, 新=enabled → syncServerToApp(id, spec, app)
   - 未变化 → 跳过
```

#### `delete_server(id: &str)`

```
1. 从 DB 读取 server（获取 apps 状态）
2. 从 DB 删除
3. 从所有曾 enabled 的工具中移除：removeServerFromApp(id, app)
```

#### `toggle_app(server_id: &str, app: &str, enabled: bool)`

```
1. 更新 DB 中对应的 enabled_* 列
2. enabled=true → syncServerToApp(id, spec, app)
3. enabled=false → removeServerFromApp(id, app)
```

### 4.2 Tauri Commands

```rust
#[tauri::command] get_mcp_servers() -> Vec<McpServer>
#[tauri::command] upsert_mcp_server(server: McpServer) -> Result<()>
#[tauri::command] delete_mcp_server(id: String) -> Result<()>
#[tauri::command] toggle_mcp_app(server_id: String, app: String, enabled: bool) -> Result<()>
#[tauri::command] probe_mcp_server(id: String) -> Result<McpProbeResult>
#[tauri::command] import_mcp_from_apps() -> Result<ImportResult>
```

### 4.3 前端 API

```typescript
// src/lib/tauri.ts
export const mcpApi = {
  getAll:          () => invoke('get_mcp_servers'),
  upsert:          (server) => invoke('upsert_mcp_server', { server }),
  delete:          (id) => invoke('delete_mcp_server', { id }),
  toggleApp:       (serverId, app, enabled) => invoke('toggle_mcp_app', { serverId, app, enabled }),
  probe:           (id) => invoke('probe_mcp_server', { id }),
  importFromApps:  () => invoke('import_mcp_from_apps'),
};
```

---

## 五、导入机制

### 5.1 导入原则

1. **不覆盖已有数据**：已存在的同名服务器只启用对应 app 标记
2. **单项失败不中止**：某个条目校验失败时记录警告，继续处理
3. **校验后写入**：导入前校验 `command`（stdio）或 `url`（http/sse）必填

### 5.2 校验规则

```rust
fn validate_server_spec(spec: &serde_json::Value) -> Result<()> {
    let server_type = spec.get("type").and_then(|v| v.as_str()).unwrap_or("stdio");
    match server_type {
        "stdio" => {
            if spec.get("command").and_then(|v| v.as_str()).is_none_or(|s| s.is_empty()) {
                return Err("stdio 类型必须提供 command");
            }
        }
        "http" | "sse" => {
            if spec.get("url").and_then(|v| v.as_str()).is_none_or(|s| s.is_empty()) {
                return Err("http/sse 类型必须提供 url");
            }
        }
        other => return Err(format!("不支持的 type: {}", other)),
    }
    Ok(())
}
```

### 5.3 导入流程

```
import_from_apps():
  total = 0
  for app in ["claude", "codex", "gemini", "opencode"]:
    adapter = get_adapter(app)
    if adapter.should_sync():
      entries = adapter.import_from_tool()
      for (id, spec) in entries:
        validate(spec)
        if DB.has(id):
          // 已存在：仅启用对应 app
          existing = DB.get(id)
          existing.apps.set(app, true)
          DB.save(existing)
        else:
          // 新建：仅启用来源 app
          new_server = McpServer { id, name: id, server: spec, apps: {app: true, others: false} }
          DB.save(new_server)
        total += 1
  return { claude: N, codex: N, gemini: N, opencode: N, total }
```

---

## 六、探测功能

### 6.1 变更

- **移除**：启动时并发探测所有 enabled 服务器 + `AppState.mcp_instructions` 缓存
- **保留**：按需探测（进入 MCP 列表页 / 点击刷新按钮时触发）

### 6.2 探测逻辑

沿用现有 MCP `initialize` JSON-RPC 探测方式。探测函数从 DB 读取 `server_config`（JSON），解析 `type` 字段决定连接方式：

- `type=stdio` 或无 type：启动子进程（`command` + `args`）发送 initialize 请求
- `type=http`：POST 请求到 `url`
- `type=sse`：GET 请求到 `url`
- 超时：10 秒

探测结果实时返回前端，不缓存到后端状态。

### 6.3 Agent Session 注入（简化）

移除 `mcpServerInstructions` 注入。创建 session 时：

1. 从 DB 读取当前工具所有 enabled 的服务器
2. 通过 adapter 转换为 SDK 格式
3. 注入 `mcpServers` 到 sidecar command

---

## 七、前端 UI

### 7.1 组件结构

```
McpSettings（重构现有）
├── 顶部工具栏
│   ├── [添加服务器] 按钮
│   ├── [从工具导入] 按钮
│   └── [刷新探测] 按钮
├── 服务器列表
│   └── 每行：名称 + 传输类型摘要 + 探测状态指示灯 + 4 个工具开关 + 编辑/删除
└── 添加/编辑弹窗（保留现有 JSON 编辑器 + 配置向导）
```

### 7.2 列表行布局

```
┌─────────────────────────────────────────────────────────────┐
│  🟢 fetch          stdio: npx -y @mcp/server-fetch    [✏️][🗑️] │
│     [Claude ✓] [Codex ✓] [Gemini ☐] [OpenCode ☐]              │
└─────────────────────────────────────────────────────────────┘
```

### 7.3 mcpStore 变更

- 移除 `toggleServer(id)` → 改用 `toggleApp(serverId, app, enabled)`
- 新增 `importFromApps()`
- probe 改为按需触发（进入页面 / 刷新按钮）

---

## 八、各工具原生配置格式速查

| 维度 | Claude Code | Codex CLI | Gemini CLI | OpenCode |
|------|------------|-----------|------------|---------|
| 文件格式 | JSON | TOML | JSON | JSON |
| 存储键 | `mcpServers` | `[mcp_servers]` | `mcpServers` | `mcp` |
| type 字段 | 显式 `"stdio"` | 显式 `"stdio"` | 无（推断） | `"local"/"remote"` |
| stdio 命令 | `command` + `args` 分离 | `command` + `args` 分离 | `command` + `args` 分离 | `command: [cmd, ...args]` 合并 |
| 环境变量 | `env: {}` | `[env]` TOML 表 | `env: {}` | `environment: {}` |
| HTTP URL | `url` + `type: "http"` | `url` + `type: "http"` | `httpUrl`（不是 `url`） | `url` + `type: "remote"` |
| HTTP Headers | `headers: {}` | `[http_headers]` TOML 表 | `headers: {}` | `headers: {}` |
| 工作目录 | `cwd` | `cwd` | — | — |

---

## 九、实现范围

### 包含

- [ ] 数据模型重构（McpServer + McpApps + 松散 JSON server）
- [ ] SQLite schema 迁移
- [ ] 4 个 Adapter 实现（Claude/Codex/Gemini/OpenCode）
- [ ] 同步服务层（upsert/delete/toggle）
- [ ] 导入机制
- [ ] 前端 UI 重构（per-tool 开关 + 导入按钮）
- [ ] 按需探测（移除启动探测）
- [ ] Windows `cmd /c` 命令包装
- [ ] 原子写入策略

### 不包含

- 元数据字段（description/homepage/docs/tags）
- Hermes 适配器
- Proxy MCP 保护
- Deep Link 批量导入
- MCP Wizard 分步创建（保留现有简化向导即可）
