use std::fs;
use std::path::{Path, PathBuf};

pub fn cleanup_claude_native_session(home: &Path, agent_session_id: &str) -> Result<(), String> {
    let claude_dir = home.join(".claude");
    let projects_dir = claude_dir.join("projects");
    if projects_dir.exists() {
        for entry in fs::read_dir(&projects_dir)
            .map_err(|error| format!("Failed to read Claude projects directory: {error}"))?
            .flatten()
        {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let jsonl = entry.path().join(format!("{agent_session_id}.jsonl"));
            if jsonl.exists() {
                let _ = fs::remove_file(jsonl);
            }
            let session_subdir = entry.path().join(agent_session_id);
            if session_subdir.exists() {
                let _ = fs::remove_dir_all(session_subdir);
            }
        }
    }
    for path in [
        claude_dir.join("session-env").join(agent_session_id),
        claude_dir.join("file-history").join(agent_session_id),
    ] {
        if path.exists() {
            let _ = fs::remove_dir_all(path);
        }
    }

    let todos_dir = claude_dir.join("todos");
    if todos_dir.exists() {
        if let Ok(entries) = fs::read_dir(&todos_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(agent_session_id) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    let debug_file = claude_dir
        .join("debug")
        .join(format!("{agent_session_id}.txt"));
    if debug_file.exists() {
        let _ = fs::remove_file(debug_file);
    }

    let history_file = claude_dir.join("history.jsonl");
    if history_file.exists() {
        if let Ok(content) = fs::read_to_string(&history_file) {
            let filtered: String = content
                .lines()
                .filter(|line| !line.contains(&format!("\"sessionId\":\"{agent_session_id}\"")))
                .collect::<Vec<_>>()
                .join("\n");
            if filtered.len() != content.len() {
                let _ = fs::write(&history_file, filtered);
            }
        }
    }
    Ok(())
}

pub fn cleanup_codex_native_session(home: &Path, agent_session_id: &str) -> Result<(), String> {
    let sessions_dir = home.join(".codex").join("sessions");
    if sessions_dir.exists() {
        let mut candidates = Vec::new();
        collect_jsonl_files(&sessions_dir, &mut candidates);
        for path in candidates {
            if read_codex_session_meta_id(&path).as_deref() == Some(agent_session_id) {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}

pub fn cleanup_codex_app_interactive_events(
    home: &Path,
    app_session_id: &str,
) -> Result<(), String> {
    let path = home
        .join(".codemux")
        .join("codex-interactive-events")
        .join(format!("{}.jsonl", sanitize_file_segment(app_session_id)));
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn collect_jsonl_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|ty| ty.is_dir()).unwrap_or(false) {
            collect_jsonl_files(&path, output);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

fn read_codex_session_meta_id(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let line = content.lines().find(|line| !line.trim().is_empty())?;
    let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("session_meta") {
        return None;
    }
    value
        .get("payload")
        .and_then(|payload| payload.get("id"))
        .and_then(|entry| entry.as_str())
        .map(ToOwned::to_owned)
}

fn sanitize_file_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_claude_native_session, cleanup_codex_app_interactive_events,
        cleanup_codex_native_session,
    };
    use std::fs;

    fn temp_home() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("codemux-native-cleanup-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn removes_only_the_abandoned_claude_jsonl() {
        let home = temp_home();
        let project = home.join(".claude").join("projects").join("demo");
        fs::create_dir_all(&project).unwrap();
        let keep = project.join("keep-session.jsonl");
        let drop = project.join("drop-session.jsonl");
        fs::write(&keep, "{\"type\":\"user\"}\n").unwrap();
        fs::write(&drop, "{\"type\":\"user\"}\n").unwrap();

        cleanup_claude_native_session(&home, "drop-session").unwrap();

        assert!(keep.exists());
        assert!(!drop.exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn removes_only_the_abandoned_codex_jsonl() {
        let home = temp_home();
        let sessions = home.join(".codex").join("sessions").join("2026").join("08");
        fs::create_dir_all(&sessions).unwrap();
        let keep = sessions.join("keep.jsonl");
        let drop = sessions.join("drop.jsonl");
        fs::write(
            &keep,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"keep-session\"}}\n",
        )
        .unwrap();
        fs::write(
            &drop,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"drop-session\"}}\n",
        )
        .unwrap();

        cleanup_codex_native_session(&home, "drop-session").unwrap();

        assert!(keep.exists());
        assert!(!drop.exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn removes_codex_interactive_events_for_the_app_session() {
        let home = temp_home();
        let dir = home.join(".codemux").join("codex-interactive-events");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app-session.jsonl");
        fs::write(&path, "{}\n").unwrap();

        cleanup_codex_app_interactive_events(&home, "app-session").unwrap();

        assert!(!path.exists());
        let _ = fs::remove_dir_all(&home);
    }
}
