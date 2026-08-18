use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

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
    let (agent_kind, project_path, global_skills) = {
        let db = state.db.lock().map_err(|error| error.to_string())?;
        let session = operations::get_session(&db, session_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "会话不存在".to_string())?;
        let project_path = session.project_id.and_then(|project_id| {
            db.query_row(
                "SELECT path FROM projects WHERE id = ?1",
                [project_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .ok()
        });
        let global_skills = crate::skills::db::list_skills(&db)
            .unwrap_or_default()
            .into_iter()
            .filter(|skill| match session.agent_kind {
                AgentKind::ClaudeCode => skill.apps.claude,
                AgentKind::Codex => skill.apps.codex,
                AgentKind::Opencode => skill.apps.opencode,
                AgentKind::GeminiCli => false,
            })
            .map(|skill| (skill.name, skill.description, skill.disk_path))
            .collect::<Vec<_>>();
        (session.agent_kind, project_path, global_skills)
    };

    let Some(project_path) = project_path else {
        return Ok(ComposerContext {
            files: Vec::new(),
            commands: build_commands(agent_kind, Vec::new(), global_skills),
        });
    };

    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&project_path);
        let mut files = Vec::new();
        collect_files(&root, &root, 0, &mut files);
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let skills = crate::skills::project::resolve_project_skills(&root, agent_kind);
        Ok(ComposerContext {
            files,
            commands: build_commands(agent_kind, skills, global_skills),
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
    if agent_kind == AgentKind::Codex {
        commands.push(command(
            "init",
            "生成 AGENTS.md 项目指导文件",
            "builtin",
            "/init",
        ));
    } else {
        for (name, description) in [
            ("init", "初始化项目，生成 CLAUDE.md"),
            ("review", "审查最近的代码变更"),
            ("code-review", "代码审查"),
            ("security-review", "安全审查"),
            ("debug", "调试当前项目"),
            ("verify", "验证代码正确性"),
            ("deep-research", "深度研究"),
            ("simplify", "简化代码"),
        ] {
            commands.push(command(name, description, "builtin", &format!("/{name}")));
        }
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
