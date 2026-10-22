use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use log::warn;
use serde::Serialize;

use crate::config::types::AgentKind;
use crate::db::operations;
use crate::AppState;

const MAX_FILES: usize = 500;
const MAX_DEPTH: usize = 5;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerContext {
    pub files: Vec<ComposerFile>,
    pub commands: Vec<ComposerCommand>,
    pub token_usage: Option<crate::agent::context_usage::ThreadTokenUsageSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerFile {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerCommand {
    pub name: String,
    pub description: String,
    pub category: &'static str,
    pub handler: &'static str,
    pub prompt: Option<String>,
    pub file_path: Option<String>,
    pub scope: Option<&'static str>,
}

pub async fn build_composer_context(
    state: &AppState,
    session_id: &str,
) -> Result<ComposerContext, String> {
    let (agent_kind, project_roots, global_skills) = {
        let db = state.db.lock().map_err(|error| error.to_string())?;
        let session = operations::get_session(&db, session_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "会话不存在".to_string())?;
        let project_roots = session
            .project_id
            .map(|project_id| operations::get_project_roots(&db, &project_id))
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or_default();
        let global_skills = crate::skills::db::list_skills(&db)
            .unwrap_or_default()
            .into_iter()
            .filter(|skill| match session.agent_kind {
                AgentKind::ClaudeCode => skill.apps.claude,
                AgentKind::Codex => skill.apps.codex,
                AgentKind::Opencode => skill.apps.opencode,
                AgentKind::Pi => false,
                AgentKind::GeminiCli => false,
            })
            .map(|skill| (skill.name, skill.description, skill.disk_path))
            .collect::<Vec<_>>();
        (session.agent_kind, project_roots, global_skills)
    };

    let token_usage = match crate::agent::commands::load_latest_token_usage_for_session(
        state, session_id, agent_kind, "restored",
    )
    .await
    {
        Ok(usage) => usage,
        Err(error) => {
            warn!(
                target: "companion",
                "Failed to load token usage for session {}: {}",
                session_id,
                error
            );
            None
        }
    };

    let Some(primary_root) = project_roots
        .iter()
        .find(|root| root.is_primary)
        .map(|root| root.path.clone())
    else {
        return Ok(ComposerContext {
            files: Vec::new(),
            commands: build_commands(agent_kind, Vec::new(), global_skills),
            token_usage,
        });
    };

    tokio::task::spawn_blocking(move || {
        let primary = PathBuf::from(&primary_root);
        let mut files = Vec::new();
        let mut seen = HashSet::new();
        for root in &project_roots {
            let root_path = PathBuf::from(&root.path);
            if !root_path.is_dir() {
                // 附加目录不可用时跳过该条；主根不可用由会话启动路径拒绝。
                continue;
            }
            let mut root_files = Vec::new();
            collect_files(&root_path, &root_path, 0, &mut root_files);
            for mut file in root_files {
                // 主根文件用相对路径；附加目录用绝对路径，避免被解析到错误的工作目录。
                if !root.is_primary {
                    file.path = root_path
                        .join(&file.path)
                        .to_string_lossy()
                        .replace('\\', "/");
                }
                if seen.insert(file.path.clone()) {
                    files.push(file);
                }
            }
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        files.truncate(MAX_FILES);
        let skills = crate::skills::project::resolve_project_skills(&primary, agent_kind);
        Ok(ComposerContext {
            files,
            commands: build_commands(agent_kind, skills, global_skills),
            token_usage,
        })
    })
    .await
    .map_err(|error| format!("加载编辑器上下文失败: {}", error))?
}

fn collect_files(root: &Path, current: &Path, depth: usize, files: &mut Vec<ComposerFile>) {
    if depth > MAX_DEPTH || files.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        if files.len() >= MAX_FILES {
            break;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist" | "build") {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .ok()
            .map(|value| value.to_string_lossy().replace('\\', "/"));
        let Some(relative) = relative else {
            continue;
        };
        let is_directory = path.is_dir();
        files.push(ComposerFile {
            name: name.to_string(),
            path: relative,
            kind: if is_directory { "directory" } else { "file" },
        });
        if is_directory {
            collect_files(root, &path, depth + 1, files);
        }
    }
}

fn build_commands(
    agent_kind: AgentKind,
    project_skills: Vec<crate::skills::project::ProjectSkill>,
    global_skills: Vec<(String, Option<String>, Option<String>)>,
) -> Vec<ComposerCommand> {
    let mut commands = vec![
        command("new", "新建对话", "session", "/new"),
        command("clear", "重置对话上下文", "session", "/clear"),
        command("compact", "压缩上下文", "session", "/compact"),
    ];
    // 与前端 `src/lib/slashCommands.ts` 的各家内置命令表保持一致：
    // 只保留在非交互通道下确实会生效的命令。
    let builtin: &[(&str, &str)] = match agent_kind {
        AgentKind::Codex => &[
            ("init", "生成 AGENTS.md 项目指导文件"),
            ("review", "审查工作区变更"),
            ("goal", "设置目标"),
        ],
        AgentKind::Opencode => &[("init", "生成/更新 AGENTS.md")],
        AgentKind::Pi => &[],
        _ => &[
            ("init", "初始化项目，生成 CLAUDE.md"),
            ("review", "审查最近的代码变更"),
            ("security-review", "安全审查"),
            ("goal", "设置目标"),
        ],
    };
    for (name, description) in builtin {
        commands.push(command(name, description, "builtin", &format!("/{name}")));
    }

    let mut seen: HashSet<String> = commands.iter().map(|item| item.name.clone()).collect();
    for skill in project_skills {
        let name = skill.name;
        if !seen.insert(name.clone()) {
            continue;
        }
        let prompt = format!("/{name} {{args}}");
        commands.push(ComposerCommand {
            name,
            description: skill
                .description
                .or(skill.display_name)
                .unwrap_or_else(|| "项目技能".to_string()),
            category: "skill",
            handler: "prompt",
            prompt: Some(prompt),
            file_path: Some(skill.disk_path),
            scope: Some("project"),
        });
    }
    for (name, description, file_path) in global_skills {
        if !seen.insert(name.clone()) {
            continue;
        }
        commands.push(ComposerCommand {
            prompt: Some(format!("/{name} {{args}}")),
            name,
            description: description.unwrap_or_else(|| "全局技能".to_string()),
            category: "skill",
            handler: "prompt",
            file_path,
            scope: Some("global"),
        });
    }
    commands
}

fn command(name: &str, description: &str, category: &'static str, prompt: &str) -> ComposerCommand {
    ComposerCommand {
        name: name.to_string(),
        description: description.to_string(),
        category,
        handler: "prompt",
        prompt: Some(prompt.to_string()),
        file_path: None,
        scope: None,
    }
}

#[cfg(test)]
mod tests {
    use super::collect_files;
    use std::fs;

    #[test]
    fn collects_relative_paths_and_skips_generated_directories() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(root.path().join("src/app.ts"), "export {}").unwrap();
        fs::write(root.path().join("node_modules/pkg.js"), "").unwrap();

        let mut files = Vec::new();
        collect_files(root.path(), root.path(), 0, &mut files);

        assert!(files.iter().any(|file| file.path == "src/app.ts"));
        assert!(!files.iter().any(|file| file.path.contains("node_modules")));
    }
}
