use crate::config::types::AgentKind;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(10);
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_SKILLS_PER_SOURCE: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkill {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub disk_path: String,
    pub source: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct CacheKey {
    project_root: String,
    agent_kind: String,
}

struct CachedSkills {
    loaded_at: Instant,
    skills: Vec<ProjectSkill>,
}

enum CacheState {
    Loading,
    Ready(CachedSkills),
}

struct CacheEntry {
    state: Mutex<CacheState>,
    completed: Condvar,
}

struct ProjectSkillResolver {
    entries: Mutex<HashMap<CacheKey, std::sync::Arc<CacheEntry>>>,
}

static RESOLVER: OnceLock<ProjectSkillResolver> = OnceLock::new();

fn resolver() -> &'static ProjectSkillResolver {
    RESOLVER.get_or_init(|| ProjectSkillResolver {
        entries: Mutex::new(HashMap::new()),
    })
}

pub fn resolve_project_skills(project_root: &Path, agent_kind: AgentKind) -> Vec<ProjectSkill> {
    let key = cache_key(project_root, agent_kind);
    let (entry, should_load) = {
        let mut entries = resolver().entries.lock().unwrap();
        match entries.get(&key) {
            Some(entry) => (entry.clone(), false),
            None => {
                let entry = std::sync::Arc::new(CacheEntry {
                    state: Mutex::new(CacheState::Loading),
                    completed: Condvar::new(),
                });
                entries.insert(key.clone(), entry.clone());
                (entry, true)
            }
        }
    };

    let mut state = entry.state.lock().unwrap();
    if should_load {
        drop(state);
        let skills = discover_project_skills(Path::new(&key.project_root), agent_kind);
        let mut state = entry.state.lock().unwrap();
        *state = CacheState::Ready(CachedSkills {
            loaded_at: Instant::now(),
            skills: skills.clone(),
        });
        entry.completed.notify_all();
        return skills;
    }

    loop {
        match &*state {
            CacheState::Ready(cached) if cached.loaded_at.elapsed() < CACHE_TTL => {
                return cached.skills.clone();
            }
            CacheState::Loading => {
                state = entry.completed.wait(state).unwrap();
            }
            CacheState::Ready(_) => {
                *state = CacheState::Loading;
                break;
            }
        }
    }
    drop(state);

    let skills = discover_project_skills(Path::new(&key.project_root), agent_kind);

    let mut state = entry.state.lock().unwrap();
    *state = CacheState::Ready(CachedSkills {
        loaded_at: Instant::now(),
        skills: skills.clone(),
    });
    entry.completed.notify_all();
    skills
}

pub fn cached_project_skills(
    project_root: &Path,
    agent_kind: AgentKind,
) -> Option<Vec<ProjectSkill>> {
    let key = cache_key(project_root, agent_kind);
    let entry = resolver().entries.lock().unwrap().get(&key).cloned()?;
    let state = entry.state.lock().unwrap();
    match &*state {
        CacheState::Ready(cached) if cached.loaded_at.elapsed() < CACHE_TTL => {
            Some(cached.skills.clone())
        }
        _ => None,
    }
}

pub fn invalidate_project_skills(project_root: &Path, agent_kind: AgentKind) {
    let key = cache_key(project_root, agent_kind);
    resolver().entries.lock().unwrap().remove(&key);
}

fn cache_key(project_root: &Path, agent_kind: AgentKind) -> CacheKey {
    CacheKey {
        project_root: canonical_or_original(project_root)
            .to_string_lossy()
            .to_string(),
        agent_kind: agent_kind.as_str().to_string(),
    }
}

fn canonical_or_original(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn source_directories(agent_kind: AgentKind) -> &'static [(&'static str, &'static str)] {
    match agent_kind {
        AgentKind::ClaudeCode => &[(".claude", ".claude/skills")],
        AgentKind::Codex => &[(".agents", ".agents/skills")],
        AgentKind::GeminiCli => &[],
        AgentKind::Pi => &[],
        AgentKind::Opencode => &[
            (".opencode", ".opencode/skills"),
            (".claude", ".claude/skills"),
            (".agents", ".agents/skills"),
        ],
    }
}

fn discover_project_skills(project_root: &Path, agent_kind: AgentKind) -> Vec<ProjectSkill> {
    let mut skills = Vec::new();
    let mut seen_names = HashSet::new();

    for (source, relative_path) in source_directories(agent_kind) {
        let source_dir =
            project_root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        scan_skill_directory(
            &source_dir,
            source,
            relative_path,
            &mut seen_names,
            &mut skills,
        );
    }

    skills.sort_by_key(|skill| skill.name.to_lowercase());
    skills
}

fn scan_skill_directory(
    source_dir: &Path,
    source: &str,
    relative_source_dir: &str,
    seen_names: &mut HashSet<String>,
    skills: &mut Vec<ProjectSkill>,
) {
    if !source_dir.is_dir() {
        return;
    }

    let mut entries = match fs::read_dir(source_dir) {
        Ok(entries) => entries.flatten().collect::<Vec<_>>(),
        Err(error) => {
            log::warn!(
                target: "skills_scan",
                "Failed to read project skill directory '{}': {}",
                source_dir.display(),
                error
            );
            return;
        }
    };
    entries.sort_by_key(|entry| entry.file_name());
    entries.truncate(MAX_SKILLS_PER_SOURCE);

    for entry in entries {
        let skill_dir = entry.path();
        if !skill_dir.is_dir() || is_link_like(&skill_dir) {
            continue;
        }

        let Some(name) = skill_dir.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let normalized_name = name.trim().to_lowercase();
        if normalized_name.is_empty() || !seen_names.insert(normalized_name.clone()) {
            continue;
        }

        let skill_md = skill_dir.join("SKILL.md");
        if !skill_md.is_file() {
            seen_names.remove(&normalized_name);
            continue;
        }

        let (description, display_name) = match read_skill_metadata(&skill_md) {
            Ok(metadata) => metadata,
            Err(error) => {
                log::warn!(
                    target: "skills_scan",
                    "Skipping project Skill '{}': {}",
                    skill_md.display(),
                    error
                );
                seen_names.remove(&normalized_name);
                continue;
            }
        };
        let relative_path = format!("{relative_source_dir}/{name}");
        let disk_path = skill_dir.to_string_lossy().to_string();
        skills.push(ProjectSkill {
            name: name.to_string(),
            display_name,
            description,
            disk_path,
            source: source.to_string(),
            relative_path,
        });
    }
}

fn read_skill_metadata(path: &Path) -> Result<(Option<String>, Option<String>), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut content = String::new();
    file.by_ref()
        .take(MAX_METADATA_BYTES)
        .read_to_string(&mut content)
        .map_err(|error| error.to_string())?;
    let trimmed = content.trim();
    if !trimmed.starts_with("---") || !trimmed[3..].contains("---") {
        return Err("SKILL.md frontmatter is missing or incomplete".to_string());
    }
    Ok(super::db::parse_frontmatter(&content))
}

fn is_link_like(path: &Path) -> bool {
    if fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(true)
    {
        return true;
    }

    #[cfg(windows)]
    if junction::exists(path).unwrap_or(false) {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_skill(root: &Path, source: &str, name: &str, description: &str) {
        let skill_dir = root.join(source).join("skills").join(name);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}"),
        )
        .unwrap();
    }

    #[test]
    fn discovers_claude_project_skills_without_persisting_them() {
        let root = tempdir().unwrap();
        write_skill(root.path(), ".claude", "review", "Review the project");

        let skills = discover_project_skills(root.path(), AgentKind::ClaudeCode);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "review");
        assert_eq!(skills[0].source, ".claude");
        assert_eq!(skills[0].relative_path, ".claude/skills/review");
    }

    #[test]
    fn selects_only_the_active_agents_project_sources() {
        let root = tempdir().unwrap();
        write_skill(root.path(), ".claude", "claude-only", "Claude");
        write_skill(root.path(), ".agents", "codex-only", "Codex");

        let claude = discover_project_skills(root.path(), AgentKind::ClaudeCode);
        let codex = discover_project_skills(root.path(), AgentKind::Codex);

        assert_eq!(
            claude
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            ["claude-only"]
        );
        assert_eq!(
            codex
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            ["codex-only"]
        );
    }

    #[test]
    fn opencode_prefers_native_source_when_names_collide() {
        let root = tempdir().unwrap();
        write_skill(root.path(), ".opencode", "review", "OpenCode");
        write_skill(root.path(), ".claude", "review", "Claude");

        let skills = discover_project_skills(root.path(), AgentKind::Opencode);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].source, ".opencode");
        assert_eq!(skills[0].description.as_deref(), Some("OpenCode"));
    }

    #[test]
    fn ignores_gemini_project_skills_until_supported() {
        let root = tempdir().unwrap();
        write_skill(root.path(), ".gemini", "review", "Gemini");

        assert!(discover_project_skills(root.path(), AgentKind::GeminiCli).is_empty());
    }

    #[test]
    fn skips_skills_with_invalid_frontmatter() {
        let root = tempdir().unwrap();
        let skill_dir = root.path().join(".claude").join("skills").join("broken");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: broken\n").unwrap();

        assert!(discover_project_skills(root.path(), AgentKind::ClaudeCode).is_empty());
    }
}
