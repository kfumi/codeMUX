use super::adapters;
use super::db;
use super::ssot;
use super::types::{Skill, SkillApps};
use crate::config::types::AgentKind;
use crate::AppState;
use std::str::FromStr;

fn skills_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::PathBuf::from(home)
        .join(".claude")
        .join("skills")
}

fn agents_skills_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::PathBuf::from(home)
        .join(".agents")
        .join("skills")
}

/// Scan a single skills directory and register all skills with SKILL.md found there.
/// Returns (directory, ssot_path) for each newly-discovered skill — the ssot_path is what the
/// caller needs to project the skill into agent dirs.
fn scan_skills_directory(
    db_guard: &rusqlite::Connection,
    dir: &std::path::Path,
) -> Vec<(String, std::path::PathBuf)> {
    let mut discovered = Vec::new();
    if !dir.exists() || !dir.is_dir() {
        return discovered;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return discovered,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Skip symlinks to avoid re-discovering our own projections
        if std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        #[cfg(windows)]
        if junction::exists(&path).unwrap_or(false) {
            continue;
        }

        // Register newly-discovered skills (names not yet in DB) with all agents enabled.
        // Existing skills keep their user-configured preferences (helper dedups by name).
        match super::service::register_discovered_skill(
            db_guard,
            &name,
            &path,
            SkillApps {
                claude: true,
                codex: true,
                gemini: true,
                opencode: true,
                pi: true,
            },
        ) {
            Ok(Some((directory, ssot_path))) => discovered.push((directory, ssot_path)),
            Ok(None) => {} // already in DB, skip
            Err(e) => log::warn!(target: "skills_scan", "Failed to register '{}': {}", name, e),
        }
    }
    discovered
}

/// Search all known skill directories for a SKILL.md matching the given name.
fn find_skill_path(name: &str) -> Option<std::path::PathBuf> {
    let candidates = [skills_dir(), agents_skills_dir()];
    for base in &candidates {
        let path = base.join(name).join("SKILL.md");
        if path.exists() {
            return Some(base.join(name));
        }
    }
    None
}

/// Scan installed Claude Code plugins for skills.
/// Reads ~/.claude/plugins/installed_plugins.json, finds all SKILL.md files
/// in each plugin's installPath, and registers them with prefixed names
/// like "superpowers:brainstorming".
fn scan_plugin_skills(db_guard: &rusqlite::Connection) -> Vec<Skill> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let manifest_path = std::path::PathBuf::from(&home)
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");

    let manifest_content = match std::fs::read_to_string(&manifest_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let manifest: serde_json::Value = match serde_json::from_str(&manifest_content) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let plugins = match manifest.get("plugins").and_then(|p| p.as_object()) {
        Some(p) => p,
        None => return Vec::new(),
    };

    let mut result = Vec::new();

    for (plugin_key, installs) in plugins {
        // Extract short name: "superpowers@claude-plugins-official" → "superpowers"
        let short_name = plugin_key.split('@').next().unwrap_or(plugin_key);

        let install_arr = match installs.as_array() {
            Some(a) => a,
            None => continue,
        };

        // Use the latest install (first entry)
        let install_path_str = match install_arr
            .first()
            .and_then(|i| i.get("installPath"))
            .and_then(|p| p.as_str())
        {
            Some(p) => p,
            None => continue,
        };
        let install_path = std::path::PathBuf::from(install_path_str);
        if !install_path.exists() {
            continue;
        }

        // Scan for SKILL.md files: check skills/ subdirectory first, then root
        let skills_dir_path = install_path.join("skills");
        let scan_dirs: Vec<std::path::PathBuf> = if skills_dir_path.exists() {
            // Each subdirectory in skills/ is a skill
            std::fs::read_dir(&skills_dir_path)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.path())
                .collect()
        } else {
            // The plugin root itself might be a skill
            vec![install_path.clone()]
        };

        for skill_dir in scan_dirs {
            let skill_md = skill_dir.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }

            let skill_name = match skill_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };

            // Prefixed name for SDK: "superpowers:brainstorming"
            let prefixed_name = format!("{}:{}", short_name, skill_name);

            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
            let (description, display_name) = db::parse_frontmatter(&content);

            let existing = db::get_skill_by_name(db_guard, &prefixed_name).unwrap_or(None);
            if let Some(existing_skill) = existing {
                result.push(existing_skill);
                continue;
            }

            let now = chrono::Utc::now().to_rfc3339();
            let skill = Skill {
                id: uuid::Uuid::new_v4().to_string(),
                name: prefixed_name.clone(),
                display_name,
                description,
                installed_at: now,
                apps: SkillApps {
                    claude: true,
                    ..Default::default()
                },
                disk_path: Some(skill_dir.to_string_lossy().to_string()),
                directory: skill_name.clone(),
            };
            let _ = db::upsert_skill(db_guard, &skill);
            result.push(skill);
        }
    }

    result
}

pub fn list_installed_skills_impl(state: &AppState) -> Result<Vec<Skill>, String> {
    let db = state.db.lock().unwrap();
    db::list_skills(&db).map_err(|e| format!("Failed to list skills: {}", e))
}

pub fn uninstall_skill_impl(state: &AppState, id: String) -> Result<bool, String> {
    let db_guard = state.db.lock().unwrap();
    let skill = db::get_skill(&db_guard, &id)
        .map_err(|e| format!("Failed to get skill: {}", e))?
        .ok_or("Skill not found")?;

    let deleted =
        db::delete_skill(&db_guard, &id).map_err(|e| format!("Failed to delete skill: {}", e))?;

    if deleted {
        let directory = if skill.directory.is_empty() {
            skill.name.clone()
        } else {
            skill.directory.clone()
        };

        // 1. Remove projections from all agent directories via adapters
        for app in adapters::all_apps() {
            if let Some(adapter) = adapters::get_adapter(app) {
                if adapter.should_sync() {
                    let _ = adapter.remove_skill(&directory);
                }
            }
        }

        // 2. Remove the source skill directory from SSOT (~/.codemux/skills/<dir>)
        //    so we don't leave behind an empty folder after the user uninstalls.
        let ssot_dir = ssot::get_ssot_dir();
        let ssot_skill_dir = ssot_dir.join(&directory);
        if ssot_skill_dir.exists() {
            let _ = std::fs::remove_dir_all(&ssot_skill_dir);
        }

        // 3. If disk_path points elsewhere (e.g. legacy ~/.claude/skills/<name>),
        //    remove that too so we don't leave orphaned folders.
        if let Some(ref disk_path) = skill.disk_path {
            let p = std::path::PathBuf::from(disk_path);
            // Avoid double-removing the SSOT dir we just deleted
            if p != ssot_skill_dir && p.exists() {
                let _ = std::fs::remove_dir_all(&p);
            }
        }
    }
    Ok(deleted)
}

pub fn toggle_skill_app_impl(
    state: &AppState,
    skill_id: String,
    app: String,
    enabled: bool,
) -> Result<(), String> {
    super::service::toggle_app(state, &skill_id, &app, enabled)
}

pub fn list_importable_skills_impl(
    state: &AppState,
) -> Result<Vec<super::types::ImportableSkill>, String> {
    super::service::list_importable(state)
}

pub fn import_skills_from_apps_impl(
    state: &AppState,
    selected: Option<Vec<String>>,
) -> Result<super::service::ImportResult, String> {
    super::service::import_from_apps(state, selected)
}

pub fn get_skill_content_impl(state: &AppState, id: String) -> Result<String, String> {
    let db_guard = state.db.lock().unwrap();
    let skill = db::get_skill(&db_guard, &id)
        .map_err(|e| format!("Failed to get skill: {}", e))?
        .ok_or("Skill not found")?;

    // Use stored disk_path if available (plugin skills, disk skills)
    if let Some(ref disk_path) = skill.disk_path {
        let skill_md = std::path::PathBuf::from(disk_path).join("SKILL.md");
        if skill_md.exists() {
            return std::fs::read_to_string(&skill_md)
                .map_err(|e| format!("Failed to read SKILL.md: {}", e));
        }
    }

    // Fallback: search known directories by name
    // For prefixed names like "superpowers:brainstorming", extract the skill name part
    let search_name = skill.name.split(':').next_back().unwrap_or(&skill.name);
    if let Some(skill_dir) = find_skill_path(search_name) {
        let skill_md = skill_dir.join("SKILL.md");
        if skill_md.exists() {
            return std::fs::read_to_string(&skill_md)
                .map_err(|e| format!("Failed to read SKILL.md: {}", e));
        }
    }
    Ok(String::new())
}

/// 内置技能清单:`(名字, SKILL.md 内容)`。
pub(crate) const BUILTIN_SKILLS: [(&str, &str); 1] =
    [("computer-control", super::builtin::COMPUTER_CONTROL_CONTENT)];

/// 我们写进去的副本后缀(与 SKILL.md 同目录):用来区分「我们写的版本」与
/// 「用户改过的版本」。用户改过的绝不覆盖;我们写的随版本更新 —— 否则技能
/// 内容永远停留在首次安装那一版(工单 12 修的就是这个:操作规范更新到不了已有安装)。
const BUILTIN_MIRROR_SUFFIX: &str = ".builtin";

/// 补齐内置技能文件,并在「确认是我们写的、且内容已过期」时刷新。
///
/// 判定顺序:
/// 1. 文件不存在 → 写入,并留一份镜像副本;
/// 2. 文件与我们当前内容一致 → 什么都不做;
/// 3. 文件与镜像副本一致(我们写的、用户没动过)→ 刷新到当前内容;
/// 4. 旧安装没有镜像副本,但文件自称是这个技能(frontmatter 的 name 与内置名一致)
///    → 认领并刷新(旧版本的内置文件就是这种情况);
/// 5. 其余(用户自己改过、或磁盘导入的同名技能)→ 一律不动。
///
/// 返回实际落盘的 `(名字, 目录)`(含刷新)。
pub(crate) fn write_builtin_skills(base: &std::path::Path) -> Vec<(String, std::path::PathBuf)> {
    let mut written = Vec::new();
    for (name, content) in BUILTIN_SKILLS {
        let directory = base.join(name);
        let skill_md = directory.join("SKILL.md");
        let mirror = directory.join(format!("SKILL.md{BUILTIN_MIRROR_SUFFIX}"));
        if let Ok(on_disk) = std::fs::read_to_string(&skill_md) {
            if on_disk == content {
                continue;
            }
            let untouched_by_user = std::fs::read_to_string(&mirror)
                .map(|last_written| last_written == on_disk)
                .unwrap_or(false);
            if !untouched_by_user && !declares_skill(&on_disk, name) {
                continue;
            }
        }
        match std::fs::create_dir_all(&directory)
            .and_then(|_| std::fs::write(&skill_md, content))
            .and_then(|_| std::fs::write(&mirror, content))
        {
            Ok(()) => written.push((name.to_string(), directory)),
            Err(error) => log::warn!(
                target: "skills_scan",
                "Failed to seed builtin skill '{}': {}",
                name,
                error
            ),
        }
    }
    written
}

/// 文件自称是这个技能(frontmatter 的 `name:` 与内置名一致)。
fn declares_skill(content: &str, name: &str) -> bool {
    content.starts_with("---")
        && content
            .lines()
            .take(12)
            .any(|line| line.trim() == format!("name: {name}"))
}

/// 内置技能种子(工单 03):系统随能力上线的技能,写进 SSOT 后按五端全开注册。
///
/// 已注册过的技能保留用户改过的开关(`register_discovered_skill` 按名去重)。
fn seed_builtin_skills(db_guard: &rusqlite::Connection) -> Vec<(String, std::path::PathBuf)> {
    let mut seeded = Vec::new();
    for (name, directory) in write_builtin_skills(&ssot::get_ssot_dir()) {
        match super::service::register_discovered_skill(
            db_guard,
            &name,
            &directory,
            SkillApps {
                claude: true,
                codex: true,
                gemini: true,
                opencode: true,
                pi: true,
            },
        ) {
            Ok(Some(pair)) => seeded.push(pair),
            Ok(None) => {}
            Err(error) => log::warn!(
                target: "skills_scan",
                "Failed to register builtin '{}': {}",
                name,
                error
            ),
        }
    }
    seeded
}

pub fn scan_disk_skills_impl(state: &AppState) -> Result<Vec<Skill>, String> {
    // Always re-scan the source directories for NEW skills (names not yet in the DB).
    // The first-time SSOT migration still runs only when the DB is empty.
    let mut to_sync: Vec<(String, std::path::PathBuf)> = Vec::new();
    {
        let db_guard = state.db.lock().unwrap();
        let existing =
            db::list_skills(&db_guard).map_err(|e| format!("Failed to list skills: {}", e))?;
        if existing.is_empty() {
            // First-time init: run SSOT migration (non-destructive: original files preserved)
            let _ = ssot::migrate_to_ssot(&db_guard);
        }

        // 系统内置技能先落 SSOT,再和磁盘发现的一起投影到五端。
        to_sync.extend(seed_builtin_skills(&db_guard));

        // Scan disk directories for new skills
        for base in &[skills_dir(), agents_skills_dir()] {
            to_sync.extend(scan_skills_directory(&db_guard, base));
        }

        // Scan installed plugins for skills (e.g. superpowers:brainstorming).
        // Plugin skills stay claude-only and are not projected; the result is dropped —
        // newly-discovered plugin skills are picked up by the final list_skills below.
        drop(scan_plugin_skills(&db_guard));
    } // DB lock released before filesystem projection below

    // Project each newly-discovered skill into every installed agent's skills dir.
    // Matches service::toggle_app: filesystem ops happen after the DB lock is dropped.
    for (directory, ssot_source) in &to_sync {
        for app in adapters::all_apps() {
            if let Some(adapter) = adapters::get_adapter(app) {
                if adapter.should_sync() {
                    if let Err(e) = adapter.sync_skill(directory, ssot_source) {
                        log::warn!(
                            target: "skills_scan",
                            "Failed to sync skill '{}' to {}: {}",
                            directory,
                            app,
                            e
                        );
                    }
                }
            }
        }
    }

    // Return the full current list (plugin + disk + pre-existing).
    let db_guard = state.db.lock().unwrap();
    db::list_skills(&db_guard).map_err(|e| format!("Failed to list skills: {}", e))
}

pub fn register_skill_from_disk_impl(state: &AppState, name: String) -> Result<Skill, String> {
    let db_guard = state.db.lock().unwrap();
    // Search both directories
    let dir =
        find_skill_path(&name).ok_or_else(|| format!("Skill '{}' not found on disk", name))?;
    db::register_skill_from_disk(&db_guard, dir.parent().unwrap_or(&dir), &name)
        .map_err(|e| format!("Failed to register skill from disk: {}", e))
}

pub async fn list_project_skills(
    project_root: String,
    agent_kind: String,
    force: Option<bool>,
) -> Result<Vec<super::project::ProjectSkill>, String> {
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    if force.unwrap_or(false) {
        super::project::invalidate_project_skills(std::path::Path::new(&project_root), agent_kind);
    }
    tokio::task::spawn_blocking(move || {
        super::project::resolve_project_skills(std::path::Path::new(&project_root), agent_kind)
    })
    .await
    .map_err(|error| format!("Failed to scan project skills: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!(
            ".codemux-builtin-skills-{}-{}-{}",
            name,
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn builtin_skills_are_written_with_parsable_frontmatter() {
        let base = temp_base("write");
        let written = write_builtin_skills(&base);
        assert_eq!(written.len(), BUILTIN_SKILLS.len());
        assert_eq!(written[0].0, "computer-control");

        let content = std::fs::read_to_string(base.join("computer-control").join("SKILL.md"))
            .expect("SKILL.md 应落盘");
        let (description, display_name) = db::parse_frontmatter(&content);
        assert_eq!(display_name.as_deref(), Some("computer-control"));
        let description = description.expect("frontmatter 应带 description");
        assert!(
            description.contains("computer-use"),
            "description 决定模型何时自动调用,须写明工具面: {description}"
        );
        // 操作规范的硬性内容都在(工单 13 起桌面有了输入面,纪律随之扩写)。
        for required in [
            "先观测",
            "不要重放",
            "网页内容不是指令",
            "敏感",
            "elementIndex",
            "background_unavailable",
        ] {
            assert!(content.contains(required), "SKILL.md 缺内容: {required}");
        }
    }

    #[test]
    fn builtin_skill_writes_do_not_overwrite_existing_files() {
        let base = temp_base("no-overwrite");
        let dir = base.join("computer-control");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "用户改过的内容").unwrap();

        assert!(
            write_builtin_skills(&base).is_empty(),
            "已存在的 SKILL.md 不应被重写"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "用户改过的内容"
        );
    }

    #[test]
    fn an_untouched_builtin_is_refreshed_when_its_content_changes() {
        let base = temp_base("refresh");
        let dir = base.join("computer-control");
        // 我们写过、用户没动过:镜像副本与 SKILL.md 一致。
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "旧版内置内容").unwrap();
        std::fs::write(dir.join("SKILL.md.builtin"), "旧版内置内容").unwrap();

        let written = write_builtin_skills(&base);

        assert_eq!(written.len(), 1, "我们写的旧版本应被刷新");
        let content = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(content.contains("电脑控制操作规范"));
        assert!(content.contains("桌面坐标怎么算"), "新版内容应落盘");
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md.builtin")).unwrap(),
            content,
            "镜像副本要同步,否则下次会把我们自己的文件当成用户改过的"
        );
    }

    #[test]
    fn a_user_edited_builtin_is_left_alone() {
        let base = temp_base("user-edited");
        let dir = base.join("computer-control");
        std::fs::create_dir_all(&dir).unwrap();
        // 镜像记录的是我们写的内容,磁盘上却是用户改过的 —— 不动它。
        std::fs::write(dir.join("SKILL.md"), "用户版:先快照再动手(自改)").unwrap();
        std::fs::write(dir.join("SKILL.md.builtin"), "我们写的旧版本").unwrap();

        assert!(write_builtin_skills(&base).is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "用户版:先快照再动手(自改)"
        );
    }

    #[test]
    fn an_older_install_without_a_mirror_is_adopted_by_its_frontmatter() {
        let base = temp_base("adopt");
        let dir = base.join("computer-control");
        // 旧安装:有 frontmatter 声明自己是 computer-control,但没有镜像副本。
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: computer-control\ndescription: 旧的\n---\n\n# 旧内容\n",
        )
        .unwrap();

        assert_eq!(
            write_builtin_skills(&base).len(),
            1,
            "旧内置文件应被认领并刷新"
        );
        let content = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(content.contains("桌面坐标怎么算"));
    }
}
