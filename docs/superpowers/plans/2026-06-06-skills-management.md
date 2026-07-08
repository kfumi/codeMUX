# Skills 管理与使用系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CodeMUX 添加完整的 skill 管理系统，支持从 GitHub 仓库浏览/安装/卸载 skills，内置 find-skills 和 skill-creator，集成到 slash 命令菜单。

**Architecture:** Rust 后端新增 `skills` 模块（types → db → github → commands），通过 GitHub API 浏览仓库中的 skills，安装到 `~/.claude/skills/` 并记录到 SQLite。前端新增 `skillStore` + `SkillsSettings` UI + slash 命令集成。Sidecar 新增 `skills` 选项传递给 Claude Agent SDK。

**Tech Stack:** Rust (reqwest, rusqlite, serde), TypeScript (React, Zustand), Claude Agent SDK

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src-tauri/src/skills/mod.rs` | Module entry, re-exports |
| `src-tauri/src/skills/types.rs` | Skill, SkillSource, RepoSkillEntry structs |
| `src-tauri/src/skills/db.rs` | SQLite CRUD for skills table |
| `src-tauri/src/skills/github.rs` | GitHub API: browse repos, download files |
| `src-tauri/src/skills/builtin.rs` | Fallback content for find-skills, skill-creator |
| `src-tauri/src/skills/commands.rs` | Tauri commands exposed to frontend |
| `src/types/skill.ts` | TypeScript interfaces |
| `src/stores/skillStore.ts` | Zustand store for skills state |
| `src/components/settings/SkillsSettings.tsx` | Skills settings UI (marketplace + installed) |

### Modified Files

| File | Change |
|------|--------|
| `src-tauri/src/db/schema.rs` | Add `skills` table creation |
| `src-tauri/src/lib.rs` | Register new module + Tauri commands |
| `src-tauri/src/agent/commands.rs` | Query enabled skills, pass to sidecar |
| `src-tauri/sidecar/src/types.ts` | Add `skills` field to start command |
| `src-tauri/sidecar/src/index.ts` | Add `'Skill'` to allowedTools, pass skills option |
| `src/lib/tauri.ts` | Add `skillApi` wrapper |
| `src/lib/slashCommands.ts` | Add `'skill'` category, dynamic registration |
| `src/components/settings/SettingsDialog.tsx` | Add Skills tab |

---

### Task 1: Rust Types + Database Schema

**Files:**
- Create: `src-tauri/src/skills/types.rs`
- Create: `src-tauri/src/skills/mod.rs`
- Create: `src-tauri/src/skills/db.rs`
- Modify: `src-tauri/src/db/schema.rs`
- Modify: `src-tauri/src/lib.rs` (module registration only — commands registered later)

- [ ] **Step 1: Create `src-tauri/src/skills/types.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub source_repo: Option<String>,
    pub source_path: Option<String>,
    pub version: Option<String>,
    pub installed_at: String,
    pub enabled: bool,
    pub is_builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoSkillEntry {
    pub name: String,
    pub description: Option<String>,
    pub path: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSource {
    pub repo: String,
    pub branch: String,
    pub skills_path: String,
}

impl Default for SkillSource {
    fn default() -> Self {
        Self {
            repo: "anthropics/skills".to_string(),
            branch: "main".to_string(),
            skills_path: "skills/".to_string(),
        }
    }
}
```

- [ ] **Step 2: Create `src-tauri/src/skills/mod.rs`**

```rust
pub mod types;
pub mod db;
pub mod github;
pub mod builtin;
pub mod commands;
```

- [ ] **Step 3: Add skills table to `src-tauri/src/db/schema.rs`**

Append inside the `execute_batch` call in `initialize_database`, after the `mcp_servers` table creation:

```sql
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT,
    description TEXT,
    source_repo TEXT,
    source_path TEXT,
    version TEXT,
    installed_at TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
```

- [ ] **Step 4: Create `src-tauri/src/skills/db.rs`**

```rust
use rusqlite::{Connection, Result, params};
use uuid::Uuid;
use chrono::Utc;

use super::types::Skill;

fn row_to_skill(row: &rusqlite::Row) -> rusqlite::Result<Skill> {
    let enabled: i32 = row.get(8)?;
    let is_builtin: i32 = row.get(9)?;
    Ok(Skill {
        id: row.get(0)?,
        name: row.get(1)?,
        display_name: row.get(2)?,
        description: row.get(3)?,
        source_repo: row.get(4)?,
        source_path: row.get(5)?,
        version: row.get(6)?,
        installed_at: row.get(7)?,
        enabled: enabled != 0,
        is_builtin: is_builtin != 0,
    })
}

pub fn list_skills(conn: &Connection) -> Result<Vec<Skill>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, display_name, description, source_repo, source_path, version, installed_at, enabled, is_builtin
         FROM skills ORDER BY is_builtin DESC, name ASC"
    )?;
    let skills = stmt.query_map([], |row| row_to_skill(row))?
        .collect::<Result<Vec<_>>>()?;
    Ok(skills)
}

pub fn get_skill(conn: &Connection, id: &str) -> Result<Option<Skill>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, display_name, description, source_repo, source_path, version, installed_at, enabled, is_builtin
         FROM skills WHERE id = ?1"
    )?;
    let mut rows = stmt.query_map(params![id], |row| row_to_skill(row))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn get_skill_by_name(conn: &Connection, name: &str) -> Result<Option<Skill>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, display_name, description, source_repo, source_path, version, installed_at, enabled, is_builtin
         FROM skills WHERE name = ?1"
    )?;
    let mut rows = stmt.query_map(params![name], |row| row_to_skill(row))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn upsert_skill(conn: &Connection, skill: &Skill) -> Result<()> {
    conn.execute(
        "INSERT INTO skills (id, name, display_name, description, source_repo, source_path, version, installed_at, enabled, is_builtin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(name) DO UPDATE SET
             display_name = excluded.display_name,
             description = excluded.description,
             source_repo = excluded.source_repo,
             source_path = excluded.source_path,
             version = excluded.version,
             installed_at = excluded.installed_at,
             enabled = CASE WHEN excluded.is_builtin = 1 THEN skills.enabled ELSE excluded.enabled END,
             is_builtin = excluded.is_builtin",
        params![
            skill.id, skill.name, skill.display_name, skill.description,
            skill.source_repo, skill.source_path, skill.version,
            skill.installed_at, skill.enabled as i32, skill.is_builtin as i32,
        ],
    )?;
    Ok(())
}

pub fn update_skill_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<()> {
    conn.execute(
        "UPDATE skills SET enabled = ?1 WHERE id = ?2",
        params![enabled as i32, id],
    )?;
    Ok(())
}

pub fn delete_skill(conn: &Connection, id: &str) -> Result<bool> {
    // Don't delete builtins
    let rows = conn.execute(
        "DELETE FROM skills WHERE id = ?1 AND is_builtin = 0",
        params![id],
    )?;
    Ok(rows > 0)
}

pub fn get_enabled_skill_names(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM skills WHERE enabled = 1 ORDER BY name")?;
    let names = stmt.query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>>>()?;
    Ok(names)
}

/// Register a skill that already exists on disk but is not in the database.
/// Parses SKILL.md frontmatter for metadata.
pub fn register_skill_from_disk(conn: &Connection, skills_dir: &std::path::Path, name: &str) -> Result<Skill> {
    let skill_dir = skills_dir.join(name);
    let skill_md = skill_dir.join("SKILL.md");

    let (description, display_name) = if skill_md.exists() {
        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
        parse_frontmatter(&content)
    } else {
        (None, None)
    };

    let now = Utc::now().to_rfc3339();
    let skill = Skill {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        display_name,
        description,
        source_repo: None,
        source_path: None,
        version: None,
        installed_at: now,
        enabled: true,
        is_builtin: false,
    };
    upsert_skill(conn, &skill)?;
    Ok(skill)
}

/// Parse YAML frontmatter from SKILL.md content.
/// Returns (description, display_name).
pub fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let content = content.trim();
    if !content.starts_with("---") {
        return (None, None);
    }
    let after_first = &content[3..];
    let end = match after_first.find("---") {
        Some(pos) => pos,
        None => return (None, None),
    };
    let frontmatter = &after_first[..end];
    let mut description = None;
    let mut display_name = None;
    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("description:") {
            let val = val.trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                description = Some(val.to_string());
            }
        }
        if let Some(val) = line.strip_prefix("name:") {
            let val = val.trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                display_name = Some(val.to_string());
            }
        }
    }
    (description, display_name)
}
```

- [ ] **Step 5: Add `mod skills;` to `src-tauri/src/lib.rs`**

Add after `mod mcp;`:

```rust
mod skills;
```

- [ ] **Step 6: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors (skills module has no external deps beyond what's already in Cargo.toml)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/skills/types.rs src-tauri/src/skills/mod.rs src-tauri/src/skills/db.rs src-tauri/src/db/schema.rs src-tauri/src/lib.rs
git commit -m "feat(skills): add types, database schema, and CRUD operations"
```

---

### Task 2: GitHub API Integration + Builtin Fallbacks

**Files:**
- Create: `src-tauri/src/skills/github.rs`
- Create: `src-tauri/src/skills/builtin.rs`

- [ ] **Step 1: Create `src-tauri/src/skills/github.rs`**

```rust
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT, ACCEPT};
use serde::Deserialize;
use base64::Engine as _;

use super::types::{RepoSkillEntry, SkillSource};

#[derive(Debug, Deserialize)]
struct GitHubContent {
    name: String,
    #[serde(rename = "type")]
    content_type: String,
    path: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    download_url: Option<String>,
}

/// Build headers for GitHub API requests, including optional auth token.
fn build_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("codemux/0.1"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github.v3+json"));
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if !token.is_empty() {
            headers.insert(
                "Authorization",
                HeaderValue::from_str(&format!("Bearer {}", token)).unwrap_or_default(),
            );
        }
    }
    headers
}

/// Browse a GitHub repo for skills.
/// Returns a list of RepoSkillEntry for each subdirectory that contains a SKILL.md.
pub async fn browse_repo_skills(
    source: &SkillSource,
    installed_names: &[String],
) -> Result<Vec<RepoSkillEntry>, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.github.com/repos/{}/contents/{}",
        source.repo, source.skills_path
    );

    let resp = client.get(&url)
        .headers(build_headers())
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API error {}: {}", status, body));
    }

    let contents: Vec<GitHubContent> = resp.json().await
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

    let mut entries = Vec::new();
    for item in contents.iter().filter(|c| c.content_type == "dir") {
        // Try to fetch SKILL.md from this subdirectory
        let skill_md_url = format!(
            "https://api.github.com/repos/{}/contents/{}/SKILL.md",
            source.repo, item.path
        );
        let description = match client.get(&skill_md_url).headers(build_headers()).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(content) = resp.json::<GitHubContent>().await {
                    content.content.and_then(|c| {
                        let decoded = base64::engine::general_purpose::STANDARD
                            .decode(c.replace('\n', "").replace(' ', ""))
                            .ok()?;
                        let text = String::from_utf8(decoded).ok()?;
                        super::db::parse_frontmatter(&text).0
                    })
                } else {
                    None
                }
            }
            _ => None,
        };

        entries.push(RepoSkillEntry {
            name: item.name.clone(),
            description,
            path: item.path.clone(),
            installed: installed_names.contains(&item.name),
        });
    }

    Ok(entries)
}

/// Download all files in a skill directory from a GitHub repo.
/// Returns a map of filename -> content.
pub async fn download_skill_files(
    repo: &str,
    skill_path: &str,
) -> Result<Vec<(String, String)>, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.github.com/repos/{}/contents/{}",
        repo, skill_path
    );

    let resp = client.get(&url)
        .headers(build_headers())
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API error {}: {}", status, body));
    }

    let contents: Vec<GitHubContent> = resp.json().await
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

    let mut files = Vec::new();
    for item in contents.iter().filter(|c| c.content_type == "file") {
        if let Some(ref content_b64) = item.content {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(content_b64.replace('\n', "").replace(' ', ""))
                .map_err(|e| format!("Base64 decode failed for {}: {}", item.name, e))?;
            let text = String::from_utf8(decoded)
                .map_err(|e| format!("UTF-8 decode failed for {}: {}", item.name, e))?;
            files.push((item.name.clone(), text));
        }
    }

    Ok(files)
}
```

- [ ] **Step 2: Add `base64` dependency to `src-tauri/Cargo.toml`**

Add to `[dependencies]`:

```toml
base64 = "0.22"
```

- [ ] **Step 3: Create `src-tauri/src/skills/builtin.rs`**

```rust
/// Fallback SKILL.md content for find-skills when network is unavailable.
pub const FIND_SKILLS_CONTENT: &str = r#"---
name: find-skills
description: Use when the user needs to find a skill for a specific task, or asks about available skills
---

# Find Skills

Help the user discover and use skills that match their needs.

## Process

1. **Understand the need:** Ask the user what capability they're looking for (if not already clear from context).

2. **Check installed skills:** List all installed skills and identify which ones match the user's need.

3. **Search the marketplace:** If no installed skill matches, browse available skills from configured repositories.

4. **Recommend:** Present the best matching skill(s) with:
   - Name and description
   - How to invoke it (e.g., `/skill-name`)
   - What it does

5. **If nothing fits:** Suggest using `/skill-creator` to create a custom skill for their specific need.

## Guidelines

- Always check installed skills first before searching the marketplace
- Recommend the most specific skill for the task, not the most general one
- If multiple skills could work, present the top 2-3 options with brief comparisons
"#;

/// Fallback SKILL.md content for skill-creator when network is unavailable.
pub const SKILL_CREATOR_CONTENT: &str = r#"---
name: skill-creator
description: Use when the user wants to create a new custom skill
---

# Skill Creator

Guide the user through creating a new custom skill.

## Process

1. **Understand the purpose:** Ask what the skill should do and when it should be used.

2. **Choose a name:** Suggest a kebab-case name (e.g., `code-review`, `api-design`). The name becomes the slash command.

3. **Choose a type:**
   - **Technique:** A concrete method with steps to follow
   - **Pattern:** A way of thinking about problems
   - **Reference:** API docs, syntax guides, tool documentation

4. **Write the SKILL.md:**
   - Frontmatter: `name` and `description` (the description determines when Claude auto-invokes the skill)
   - Body: Clear, actionable instructions. Use sections, numbered steps, and examples.

5. **Save and register:**
   - Write the file to `~/.claude/skills/{name}/SKILL.md`
   - The skill is immediately available via `/{name}`

## SKILL.md Template

```markdown
---
name: {name}
description: {one-line description of when to use this skill}
---

# {Title}

## Overview
What this skill does and why.

## Process
Step-by-step instructions.

## Guidelines
Constraints and best practices.
```

## Important

- The `description` field is critical — it determines when Claude automatically invokes the skill
- Keep descriptions specific and action-oriented
- The body should be detailed enough that Claude can follow it without additional context
"#;
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles (may need `cargo build` to pull base64 dep)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/skills/github.rs src-tauri/src/skills/builtin.rs src-tauri/Cargo.toml
git commit -m "feat(skills): add GitHub API integration and builtin fallback content"
```

---

### Task 3: Tauri Commands

**Files:**
- Create: `src-tauri/src/skills/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register commands)

- [ ] **Step 1: Create `src-tauri/src/skills/commands.rs`**

```rust
use tauri::State;
use crate::AppState;
use super::types::{Skill, RepoSkillEntry, SkillSource};
use super::db;
use super::github;
use super::builtin;

fn skills_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::PathBuf::from(home).join(".claude").join("skills")
}

fn default_source() -> SkillSource {
    let config = crate::config::types::AppConfig::default();
    // Use default SkillSource
    SkillSource::default()
}

#[tauri::command]
pub fn list_installed_skills(state: State<'_, AppState>) -> Result<Vec<Skill>, String> {
    let db = state.db.lock().unwrap();
    db::list_skills(&db).map_err(|e| format!("Failed to list skills: {}", e))
}

#[tauri::command]
pub async fn browse_repo_skills(
    state: State<'_, AppState>,
    repo: String,
    branch: Option<String>,
    path: Option<String>,
) -> Result<Vec<RepoSkillEntry>, String> {
    let source = SkillSource {
        repo,
        branch: branch.unwrap_or_else(|| "main".to_string()),
        skills_path: path.unwrap_or_else(|| "skills/".to_string()),
    };

    // Get installed skill names for comparison
    let installed_names = {
        let db = state.db.lock().unwrap();
        db::list_skills(&db)
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.name)
            .collect::<Vec<_>>()
    };

    github::browse_repo_skills(&source, &installed_names).await
}

#[tauri::command]
pub async fn install_skill(
    state: State<'_, AppState>,
    repo: String,
    branch: String,
    path: String,
    name: String,
) -> Result<Skill, String> {
    // Download all files from the skill directory
    let files = github::download_skill_files(&repo, &path).await?;

    // Write files to ~/.claude/skills/{name}/
    let skill_dir = skills_dir().join(&name);
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create skill directory: {}", e))?;

    for (filename, content) in &files {
        let file_path = skill_dir.join(filename);
        std::fs::write(&file_path, content)
            .map_err(|e| format!("Failed to write {}: {}", filename, e))?;
    }

    // Parse SKILL.md frontmatter
    let skill_md_content = files.iter()
        .find(|(name, _)| name == "SKILL.md")
        .map(|(_, content)| content.as_str())
        .unwrap_or("");
    let (description, display_name) = db::parse_frontmatter(skill_md_content);

    // Upsert into database
    let now = chrono::Utc::now().to_rfc3339();

    // Check if skill already exists (preserve id and enabled state)
    let db = state.db.lock().unwrap();
    let existing = db::get_skill_by_name(&db, &name).unwrap_or(None);
    let skill = Skill {
        id: existing.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: name.clone(),
        display_name,
        description,
        source_repo: Some(repo),
        source_path: Some(path),
        version: None,
        installed_at: now,
        enabled: existing.as_ref().map(|s| s.enabled).unwrap_or(true),
        is_builtin: false,
    };
    db::upsert_skill(&db, &skill).map_err(|e| format!("Failed to save skill: {}", e))?;

    Ok(skill)
}

#[tauri::command]
pub fn uninstall_skill(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let db = state.db.lock().unwrap();

    // Get skill info before deleting
    let skill = db::get_skill(&db, &id)
        .map_err(|e| format!("Failed to get skill: {}", e))?
        .ok_or("Skill not found")?;

    if skill.is_builtin {
        return Err("Cannot uninstall builtin skills".to_string());
    }

    // Delete from database
    let deleted = db::delete_skill(&db, &id)
        .map_err(|e| format!("Failed to delete skill: {}", e))?;

    // Delete files from disk
    if deleted {
        let skill_dir = skills_dir().join(&skill.name);
        if skill_dir.exists() {
            let _ = std::fs::remove_dir_all(&skill_dir);
        }
    }

    Ok(deleted)
}

#[tauri::command]
pub fn toggle_skill(state: State<'_, AppState>, id: String, enabled: bool) -> Result<bool, String> {
    let db = state.db.lock().unwrap();
    db::update_skill_enabled(&db, &id, enabled)
        .map_err(|e| format!("Failed to toggle skill: {}", e))?;
    Ok(enabled)
}

#[tauri::command]
pub fn get_skill_content(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    let skill = db::get_skill(&db, &id)
        .map_err(|e| format!("Failed to get skill: {}", e))?
        .ok_or("Skill not found")?;

    let skill_md = skills_dir().join(&skill.name).join("SKILL.md");
    if skill_md.exists() {
        std::fs::read_to_string(&skill_md)
            .map_err(|e| format!("Failed to read SKILL.md: {}", e))
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub fn sync_builtin_skills(state: State<'_, AppState>) -> Result<Vec<Skill>, String> {
    let db = state.db.lock().unwrap();
    let dir = skills_dir();

    let builtins = [
        ("find-skills", builtin::FIND_SKILLS_CONTENT),
        ("skill-creator", builtin::SKILL_CREATOR_CONTENT),
    ];

    let mut result = Vec::new();
    for (name, fallback_content) in &builtins {
        let skill_dir = dir.join(name);
        let skill_md = skill_dir.join("SKILL.md");

        // Write fallback content if file doesn't exist
        if !skill_md.exists() {
            let _ = std::fs::create_dir_all(&skill_dir);
            let _ = std::fs::write(&skill_md, fallback_content);
        }

        // Upsert into database with is_builtin = 1
        let now = chrono::Utc::now().to_rfc3339();
        let (description, display_name) = if skill_md.exists() {
            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
            db::parse_frontmatter(&content)
        } else {
            (None, None)
        };

        let existing = db::get_skill_by_name(&db, name).unwrap_or(None);
        let skill = Skill {
            id: existing.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: name.to_string(),
            display_name,
            description,
            source_repo: Some("anthropics/skills".to_string()),
            source_path: Some(format!("skills/{}", name)),
            version: None,
            installed_at: existing.as_ref().map(|s| s.installed_at.clone()).unwrap_or_else(|| now.clone()),
            enabled: existing.as_ref().map(|s| s.enabled).unwrap_or(true),
            is_builtin: true,
        };
        let _ = db::upsert_skill(&db, &skill);
        result.push(skill);
    }

    Ok(result)
}

#[tauri::command]
pub fn register_skill_from_disk(state: State<'_, AppState>, name: String) -> Result<Skill, String> {
    let db = state.db.lock().unwrap();
    let dir = skills_dir();
    db::register_skill_from_disk(&db, &dir, &name)
        .map_err(|e| format!("Failed to register skill from disk: {}", e))
}

#[tauri::command]
pub fn get_skill_sources() -> Result<Vec<SkillSource>, String> {
    // For now, return default. Can be extended to read from AppConfig later.
    Ok(vec![SkillSource::default()])
}

#[tauri::command]
pub fn get_enabled_skill_names(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().unwrap();
    db::get_enabled_skill_names(&db).map_err(|e| format!("Failed to get enabled skills: {}", e))
}
```

- [ ] **Step 2: Register commands in `src-tauri/src/lib.rs`**

Add to the `invoke_handler` macro in `lib.rs`, after the MCP commands:

```rust
skills::commands::list_installed_skills,
skills::commands::browse_repo_skills,
skills::commands::install_skill,
skills::commands::uninstall_skill,
skills::commands::toggle_skill,
skills::commands::get_skill_content,
skills::commands::sync_builtin_skills,
skills::commands::register_skill_from_disk,
skills::commands::get_skill_sources,
skills::commands::get_enabled_skill_names,
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/skills/commands.rs src-tauri/src/lib.rs
git commit -m "feat(skills): add Tauri commands for skill management"
```

---

### Task 4: Sidecar Integration

**Files:**
- Modify: `src-tauri/sidecar/src/types.ts`
- Modify: `src-tauri/sidecar/src/index.ts`
- Modify: `src-tauri/src/agent/commands.rs`

- [ ] **Step 1: Update `src-tauri/sidecar/src/types.ts`**

Replace the `SidecarCommand` type with:

```typescript
export type SidecarCommand =
  | { type: 'start'; prompt: string; cwd: string; sessionId?: string; apiKey?: string; baseUrl?: string; model?: string; mcpServers?: Record<string, unknown>; mcpServerInstructions?: Record<string, string>; skills?: string[] }
  | { type: 'reset_session'; sessionId: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' }
  | { type: 'tool_response'; toolUseId: string; response: unknown };
```

- [ ] **Step 2: Update `src-tauri/sidecar/src/index.ts` — add `'Skill'` to allowedTools**

Find the `allowedTools` array in `handleStart` and add `'Skill'`:

```typescript
allowedTools: [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'AskUserQuestion', 'TodoWrite',
  'WaitForMcpServers', 'Skill',
  ...Object.keys(cmd.mcpServers || {}).map(name => `mcp__${name}__*`),
],
```

- [ ] **Step 3: Update `src-tauri/sidecar/src/index.ts` — pass skills option**

After the `options` object is built (after the `if (claudePath)` line, before the `if (claudeSessionId)` block), add:

```typescript
// Pass enabled skills filter to SDK
if (cmd.skills && cmd.skills.length > 0) {
  options.skills = cmd.skills;
}
```

- [ ] **Step 4: Update `src-tauri/src/agent/commands.rs` — query and pass skills**

In `start_agent_session`, after the MCP servers block (after the `cmd["mcpServerInstructions"]` assignment), add:

```rust
// 读取启用的 skills
let enabled_skills = {
    let db = state.db.lock().unwrap();
    crate::skills::db::get_enabled_skill_names(&db).unwrap_or_default()
};

if !enabled_skills.is_empty() {
    cmd["skills"] = serde_json::json!(enabled_skills);
}
```

- [ ] **Step 5: Rebuild sidecar**

Run: `cd src-tauri/sidecar && npm run build`

- [ ] **Step 6: Verify Rust compilation**

Run: `cd src-tauri && cargo check`

- [ ] **Step 7: Commit**

```bash
git add src-tauri/sidecar/src/types.ts src-tauri/sidecar/src/index.ts src-tauri/src/agent/commands.rs
git commit -m "feat(skills): integrate skills with sidecar — pass skills option and add Skill to allowedTools"
```

---

### Task 5: Frontend Types + API + Store

**Files:**
- Create: `src/types/skill.ts`
- Modify: `src/lib/tauri.ts`
- Create: `src/stores/skillStore.ts`

- [ ] **Step 1: Create `src/types/skill.ts`**

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
  path: string;
  installed: boolean;
}

export interface SkillSource {
  repo: string;
  branch: string;
  skills_path: string;
}
```

- [ ] **Step 2: Add `skillApi` to `src/lib/tauri.ts`**

Add import at top:

```typescript
import type { Skill, RepoSkillEntry, SkillSource } from '../types/skill';
```

Add at the end of the file, after `mcpApi`:

```typescript
export const skillApi = {
  listInstalled: (): Promise<Skill[]> => invoke('list_installed_skills'),
  browseRepo: (repo: string, branch?: string, path?: string): Promise<RepoSkillEntry[]> =>
    invoke('browse_repo_skills', { repo, branch, path }),
  install: (repo: string, branch: string, path: string, name: string): Promise<Skill> =>
    invoke('install_skill', { repo, branch, path, name }),
  uninstall: (id: string): Promise<boolean> => invoke('uninstall_skill', { id }),
  toggle: (id: string, enabled: boolean): Promise<boolean> =>
    invoke('toggle_skill', { id, enabled }),
  getContent: (id: string): Promise<string> => invoke('get_skill_content', { id }),
  syncBuiltins: (): Promise<Skill[]> => invoke('sync_builtin_skills'),
  getSources: (): Promise<SkillSource[]> => invoke('get_skill_sources'),
  registerFromDisk: (name: string): Promise<Skill> =>
    invoke('register_skill_from_disk', { name }),
  getEnabledNames: (): Promise<string[]> => invoke('get_enabled_skill_names'),
};
```

- [ ] **Step 3: Create `src/stores/skillStore.ts`**

```typescript
import { create } from 'zustand';
import type { Skill, RepoSkillEntry, SkillSource } from '../types/skill';
import { skillApi } from '../lib/tauri';

interface SkillStore {
  installedSkills: Skill[];
  browseResults: RepoSkillEntry[];
  skillSources: SkillSource[];
  isLoading: boolean;
  browseLoading: boolean;
  error: string | null;

  fetchInstalled: () => Promise<void>;
  browseRepo: (repo: string, branch?: string, path?: string) => Promise<void>;
  installSkill: (repo: string, branch: string, path: string, name: string) => Promise<void>;
  uninstallSkill: (id: string) => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
  getSkillContent: (id: string) => Promise<string>;
  syncBuiltins: () => Promise<void>;
  fetchSources: () => Promise<void>;
  registerFromDisk: (name: string) => Promise<void>;
}

export const useSkillStore = create<SkillStore>((set, get) => ({
  installedSkills: [],
  browseResults: [],
  skillSources: [],
  isLoading: false,
  browseLoading: false,
  error: null,

  fetchInstalled: async () => {
    set({ isLoading: true, error: null });
    try {
      const skills = await skillApi.listInstalled();
      set({ installedSkills: skills, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  browseRepo: async (repo: string, branch?: string, path?: string) => {
    set({ browseLoading: true, error: null });
    try {
      const results = await skillApi.browseRepo(repo, branch, path);
      set({ browseResults: results, browseLoading: false });
    } catch (error) {
      set({ error: String(error), browseLoading: false });
    }
  },

  installSkill: async (repo: string, branch: string, path: string, name: string) => {
    try {
      const skill = await skillApi.install(repo, branch, path, name);
      set((state) => {
        const exists = state.installedSkills.some((s) => s.id === skill.id);
        const installedSkills = exists
          ? state.installedSkills.map((s) => (s.id === skill.id ? skill : s))
          : [...state.installedSkills, skill];
        // Mark as installed in browse results
        const browseResults = state.browseResults.map((r) =>
          r.name === name ? { ...r, installed: true } : r
        );
        return { installedSkills, browseResults };
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  uninstallSkill: async (id: string) => {
    try {
      await skillApi.uninstall(id);
      set((state) => {
        const skill = state.installedSkills.find((s) => s.id === id);
        const installedSkills = state.installedSkills.filter((s) => s.id !== id);
        // Mark as not installed in browse results
        const browseResults = skill
          ? state.browseResults.map((r) =>
              r.name === skill.name ? { ...r, installed: false } : r
            )
          : state.browseResults;
        return { installedSkills, browseResults };
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  toggleSkill: async (id: string, enabled: boolean) => {
    try {
      await skillApi.toggle(id, enabled);
      set((state) => ({
        installedSkills: state.installedSkills.map((s) =>
          s.id === id ? { ...s, enabled } : s
        ),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  getSkillContent: async (id: string) => {
    return skillApi.getContent(id);
  },

  syncBuiltins: async () => {
    try {
      await skillApi.syncBuiltins();
      // Refresh installed list
      await get().fetchInstalled();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  fetchSources: async () => {
    try {
      const sources = await skillApi.getSources();
      set({ skillSources: sources });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  registerFromDisk: async (name: string) => {
    try {
      const skill = await skillApi.registerFromDisk(name);
      set((state) => {
        const exists = state.installedSkills.some((s) => s.id === skill.id);
        const installedSkills = exists
          ? state.installedSkills.map((s) => (s.id === skill.id ? skill : s))
          : [...state.installedSkills, skill];
        return { installedSkills };
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
}));
```

- [ ] **Step 4: Verify frontend compilation**

Run: `cd D:/project/ai-code/codeMUX && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/types/skill.ts src/lib/tauri.ts src/stores/skillStore.ts
git commit -m "feat(skills): add frontend types, API wrapper, and Zustand store"
```

---

### Task 6: Skills Settings UI

**Files:**
- Create: `src/components/settings/SkillsSettings.tsx`
- Modify: `src/components/settings/SettingsDialog.tsx`

- [ ] **Step 1: Create `src/components/settings/SkillsSettings.tsx`**

```tsx
import { useState, useEffect } from 'react';
import { useSkillStore } from '../../stores/skillStore';
import type { Skill, RepoSkillEntry } from '../../types/skill';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import {
  Plus, Trash2, Loader2, Package, Search, Download,
  CheckCircle, ExternalLink, Eye, Puzzle,
} from 'lucide-react';
import { toast } from 'sonner';
import MarkdownRenderer from '../agent/MarkdownRenderer';

export function SkillsSettingsPanel() {
  const {
    installedSkills, browseResults, skillSources,
    isLoading, browseLoading, error,
    fetchInstalled, browseRepo, installSkill, uninstallSkill,
    toggleSkill, getSkillContent, syncBuiltins, fetchSources,
  } = useSkillStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    syncBuiltins().then(() => {
      fetchInstalled();
      fetchSources().then(() => {
        // Auto-browse default source
        const defaultSource = skillSources[0];
        if (defaultSource) {
          browseRepo(defaultSource.repo, defaultSource.branch, defaultSource.skills_path);
        }
      });
    });
  }, []);

  // Browse when sources are loaded
  useEffect(() => {
    if (skillSources.length > 0 && browseResults.length === 0 && !browseLoading) {
      const s = skillSources[0];
      browseRepo(s.repo, s.branch, s.skills_path);
    }
  }, [skillSources]);

  const handleInstall = async (entry: RepoSkillEntry) => {
    const source = skillSources[0];
    if (!source) return;
    setInstalling(entry.name);
    try {
      await installSkill(source.repo, source.branch, entry.path, entry.name);
      toast.success(`已安装 ${entry.name}`);
    } catch {
      toast.error(`安装 ${entry.name} 失败`);
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async () => {
    if (!deletingId) return;
    try {
      await uninstallSkill(deletingId);
      toast.success('已卸载');
    } catch {
      toast.error('卸载失败');
    }
    setDeleteConfirm(false);
    setDeletingId(null);
  };

  const handlePreview = async (skill: Skill) => {
    const content = await getSkillContent(skill.id);
    setPreviewContent(content);
    setPreviewTitle(skill.display_name || skill.name);
  };

  const filteredBrowse = browseResults.filter((r) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return r.name.toLowerCase().includes(q) || (r.description?.toLowerCase().includes(q) ?? false);
  });

  return (
    <div className="space-y-6 pr-12">
      {/* ── Marketplace ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium flex items-center gap-2">
            <Package className="h-4 w-4" />
            Skills 市场
          </h3>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {skillSources.length > 0 && (
              <span className="flex items-center gap-1">
                <ExternalLink className="h-3 w-3" />
                {skillSources[0].repo}
              </span>
            )}
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索 skills..."
            className="pl-9"
          />
        </div>

        {browseLoading && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            加载中...
          </div>
        )}

        {!browseLoading && filteredBrowse.length === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Package className="h-6 w-6 mb-2 opacity-50" />
            <p className="text-sm">暂无可用 skills</p>
          </div>
        )}

        <div className="space-y-2 max-h-[240px] overflow-y-auto">
          {filteredBrowse.map((entry) => (
            <div
              key={entry.name}
              className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm">{entry.name}</span>
                {entry.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {entry.description}
                  </p>
                )}
              </div>
              {entry.installed ? (
                <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                  <CheckCircle className="h-3 w-3" />
                  已安装
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleInstall(entry)}
                  disabled={installing === entry.name}
                >
                  {installing === entry.name ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3 mr-1" />
                  )}
                  安装
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Installed Skills ── */}
      <div className="space-y-3">
        <h3 className="font-medium flex items-center gap-2">
          <Puzzle className="h-4 w-4" />
          已安装 Skills ({installedSkills.length})
        </h3>

        {isLoading && installedSkills.length === 0 && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            加载中...
          </div>
        )}

        {!isLoading && installedSkills.length === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Puzzle className="h-6 w-6 mb-2 opacity-50" />
            <p className="text-sm">暂无已安装的 skills</p>
          </div>
        )}

        <div className="space-y-2">
          {installedSkills.map((skill) => (
            <div
              key={skill.id}
              className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">
                    {skill.display_name || skill.name}
                  </span>
                  {skill.is_builtin && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                      内置
                    </span>
                  )}
                </div>
                {skill.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {skill.description}
                  </p>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => handlePreview(skill)}>
                <Eye className="h-4 w-4" />
              </Button>
              <Switch
                checked={skill.enabled}
                onCheckedChange={(enabled) => toggleSkill(skill.id, enabled)}
              />
              {!skill.is_builtin && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setDeletingId(skill.id); setDeleteConfirm(true); }}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Delete confirmation */}
      <Dialog open={deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(false)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>卸载 Skill</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定要卸载 "{installedSkills.find((s) => s.id === deletingId)?.name}" 吗？文件将从磁盘删除。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(false)}>取消</Button>
            <Button variant="destructive" onClick={handleUninstall}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Content preview */}
      <Dialog open={!!previewContent} onOpenChange={(open) => !open && setPreviewContent(null)}>
        <DialogContent className="sm:max-w-[600px] max-h-[70vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{previewTitle}</DialogTitle>
          </DialogHeader>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownRenderer content={previewContent || ''} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: Update `src/components/settings/SettingsDialog.tsx`**

Add import:

```typescript
import { SkillsSettingsPanel } from './SkillsSettings';
import { Puzzle } from 'lucide-react';
```

Update `SettingsTab` type:

```typescript
type SettingsTab = 'general' | 'appearance' | 'provider' | 'mcp' | 'skills';
```

Add to `tabs` array (after MCP):

```typescript
{ id: 'skills' as SettingsTab, label: 'Skills', icon: Puzzle },
```

Add to the render section (after the MCP panel):

```tsx
{activeTab === 'skills' && <SkillsSettingsPanel />}
```

- [ ] **Step 3: Verify frontend compilation**

Run: `cd D:/project/ai-code/codeMUX && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/SkillsSettings.tsx src/components/settings/SettingsDialog.tsx
git commit -m "feat(skills): add Skills settings UI with marketplace and installed list"
```

---

### Task 7: Slash Command Integration + App Startup

**Files:**
- Modify: `src/lib/slashCommands.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Update `src/lib/slashCommands.ts`**

Update the `CommandCategory` type:

```typescript
export type CommandCategory = 'session' | 'info' | 'builtin' | 'custom' | 'skill';
```

Add a mutable skill commands array and registration function after the `commands` array:

```typescript
// ─── Skill 命令 (动态注册) ─────────────────────────────

interface SkillInfo {
  name: string;
  description: string;
  is_builtin: boolean;
}

const skillCommands: SlashCommand[] = [];

/** 注册 skill 命令（应用启动时和 skill 变更时调用） */
export function registerSkillCommands(skills: SkillInfo[]): void {
  // Remove existing skill commands
  skillCommands.length = 0;

  for (const skill of skills) {
    skillCommands.push({
      name: skill.name,
      description: skill.description || skill.name,
      alias: [],
      category: 'skill',
      handler: 'prompt',
      // The prompt tells the SDK to invoke the skill by name.
      // The Skill tool handles loading the SKILL.md content.
      prompt: `Use the ${skill.name} skill.`,
    });
  }
}
```

Update `getAllCommands` to include skill commands:

```typescript
export function getAllCommands(): SlashCommand[] {
  return [...commands, ...skillCommands];
}
```

Update `filterCommands` to include skill commands:

```typescript
export function filterCommands(prefix: string): SlashCommand[] {
  const all = [...commands, ...skillCommands];
  if (!prefix) return all;
  const lower = prefix.toLowerCase();
  return all.filter(
    (c) =>
      c.name.startsWith(lower) ||
      c.description.includes(lower) ||
      c.alias?.some((a) => a.startsWith(lower))
  );
}
```

Update `findCommand` to search skill commands too:

```typescript
export function findCommand(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase();
  const all = [...commands, ...skillCommands];
  return all.find(
    (c) => c.name === lower || c.alias?.some((a) => a === lower)
  );
}
```

- [ ] **Step 2: Update `src/App.tsx` — sync builtins + register skill commands on startup**

Add imports at top:

```typescript
import { useSkillStore } from './stores/skillStore';
import { registerSkillCommands } from './lib/slashCommands';
```

Inside the `App` component, add an effect that runs on mount (after existing effects):

```typescript
// Sync builtin skills and register skill commands
useEffect(() => {
  const skillStore = useSkillStore.getState();
  skillStore.syncBuiltins().then(() => {
    skillStore.fetchInstalled().then(() => {
      const skills = useSkillStore.getState().installedSkills;
      registerSkillCommands(
        skills.filter(s => s.enabled).map(s => ({
          name: s.name,
          description: s.description || s.display_name || s.name,
          is_builtin: s.is_builtin,
        }))
      );
    });
  });
}, []);
```

- [ ] **Step 3: Verify frontend compilation**

Run: `cd D:/project/ai-code/codeMUX && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/lib/slashCommands.ts src/App.tsx
git commit -m "feat(skills): integrate skills into slash commands and app startup"
```

---

### Task 8: End-to-End Verification

- [ ] **Step 1: Build Rust backend**

Run: `cd src-tauri && cargo build`
Expected: Successful build

- [ ] **Step 2: Build sidecar**

Run: `cd src-tauri/sidecar && npm run build`
Expected: Successful build

- [ ] **Step 3: Build frontend**

Run: `cd D:/project/ai-code/codeMUX && npm run build`
Expected: Successful build

- [ ] **Step 4: Run the app and verify**

1. Open Settings → Skills tab
2. Verify builtin skills (find-skills, skill-creator) appear in "已安装" list
3. Verify marketplace shows skills from anthropics/skills (if network available)
4. Install a skill from the marketplace
5. Verify it appears in the installed list with correct description
6. Toggle a skill off, verify it disappears from `/` commands
7. Toggle back on, verify it reappears
8. Uninstall the skill, verify it's removed
9. Type `/` in the chat input, verify skill commands appear with `[skill]` badge

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(skills): complete skills management system — marketplace, builtin skills, slash command integration"
```
