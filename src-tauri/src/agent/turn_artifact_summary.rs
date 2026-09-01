use serde_json::{json, Value};
use similar::{ChangeTag, TextDiff};

use crate::config::types::AgentKind;

pub(crate) fn supports_turn_artifact_summary_backfill(agent_kind: AgentKind) -> bool {
    matches!(
        agent_kind,
        AgentKind::ClaudeCode | AgentKind::Codex | AgentKind::Opencode
    )
}

pub(crate) fn backfill_turn_artifact_summaries(events: &mut Vec<Value>) -> bool {
    if !timeline_has_mutation_tools(events) {
        return false;
    }
    let before = summary_fingerprint(events);
    events.retain(|event| !is_session_summary_event(event));
    inject_turn_artifact_summaries(events);
    summary_fingerprint(events) != before
}

fn summary_fingerprint(events: &[Value]) -> String {
    let summaries: Vec<&Value> = events
        .iter()
        .filter(|event| is_session_summary_event(event))
        .collect();
    serde_json::to_string(&summaries).unwrap_or_default()
}

fn timeline_has_mutation_tools(events: &[Value]) -> bool {
    events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("tool_started")
            && event
                .get("name")
                .and_then(Value::as_str)
                .map(|name| {
                    matches!(
                        name.to_ascii_lowercase().as_str(),
                        "write" | "edit" | "apply_patch"
                    )
                })
                .unwrap_or(false)
    })
}

fn is_session_summary_event(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("system_event")
        && event.get("subtype").and_then(Value::as_str) == Some("session_summary")
}

#[cfg(test)]
fn count_session_summaries(events: &[Value]) -> usize {
    events.iter().filter(|event| is_session_summary_event(event)).count()
}

pub(crate) fn inject_turn_artifact_summaries(events: &mut Vec<Value>) {
    if events.is_empty() {
        return;
    }

    let cwd = extract_working_directory(events).unwrap_or_else(|| ".".to_string());
    let mut output = Vec::new();
    let mut turn_events: Vec<Value> = Vec::new();
    let mut turn_has_summary = false;

    let flush_turn = |output: &mut Vec<Value>, turn_events: &mut Vec<Value>, turn_has_summary: &mut bool| {
        if turn_events.is_empty() {
            return;
        }

        if !*turn_has_summary {
            if let Some(summary) = build_turn_summary(&turn_events, &cwd) {
                let turn_finished_index = turn_events
                    .iter()
                    .position(|event| event.get("type").and_then(Value::as_str) == Some("turn_finished"));
                if let Some(index) = turn_finished_index {
                    output.extend(turn_events.drain(..index));
                    output.push(summary);
                    output.extend(turn_events.drain(..));
                } else {
                    output.extend(turn_events.drain(..));
                    output.push(summary);
                }
                *turn_has_summary = false;
                return;
            }
        }

        output.extend(turn_events.drain(..));
        *turn_has_summary = false;
    };

    for event in events.drain(..) {
        if event.get("type").and_then(Value::as_str) == Some("user_message") && !turn_events.is_empty() {
            flush_turn(&mut output, &mut turn_events, &mut turn_has_summary);
        }

        if event.get("type").and_then(Value::as_str) == Some("system_event")
            && event.get("subtype").and_then(Value::as_str) == Some("session_summary")
        {
            turn_has_summary = true;
        }

        turn_events.push(event);

        if turn_events
            .last()
            .and_then(|event| event.get("type"))
            .and_then(Value::as_str)
            == Some("turn_finished")
        {
            flush_turn(&mut output, &mut turn_events, &mut turn_has_summary);
        }
    }

    flush_turn(&mut output, &mut turn_events, &mut turn_has_summary);
    *events = output;
}

fn extract_working_directory(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("system_event") {
            return None;
        }
        if event.get("subtype").and_then(Value::as_str) != Some("init") {
            return None;
        }
        event
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn build_turn_summary(events: &[Value], cwd: &str) -> Option<Value> {
    let mut files: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
    let mut snapshots: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut snapshots_by_tool: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut pending: std::collections::HashMap<String, PendingTool> = std::collections::HashMap::new();

    for event in events {
        match event.get("type").and_then(Value::as_str) {
            Some("file_snapshot") => {
                let file_path = read_string(event, "file_path")?;
                let snapshot = json!({
                    "content": read_string(event, "original_content").unwrap_or_default(),
                    "is_new": event.get("is_new").and_then(Value::as_bool).unwrap_or(false),
                });
                let normalized = resolve_path(cwd, &file_path);
                snapshots.entry(normalized.clone()).or_insert(snapshot.clone());
                if let Some(tool_use_id) = read_string(event, "tool_use_id") {
                    snapshots_by_tool.insert(tool_use_id, snapshot);
                }
            }
            Some("tool_started") => {
                let tool_use_id = read_string(event, "tool_use_id")?;
                let name = normalize_tool_name(read_string(event, "name").unwrap_or_default());
                let input = event.get("input").cloned().unwrap_or_else(|| json!({}));
                if name == "apply_patch" {
                    pending.insert(
                        tool_use_id,
                        PendingTool::ApplyPatch {
                            patch_text: extract_patch_text(&input),
                            changes: extract_patch_changes(&input),
                        },
                    );
                } else if name == "write" {
                    let file_path = read_file_path(&input)?;
                    let content = read_string(&input, "content")?;
                    pending.insert(
                        tool_use_id,
                        PendingTool::Write { file_path, content },
                    );
                } else if name == "edit" {
                    pending.insert(
                        tool_use_id,
                        PendingTool::Edit {
                            file_path: read_file_path(&input)?,
                            old_string: read_string(&input, "old_string")
                                .or_else(|| read_string(&input, "oldString"))?,
                            new_string: read_string(&input, "new_string")
                                .or_else(|| read_string(&input, "newString"))?,
                        },
                    );
                }
            }
            Some("tool_finished") => {
                if event.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                    continue;
                }
                let tool_use_id = read_string(event, "tool_use_id")?;
                let Some(pending_tool) = pending.remove(&tool_use_id) else {
                    continue;
                };
                match pending_tool {
                    PendingTool::ApplyPatch { patch_text, changes } => {
                        if let Some(change_entries) = changes {
                            for change in change_entries {
                                if let Some(entry) = diff_from_change(cwd, &change) {
                                    files.insert(
                                        read_string(&entry, "file").unwrap_or_default(),
                                        entry,
                                    );
                                }
                            }
                        } else if let Some(patch_text) = patch_text {
                            for entry in diffs_from_freeform_patch(cwd, &patch_text) {
                                files.insert(read_string(&entry, "file").unwrap_or_default(), entry);
                            }
                        }
                    }
                    PendingTool::Write { file_path, content } => {
                        let resolved = resolve_path(cwd, &file_path);
                        let before = snapshot_content(&snapshots, &snapshots_by_tool, &file_path, Some(&tool_use_id));
                        if let Some(entry) = finalize_diff_entry(cwd, resolved.clone(), before, content, None) {
                            files.insert(resolved, entry);
                        }
                    }
                    PendingTool::Edit {
                        file_path,
                        old_string,
                        new_string,
                    } => {
                        let resolved = resolve_path(cwd, &file_path);
                        let snapshot = snapshot_content(
                            &snapshots,
                            &snapshots_by_tool,
                            &file_path,
                            Some(&tool_use_id),
                        );
                        let snapshot_is_empty = snapshot.is_empty();
                        let normalized_snapshot = normalize_line_endings(&snapshot);
                        let normalized_old = normalize_line_endings(&old_string);
                        let normalized_new = normalize_line_endings(&new_string);
                        let mut before = normalized_snapshot.clone();
                        let mut after = normalized_snapshot;
                        let mut applied = false;
                        if let Some(index) = after.find(&normalized_old) {
                            after.replace_range(index..index + normalized_old.len(), &normalized_new);
                            applied = true;
                        } else if snapshot_is_empty {
                            before = normalized_old;
                            after = normalized_new;
                            applied = true;
                        }
                        if applied {
                            if let Some(entry) = finalize_diff_entry(cwd, resolved.clone(), before, after, None) {
                                files.insert(resolved, entry);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if files.is_empty() {
        return None;
    }

    let session_id = events
        .iter()
        .find_map(|event| read_string(event, "session_id"))
        .unwrap_or_default();

    Some(json!({
        "type": "system_event",
        "subtype": "session_summary",
        "session_id": session_id,
        "diffs": files.into_values().collect::<Vec<_>>(),
    }))
}

enum PendingTool {
    Write { file_path: String, content: String },
    Edit {
        file_path: String,
        old_string: String,
        new_string: String,
    },
    ApplyPatch {
        patch_text: Option<String>,
        changes: Option<Vec<Value>>,
    },
}

fn normalize_tool_name(name: String) -> String {
    name.to_ascii_lowercase()
}

fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn read_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn read_file_path(input: &Value) -> Option<String> {
    read_string(input, "file_path").or_else(|| read_string(input, "filePath"))
}

fn resolve_path(cwd: &str, raw_path: &str) -> String {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    if trimmed.starts_with('/')
        || trimmed.chars().nth(1) == Some(':')
            && trimmed.as_bytes().get(2).copied() == Some(b'\\')
    {
        return trimmed.replace('\\', "/");
    }
    format!(
        "{}/{}",
        cwd.trim_end_matches('/').trim_end_matches('\\'),
        trimmed.replace('\\', "/")
    )
}

fn normalize_path_key(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    while normalized.ends_with('/') && normalized.len() > 1 {
        normalized.pop();
    }
    #[cfg(windows)]
    {
        normalized = normalized.to_ascii_lowercase();
    }
    normalized
}

fn is_path_in_workspace(cwd: &str, file_path: &str) -> bool {
    if cwd.trim().is_empty() || file_path.trim().is_empty() {
        return false;
    }
    let resolved = resolve_path(cwd, file_path);
    let cwd_key = normalize_path_key(cwd);
    let file_key = normalize_path_key(&resolved);
    if file_key == cwd_key {
        return true;
    }
    file_key.starts_with(&format!("{}/", cwd_key))
}

fn count_diff_lines(old_content: &str, new_content: &str) -> (u64, u64) {
    let diff = TextDiff::from_lines(old_content, new_content);
    let mut additions = 0;
    let mut deletions = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => deletions += 1,
            ChangeTag::Equal => {}
        }
    }
    (additions, deletions)
}

fn finalize_diff_entry(
    cwd: &str,
    file: String,
    before: String,
    after: String,
    patch: Option<String>,
) -> Option<Value> {
    if !is_path_in_workspace(cwd, &file) {
        return None;
    }
    let (additions, deletions) = count_diff_lines(&before, &after);
    if additions == 0 && deletions == 0 {
        return None;
    }
    let mut entry = json!({
        "file": file,
        "before": before,
        "after": after,
        "additions": additions,
        "deletions": deletions,
    });
    if let Some(patch) = patch {
        if let Some(object) = entry.as_object_mut() {
            object.insert("patch".to_string(), json!(patch));
        }
    }
    Some(entry)
}

fn snapshot_content(
    snapshots: &std::collections::HashMap<String, Value>,
    snapshots_by_tool: &std::collections::HashMap<String, Value>,
    file_path: &str,
    tool_use_id: Option<&str>,
) -> String {
    if let Some(tool_use_id) = tool_use_id {
        if let Some(snapshot) = snapshots_by_tool.get(tool_use_id) {
            return read_string(snapshot, "content").unwrap_or_default();
        }
    }
    let resolved = resolve_path("", file_path);
    snapshots
        .get(&resolved)
        .or_else(|| {
            snapshots
                .iter()
                .find(|(key, _)| key.ends_with(file_path) || file_path.ends_with(key.as_str()))
                .map(|(_, value)| value)
        })
        .and_then(|snapshot| read_string(snapshot, "content"))
        .unwrap_or_default()
}

fn extract_patch_text(input: &Value) -> Option<String> {
    if let Some(direct) = read_string(input, "input") {
        if direct.contains("*** Begin Patch") {
            return Some(direct);
        }
    }
    input.as_object().and_then(|object| {
        object.values().find_map(|value| {
            value
                .as_str()
                .filter(|text| text.contains("*** Begin Patch"))
                .map(str::to_string)
        })
    })
}

fn extract_patch_changes(input: &Value) -> Option<Vec<Value>> {
    input
        .get("changes")
        .and_then(Value::as_array)
        .cloned()
        .filter(|changes| !changes.is_empty())
}

fn diff_from_change(cwd: &str, change: &Value) -> Option<Value> {
    let path = read_string(change, "path")?;
    let file = resolve_path(cwd, &path);
    if !is_path_in_workspace(cwd, &file) {
        return None;
    }
    let diff = read_string(change, "diff").unwrap_or_default();
    if diff.is_empty() {
        return None;
    }
    let kind = read_string(change, "kind").unwrap_or_default().to_ascii_lowercase();
    if kind == "add" {
        let stats = count_diff_lines("", &diff);
        return Some(json!({
            "file": file,
            "after": diff,
            "additions": stats.0,
            "deletions": stats.1,
        }));
    }
    if kind == "delete" {
        let stats = count_diff_lines(&diff, "");
        return Some(json!({
            "file": file,
            "before": diff,
            "after": "",
            "additions": stats.0,
            "deletions": stats.1,
        }));
    }

    let mut before_lines = Vec::new();
    let mut after_lines = Vec::new();
    for line in diff.lines() {
        if line.starts_with('-') && !line.starts_with("---") {
            before_lines.push(&line[1..]);
        } else if line.starts_with('+') && !line.starts_with("+++") {
            after_lines.push(&line[1..]);
        }
    }
    if !before_lines.is_empty() || !after_lines.is_empty() {
        let before = before_lines.join("\n");
        let after = after_lines.join("\n");
        let stats = count_diff_lines(&before, &after);
        return Some(json!({
            "file": file,
            "patch": diff,
            "before": before,
            "after": after,
            "additions": stats.0,
            "deletions": stats.1,
        }));
    }

    let stats = count_diff_lines("", &diff);
    Some(json!({
        "file": file,
        "after": diff,
        "additions": stats.0,
        "deletions": stats.1,
    }))
}

fn diffs_from_freeform_patch(cwd: &str, patch_text: &str) -> Vec<Value> {
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();

    let flush = |entries: &mut Vec<Value>, path: &Option<String>, lines: &mut Vec<String>| {
        let Some(path) = path.clone() else {
            lines.clear();
            return;
        };
        let file = resolve_path(cwd, &path);
        if !is_path_in_workspace(cwd, &file) {
            lines.clear();
            return;
        }
        let mut before_lines = Vec::new();
        let mut after_lines = Vec::new();
        for line in lines.iter() {
            if line.starts_with('-') && !line.starts_with("---") {
                before_lines.push(line[1..].to_string());
            } else if line.starts_with('+') && !line.starts_with("+++") {
                after_lines.push(line[1..].to_string());
            }
        }
        let before = before_lines.join("\n");
        let after = after_lines.join("\n");
        let stats = count_diff_lines(&before, &after);
        entries.push(json!({
            "file": file,
            "before": before,
            "after": after,
            "additions": stats.0,
            "deletions": stats.1,
        }));
        lines.clear();
    };

    for line in patch_text.lines() {
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            flush(&mut entries, &current_path, &mut current_lines);
            current_path = Some(path.to_string());
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            flush(&mut entries, &current_path, &mut current_lines);
            current_path = Some(path.to_string());
            continue;
        }
        if line.starts_with("***") || line.starts_with("@@") {
            continue;
        }
        if current_path.is_some() {
            current_lines.push(line.to_string());
        }
    }
    flush(&mut entries, &current_path, &mut current_lines);
    entries
}

#[cfg(test)]
mod tests {
    use super::inject_turn_artifact_summaries;
    use serde_json::{json, Value};

    #[test]
    fn injects_session_summary_before_turn_finished_for_apply_patch_history() {
        let mut events = vec![
            json!({
                "type": "user_message",
                "session_id": "session-1",
                "content": "patch readme",
            }),
            json!({
                "type": "tool_started",
                "session_id": "session-1",
                "tool_use_id": "patch-1",
                "name": "apply_patch",
                "input": {
                    "input": "*** Begin Patch\n*** Update File: README.md\n-old\n+new\n*** End Patch"
                },
            }),
            json!({
                "type": "tool_finished",
                "session_id": "session-1",
                "tool_use_id": "patch-1",
                "is_error": false,
                "content": "Success",
            }),
            json!({
                "type": "turn_finished",
                "session_id": "session-1",
                "outcome": "interrupted",
            }),
        ];

        inject_turn_artifact_summaries(&mut events);

        let summary_index = events
            .iter()
            .position(|event| event.get("subtype").and_then(|value| value.as_str()) == Some("session_summary"))
            .expect("summary should be injected");
        let turn_finished_index = events
            .iter()
            .position(|event| event.get("type").and_then(|value| value.as_str()) == Some("turn_finished"))
            .expect("turn finished should remain");
        assert!(summary_index < turn_finished_index);
    }

    #[test]
    fn backfill_is_idempotent_when_summary_already_present() {
        let mut events = vec![
            json!({
                "type": "user_message",
                "session_id": "session-1",
                "content": "patch readme",
            }),
            json!({
                "type": "tool_started",
                "session_id": "session-1",
                "tool_use_id": "write-1",
                "name": "Write",
                "input": { "file_path": "README.md", "content": "hello\n" },
            }),
            json!({
                "type": "tool_finished",
                "session_id": "session-1",
                "tool_use_id": "write-1",
                "is_error": false,
                "content": "Success",
            }),
            json!({
                "type": "system_event",
                "subtype": "session_summary",
                "session_id": "session-1",
                "diffs": [{ "file": "./README.md", "before": "", "after": "hello\n", "additions": 1, "deletions": 0 }],
            }),
            json!({
                "type": "turn_finished",
                "session_id": "session-1",
                "outcome": "completed",
            }),
        ];

        assert!(!super::backfill_turn_artifact_summaries(&mut events));
        assert_eq!(super::count_session_summaries(&events), 1);
    }

    #[test]
    fn backfill_injects_missing_summary_for_write_turn() {
        let mut events = vec![
            json!({
                "type": "user_message",
                "session_id": "session-1",
                "content": "write file",
            }),
            json!({
                "type": "tool_started",
                "session_id": "session-1",
                "tool_use_id": "write-1",
                "name": "Write",
                "input": {
                    "file_path": "README.md",
                    "content": "hello",
                },
            }),
            json!({
                "type": "tool_finished",
                "session_id": "session-1",
                "tool_use_id": "write-1",
                "is_error": false,
                "content": "Success",
            }),
            json!({
                "type": "assistant_message",
                "session_id": "session-1",
                "content": [{ "type": "text", "text": "done" }],
            }),
        ];

        assert!(super::backfill_turn_artifact_summaries(&mut events));
        assert_eq!(super::count_session_summaries(&events), 1);
    }

    #[test]
    fn matches_edit_old_string_against_crlf_file_snapshots() {
        let mut events = vec![
            json!({
                "type": "system_event",
                "subtype": "init",
                "session_id": "session-1",
                "cwd": "D:/project/demo",
            }),
            json!({
                "type": "file_snapshot",
                "session_id": "session-1",
                "file_path": "D:/project/demo/src/orderCompleteProcess.vue",
                "original_content": "<template>\r\n  <view>old</view>\r\n</template>\r\n",
                "is_new": false,
                "tool_use_id": "edit-crlf",
            }),
            json!({
                "type": "tool_started",
                "session_id": "session-1",
                "tool_use_id": "edit-crlf",
                "name": "Edit",
                "input": {
                    "filePath": "src/orderCompleteProcess.vue",
                    "oldString": "<template>\n  <view>old</view>\n</template>",
                    "newString": "<template>\n  <view>new</view>\n</template>",
                },
            }),
            json!({
                "type": "tool_finished",
                "session_id": "session-1",
                "tool_use_id": "edit-crlf",
                "is_error": false,
                "content": "Success",
            }),
            json!({
                "type": "turn_finished",
                "session_id": "session-1",
                "outcome": "completed",
            }),
        ];

        inject_turn_artifact_summaries(&mut events);
        let summary = events
            .iter()
            .find(|event| event.get("subtype").and_then(|value| value.as_str()) == Some("session_summary"))
            .expect("summary should be injected");
        let diffs = summary.get("diffs").and_then(Value::as_array).expect("diffs array");
        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].get("file").and_then(Value::as_str),
            Some("D:/project/demo/src/orderCompleteProcess.vue")
        );
        assert_eq!(diffs[0].get("additions").and_then(Value::as_u64), Some(1));
        assert_eq!(diffs[0].get("deletions").and_then(Value::as_u64), Some(1));
    }

    #[test]
    fn ignores_files_outside_workspace_cwd() {
        let mut events = vec![
            json!({
                "type": "system_event",
                "subtype": "init",
                "session_id": "session-1",
                "cwd": "D:/project/demo",
            }),
            json!({
                "type": "user_message",
                "session_id": "session-1",
                "content": "write outside file",
            }),
            json!({
                "type": "tool_started",
                "session_id": "session-1",
                "tool_use_id": "write-1",
                "name": "Write",
                "input": {
                    "file_path": "D:/other/project/outside.ts",
                    "content": "export {}\n",
                },
            }),
            json!({
                "type": "tool_finished",
                "session_id": "session-1",
                "tool_use_id": "write-1",
                "is_error": false,
                "content": "Success",
            }),
            json!({
                "type": "turn_finished",
                "session_id": "session-1",
                "outcome": "completed",
            }),
        ];

        inject_turn_artifact_summaries(&mut events);
        assert_eq!(super::count_session_summaries(&events), 0);
    }
}
