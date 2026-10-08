use serde_json::{json, Value};
use similar::{ChangeTag, TextDiff};

pub(crate) fn inject_turn_artifact_summaries(events: &mut Vec<Value>) {
    if events.is_empty() {
        return;
    }

    let cwd = extract_working_directory(events).unwrap_or_else(|| ".".to_string());
    let mut output = Vec::new();
    let mut accumulator = TurnArtifactAccumulator::new(cwd);
    let mut turn_has_summary = false;
    // 是否处在一轮中间（还没见 turn_finished）。
    // 初值为 true：一段事件切片可能从轮中间开始（分页/增量加载，或流被截断），
    // 此时没有 user_message 也没有 turn_finished，但残余汇总仍然要补发。
    // 补发必须同时满足「轮还没收尾」和「这一轮还没有产物事件」：缺少前者时，
    // 一段已经正常收尾、且已经有产物事件的轮次会在流末尾再补发一张，于是同一轮
    // 挂出两张卡片 —— 这正是本功能要消灭的那个问题，而加载历史这条路径上它会
    // 自己制造重复（库里已经存着实时写入的那张）。
    let mut turn_open = true;
    let mut session_id = String::new();

    for event in events.drain(..) {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(id) = event.get("session_id").and_then(Value::as_str) {
            session_id = id.to_string();
        }

        if event_type == "user_message" {
            // 新的一轮（一条 User Message）：先为上一轮残余（被中断、没有
            // turn_finished 的流）补发汇总，再重置基线。
            if turn_open && !turn_has_summary {
                if let Some(summary) = accumulator.summary(&session_id) {
                    output.push(summary);
                }
            }
            accumulator.reset();
            turn_has_summary = false;
            turn_open = true;
        }

        if event_type == "system_event"
            && event.get("subtype").and_then(Value::as_str) == Some("session_summary")
        {
            turn_has_summary = true;
        }

        accumulator.observe(&event);

        if event_type == "turn_finished" {
            // 产物汇总按「轮」累积：turn_finished 只发射当前累计、不清空，
            // 因此一个 send 内的多次内部收尾各自携带着整轮基线的最新快照，
            // 前端按文件取最新即得整轮净变化。summary 必须先于 turn_finished。
            if !turn_has_summary {
                if let Some(summary) = accumulator.summary(&session_id) {
                    output.push(summary);
                }
            }
            turn_has_summary = false;
            turn_open = false;
        }
        output.push(event);
    }

    // 流末尾残余：轮没有以 turn_finished 结束（进程中断等）。
    if turn_open && !turn_has_summary {
        if let Some(summary) = accumulator.summary(&session_id) {
            output.push(summary);
        }
    }
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
        event.get("cwd").and_then(Value::as_str).map(str::to_string)
    })
}

/// 累积一个「轮」（一条 User Message 到下一条之间）的产物状态。
///
/// 与 sidecar 的 TypeScript 聚合器同构：跨内部 turn 持有文件基线与待定工具，
/// 每次 `summary` 发射整轮累计（不重置），重置由下一轮的 user_message 驱动。
/// 一个文件在本轮里的起点内容与当前内容。
///
/// 需要它是因为一轮可以多次改同一个文件，而 `edit` 只带 hunk
/// （`old_string`/`new_string`），不带它所作用的正文。没有这份状态时每个 hunk
/// 都会去套「本轮开始时的快照」，于是同一文件的第二次编辑匹配不上、被静默丢弃，
/// 卡片停留在第一次编辑的中间态。
#[derive(Clone)]
struct FileRoundState {
    /// 本轮开始时该文件的内容，即卡片的 `before`。
    baseline: String,
    /// 已应用的改动之后的内容，即卡片的 `after`。
    current: String,
}

struct TurnArtifactAccumulator {
    cwd: String,
    files: std::collections::BTreeMap<String, Value>,
    snapshots: std::collections::HashMap<String, Value>,
    snapshots_by_tool: std::collections::HashMap<String, Value>,
    pending: std::collections::HashMap<String, PendingTool>,
    file_states: std::collections::HashMap<String, FileRoundState>,
    dirty: bool,
}

impl TurnArtifactAccumulator {
    fn new(cwd: String) -> Self {
        Self {
            cwd,
            files: std::collections::BTreeMap::new(),
            snapshots: std::collections::HashMap::new(),
            snapshots_by_tool: std::collections::HashMap::new(),
            pending: std::collections::HashMap::new(),
            file_states: std::collections::HashMap::new(),
            dirty: false,
        }
    }

    fn observe(&mut self, event: &Value) {
        match event.get("type").and_then(Value::as_str) {
            Some("file_snapshot") => self.observe_file_snapshot(event),
            Some("tool_started") => self.observe_tool_started(event),
            Some("tool_finished") => self.finish_tool(event),
            _ => {}
        }
    }

    /// 发射当前累计；自上次发射以来没有新的落盘变更时返回 None。
    /// 刻意不重置状态（理由见 `inject_turn_artifact_summaries`）。
    fn summary(&mut self, session_id: &str) -> Option<Value> {
        if !self.dirty || self.files.is_empty() {
            return None;
        }
        self.dirty = false;
        Some(json!({
            "type": "system_event",
            "subtype": "session_summary",
            "session_id": session_id,
            "diffs": self.files.values().cloned().collect::<Vec<_>>(),
        }))
    }

    fn reset(&mut self) {
        self.files.clear();
        self.snapshots.clear();
        self.snapshots_by_tool.clear();
        self.pending.clear();
        self.file_states.clear();
        self.dirty = false;
    }

    /// 套用所有能匹配上的 hunk，返回是否有任何一个套上了。
    fn apply_hunks(content: &str, hunks: &[(String, String)]) -> (bool, String) {
        let mut result = content.to_string();
        let mut applied = false;
        for (old_string, new_string) in hunks {
            let normalized_old = normalize_line_endings(old_string);
            let normalized_new = normalize_line_endings(new_string);
            if let Some(index) = result.find(&normalized_old) {
                result.replace_range(index..index + normalized_old.len(), &normalized_new);
                applied = true;
            }
        }
        (applied, result)
    }

    /// 把一次文件改动记成 `baseline → current`，卡片因此永远反映整轮净变化，
    /// 而不是某个中间态。
    ///
    /// 一轮结束时回到起点的文件会从卡片上撤下（净零过滤），包括先前已经被放上去
    /// 的情况 —— 这是「没有成功变更的轮次不产出卡片」这条规则，必须在这里执行，
    /// 而不能只在条目第一次生成时判一次。
    fn record_mutation(&mut self, file: String, baseline: String, current: String) {
        self.file_states.insert(
            file.clone(),
            FileRoundState {
                baseline: baseline.clone(),
                current: current.clone(),
            },
        );
        match finalize_diff_entry(file.clone(), baseline, current, None) {
            Some(entry) => {
                self.files.insert(file, entry);
                self.dirty = true;
            }
            None => {
                self.files.remove(&file);
            }
        }
    }

    fn observe_file_snapshot(&mut self, event: &Value) {
        let Some(file_path) = read_string(event, "file_path") else {
            return;
        };
        let snapshot = json!({
            "content": read_string(event, "original_content").unwrap_or_default(),
            "is_new": event.get("is_new").and_then(Value::as_bool).unwrap_or(false),
        });
        // 首个快照胜出：它是本轮基线，后续同文件快照不能把基线挪到轮中状态。
        let normalized = resolve_path(&self.cwd, &file_path);
        self.snapshots
            .entry(normalized)
            .or_insert_with(|| snapshot.clone());
        if let Some(tool_use_id) = read_string(event, "tool_use_id") {
            self.snapshots_by_tool.insert(tool_use_id, snapshot);
        }
    }

    fn observe_tool_started(&mut self, event: &Value) {
        let Some(tool_use_id) = read_string(event, "tool_use_id") else {
            return;
        };
        let raw_name = read_string(event, "name").unwrap_or_default();
        let input = event.get("input").cloned().unwrap_or_else(|| json!({}));
        match mutation_kind(&raw_name) {
            Some(MutationKind::ApplyPatch) => {
                self.pending.insert(
                    tool_use_id,
                    PendingTool::ApplyPatch {
                        patch_text: extract_patch_text(&input),
                        changes: extract_patch_changes(&input),
                    },
                );
            }
            Some(MutationKind::Write) => {
                if let (Some(file_path), Some(content)) = (
                    find_path_deep(&input),
                    find_string_deep(&input, &["content", "file_text", "text"]),
                ) {
                    self.pending
                        .insert(tool_use_id, PendingTool::Write { file_path, content });
                }
            }
            Some(MutationKind::Edit) => {
                if let (Some(file_path), Some(hunks)) =
                    (find_path_deep(&input), extract_edit_hunks(&input))
                {
                    self.pending
                        .insert(tool_use_id, PendingTool::Edit { file_path, hunks });
                }
            }
            None => {}
        }
    }

    fn finish_tool(&mut self, event: &Value) {
        if event
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return;
        }
        let Some(tool_use_id) = read_string(event, "tool_use_id") else {
            return;
        };
        let Some(pending_tool) = self.pending.remove(&tool_use_id) else {
            return;
        };
        match pending_tool {
            PendingTool::ApplyPatch {
                patch_text,
                changes,
            } => {
                if let Some(change_entries) = changes {
                    for change in change_entries {
                        if let Some(entry) = diff_from_change(&self.cwd, &change) {
                            let file = read_string(&entry, "file").unwrap_or_default();
                            self.record_patch_entry(file, entry);
                        }
                    }
                } else if let Some(patch_text) = patch_text {
                    for entry in diffs_from_freeform_patch(&self.cwd, &patch_text) {
                        let file = read_string(&entry, "file").unwrap_or_default();
                        self.record_patch_entry(file, entry);
                    }
                }
            }
            PendingTool::Write { file_path, content } => {
                let resolved = resolve_path(&self.cwd, &file_path);
                // 写入是整文件替换：基线取本轮起点，结果取本次调用的正文。
                let baseline = self
                    .file_states
                    .get(&resolved)
                    .map(|state| state.baseline.clone())
                    .unwrap_or_else(|| {
                        snapshot_content(
                            &self.cwd,
                            &self.snapshots,
                            &self.snapshots_by_tool,
                            &file_path,
                            Some(&tool_use_id),
                        )
                    });
                self.record_mutation(resolved, baseline, content);
            }
            PendingTool::Edit { file_path, hunks } => {
                let resolved = resolve_path(&self.cwd, &file_path);
                let snapshot = snapshot_content(
                    &self.cwd,
                    &self.snapshots,
                    &self.snapshots_by_tool,
                    &file_path,
                    Some(&tool_use_id),
                );
                let state = self.file_states.get(&resolved).cloned();
                let (applied, baseline, current) = if let Some(state) = state {
                    // 本轮对该文件的第二次及以后的编辑：hunk 是针对本轮已经产出的
                    // 内容，而不是针对本轮起点的快照。
                    let (applied, current) =
                        Self::apply_hunks(&normalize_line_endings(&state.current), &hunks);
                    (applied, state.baseline, current)
                } else if !snapshot.is_empty() {
                    let normalized_snapshot = normalize_line_endings(&snapshot);
                    let (applied, current) = Self::apply_hunks(&normalized_snapshot, &hunks);
                    (applied, normalized_snapshot, current)
                } else if !hunks.is_empty() {
                    // 退化基线：没有快照（原生会话同步一律没有，pi 也从不产生），
                    // 前后正文只能由 hunk 自身拼出。
                    let baseline = hunks
                        .iter()
                        .map(|(old_string, _)| normalize_line_endings(old_string))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let current = hunks
                        .iter()
                        .map(|(_, new_string)| normalize_line_endings(new_string))
                        .collect::<Vec<_>>()
                        .join("\n");
                    (true, baseline, current)
                } else {
                    (false, String::new(), String::new())
                };
                if applied {
                    self.record_mutation(resolved, baseline, current);
                }
            }
        }
    }

    /// 补丁条目自带前后正文，保持其原有形状（卡片会渲染 `patch`）；同时记录本轮
    /// 状态，使本轮里随后对该文件的编辑/写入仍然以本轮起点为基线。
    fn record_patch_entry(&mut self, file: String, entry: Value) {
        self.file_states.insert(
            file.clone(),
            FileRoundState {
                baseline: read_string(&entry, "before").unwrap_or_default(),
                current: read_string(&entry, "after").unwrap_or_default(),
            },
        );
        self.files.insert(file, entry);
        self.dirty = true;
    }
}

/// 兼容入口：把一段事件切片视作一个完整的轮，返回其累计汇总。
/// 注入主路径走 [`inject_turn_artifact_summaries`] 的增量累积；
/// 这个包装供共享 fixture 与既有单测直接调用，因此只在测试构建里存在。
#[cfg(test)]
fn build_turn_summary(events: &[Value], cwd: &str) -> Option<Value> {
    let mut accumulator = TurnArtifactAccumulator::new(cwd.to_string());
    let mut session_id = String::new();
    for event in events {
        if let Some(id) = event.get("session_id").and_then(Value::as_str) {
            session_id = id.to_string();
        }
        accumulator.observe(event);
    }
    accumulator.summary(&session_id)
}

enum PendingTool {
    Write {
        file_path: String,
        content: String,
    },
    Edit {
        file_path: String,
        hunks: Vec<(String, String)>,
    },
    ApplyPatch {
        patch_text: Option<String>,
        changes: Option<Vec<Value>>,
    },
}

/// Canonical write-operation kinds. Mirrors the sidecar's `MutationKind`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum MutationKind {
    Write,
    Edit,
    ApplyPatch,
}

/// Nested carriers seen in the wild: Codex puts a freeform patch under `input`,
/// some agents wrap arguments in `arguments` / `params` / `payload`.
const NESTED_PAYLOAD_KEYS: [&str; 4] = ["input", "arguments", "params", "payload"];

/// `notebook_path` is deliberately absent — notebook tooling is out of scope.
const PATH_KEYS: [&str; 6] = [
    "file_path",
    "filePath",
    "path",
    "target_file",
    "targetFile",
    "filename",
];

const MAX_SEARCH_DEPTH: usize = 6;

/// Normalizes a raw tool name so spelling differences collapse: lowercased,
/// `-` and whitespace to `_`, parentheses dropped. Prefix-agnostic, so
/// `mcp__fs__write_file` canonicalizes to `mcp__fs__write_file` and is resolved
/// by suffix in [`mutation_kind`].
fn canonicalize_tool_name(name: &str) -> String {
    let lowered = name.trim().to_ascii_lowercase();
    let without_parens = lowered.replace(['(', ')'], "");
    let mut normalized = String::with_capacity(without_parens.len());
    let mut previous_was_separator = false;
    for character in without_parens.chars() {
        if character.is_whitespace() || character == '-' {
            if !previous_was_separator {
                normalized.push('_');
                previous_was_separator = true;
            }
            continue;
        }
        previous_was_separator = false;
        normalized.push(character);
    }
    normalized
}

/// Resolves a raw tool name to a canonical write kind, or `None` when the tool is
/// not a file mutation.
///
/// Case-insensitive by construction: the native-history path passes provider tool
/// names through verbatim (uppercase for one Agent Kind, lowercase for another), so
/// a case-sensitive check would silently disable artifact summaries for every
/// imported session. The alias table must stay identical to `toolNames.canonical`
/// in the shared fixture — `toolNamesConformance` in the sidecar asserts they agree.
fn mutation_kind(name: &str) -> Option<MutationKind> {
    let canonical = canonicalize_tool_name(name);
    if let Some(kind) = alias_kind(&canonical) {
        return Some(kind);
    }
    // Host-prefixed forms: `mcp__<server>__write_file`, `<server>/write_file`,
    // `<server>.write_file`. Try every suffix that starts after a separator run,
    // so a third-party MCP write tool is recognized whatever the prefix spelling.
    let bytes = canonical.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        let is_separator = !byte.is_ascii_alphanumeric();
        if !is_separator {
            continue;
        }
        let suffix = &canonical[index + 1..];
        if suffix.is_empty() {
            continue;
        }
        if let Some(kind) = alias_kind(suffix) {
            return Some(kind);
        }
    }
    None
}

fn alias_kind(canonical: &str) -> Option<MutationKind> {
    match canonical {
        "write" | "write_file" | "writefile" | "write_to_file" | "create_file" | "save_file" => {
            Some(MutationKind::Write)
        }
        "edit" | "edit_file" | "editfile" | "update_file" | "replace_in_file" | "str_replace"
        | "multiedit" | "multi_edit" | "batch_edit" => Some(MutationKind::Edit),
        "apply_patch" | "applypatch" | "patch" | "apply_diff" => Some(MutationKind::ApplyPatch),
        _ => None,
    }
}

/// Reads a string field, preferring the top level and then descending through the
/// known envelope keys.
///
/// Needed because the same logical argument is passed directly by one source and
/// wrapped (`input` / `arguments` / `params` / `payload`) by another — reading only
/// the top level silently dropped those mutations. The sidecar applies the same
/// rule; a shared-fixture case pins it.
fn find_string_deep(value: &Value, keys: &[&str]) -> Option<String> {
    find_string_deep_at(value, keys, 0)
}

fn find_string_deep_at(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
    if depth > MAX_SEARCH_DEPTH {
        return None;
    }
    let object = value.as_object()?;
    for key in keys {
        if let Some(found) = object.get(*key).and_then(Value::as_str) {
            return Some(found.to_string());
        }
    }
    for nested in NESTED_PAYLOAD_KEYS {
        if let Some(found) = object
            .get(nested)
            .and_then(|inner| find_string_deep_at(inner, keys, depth + 1))
        {
            return Some(found);
        }
    }
    None
}

/// Finds the first file path a tool call touched, looking through the same
/// envelope keys as [`find_string_deep`]. A multi-file `changes` payload keeps its
/// paths as object keys, so those are consulted too.
fn find_path_deep(value: &Value) -> Option<String> {
    let mut found: Vec<String> = Vec::new();
    collect_paths_deep(value, 0, &mut found);
    found.into_iter().next()
}

fn collect_paths_deep(value: &Value, depth: usize, found: &mut Vec<String>) {
    if depth > MAX_SEARCH_DEPTH {
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                collect_paths_deep(item, depth + 1, found);
            }
        }
        Value::Object(object) => {
            for key in PATH_KEYS {
                if let Some(candidate) = object.get(key).and_then(Value::as_str) {
                    if !candidate.trim().is_empty() {
                        found.push(candidate.trim().to_string());
                    }
                }
            }
            if let Some(changes) = object.get("changes").and_then(Value::as_object) {
                for key in changes.keys() {
                    if !key.trim().is_empty() {
                        found.push(key.trim().to_string());
                    }
                }
            }
            for nested in NESTED_PAYLOAD_KEYS {
                if let Some(inner) = object.get(nested) {
                    collect_paths_deep(inner, depth + 1, found);
                }
            }
        }
        _ => {}
    }
}

fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn read_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Normalizes an edit tool's hunks. Handles pi's `{ edits: [{ oldText, newText }] }`
/// shape alongside the flat `old_string`/`new_string` (Claude/OpenCode) shape, and
/// looks through the same envelope keys as path extraction so a wrapped payload is
/// recognized too.
fn extract_edit_hunks(input: &Value) -> Option<Vec<(String, String)>> {
    if let Some(hunks) = parse_edit_hunks(input) {
        return Some(hunks);
    }
    for nested in NESTED_PAYLOAD_KEYS {
        if let Some(inner) = input.get(nested) {
            if let Some(hunks) = extract_edit_hunks(inner) {
                return Some(hunks);
            }
        }
    }
    None
}

fn parse_edit_hunks(input: &Value) -> Option<Vec<(String, String)>> {
    if let Some(edits) = input.get("edits").and_then(Value::as_array) {
        let mut hunks = Vec::new();
        for entry in edits {
            let old_string = read_string(entry, "oldText")
                .or_else(|| read_string(entry, "old_string"))
                .or_else(|| read_string(entry, "oldString"));
            let new_string = read_string(entry, "newText")
                .or_else(|| read_string(entry, "new_string"))
                .or_else(|| read_string(entry, "newString"));
            if let (Some(old_string), Some(new_string)) = (old_string, new_string) {
                hunks.push((old_string, new_string));
            }
        }
        if !hunks.is_empty() {
            return Some(hunks);
        }
    }

    let old_string =
        read_string(input, "old_string").or_else(|| read_string(input, "oldString"))?;
    let new_string =
        read_string(input, "new_string").or_else(|| read_string(input, "newString"))?;
    Some(vec![(old_string, new_string)])
}

fn resolve_path(cwd: &str, raw_path: &str) -> String {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    // `D:/x` 与 `D:\x` 都算绝对路径。只认反斜杠会让前斜杠形态的 Windows 绝对路径
    // 被当成相对路径、在前面又拼一次 cwd，产物条目的 file 就成了重复路径
    // （Codex、pi、OpenCode 三条来源都可能给出前斜杠形态）。
    if trimmed.starts_with('/') || is_windows_absolute(trimmed) {
        return trimmed.replace('\\', "/");
    }
    // cwd 也要一并做斜杠归一：会话的工作目录常常是 `D:\project\x` 形态，而工具入参
    // 给的是相对路径，直接拼接会产出 `D:\project\x/src/app.ts` 这种混合拼写。卡片按
    // file 去重，同一条会话在实时（TypeScript，统一成前斜杠）与刷新后（这里）就会
    // 被当成两个不同文件，同一个文件出现两条。
    let base = cwd.replace('\\', "/");
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        trimmed.replace('\\', "/")
    )
}

fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() > 2
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && bytes[0].is_ascii_alphabetic()
}

/// Counts added/removed lines with the SAME semantics as the sidecar's
/// TypeScript implementation, because the two must agree: the sidecar computes
/// these numbers live and the frontend recomputes them on every render, so a
/// divergence means one logical change shows two different figures depending on
/// where you look.
///
/// The shared semantics: split on `\n`, **drop the final empty element**, then
/// diff the resulting line *contents*. Two consequences that `similar`'s own
/// text diff does not give us for free, and that cost real user-visible
/// divergence before this was fixed:
///
/// 1. the presence or absence of a trailing newline is not itself a change;
/// 2. a line terminator is not part of a line's identity, so `"a"` and `"a\n"`
///    are the same line — `similar` compares `&str` elements *including* their
///    terminators, so it would report that as one insertion plus one deletion.
///
/// Normalizing both sides to newline-terminated lines makes `similar` diff line
/// contents, which is what the TypeScript side does.
///
/// Known remaining divergence, deliberately not fixed here and recorded in the
/// shared fixture: a CRLF <-> LF whole-file conversion counts as a full-file
/// change on both sides; and for genuinely ambiguous inputs the two libraries'
/// differ engines may pick different (equally minimal) edit scripts.
fn count_diff_lines(old_content: &str, new_content: &str) -> (u64, u64) {
    let old_normalized = normalize_lines_for_diff(old_content);
    let new_normalized = normalize_lines_for_diff(new_content);
    let diff = TextDiff::from_lines(old_normalized.as_str(), new_normalized.as_str());
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

/// Splits on `\n`, drops the final empty element, and re-joins with `\n` so that
/// every line carries a terminator. `"a\n"` -> `"a\n"`, `"a\nb"` -> `"a\nb\n"`,
/// `"a\nb\n"` -> `"a\nb\n"`, `""` -> `""`.
///
/// The empty input keeps its own branch: `""` has no lines, so it must stay
/// empty rather than normalize into a single blank line.
fn normalize_lines_for_diff(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let without_final_newline = value.strip_suffix('\n').unwrap_or(value);
    let mut normalized = String::with_capacity(without_final_newline.len() + 1);
    normalized.push_str(without_final_newline);
    normalized.push('\n');
    normalized
}

fn finalize_diff_entry(
    file: String,
    before: String,
    after: String,
    patch: Option<String>,
) -> Option<Value> {
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
    cwd: &str,
    snapshots: &std::collections::HashMap<String, Value>,
    snapshots_by_tool: &std::collections::HashMap<String, Value>,
    file_path: &str,
    tool_use_id: Option<&str>,
) -> String {
    // 顺序很重要：先按文件找本轮快照，再退到按工具调用找。
    //
    // 按文件存的快照是本轮第一次改动该文件时的内容，也就是卡片要的「整轮基线」；
    // 按工具调用存的是紧随本次编辑之前那一帧的内容，是轮中状态。先查后者会让
    // 同一轮里对同一文件的第二次及以后的编辑把基线挪到轮中，卡片于是只报最后
    // 一次编辑的局部变化（实测：一个 25 次编辑的真实轮次报 119/2，而整轮净变化
    // 是 120/2 加前面的累计）。TypeScript 侧同样是「先文件、后工具」。
    for candidate in [resolve_path(cwd, file_path), resolve_path("", file_path)] {
        if let Some(snapshot) = snapshots.get(&candidate) {
            return read_string(snapshot, "content").unwrap_or_default();
        }
    }
    if let Some(tool_use_id) = tool_use_id {
        if let Some(snapshot) = snapshots_by_tool.get(tool_use_id) {
            return read_string(snapshot, "content").unwrap_or_default();
        }
    }
    String::new()
}

/// Finds a freeform patch body anywhere in a tool's input.
///
/// The patch text is carried under different keys depending on the source: Codex
/// nests it under `input`, OpenCode names the key `patchText`, and some paths pass
/// it as the whole argument. Matched on the body marker rather than on a key list,
/// so a new key name does not silently drop the patch.
fn extract_patch_text(input: &Value) -> Option<String> {
    find_patch_text_deep(input, 0)
}

fn find_patch_text_deep(value: &Value, depth: usize) -> Option<String> {
    if depth > MAX_SEARCH_DEPTH {
        return None;
    }
    match value {
        Value::String(text) => text.contains("*** Begin Patch").then(|| text.to_string()),
        Value::Array(items) => items
            .iter()
            .find_map(|item| find_patch_text_deep(item, depth + 1)),
        Value::Object(object) => object
            .values()
            .find_map(|inner| find_patch_text_deep(inner, depth + 1)),
        _ => None,
    }
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
    let diff = read_string(change, "diff").unwrap_or_default();
    if diff.is_empty() {
        return None;
    }
    let kind = read_string(change, "kind")
        .unwrap_or_default()
        .to_ascii_lowercase();
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
        // 删除后没有 after 内容：空侧省略而非发 ""（与自由文本补丁路径、
        // sidecar 侧同一约定，共享 fixture 有用例钉住）。
        return Some(json!({
            "file": file,
            "before": diff,
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
    let mut current_operation = "update";
    let mut current_lines: Vec<String> = Vec::new();

    let flush = |entries: &mut Vec<Value>,
                 path: &Option<String>,
                 operation: &str,
                 lines: &mut Vec<String>| {
        let Some(path) = path.clone() else {
            lines.clear();
            return;
        };
        let file = resolve_path(cwd, &path);
        let mut before_lines = Vec::new();
        let mut after_lines = Vec::new();
        for line in lines.iter() {
            if line.starts_with('-') && !line.starts_with("---") {
                before_lines.push(line[1..].to_string());
            } else if line.starts_with('+') && !line.starts_with("+++") {
                after_lines.push(line[1..].to_string());
            }
        }
        // An Add File directive carries only `+` lines and a Delete File only `-`
        // lines; the empty side is omitted rather than emitted as "".
        let before = match operation {
            "add" => String::new(),
            _ => before_lines.join("\n"),
        };
        let after = match operation {
            "delete" => String::new(),
            _ => after_lines.join("\n"),
        };
        let stats = count_diff_lines(&before, &after);
        let mut entry = serde_json::Map::new();
        entry.insert("file".to_string(), json!(file));
        if !before.is_empty() {
            entry.insert("before".to_string(), json!(before));
        }
        if !after.is_empty() {
            entry.insert("after".to_string(), json!(after));
        }
        entry.insert("additions".to_string(), json!(stats.0));
        entry.insert("deletions".to_string(), json!(stats.1));
        entries.push(Value::Object(entry));
        lines.clear();
    };

    for line in patch_text.lines() {
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            flush(
                &mut entries,
                &current_path,
                current_operation,
                &mut current_lines,
            );
            current_path = Some(path.to_string());
            current_operation = "update";
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            flush(
                &mut entries,
                &current_path,
                current_operation,
                &mut current_lines,
            );
            current_path = Some(path.to_string());
            current_operation = "add";
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            flush(
                &mut entries,
                &current_path,
                current_operation,
                &mut current_lines,
            );
            current_path = Some(path.to_string());
            current_operation = "delete";
            continue;
        }
        if line.starts_with("***") || line.starts_with("@@") {
            continue;
        }
        if current_path.is_some() {
            current_lines.push(line.to_string());
        }
    }
    flush(
        &mut entries,
        &current_path,
        current_operation,
        &mut current_lines,
    );
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
            .position(|event| {
                event.get("subtype").and_then(|value| value.as_str()) == Some("session_summary")
            })
            .expect("summary should be injected");
        let turn_finished_index = events
            .iter()
            .position(|event| {
                event.get("type").and_then(|value| value.as_str()) == Some("turn_finished")
            })
            .expect("turn finished should remain");
        assert!(summary_index < turn_finished_index);
    }

    #[test]
    fn matches_pi_edit_path_and_edits_hunks() {
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
                "file_path": "D:/project/demo/src/app.ts",
                "original_content": "alpha\nbeta\n",
                "is_new": false,
                "tool_use_id": "edit-pi",
            }),
            json!({
                "type": "tool_started",
                "session_id": "session-1",
                "tool_use_id": "edit-pi",
                "name": "edit",
                "input": {
                    "path": "src/app.ts",
                    "edits": [{ "oldText": "alpha", "newText": "ALPHA" }],
                },
            }),
            json!({
                "type": "tool_finished",
                "session_id": "session-1",
                "tool_use_id": "edit-pi",
                "is_error": false,
                "content": "Successfully replaced 1 block(s)",
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
            .find(|event| {
                event.get("subtype").and_then(|value| value.as_str()) == Some("session_summary")
            })
            .expect("summary should be injected");
        let diffs = summary
            .get("diffs")
            .and_then(Value::as_array)
            .expect("diffs array");
        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].get("file").and_then(Value::as_str),
            Some("D:/project/demo/src/app.ts")
        );
        assert_eq!(diffs[0].get("additions").and_then(Value::as_u64), Some(1));
        assert_eq!(diffs[0].get("deletions").and_then(Value::as_u64), Some(1));
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
            .find(|event| {
                event.get("subtype").and_then(|value| value.as_str()) == Some("session_summary")
            })
            .expect("summary should be injected");
        let diffs = summary
            .get("diffs")
            .and_then(Value::as_array)
            .expect("diffs array");
        assert_eq!(diffs.len(), 1);
        assert_eq!(
            diffs[0].get("file").and_then(Value::as_str),
            Some("D:/project/demo/src/orderCompleteProcess.vue")
        );
        assert_eq!(diffs[0].get("additions").and_then(Value::as_u64), Some(1));
        assert_eq!(diffs[0].get("deletions").and_then(Value::as_u64), Some(1));
    }

    /// Conformance against the repository-level shared fixture.
    ///
    /// The same file is asserted by the sidecar (TypeScript) suite, so the two
    /// implementations of this algorithm cannot drift apart silently: whatever
    /// one side changes, the other must match, and the expected values live in
    /// exactly one place.
    mod shared_fixture {
        use std::path::{Path, PathBuf};

        use serde_json::Value;

        use super::super::{build_turn_summary, count_diff_lines};

        const FIXTURE_RELATIVE: &str = "test-data/turn-artifact-summary/cases.json";

        /// Resolve the fixture by walking up from the crate root, so the suite
        /// behaves the same no matter which directory cargo was invoked from.
        fn fixture_path() -> PathBuf {
            let mut directory = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
            for _ in 0..8 {
                let candidate = directory.join(FIXTURE_RELATIVE);
                if candidate.is_file() {
                    return candidate;
                }
                match directory.parent() {
                    Some(parent) => directory = parent.to_path_buf(),
                    None => break,
                }
            }
            panic!("shared fixture not found by walking up from CARGO_MANIFEST_DIR");
        }

        fn fixture() -> Value {
            let raw = std::fs::read_to_string(fixture_path()).expect("read shared fixture");
            serde_json::from_str(&raw).expect("parse shared fixture")
        }

        /// Project one produced entry onto the fields the fixture asserts.
        /// `patch` is deliberately dropped: the two implementations disagree
        /// about whether it is present, and it is not what the user sees.
        fn project(entry: &Value) -> Value {
            let mut projected = serde_json::Map::new();
            projected.insert(
                "file".to_string(),
                entry.get("file").cloned().unwrap_or(Value::Null),
            );
            projected.insert(
                "additions".to_string(),
                entry
                    .get("additions")
                    .cloned()
                    .unwrap_or(serde_json::json!(0)),
            );
            projected.insert(
                "deletions".to_string(),
                entry
                    .get("deletions")
                    .cloned()
                    .unwrap_or(serde_json::json!(0)),
            );
            if let Some(before) = entry.get("before").and_then(Value::as_str) {
                projected.insert("before".to_string(), Value::String(before.to_string()));
            }
            if let Some(after) = entry.get("after").and_then(Value::as_str) {
                projected.insert("after".to_string(), Value::String(after.to_string()));
            }
            Value::Object(projected)
        }

        #[test]
        fn line_count_semantics_match_the_shared_expectations() {
            let fixture = fixture();
            let cases = fixture
                .get("lineCases")
                .and_then(Value::as_array)
                .expect("lineCases");
            assert!(!cases.is_empty(), "fixture must carry line cases");

            for case in cases {
                let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
                let before = case
                    .get("before")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let after = case
                    .get("after")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let expected_additions = case
                    .get("additions")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let expected_deletions = case
                    .get("deletions")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();

                let (additions, deletions) = count_diff_lines(before, after);
                assert_eq!(
                    (additions, deletions),
                    (expected_additions, expected_deletions),
                    "line case `{name}` diverged"
                );
            }
        }

        #[test]
        fn event_sequences_match_the_shared_expectations() {
            let fixture = fixture();
            let cases = fixture
                .get("eventCases")
                .and_then(Value::as_array)
                .expect("eventCases");
            assert!(!cases.is_empty(), "fixture must carry event cases");

            for case in cases {
                let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
                let cwd = case.get("cwd").and_then(Value::as_str).unwrap_or(".");
                let events = case
                    .get("events")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let expected: Vec<Value> = case
                    .get("expectedDiffs")
                    .and_then(Value::as_array)
                    .map(|diffs| diffs.iter().map(project).collect())
                    .unwrap_or_default();

                let summary = build_turn_summary(&events, cwd);
                let produced: Vec<Value> = summary
                    .as_ref()
                    .and_then(|value| value.get("diffs"))
                    .and_then(Value::as_array)
                    .map(|diffs| diffs.iter().map(project).collect())
                    .unwrap_or_default();

                assert_eq!(produced, expected, "event case `{name}` diverged");
            }
        }

        /// Session-level conformance: how many artifact cards a sequence of turns
        /// emits. `build_turn_summary` collapses everything into one round, so
        /// these cases go through the real timeline entry point instead.
        ///
        /// The daemon learns the working directory from the timeline's own init
        /// frame (the sidecar is handed it as a parameter), so the case-level
        /// `cwd` is injected as an init frame here — that is exactly what the
        /// loader sees on a real timeline.
        #[test]
        fn session_card_counts_match_the_shared_expectations() {
            use super::super::inject_turn_artifact_summaries;

            let fixture = fixture();
            let cases = fixture
                .get("sessionCases")
                .and_then(Value::as_array)
                .expect("sessionCases");
            assert!(!cases.is_empty(), "fixture must carry session cases");

            for case in cases {
                let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
                let cwd = case.get("cwd").and_then(Value::as_str).unwrap_or(".");
                let mut events = vec![serde_json::json!({
                    "type": "system_event",
                    "subtype": "init",
                    "cwd": cwd,
                })];
                events.extend(
                    case.get("events")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                );

                inject_turn_artifact_summaries(&mut events);

                let produced: Vec<Vec<Value>> = events
                    .iter()
                    .filter(|event| {
                        event.get("type").and_then(Value::as_str) == Some("system_event")
                            && event.get("subtype").and_then(Value::as_str)
                                == Some("session_summary")
                    })
                    .map(|summary| {
                        summary
                            .get("diffs")
                            .and_then(Value::as_array)
                            .map(|diffs| diffs.iter().map(project).collect())
                            .unwrap_or_default()
                    })
                    .collect();

                let expected: Vec<Vec<Value>> = case
                    .get("expectedSummaries")
                    .and_then(Value::as_array)
                    .map(|summaries| {
                        summaries
                            .iter()
                            .map(|summary| {
                                summary
                                    .get("diffs")
                                    .and_then(Value::as_array)
                                    .map(|diffs| diffs.iter().map(project).collect())
                                    .unwrap_or_default()
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                assert_eq!(produced, expected, "session case `{name}` diverged");
            }
        }
    }
}
