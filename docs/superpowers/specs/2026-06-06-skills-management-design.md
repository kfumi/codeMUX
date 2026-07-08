# Skills 管理与使用系统设计

> CodeMUX 自定义 skill 系统 — 支持市场浏览、安装/卸载、内置 skills、slash 命令集成

## 概述

为 CodeMUX 添加一套完整的 skill 管理系统，让用户可以：
- 从 GitHub 仓库（如 `anthropics/skills`）浏览和安装 skills
- 在 Settings UI 中管理已安装的 skills（启用/禁用/卸载）
- 使用内置的 `find-skills` 和 `skill-creator` skills
- 通过 `/` 命令菜单快速调用已安装的 skills

Skills 遵循 Claude Code 的 SKILL.md 格式，安装到 `~/.claude/skills/` 目录，与 Claude Agent SDK 原生兼容。

## 数据模型

### SQLite 表：`skills`

```sql
CREATE TABLE skills (
  id            TEXT PRIMARY KEY,   -- UUID
  name          TEXT NOT NULL UNIQUE, -- skill 目录名 (如 "brainstorming")
  display_name  TEXT,               -- 可选的显示名
  description   TEXT,               -- SKILL.md frontmatter 中的 description
  source_repo   TEXT,               -- 来源仓库 (如 "anthropics/skills")，内置 skill 为 NULL
  source_path   TEXT,               -- 仓库中的路径 (如 "skills/brainstorming")
  version       TEXT,               -- 版本号 (如有)
  installed_at  TEXT NOT NULL,      -- ISO 时间戳
  enabled       INTEGER DEFAULT 1,  -- 0=禁用, 1=启用
  is_builtin    INTEGER DEFAULT 0   -- 1=内置 skill (find-skills, skill-creator)
);
```

### 文件系统

```
~/.claude/skills/
  find-skills/SKILL.md          # 内置
  skill-creator/SKILL.md       # 内置
  brainstorming/SKILL.md       # 从市场安装
  writing-skills/SKILL.md      # 从市场安装
  ...
```

### 源仓库配置

在 `AppConfig` 中新增 `skill_sources` 字段：

```rust
// config/types.rs
pub struct SkillSource {
    pub repo: String,        // "owner/repo"，如 "anthropics/skills"
    pub branch: String,      // 默认 "main"
    pub skills_path: String, // skills 在仓库中的子目录，默认 "skills/"
}
```

默认值：`[{ repo: "anthropics/skills", branch: "main", skills_path: "skills/" }]`

## Rust 后端

### 模块结构

```
src-tauri/src/
  skills/
    mod.rs              # 模块入口，re-export
    types.rs            # Skill, SkillSource 结构体
    db.rs               # SQLite CRUD 操作
    github.rs           # GitHub API 调用
    commands.rs         # Tauri 命令
```

### Tauri 命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `list_installed_skills` | — | `Vec<Skill>` | 获取已安装的 skills 列表 |
| `browse_repo_skills` | `repo, branch?, path?` | `Vec<RepoSkillEntry>` | 从 GitHub 仓库浏览可用 skills |
| `install_skill` | `repo, branch, path, name` | `Skill` | 下载并安装 skill |
| `uninstall_skill` | `id` | `bool` | 删除 skill 文件和数据库记录 |
| `toggle_skill` | `id, enabled` | `bool` | 启用/禁用 skill |
| `get_skill_content` | `id` | `String` | 获取 SKILL.md 内容（预览） |
| `sync_builtin_skills` | — | `Vec<Skill>` | 启动时确保内置 skills 存在 |
| `get_skill_sources` | — | `Vec<SkillSource>` | 获取配置的源仓库列表 |
| `add_skill_source` | `repo, branch?, path?` | `SkillSource` | 添加新的源仓库 |
| `remove_skill_source` | `repo` | `bool` | 移除源仓库 |
| `register_skill_from_disk` | `name` | `Skill` | 扫描磁盘上的 skill 并注册到数据库 |

### GitHub API 集成 (`github.rs`)

使用 `reqwest` 调用 GitHub REST API：

- `GET /repos/{owner}/{repo}/contents/{path}` — 列出目录，识别包含 SKILL.md 的子目录
- `GET /repos/{owner}/{repo}/contents/{path}/{name}/SKILL.md` — 获取文件内容（Base64 解码）
- 支持可选的 GitHub token（通过 `GITHUB_TOKEN` 环境变量或配置）提高速率限制
- 安装时下载整个 skill 目录（SKILL.md + 支持文件）

**浏览逻辑：**
1. 调用 `GET /repos/{owner}/{repo}/contents/{skills_path}` 获取目录列表
2. 过滤出类型为 `dir` 的条目（每个子目录代表一个 skill）
3. 对每个子目录，获取 `SKILL.md` 文件内容（通过 contents API 返回的 Base64 编码）
4. 解析 SKILL.md 的 frontmatter 提取 name 和 description
5. 对比数据库中已安装的 skills，标记 `installed` 状态
6. 返回包含名称、描述、路径、安装状态的列表

**安装逻辑：**
1. 递归下载 skill 目录中的所有文件
2. 写入 `~/.claude/skills/{name}/`
3. 解析 SKILL.md frontmatter 获取元数据
4. 插入 SQLite 记录

### 数据库操作 (`db.rs`)

```rust
pub fn init_skills_table(db: &Connection) -> Result<()>
pub fn list_skills(db: &Connection) -> Result<Vec<Skill>>
pub fn get_skill(db: &Connection, id: &str) -> Result<Option<Skill>>
pub fn get_skill_by_name(db: &Connection, name: &str) -> Result<Option<Skill>>
pub fn insert_skill(db: &Connection, skill: &Skill) -> Result<()>
pub fn update_skill_enabled(db: &Connection, id: &str, enabled: bool) -> Result<()>
pub fn delete_skill(db: &Connection, id: &str) -> Result<()>
/// 注册磁盘上已有但数据库中没有的 skill（用于 skill-creator 创建的 skills）
pub fn register_skill_from_disk(skills_dir: &Path, name: &str) -> Result<Skill>
```

### 启动流程

应用启动时调用 `sync_builtin_skills`：
1. 从配置的内置源仓库下载 `find-skills` 和 `skill-creator`（默认从 `anthropics/skills` 仓库）
2. 写入 `~/.claude/skills/{name}/SKILL.md`
3. 如果下载失败（网络不可用），使用内置 fallback 内容
4. 在 SQLite 中标记 `is_builtin = 1`
5. 内置 skills 不可卸载，但可以禁用

## Sidecar 集成

### 修改 `sidecar/src/types.ts`

```typescript
// start 命令新增 skills 字段
{ type: 'start'; prompt: string; cwd: string; sessionId?: string;
  apiKey?: string; baseUrl?: string; model?: string;
  mcpServers?: Record<string, unknown>;
  mcpServerInstructions?: Record<string, string>;
  skills?: string[];  // 新增：启用的 skill 名称列表
}
```

### 修改 `sidecar/src/index.ts`

在 `handleStart` 的 `options` 中：

```typescript
// 1. 将 'Skill' 加入 allowedTools
allowedTools: [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'AskUserQuestion', 'TodoWrite',
  'WaitForMcpServers', 'Skill',  // 新增
  ...Object.keys(cmd.mcpServers || {}).map(name => `mcp__${name}__*`),
],

// 2. 传递 skills 选项给 SDK
if (cmd.skills !== undefined) {
  options.skills = cmd.skills;
}
```

### Rust 端传递 skills

在 `agent/commands.rs` 的 start 命令处理中：
1. 从 SQLite 查询所有 `enabled = 1` 的 skills
2. 提取 skill 名称列表
3. 传递给 sidecar 的 `start` 命令

```rust
// 伪代码
let enabled_skills: Vec<String> = db::list_skills(&conn)?
    .into_iter()
    .filter(|s| s.enabled)
    .map(|s| s.name)
    .collect();

sidecar.send(StartCommand {
    // ...existing fields...
    skills: if enabled_skills.is_empty() { None } else { Some(enabled_skills) },
});
```

## 前端

### 新增 Store：`skillStore.ts`

```typescript
interface SkillState {
  installedSkills: Skill[];
  browseResults: RepoSkillEntry[];
  skillSources: SkillSource[];
  loading: boolean;
  browseLoading: boolean;
  error: string | null;

  // Actions
  fetchInstalled: () => Promise<void>;
  browseRepo: (repo: string, branch?: string, path?: string) => Promise<void>;
  installSkill: (repo: string, branch: string, path: string, name: string) => Promise<void>;
  uninstallSkill: (id: string) => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
  getSkillContent: (id: string) => Promise<string>;
  syncBuiltins: () => Promise<void>;
  fetchSources: () => Promise<void>;
  addSource: (repo: string, branch?: string, path?: string) => Promise<void>;
  removeSource: (repo: string) => Promise<void>;
  registerFromDisk: (name: string) => Promise<void>;
}
```

### Tauri API 包装 (`lib/tauri.ts`)

```typescript
export const skillApi = {
  listInstalled: () => invoke<Skill[]>('list_installed_skills'),
  browseRepo: (repo: string, branch?: string, path?: string) =>
    invoke<RepoSkillEntry[]>('browse_repo_skills', { repo, branch, path }),
  install: (repo: string, branch: string, path: string, name: string) =>
    invoke<Skill>('install_skill', { repo, branch, path, name }),
  uninstall: (id: string) => invoke<boolean>('uninstall_skill', { id }),
  toggle: (id: string, enabled: boolean) =>
    invoke<boolean>('toggle_skill', { id, enabled }),
  getContent: (id: string) => invoke<string>('get_skill_content', { id }),
  syncBuiltins: () => invoke<Skill[]>('sync_builtin_skills'),
  getSources: () => invoke<SkillSource[]>('get_skill_sources'),
  addSource: (repo: string, branch?: string, path?: string) =>
    invoke<SkillSource>('add_skill_source', { repo, branch, path }),
  removeSource: (repo: string) => invoke<boolean>('remove_skill_source', { repo }),
  registerFromDisk: (name: string) => invoke<Skill>('register_skill_from_disk', { name }),
};
```

### Settings UI：SkillsSettings 组件

在 `SettingsDialog` 中新增 **"Skills"** tab，参照 `McpSettings.tsx` 的布局风格。

**上方 — Skills 市场**

```
┌─────────────────────────────────────────────────────┐
│ 🔍 搜索 skills...                                    │
├─────────────────────────────────────────────────────┤
│ 源仓库: [anthropics/skills ▾]  [+ 添加源]            │
├─────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────┐ │
│ │ brainstorming                          [安装]   │ │
│ │ 帮助将想法转化为完整设计和规范...                   │ │
│ ├─────────────────────────────────────────────────┤ │
│ │ writing-skills                    [已安装 ✓]    │ │
│ │ 使用 TDD 方法创建和验证 skills...                  │ │
│ ├─────────────────────────────────────────────────┤ │
│ │ systematic-debugging                [安装]       │ │
│ │ 系统性调试方法论...                               │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**下方 — 已安装 Skills**

```
┌─────────────────────────────────────────────────────┐
│ 已安装 Skills (3)                                    │
├─────────────────────────────────────────────────────┤
│ find-skills           搜索和推荐 skills    [内置] [●] │
│ skill-creator         创建新 skill         [内置] [●] │
│ brainstorming         设计协作             [🗑]  [●]  │
└─────────────────────────────────────────────────────┘
```

- 点击卡片可预览 SKILL.md 内容（弹窗或侧栏）
- 内置 skills 标记为"内置"，不可卸载
- 开关控制启用/禁用
- 搜索框按名称/描述过滤市场结果

### Slash 命令集成

修改 `slashCommands.ts`：

1. 新增 `'skill'` 命令分类
2. 应用启动时从 `skillStore` 加载已启用的 skills
3. 每个 skill 注册为一个 slash command：

```typescript
// 动态注册
function registerSkillCommands(skills: Skill[]) {
  for (const skill of skills.filter(s => s.enabled)) {
    commands.push({
      name: skill.name,
      description: skill.description || skill.display_name || skill.name,
      category: 'skill',
      handler: 'prompt',
      prompt: `Use the ${skill.name} skill.`,  // SDK 的 Skill 工具会自动处理
    });
  }
}
```

**`/` 菜单中的显示：**

```
/find-skills          搜索和推荐适用的 skills            [skill] [内置]
/skill-creator       创建新的 skill                    [skill] [内置]
/brainstorming       帮助将想法转化为完整设计和规范       [skill]
```

### 类型定义 (`types/skill.ts`)

```typescript
export interface Skill {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  source_repo: string | null;
  source_path: string | null;
  version: string | null;
  installed_at: string;
  enabled: boolean;
  is_builtin: boolean;
}

export interface RepoSkillEntry {
  name: string;
  description: string | null;
  path: string;       // 仓库中的路径
  installed: boolean; // 是否已安装
}

export interface SkillSource {
  repo: string;
  branch: string;
  skills_path: string;
}
```

## 内置 Skills

内置 skills 优先从已配置的源仓库（默认 `anthropics/skills`）下载。代码中内嵌 fallback 内容，确保离线时也能正常工作。

### find-skills

**来源：** `anthropics/skills` 仓库（如存在）
**Fallback 位置：** 代码内嵌于 `src-tauri/src/skills/builtin.rs`

**Frontmatter:**
```yaml
---
name: find-skills
description: Use when the user needs to find a skill for a specific task, or asks about available skills
---
```

**核心逻辑：**
1. 询问用户想要什么能力（如果 prompt 中没有说明）
2. 调用 `list_installed_skills` 检查本地已安装的 skills
3. 调用 `browse_repo_skills` 搜索市场上的 skills
4. 推荐最匹配的 skill，说明其用途和用法
5. 如果没有合适的，建议使用 `/skill-creator` 创建新的

### skill-creator

**来源：** `anthropics/skills` 仓库（如存在）
**Fallback 位置：** 代码内嵌于 `src-tauri/src/skills/builtin.rs`

**Frontmatter:**
```yaml
---
name: skill-creator
description: Use when the user wants to create a new custom skill
---
```

**核心逻辑：**
1. 询问 skill 的用途和名称
2. 询问 skill 类型：technique（具体方法）、pattern（思维模式）、reference（参考文档）
3. 引导编写 SKILL.md 的 frontmatter（name, description）和 body
4. 生成文件到 `~/.claude/skills/{name}/SKILL.md`
5. 调用 `register_skill_from_disk` Tauri 命令将元数据同步到数据库
6. 提示用户 skill 已可用，可通过 `/{name}` 调用

## 文件变更清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `src-tauri/src/skills/mod.rs` | Skills 模块入口 |
| `src-tauri/src/skills/types.rs` | Skill, SkillSource 结构体 |
| `src-tauri/src/skills/db.rs` | SQLite CRUD 操作 |
| `src-tauri/src/skills/github.rs` | GitHub API 集成 |
| `src-tauri/src/skills/commands.rs` | Tauri 命令 |
| `src-tauri/src/skills/builtin.rs` | 内置 skills 的 fallback 内容 |
| `src/stores/skillStore.ts` | Zustand store |
| `src/types/skill.ts` | TypeScript 类型定义 |
| `src/components/settings/SkillsSettings.tsx` | Skills 设置 UI |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src-tauri/src/db/schema.rs` | 新增 `skills` 表 |
| `src-tauri/src/lib.rs` | 注册新的 Tauri 命令 |
| `src-tauri/sidecar/src/types.ts` | start 命令新增 `skills` 字段 |
| `src-tauri/sidecar/src/index.ts` | 传递 `skills` 选项，`allowedTools` 加入 `'Skill'` |
| `src-tauri/src/agent/commands.rs` | 查询并传递 enabled skills 给 sidecar |
| `src-tauri/src/config/types.rs` | 新增 `SkillSource` 配置 |
| `src/components/settings/SettingsDialog.tsx` | 新增 Skills tab |
| `src/lib/slashCommands.ts` | 支持动态注册 skill 命令 |
| `src/App.tsx` | 启动时 sync builtins + 加载 skills |
| `src/lib/tauri.ts` | 新增 `skillApi` |

## 错误处理

- **网络错误**：浏览/安装时 GitHub API 不可用，显示友好提示，支持重试
- **文件系统错误**：写入 `~/.claude/skills/` 失败时提示权限问题
- **SKILL.md 解析错误**：frontmatter 格式不正确时，使用目录名作为 name，空 description
- **重复安装**：检测同名 skill 已存在时，自动覆盖更新（保留 enabled 状态和 id）
- **GitHub API 速率限制**：提示用户配置 GitHub token

## 未来扩展（不在 V1 范围内）

- Skills 版本管理和更新检测
- 项目级 skills（`.claude/skills/`）
- Skills 评分和社区推荐
- 自定义 skill 编辑器 UI
- 从本地 zip/tar 导入 skills
