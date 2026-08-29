//! Restores subagent descriptors and timelines from the Claude CLI's on-disk
//! `subagents/` transcripts when session history is hydrated or re-synced from
//! the CLI. Each `<session>/subagents/agent-<id>.jsonl` is one child track;
//! the sibling `agent-<id>.meta.json` carries `agentType`, `description` and
//! the parent Task `toolUseId` that becomes the canonical `subagent_id`.
//!
//! Live sidecar captures always win: callers skip descriptors that already
//! exist in the database, so a resync never rewrites or terminates children
//! recorded while the session was running.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::history_events::normalize_history_events;

pub(crate) struct ClaudeSubagentHistory {
    pub subagent_id: String,
    /// Sidecar-shaped `subagent_upsert` event, ready for
    /// `operations::upsert_session_subagent`.
    pub upsert: Value,
    /// Sidecar-shaped `subagent_timeline` envelopes, ready for
    /// `operations::append_session_subagent_event`.
    pub timeline: Vec<Value>,
}

/// Locate `<projects>/<project>/<claude_session_id>/subagents` — the session
/// subdirectory that holds the per-child transcripts.
pub(crate) fn find_claude_session_subagents_dir(
    claude_dir: &Path,
    claude_session_id: &str,
) -> Option<PathBuf> {
    let projects_dir = claude_dir.join("projects");
    if !projects_dir.exists() {
        return None;
    }
    for entry in fs::read_dir(&projects_dir).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let session_jsonl = entry.path().join(format!("{}.jsonl", claude_session_id));
        if !session_jsonl.exists() {
            continue;
        }
        let subagents_dir = entry.path().join(claude_session_id).join("subagents");
        return subagents_dir.is_dir().then_some(subagents_dir);
    }
    None
}

fn read_agent_meta(subagents_dir: &Path, agent_id: &str) -> Option<Value> {
    let path = subagents_dir.join(format!("agent-{}.meta.json", agent_id));
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn meta_string(meta: Option<&Value>, key: &str) -> Option<String> {
    meta.and_then(|meta| meta.get(key))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// Collect sidechain transcript lines that project to parent-visible events
/// (the same rule the parent timeline uses, minus `result`/system frames a
/// child transcript never contains).
fn read_agent_transcript(path: &Path) -> Vec<Value> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut raw_events = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let msg_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(msg_type, "user" | "assistant") {
            continue;
        }
        if value
            .get("isMeta")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        raw_events.push(value);
    }
    raw_events
}

pub(crate) fn load_claude_session_subagent_history(
    claude_dir: &Path,
    claude_session_id: &str,
    app_session_id: &str,
) -> Vec<ClaudeSubagentHistory> {
    let Some(subagents_dir) = find_claude_session_subagents_dir(claude_dir, claude_session_id)
    else {
        return Vec::new();
    };

    let mut transcript_paths: Vec<PathBuf> = fs::read_dir(&subagents_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| ext.eq_ignore_ascii_case("jsonl"))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    transcript_paths.sort();

    let mut entries = Vec::new();
    for path in transcript_paths {
        let Some(agent_id) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.strip_prefix("agent-"))
        else {
            continue;
        };
        let meta = read_agent_meta(&subagents_dir, agent_id);
        let tool_use_id = meta_string(meta.as_ref(), "toolUseId");
        // The parent Task tool_use_id is the canonical subagent id — the same
        // id the live sidecar adapter derives from task announcements.
        let subagent_id = tool_use_id
            .clone()
            .unwrap_or_else(|| format!("claude-agent-{}", agent_id));

        let raw_events = read_agent_transcript(&path);
        if raw_events.is_empty() {
            continue;
        }
        let inner_events = normalize_history_events(raw_events, app_session_id);
        if inner_events.is_empty() {
            continue;
        }

        let timeline = inner_events
            .into_iter()
            .map(|inner| {
                json!({
                    "type": "subagent_timeline",
                    "session_id": app_session_id,
                    "subagent_id": subagent_id,
                    "provider": "claude",
                    "event": inner,
                    "event_id": inner.get("event_id").cloned().unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string())),
                    "timestamp": inner.get("timestamp").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();

        let upsert = json!({
            "type": "subagent_upsert",
            "session_id": app_session_id,
            "subagent_id": subagent_id,
            "provider": "claude",
            "title": meta_string(meta.as_ref(), "agentType"),
            "description": meta_string(meta.as_ref(), "description"),
            // Restored transcripts are finished runs; live captures own any
            // richer status and are skipped by the caller anyway.
            "status": "completed",
            "tool_call_id": tool_use_id,
        });

        entries.push(ClaudeSubagentHistory {
            subagent_id,
            upsert,
            timeline,
        });
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_session_fixture(home: &Path) -> PathBuf {
        let project = home.join(".claude").join("projects").join("demo");
        let session_dir = project.join("sess-1");
        let subagents = session_dir.join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(
            project.join("sess-1.jsonl"),
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        )
        .unwrap();

        fs::write(
            subagents.join("agent-abc.meta.json"),
            r#"{"agentType":"Explore","description":"探索后端","toolUseId":"toolu_1","spawnDepth":1}"#,
        )
        .unwrap();
        fs::write(
            subagents.join("agent-abc.jsonl"),
            concat!(
                "{\"type\":\"user\",\"isSidechain\":true,\"agentId\":\"abc\",\"uuid\":\"u1\",\"timestamp\":\"2026-08-29T09:42:51.082Z\",\"message\":{\"role\":\"user\",\"content\":\"探索 Rust 技术栈\"}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"agentId\":\"abc\",\"uuid\":\"a1\",\"timestamp\":\"2026-08-29T09:43:10.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"结论如下\"},{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Read\",\"input\":{\"file_path\":\"a.rs\"}}]}}\n",
                "{\"type\":\"user\",\"isSidechain\":true,\"agentId\":\"abc\",\"uuid\":\"u2\",\"timestamp\":\"2026-08-29T09:43:11.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"ok\"}]}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"agentId\":\"abc\",\"uuid\":\"a2\",\"timestamp\":\"2026-08-29T09:43:20.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"完成\"}]}}\n",
                "{\"attachment\":{\"type\":\"skill_listing\",\"content\":\"...\"}}\n",
            ),
        )
        .unwrap();
        session_dir
    }

    #[test]
    fn loads_descriptors_and_timelines_from_subagents_directory() {
        let home = std::env::temp_dir().join(format!(
            "codemux-claude-subagent-history-{}",
            uuid::Uuid::new_v4()
        ));
        write_session_fixture(&home);

        let entries =
            load_claude_session_subagent_history(&home.join(".claude"), "sess-1", "app-1");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.subagent_id, "toolu_1");
        assert_eq!(entry.upsert["type"], "subagent_upsert");
        assert_eq!(entry.upsert["session_id"], "app-1");
        assert_eq!(entry.upsert["title"], "Explore");
        assert_eq!(entry.upsert["description"], "探索后端");
        assert_eq!(entry.upsert["status"], "completed");
        assert_eq!(entry.upsert["tool_call_id"], "toolu_1");

        // prompt + assistant text/tool_use + tool_result + final text
        let kinds: Vec<&str> = entry
            .timeline
            .iter()
            .map(|event| event["event"]["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "user_message",
                "assistant_message",
                "tool_started",
                "tool_finished",
                "assistant_message"
            ]
        );
        let first = &entry.timeline[0];
        assert_eq!(first["type"], "subagent_timeline");
        assert_eq!(first["subagent_id"], "toolu_1");
        assert_eq!(first["event_id"], first["event"]["event_id"]);
        assert_eq!(first["event"]["event_id"], "u1");
        assert_eq!(first["event"]["sequence"], 0);

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn falls_back_to_agent_id_when_meta_is_missing() {
        let home = std::env::temp_dir().join(format!(
            "codemux-claude-subagent-history-{}",
            uuid::Uuid::new_v4()
        ));
        let subagents = write_session_fixture(&home).join("subagents");
        fs::remove_file(subagents.join("agent-abc.meta.json")).unwrap();

        let entries =
            load_claude_session_subagent_history(&home.join(".claude"), "sess-1", "app-1");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].subagent_id, "claude-agent-abc");
        assert_eq!(entries[0].upsert["tool_call_id"], Value::Null);

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn returns_empty_without_subagents_directory() {
        let home = std::env::temp_dir().join(format!(
            "codemux-claude-subagent-history-{}",
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("demo");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("sess-1.jsonl"), "{}\n").unwrap();

        let entries =
            load_claude_session_subagent_history(&home.join(".claude"), "sess-1", "app-1");
        assert!(entries.is_empty());

        fs::remove_dir_all(&home).ok();
    }
}
