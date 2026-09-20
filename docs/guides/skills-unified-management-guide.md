# Skills 统一管理实现指导说明

> 基于 CC Switch 项目分析，面向需要实现多智能体（Claude Code、Codex、Gemini CLI、OpenCode、Hermes 等）Skills 统一管理的场景。文档梳理该项目中 Skills 模块的整体架构、数据模型、同步机制、导入流程与前端交互，并抽取为可在你自己的应用中复用的设计要点。

***

## 目录

- [一、整体架构](#一整体架构)
- [二、数据模型设计](#二数据模型设计)
- [三、应用类型抽象与多智能体适配](#三应用类型抽象与多智能体适配)
- [四、SSOT 目录与文件同步策略](#四ssot-目录与文件同步策略)
- [五、Skill 元数据与发现机制](#五skill-元数据与发现机制)
- [六、核心服务流程](#六核心服务流程)
- [七、导入机制（从已有目录迁移）](#七导入机制从已有目录迁移)
- [八、更新检测与备份恢复](#八更新检测与备份恢复)
- [九、Deep Link 仓库导入](#九deep-link-仓库导入)
- [十、前端架构与状态管理](#十前端架构与状态管理)
- [十一、关键代码参考清单](#十一关键代码参考清单)
- [十二、接入建议与避坑要点](#十二接入建议与避坑要点)

***

## 一、整体架构

### 1.1 核心设计理念

**SSOT（Single Source of Truth）+ 多智能体投影：**

- 文件层 SSOT：所有 skill 文件统一存放在 `~/.cc-switch/skills/`（或社区标准目录 `~/.agents/skills/`）。
- 数据库层 SSOT：SQLite 中 `skills` 表保存每个 skill 的元数据 + 五个 boolean 启用标志位（每个智能体一份）。
- 各智能体目录是投影：通过 symlink 或文件复制把启用的 skill 同步到对应智能体的 `skills/` 目录，智能体自身只读取自己目录下的文件。

```
                    ┌─────────────────────────────────┐
                    │   SQLite 数据库（skills 表）       │
                    │   id + 元数据 + content_hash      │
                    │   + enabled_claude                │
                    │   + enabled_codex                 │
                    │   + enabled_gemini                │
                    │   + enabled_opencode              │
                    │   + enabled_hermes                │
                    └────────────────┬─────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │ SkillService（同步调度层）        │
                    └────────────────┬─────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
   │ SSOT 目录         │   │ Claude 目录       │   │ Codex / Gemini…  │
   │ ~/.cc-switch/    │──▶│ ~/.claude/skills/ │   │ ~/.codex/skills/ │
   │   skills/        │   │ (symlink 或 copy) │   │ (symlink/copy)   │
   └──────────────────┘   └──────────────────┘   └──────────────────┘
```

### 1.2 支持的智能体清单

| 智能体            | Skills 目录（默认）                             | 是否参与 Skills 同步                           |
| -------------- | ----------------------------------------- | ---------------------------------------- |
| Claude Code    | `~/.claude/skills/`                       | ✅                                        |
| Codex CLI      | `~/.codex/skills/`                        | ✅                                        |
| Gemini CLI     | `~/.gemini/skills/`                       | ✅                                        |
| OpenCode       | `~/.config/opencode/skills/`              | ✅                                        |
| Hermes         | `~/.hermes/skills/`（由 `hermes_config` 解析） | ✅                                        |
| Claude Desktop | —                                         | ⏭️ 跳过（3P profiles 不走 CC Switch skill 同步） |
| OpenClaw       | —                                         | ⏭️ 跳过（不支持 Skills）                        |

> 所有目录都允许通过 `settings.json` 的 `*_override_dir` 字段覆盖，便于用户自定义安装位置。

***

## 二、数据模型设计

### 2.1 数据库表结构

```sql
-- 已安装 skill 的统一记录
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,                  -- 形如 "owner/repo:directory" 或 "local:directory"
    name TEXT NOT NULL,
    description TEXT,
    directory TEXT NOT NULL,              -- SSOT 下的子目录名
    repo_owner TEXT,
    repo_name TEXT,
    repo_branch TEXT DEFAULT 'main',
    readme_url TEXT,
    enabled_claude BOOLEAN NOT NULL DEFAULT 0,
    enabled_codex BOOLEAN NOT NULL DEFAULT 0,
    enabled_gemini BOOLEAN NOT NULL DEFAULT 0,
    enabled_opencode BOOLEAN NOT NULL DEFAULT 0,
    enabled_hermes BOOLEAN NOT NULL DEFAULT 0,
    installed_at INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT,                    -- SHA-256，用于更新检测
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- 仓库源（发现新 skill 的来源）
CREATE TABLE IF NOT EXISTS skill_repos (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',
    enabled BOOLEAN NOT NULL DEFAULT 1,
    PRIMARY KEY (owner, name)
);

-- 通用设置（SSOT 位置、同步方式、迁移标志等）
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
```

### 2.2 核心字段说明

- **`id`**：唯一标识。仓库 skill 用 `owner/repo:directory`，本地 skill 用 `local:directory`。同一仓库的同名 skill 重复安装会复用记录。
- **`directory`**：仅一段（如 `pdf-tool`），不允许 `/` 或 `..`，避免路径穿越。多级路径在安装时取最后一段。
- **五个** **`enabled_*`** **字段**：每个智能体一个独立标志位，组合表达"这个 skill 启用给哪些 agent"。新增 agent 时增加一列即可，向后兼容。
- **`content_hash`**：整个 skill 目录的 SHA-256（按文件相对路径字典序拼接内容计算），用于增量更新检测。

### 2.3 Rust 端结构（参考 `app_config.rs`）

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SkillApps {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub opencode: bool,
    pub hermes: bool,
}

impl SkillApps {
    pub fn is_enabled_for(&self, app: &AppType) -> bool { /* ... */ }
    pub fn set_enabled_for(&mut self, app: &AppType, enabled: bool) { /* ... */ }
    pub fn enabled_apps(&self) -> Vec<AppType> { /* ... */ }
    pub fn only(app: &AppType) -> Self { /* ... */ }
    pub fn from_labels(labels: &[String]) -> Self { /* ... */ }
}
```

### 2.4 TypeScript 端结构（参考 `src/lib/api/skills.ts`）

```typescript
export interface SkillApps {
  claude: boolean;
  "claude-desktop"?: boolean;
  codex: boolean;
  gemini: boolean;
  opencode: boolean;
  openclaw: boolean;
  hermes: boolean;
}

export interface InstalledSkill {
  id: string;
  name: string;
  description?: string;
  directory: string;
  repoOwner?: string;
  repoName?: string;
  repoBranch?: string;
  readmeUrl?: string;
  apps: SkillApps;
  installedAt: number;
  contentHash?: string;
  updatedAt: number;
}
```

***

## 三、应用类型抽象与多智能体适配

### 3.1 AppType 枚举

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppType {
    Claude,
    #[serde(rename = "claude-desktop", alias = "claude_desktop", alias = "claudeDesktop")]
    ClaudeDesktop,
    Codex,
    Gemini,
    OpenCode,
    OpenClaw,
    Hermes,
}
```

### 3.2 关键方法

- `AppType::as_str()` — 字符串标识，用于数据库标签和日志
- `AppType::all()` — 迭代所有支持的 app
- `AppType::from_str(s)` — 解析字符串（容错多种命名风格）
- `AppType::is_additive_mode()` — 区分"切换模式"（Claude/Codex/Gemini）与"叠加模式"（OpenCode/OpenClaw/Hermes），决定 provider 写入策略

### 3.3 各智能体目录解析

参考 `SkillService::get_app_skills_dir(app)`：

1. 优先读取 `settings.json` 中的 `*_override_dir`（用户自定义路径）。
2. 否则回退到平台默认路径（如 `~/.claude/skills/`）。
3. Windows 上 home 目录通过 `dirs::home_dir()` 获取。

### 3.4 前端 AppId 配置

```typescript
// src/config/appConfig.tsx
export const SKILLS_APP_IDS: AppId[] = [
  "claude", "codex", "gemini", "opencode", "hermes",
];
```

UI 中所有 Skills 面板都基于这个列表渲染开关，新增 agent 只需在两端各加一项即可。

***

## 四、SSOT 目录与文件同步策略

### 4.1 SSOT 目录选择

```rust
pub enum SkillStorageLocation {
    CcSwitch,   // ~/.cc-switch/skills/（默认）
    Unified,    // ~/.agents/skills/（社区共享目录）
}
```

存储在 `settings` 表中。`migrate_storage` 在两个位置之间移动文件，流程：

1. 解析旧目录和新目录（**不改设置**）
2. 逐个 skill 目录 `rename`（同文件系统原子操作），失败回退到 `copy + delete`
3. 文件移动完成后才持久化设置（中途崩溃时设置仍指向旧目录，数据不丢）
4. 刷新所有应用目录的 symlink（指向新 SSOT）

### 4.2 同步方式

```rust
pub enum SyncMethod {
    Auto,       // 优先 symlink，失败回退 copy（默认）
    Symlink,    // 仅 symlink
    Copy,       // 仅 copy
}
```

`sync_to_app_dir(directory, app)` 的核心逻辑：

```rust
match sync_method {
    SyncMethod::Auto => {
        // 如果目标已存在且不是 symlink，说明用户手动放了文件 → 改用 copy 覆盖
        if dest.exists() && !is_symlink(&dest) {
            replace_dest_with_copy(&source, &dest, directory)?;
            return Ok(());
        }
        // 已是 symlink → 删除后重建
        if is_symlink(&dest) { remove_path(&dest)?; }
        // 优先尝试 symlink
        match create_symlink(&source, &dest) {
            Ok(()) => return Ok(()),
            Err(err) => log::warn!("symlink 失败，回退到 copy: {err:#}"),
        }
        // 回退 copy
        replace_dest_with_copy(&source, &dest, directory)?;
    }
    SyncMethod::Symlink => { /* 强制 symlink */ }
    SyncMethod::Copy => { /* 强制 copy */ }
}
```

### 4.3 跨平台 symlink

- **Unix**：`std::os::unix::fs::symlink`
- **Windows**：`std::os::windows::fs::symlink_dir`（注意：Windows 上删除目录 symlink 必须用 `fs::remove_dir`，不能用 `remove_file`）

### 4.4 安全替换目标目录

`replace_dest_with_copy` 使用临时目录 + rename 的原子替换：

1. 校验源目录存在且包含 `SKILL.md`（拒绝空源覆盖现有目标）
2. 复制到 `.{name}.tmp-{pid}-{nonce}` 临时目录
3. 删除旧 dest（symlink 或真实目录）
4. `fs::rename` 临时目录到 dest

### 4.5 路径穿越防护

```rust
fn sanitize_skill_source_path(raw: &str) -> Option<PathBuf> {
    // 仅接受 Normal 分量，拒绝 .、..、绝对路径、Windows 前缀
}

fn sanitize_install_name(raw: &str) -> Option<String> {
    // 仅接受单段 Normal 名称，不允许开头是 .
}
```

***

## 五、Skill 元数据与发现机制

### 5.1 SKILL.md 元数据格式

每个 skill 目录下必须有一个 `SKILL.md`，使用 YAML front matter：

```markdown
---
name: PDF Tool
description: A skill for working with PDF files
---

# Skill 内容（prompt、工具说明等）
...
```

解析逻辑（`parse_skill_metadata_static`）：

1. 去除 BOM
2. 用 `---` 分割三段，取中间段做 YAML 解析
3. 解析失败时返回空元数据（不阻塞流程，用目录名兜底）

### 5.2 发现流程

`SkillService::discover_available(repos)`：

1. 从数据库读取启用的仓库列表
2. 对每个仓库并发调用 `fetch_repo_skills`：
   - `download_repo`：尝试 `branch → main → master` 顺序下载 ZIP
   - 解压到临时目录
   - `scan_dir_recursive`：递归查找 `SKILL.md`，构建 `DiscoverableSkill`
3. 基于 `owner/repo:directory` 去重
4. 按名称排序返回

### 5.3 GitHub ZIP 中的 symlink 处理

GitHub 归档保留了 symlink 元数据。解压时分两遍：

1. 普通文件和目录直接写盘
2. symlink 条目收集后，在 `resolve_symlinks_in_dir` 中把目标内容**复制**到 symlink 位置（而非创建真实 symlink），保证跨平台兼容且 skill 内容自包含。同时做路径穿越检查（`resolved.starts_with(canonical_base)`）。

### 5.4 公共注册表（skills.sh）

可选集成第三方公共目录搜索：

```
GET https://skills.sh/api/search?q={query}&limit={limit}&offset={offset}
```

返回结果转换为 `DiscoverableSkill` 复用现有安装流程。过滤非 GitHub 来源（owner 或 repo 包含 `.`）。

***

## 六、核心服务流程

### 6.1 安装（`SkillService::install`）

```
1. 校验 skill.directory（sanitize_skill_source_path / sanitize_install_name）
2. 检查数据库是否已有同名 directory：
   ├─ 同仓库：返回现有记录，更新 current_app 启用状态
   └─ 不同仓库：报错 SKILL_DIRECTORY_CONFLICT
3. 如果 SSOT 中不存在该目录：
   a. download_repo → 临时目录
   b. resolve_skill_source_dir：直接路径 / 名称回退查找 / 仓库根回退
   c. canonicalize 校验源在临时目录内
   d. copy_dir_recursive 到 SSOT
4. 计算 content_hash（SHA-256）
5. 构建 InstalledSkill 记录，apps = SkillApps::only(current_app)
6. db.save_skill() 写库
7. sync_to_app_dir → 同步到当前 app 目录
```

### 6.2 卸载（`SkillService::uninstall`）

```
1. 读取 skill 信息
2. create_uninstall_backup：
   - 找到源目录（SSOT 优先，否则各 app 目录）
   - 复制到 ~/.cc-switch/skill-backups/{timestamp}_{slug}/skill/
   - 写 meta.json（含 skill 全量信息 + backup_created_at + source_path）
   - 保留最多 20 个备份，超出按修改时间清理
3. 从所有 app 目录删除（remove_from_app）
4. 从 SSOT 删除目录
5. db.delete_skill(id)
```

### 6.3 切换应用启用状态（`SkillService::toggle_app`）

```
1. 读取 skill，更新 apps.set_enabled_for(app, enabled)
2. 启用：sync_to_app_dir(directory, app)  // 创建 symlink/copy
3. 禁用：remove_from_app(directory, app)  // 仅删 symlink 或目录
4. db.update_skill_apps(id, &skill.apps)
```

UI 上每个 skill 行有 5 个开关，点击即触发此流程。

### 6.4 批量同步到某 app（`SkillService::sync_to_app`）

用于 provider 切换、存储位置迁移等场景需要重建某 app 目录的情况：

```
1. 读取所有已安装 skill
2. 遍历 app 目录：
   - 已在数据库但未启用此 app → 删除
   - 不在数据库但是指向 SSOT 的 symlink → 删除（清理孤儿）
3. 对所有启用此 app 的 skill 调用 sync_to_app_dir
```

***

## 七、导入机制（从已有目录迁移）

### 7.1 扫描未管理 skill（`scan_unmanaged`）

扫描三类目录：

1. 各 app 的 skills 目录（`~/.claude/skills/` 等）
2. `~/.agents/skills/`（社区共享目录）
3. SSOT 目录自身（`~/.cc-switch/skills/`）

收集所有包含 `SKILL.md` 的子目录，排除已在数据库中的。返回 `UnmanagedSkill` 列表，包含 `found_in`（在哪些目录中找到，用于 UI 预选启用状态）。

### 7.2 导入流程（`import_from_apps`）

```rust
pub fn import_from_apps(db, imports: Vec<ImportSkillSelection>) -> Result<Vec<InstalledSkill>> {
    // 1. 解析 ~/.agents/.skill-lock.json，提取 skill -> 仓库信息映射
    let agents_lock = parse_agents_lock();

    // 2. 把 lock 中发现的仓库保存到 skill_repos 表（去重）
    save_repos_from_lock(db, &agents_lock, imports.iter().map(|s| s.directory.as_str()));

    // 3. 对每个用户选择的 skill：
    for selection in imports {
        // a. 在所有候选目录中查找源路径
        // b. 复制到 SSOT（如果不存在）
        // c. 解析 SKILL.md 元数据
        // d. 启用状态仅信任用户显式选择（不自动推断）
        // e. 从 lock 文件提取 repo 信息（无则标记为 local:directory）
        // f. 计算 content_hash
        // g. 构建 InstalledSkill 写库
    }
}
```

### 7.3 agents lock 文件解析

`~/.agents/.skill-lock.json` 是社区约定的 skill 锁文件，结构：

```json
{
  "skills": {
    "skill-name": {
      "source": "owner/repo",
      "sourceType": "github",
      "sourceUrl": "https://github.com/owner/repo/tree/branch/path",
      "skillPath": "path/to/SKILL.md",
      "branch": "main"
    }
  }
}
```

解析时支持多种分支来源：`branch` 字段 → `sourceBranch` 字段 → 从 `sourceUrl` 解析（`/tree/<branch>/`、`#branch`、`?branch=` 三种格式）。

### 7.4 首次启动迁移（`migrate_skills_to_ssot`）

启动时检查 `settings.skills_ssot_migration_pending` 标志，若为 true 且数据库为空：

1. 扫描各 app 目录的 skill
2. 复制到 SSOT
3. 根据 `found_in` 自动推断各 app 的启用状态
4. 从 lock 文件提取仓库信息
5. 写库并清除 pending 标志

迁移失败保留 pending 标志，下次启动重试。

***

## 八、更新检测与备份恢复

### 8.1 内容哈希计算

```rust
pub fn compute_dir_hash(dir: &Path) -> Result<String> {
    // 1. 递归收集所有非隐藏文件（跳过 . 开头）
    // 2. 按相对路径字典序排序
    // 3. 对每个文件：hasher.update(rel_path); hasher.update(\0);
    //                hasher.update(content); hasher.update(\0);
    // 4. 返回 SHA-256 十六进制
}
```

注意：相对路径中的 `\` 替换为 `/`，保证跨平台一致。

### 8.2 更新检测（`check_updates`）

```
1. 取所有有 repo_owner 的 skill（本地 skill 跳过）
2. 按 (owner, name, branch) 分组
3. 每组下载一次仓库 ZIP（避免重复下载）
4. 对组内每个 skill：
   a. 在远程仓库中找到匹配的 skill 目录（按 install_name 匹配）
   b. 计算远程哈希
   c. 本地哈希优先用数据库缓存，否则实时计算并回写
   d. 哈希不同 → 加入更新列表
```

### 8.3 更新执行（`update_skill`）

```
1. 读取 skill，解析 repo 信息
2. 下载仓库 ZIP
3. 找到远程 skill 源目录
4. create_uninstall_backup（备份旧版本）
5. 删除旧 SSOT 目录，复制新内容
6. 计算新哈希、解析新元数据（name/description 可能变化）
7. 更新 readme_url（用实际下载成功的分支）
8. db.save_skill 更新记录
9. 对所有已启用的 app 调用 sync_to_app_dir
```

### 8.4 备份恢复（`restore_from_backup`）

```
1. 读取 meta.json，恢复 skill 元数据
2. 检查数据库中是否已有同 id 或同 directory → 拒绝
3. 复制 backup/skill/ 到 SSOT
4. 重新计算 content_hash
5. apps 重置为 only(current_app)（恢复时由用户重新选择启用范围）
6. 写库 + sync_to_app_dir
```

***

## 九、Deep Link 仓库导入

通过 `ccswitch://` 协议快速添加仓库源，参考 [src-tauri/src/deeplink/skill.rs](file:///d:/project/cc-switch/src-tauri/src/deeplink/skill.rs)：

```
ccswitch://import?type=skill&repo=owner/name&branch=main&enabled=true
```

处理流程：

1. 校验 `resource == "skill"`
2. 解析 `repo` 字段（格式必须是 `owner/name`）
3. 构建 `SkillRepo`（branch 默认 main，enabled 默认 true）
4. 调用 `db.save_skill_repo` 写库
5. 不下载 skill，仅添加仓库源，后续由用户在发现面板中安装具体 skill

***

## 十、前端架构与状态管理

### 10.1 React Query 缓存设计

参考 [src/hooks/useSkills.ts](file:///d:/project/cc-switch/src/hooks/useSkills.ts)：

| Query Key                                      | 用途           | staleTime                 |
| ---------------------------------------------- | ------------ | ------------------------- |
| `["skills", "installed"]`                      | 已安装列表        | `Infinity`（仅手动刷新）         |
| `["skills", "discoverable"]`                   | 可发现列表        | `Infinity`                |
| `["skills", "repos"]`                          | 仓库列表         | 默认                        |
| `["skills", "unmanaged"]`                      | 未管理 skill    | 默认 `enabled: false`       |
| `["skills", "updates"]`                        | 更新检测结果       | 5 分钟                      |
| `["skills", "skillssh", query, limit, offset]` | skills.sh 搜索 | 5 分钟 + `keepPreviousData` |
| `["skills", "backups"]`                        | 备份列表         | 默认 `enabled: false`       |

`staleTime: Infinity` + `placeholderData: keepPreviousData` 的组合实现"首次用缓存、刷新才重取"的体验。

### 10.2 Mutation 缓存策略

- **安装/卸载/更新/导入 ZIP**：成功后直接 `setQueryData` 局部更新 `installed` 缓存，**不触发刷新**，避免列表跳动。
- **导入未管理 skill**：`setQueryData` 合并 + `invalidateQueries(['unmanaged'])` 刷新扫描结果。
- **切换 app 启用**：`invalidateQueries(['installed'])` 触发重取（因为涉及多个聚合字段）。
- **添加/删除仓库**：`invalidateQueries(['repos', 'discoverable'])`。

合并去重参考 `mergeImportedSkills`：按 id 去重，新记录优先，空数组返回原引用避免无谓通知。

### 10.3 主要 UI 组件

参考 [src/components/skills/](file:///d:/project/cc-switch/src/components/skills)：

- **`UnifiedSkillsPanel`**：已安装 skill 列表，每行 5 个 app 开关 + 更新/卸载按钮，顶部 `AppCountBar` 显示各 app 启用数。
- **`SkillsPage`**：发现面板，支持两种来源切换：
  - **仓库模式**：从配置的 GitHub 仓库浏览，支持搜索 + 仓库筛选 + 状态筛选
  - **skills.sh 模式**：关键词搜索 + 分页加载更多
- **`SkillCard`**：单卡片，展示 name/description/source/installed 状态 + 安装按钮。
- **`RepoManagerPanel`**：仓库增删管理。
- **`ImportSkillsDialog`**：未管理 skill 导入对话框，复选框 + 每行 5 个 app 开关（默认根据 `foundIn` 预选）。
- **`RestoreSkillsDialog`**：备份恢复对话框，列表展示 + 恢复/删除操作。

### 10.4 设置项组件

- **`SkillSyncMethodSettings`**：symlink / copy 切换。
- **`SkillStorageLocationSettings`**：SSOT 存储位置切换。

### 10.5 AppToggleGroup 与 SKILLS\_APP\_IDS

`AppToggleGroup` 是通用组件，传入 `appIds` 数组即可渲染一组开关。Skills 模块传入 `SKILLS_APP_IDS`（排除 OpenClaw），MCP 模块也复用同一组件。

***

## 十一、关键代码参考清单

### 后端（Rust / Tauri）

| 文件                                                                                                        | 职责                                      |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| [src-tauri/src/services/skill.rs](file:///d:/project/cc-switch/src-tauri/src/services/skill.rs)           | SkillService 主体：发现、安装、卸载、同步、更新、导入、迁移    |
| [src-tauri/src/commands/skill.rs](file:///d:/project/cc-switch/src-tauri/src/commands/skill.rs)           | Tauri 命令层，桥接前端调用                        |
| [src-tauri/src/database/dao/skills.rs](file:///d:/project/cc-switch/src-tauri/src/database/dao/skills.rs) | 数据库 CRUD                                |
| [src-tauri/src/database/schema.rs](file:///d:/project/cc-switch/src-tauri/src/database/schema.rs)         | 表结构与迁移                                  |
| [src-tauri/src/app\_config.rs](file:///d:/project/cc-switch/src-tauri/src/app_config.rs)                  | AppType / SkillApps / InstalledSkill 定义 |
| [src-tauri/src/deeplink/skill.rs](file:///d:/project/cc-switch/src-tauri/src/deeplink/skill.rs)           | Deep Link 仓库导入                          |
| [src-tauri/src/settings.rs](file:///d:/project/cc-switch/src-tauri/src/settings.rs)                       | 同步方式、存储位置等设置读写                          |
| [src-tauri/src/lib.rs](file:///d:/project/cc-switch/src-tauri/src/lib.rs)                                 | 启动时初始化默认仓库 + 自动迁移                       |

### 前端（React / TypeScript）

| 文件                                                                                                                                      | 职责                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| [src/lib/api/skills.ts](file:///d:/project/cc-switch/src/lib/api/skills.ts)                                                             | Tauri invoke 封装 + 类型定义    |
| [src/hooks/useSkills.ts](file:///d:/project/cc-switch/src/hooks/useSkills.ts)                                                           | React Query hooks         |
| [src/hooks/useSkills.helpers.ts](file:///d:/project/cc-switch/src/hooks/useSkills.helpers.ts)                                           | 缓存合并工具                    |
| [src/components/skills/UnifiedSkillsPanel.tsx](file:///d:/project/cc-switch/src/components/skills/UnifiedSkillsPanel.tsx)               | 已安装列表面板                   |
| [src/components/skills/SkillsPage.tsx](file:///d:/project/cc-switch/src/components/skills/SkillsPage.tsx)                               | 发现面板                      |
| [src/components/skills/SkillCard.tsx](file:///d:/project/cc-switch/src/components/skills/SkillCard.tsx)                                 | 技能卡片                      |
| [src/components/skills/RepoManagerPanel.tsx](file:///d:/project/cc-switch/src/components/skills/RepoManagerPanel.tsx)                   | 仓库管理面板                    |
| [src/components/settings/SkillSyncMethodSettings.tsx](file:///d:/project/cc-switch/src/components/settings/SkillSyncMethodSettings.tsx) | 同步方式设置                    |
| [src/config/appConfig.tsx](file:///d:/project/cc-switch/src/config/appConfig.tsx)                                                       | SKILLS\_APP\_IDS 等 app 配置 |

***

## 十二、接入建议与避坑要点

### 12.1 实现顺序建议

1. **先定数据模型**：`AppType` 枚举 + `SkillApps` 结构 + 数据库表，这是所有逻辑的根基。
2. **实现 SSOT 目录管理**：`get_ssot_dir` / `get_app_skills_dir` + 路径覆盖支持。
3. **实现文件同步**：`sync_to_app_dir` / `remove_from_app` / `sync_to_app`，重点处理 symlink 与 copy 的回退。
4. **实现安装/卸载/切换 app**：核心三件事，先跑通单 app 流程。
5. **实现发现与元数据解析**：`SKILL.md` 解析 + 仓库扫描。
6. **实现导入与迁移**：扫描未管理 skill + 首次启动迁移。
7. **实现更新检测与备份**：内容哈希 + 备份目录。
8. **前端 UI**：先列表 + 开关，再发现面板，最后备份恢复。

### 12.2 关键避坑点

- **路径穿越**：用户提供的 `directory` 必须经过 `sanitize_*` 校验，拒绝 `..`、绝对路径、Windows 前缀。
- **Windows symlink**：目录 symlink 用 `symlink_dir` 创建、`remove_dir` 删除；普通文件 symlink 用 `symlink` 创建、`remove_file` 删除。混用会报错。
- **GitHub ZIP 中的 symlink**：必须二次处理，把目标内容复制到 symlink 位置，否则跨平台解压会丢失内容。
- **多级目录名**：`directory` 字段最终落盘时只用最后一段，避免在 SSOT 中创建多级目录。
- **同名冲突**：同仓库同名 skill 视为重复安装（更新启用状态），不同仓库同名 skill 报错（避免歧义）。
- **存储位置迁移**：先移文件后改设置，保证崩溃时不丢数据；迁移完成后必须刷新所有 app 目录的 symlink。
- **更新检测的哈希缓存**：本地哈希优先用数据库缓存，缺失时实时计算并回写，避免每次都重新计算。
- **备份保留策略**：最多 20 个，超出按修改时间清理；备份目录名包含时间戳 + slug，避免冲突。
- **Deep Link 仅添加仓库源**：不要在 deep link 中直接安装 skill，应交给用户在 UI 中确认。
- **provider 切换时的 skill 同步**：切换 provider 后调用 `sync_to_app` 重建该 app 目录，避免 skill 状态不一致。

### 12.3 扩展性设计

- **新增智能体**：在 `AppType` 枚举加一项 → 数据库加一列 `enabled_xxx` → `SkillApps` 加一字段 → `SKILLS_APP_IDS` 加一项 → `get_app_skills_dir` 加路径解析。整体改动可控。
- **新增发现源**：发现层是独立的 `fetch_repo_skills` / `search_skills_sh`，新增源只需实现返回 `DiscoverableSkill` 列表的函数。
- **新增同步方式**：在 `SyncMethod` 枚举加一项，在 `sync_to_app_dir` 的 match 中加分支即可。
- **新增存储位置**：在 `SkillStorageLocation` 枚举加一项，在 `get_ssot_dir` 与 `migrate_storage` 中加路径解析。

### 12.4 与原项目的差异提示

- 本文档基于 CC Switch v3.16.x，其中 `SkillApps` 包含 `claude-desktop` / `openclaw` 字段是为了向后兼容，实际 Skills 模块**不**对这两个 app 同步文件（`is_enabled_for` 直接返回 false）。
- 在你自己的实现中，如果不需要兼容旧版，可以只保留实际支持的智能体字段。
- `AppType::is_additive_mode()` 与 Skills 模块无关，仅用于 provider 写入策略，可不在 Skills 实现中考虑。

