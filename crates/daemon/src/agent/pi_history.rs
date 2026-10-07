//! pi native history: load pi session JSONL and convert to timeline events.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use log::{debug, info};
use serde_json::{json, Value};

use crate::config::types::AgentKind;

use super::context_usage::{ThreadTokenUsageSnapshot, TokenUsageBreakdown};
use super::history_events::{is_ask_user_question_tool_name, normalize_history_events};
use super::native_jsonl::read_json_stream_values;
use super::rewind::normalize_rewind_text;
use super::session_lifecycle::get_agent_session_id;

/// 从 pi 会话 JSONL 活动链上最后一条带 `usage` 的 assistant 消息提取上下文用量。
pub(crate) fn latest_pi_usage_from_session_values(
    raw_events: &[Value],
    freshness: &str,
) -> Option<ThreadTokenUsageSnapshot> {
    for entry in select_pi_active_chain(raw_events).into_iter().rev() {
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let message = entry.get("message")?;
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let usage = message.get("usage")?;
        let input_tokens = read_pi_usage_u64(
            usage
                .get("input")
                .or_else(|| usage.get("input_tokens"))
                .or_else(|| usage.get("inputTokens")),
        );
        let cached_input_tokens = read_pi_usage_u64(
            usage
                .get("cacheRead")
                .or_else(|| usage.get("cache_read"))
                .or_else(|| usage.get("cached_input_tokens"))
                .or_else(|| usage.get("cachedInputTokens")),
        );
        let output_tokens = read_pi_usage_u64(
            usage
                .get("output")
                .or_else(|| usage.get("output_tokens"))
                .or_else(|| usage.get("outputTokens")),
        );
        if input_tokens == 0 && cached_input_tokens == 0 && output_tokens == 0 {
            continue;
        }

        let total_tokens = input_tokens.saturating_add(cached_input_tokens);
        let breakdown = TokenUsageBreakdown {
            total_tokens,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_output_tokens: 0,
        };

        return Some(ThreadTokenUsageSnapshot {
            total: breakdown.clone(),
            last: breakdown,
            model_context_window: None,
            context_usage_source: "history_file".to_string(),
            context_usage_freshness: freshness.to_string(),
        });
    }

    None
}

fn read_pi_usage_u64(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(Value::String(text)) => text.parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

pub(crate) fn convert_pi_history_values_to_events(
    raw_events: &[Value],
    app_session_id: &str,
) -> Vec<Value> {
    let mut intermediate = Vec::new();

    for raw in select_pi_active_chain(raw_events) {
        let Some(entry_type) = raw.get("type").and_then(Value::as_str) else {
            continue;
        };

        match entry_type {
            "message" => {
                if let Some(converted) = convert_pi_message_entry(raw) {
                    intermediate.push(converted);
                }
            }
            "compaction" => {
                // pi 会话文件落盘的是 compaction 树条目（SessionEntryBase，带
                // timestamp/summary）；compaction_start/end 只是运行时事件不写文件。
                let mut boundary = json!({
                    "type": "system",
                    "subtype": "compact_boundary",
                    "content": "Conversation compacted",
                    "compact_metadata": { "trigger": "auto" },
                });
                if let Some(timestamp) = raw.get("timestamp") {
                    boundary["timestamp"] = timestamp.clone();
                }
                intermediate.push(boundary);
            }
            "compaction_end" if raw.get("aborted").and_then(Value::as_bool) != Some(true) => {
                let reason = raw.get("reason").and_then(Value::as_str).unwrap_or("auto");
                intermediate.push(json!({
                    "type": "system",
                    "subtype": "compact_boundary",
                    "content": "Conversation compacted",
                    "compact_metadata": {
                        "trigger": if reason == "manual" { "manual" } else { "auto" },
                    },
                }));
            }
            _ => {}
        }
    }

    let normalized = normalize_history_events(intermediate, app_session_id);
    let mut events = inject_pi_turn_boundaries(normalized);
    // 投影出口清洗：内部 marker 前缀（见 strip_pi_internal_markers）不得出现在历史里。
    strip_pi_internal_markers(&mut events);
    events
}

/// pi 会话文件是 `id`/`parentId` 树（`/tree` 分支后文件包含所有分支的条目），
/// 真正的"当前对话"是活动叶子到根的链。仅在条目实际使用 parentId 链接时按链
/// 选取；线性文件（无 parentId，含 v1 旧格式）返回全量线性转换。
///
/// 与 codeg 实现的取舍差异（同一份树投影，两处边界选择相反）：
/// - 成环（链上重复出现同一 id）时我们**保留已经解析出来的那段链**并终止遍历；
///   codeg 会整体放弃链退回全量线性，那会把被放弃分支交错进对话。
/// - 父条目缺失（断链）时我们退回全量线性：断链意味着文件不是 pi 写的或已损坏，
///   按链裁剪此时可能丢内容，宁可交错也不丢条目。
/// - 不参与树结构的条目（缺 `id` 或无 `parentId` 键）不按链裁剪，原样保留
///   （见 `is_detached_pi_tree_entry`）。
pub(crate) fn select_pi_active_chain(raw_events: &[Value]) -> Vec<&Value> {
    let uses_parent_links = raw_events.iter().any(|entry| {
        entry
            .get("parentId")
            .and_then(Value::as_str)
            .is_some_and(|parent| !parent.is_empty())
    });
    if !uses_parent_links {
        return raw_events.iter().collect();
    }

    let id_to_index: HashMap<&str, usize> = raw_events
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(|id| (id, index))
        })
        .collect();
    let Some(mut cursor) = raw_events
        .iter()
        .rposition(|entry| entry.get("id").and_then(Value::as_str).is_some())
    else {
        return raw_events.iter().collect();
    };

    let mut chain = vec![cursor];
    let mut visited: HashSet<usize> = HashSet::from([cursor]);
    loop {
        let parent = raw_events[cursor]
            .get("parentId")
            .and_then(Value::as_str)
            .filter(|parent| !parent.is_empty());
        let Some(parent) = parent else {
            break; // 到根，链完整
        };
        let Some(parent_index) = id_to_index.get(parent) else {
            // 父条目缺失（断链）：意味着文件不是 pi 写的或已损坏，此时按链裁剪
            // 可能丢内容，故退回全量线性（宁可交错也不丢条目）。
            return raw_events.iter().collect();
        };
        if !visited.insert(*parent_index) {
            break; // 成环：终止遍历，保留已经解析出来的那段链
        }
        chain.push(*parent_index);
        cursor = *parent_index;
    }

    // 结果按原始下标升序（文件序）返回：链上条目 + 不参与树结构的条目；
    // 其余条目属于被放弃的分支，剔除。
    let on_chain: HashSet<usize> = chain.into_iter().collect();
    raw_events
        .iter()
        .enumerate()
        .filter(|(index, entry)| on_chain.contains(index) || is_detached_pi_tree_entry(entry))
        .map(|(_, entry)| entry)
        .collect()
}

/// 是否是不参与 pi 会话树结构的条目：pi 给每个条目都写 `parentId` 键（显式
/// `null` 表示虚拟根），所以「`id` 缺失或为空」以及「没有 `parentId` 键」都说明该
/// 条目不在树里（或不是 pi 写的）。按链裁剪时这类条目必须原样保留，否则会丢内容。
fn is_detached_pi_tree_entry(entry: &Value) -> bool {
    let has_id = entry
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    let has_parent_key = entry.get("parentId").is_some();
    !has_id || !has_parent_key
}

/// CodeMUX pi 临时扩展用 title 前缀做语义标记（定义在
/// `apps/sidecar/src/piExtension.ts`：`__codemux_approve__:` 审批、`__codemux_ask__:`
/// 提问），sidecar 靠它识别扩展 UI 请求的语义。这是传输侧的内部约定：只应到达
/// 客户端，不应写回会话文件，也不该出现在投影出来的历史里。
///
/// 只剥前缀而不是丢掉整条记录：前缀通常直接贴在用户真看到过的文案前面（如
/// `__codemux_ask__:请确认`），整条丢弃会误删对话内容；剥掉前缀既隐藏实现细节
/// 又完整保留其后的可读文本。
fn strip_pi_internal_markers(events: &mut [Value]) {
    for event in events.iter_mut() {
        strip_pi_internal_markers_in_value(event);
    }
}

fn strip_pi_internal_markers_in_value(value: &mut Value) {
    match value {
        Value::String(text) => {
            if let Some(stripped) = strip_pi_marker_prefix(text) {
                *text = stripped;
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(strip_pi_internal_markers_in_value),
        Value::Object(map) => map
            .values_mut()
            .for_each(strip_pi_internal_markers_in_value),
        _ => {}
    }
}

/// 剥掉字符串开头的 CodeMUX 内部 marker 前缀（判定用 trim 后的内容，前缀前的
/// 空白原样保留），其余文本不动。
fn strip_pi_marker_prefix(text: &str) -> Option<String> {
    const MARKER_PREFIXES: [&str; 2] = ["__codemux_approve__:", "__codemux_ask__:"];
    let head = text.trim_start();
    let leading_whitespace = &text[..text.len() - head.len()];
    MARKER_PREFIXES
        .iter()
        .find_map(|prefix| head.strip_prefix(prefix))
        .map(|rest| format!("{}{}", leading_whitespace, rest))
}
/// 活动链上一条可回退的用户消息条目（fork 目标）。
struct PiRewindableUser {
    entry_id: String,
    /// pi 原文文本（string 或 text 块拼接，未做展示层剥离）。
    text: String,
}

/// 收集活动链上的可回退用户消息，口径对齐前端 `isRewindableUserEvent`：
/// 文本非空或含图片附件；tool_result 条目在时间线上不构成用户消息，排除。
fn collect_pi_rewindable_users(raw_events: &[Value]) -> Vec<PiRewindableUser> {
    let mut users = Vec::new();
    for entry in select_pi_active_chain(raw_events) {
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let message = match entry.get("message") {
            Some(message) => message,
            None => continue,
        };
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(entry_id) = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
        else {
            continue;
        };
        let content = message.get("content");
        let text = match content {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter_map(|block| {
                    let block_type = block.get("type").and_then(Value::as_str)?;
                    if block_type != "text" && block_type != "input_text" {
                        return None;
                    }
                    block.get("text").and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        let has_image = content.and_then(Value::as_array).is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) == Some("image"))
        });
        if normalize_rewind_text(&text).is_empty() && !has_image {
            continue;
        }
        users.push(PiRewindableUser { entry_id, text });
    }
    users
}

fn verify_pi_rewind_fingerprint(
    user: &PiRewindableUser,
    text_fingerprint: Option<&str>,
) -> Result<(), String> {
    if let Some(fingerprint) = text_fingerprint
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if normalize_rewind_text(&user.text) != normalize_rewind_text(fingerprint) {
            return Err(format!(
                "Rewind target text mismatch for pi entry {}",
                user.entry_id
            ));
        }
    }
    Ok(())
}

/// 解析 rewind 目标用户消息的 pi 条目 id（`fork` RPC 的 entryId）。
/// 定位优先级：providerMessageId（时间线自带 pi 条目 id，精确匹配）→
/// turnOrdinal（第 N 条可回退用户消息，1-based，附指纹校验）→ 无 locator 时
/// 取活动链最新一条。ordinal 是较弱定位，指纹不一致或目标不存在时报错
/// （宁漏勿错，不猜目标）。
pub(crate) fn resolve_pi_rewind_entry_id(
    history_path: &Path,
    provider_message_id: Option<&str>,
    turn_ordinal: Option<usize>,
    text_fingerprint: Option<&str>,
) -> Result<String, String> {
    let raw_events = read_json_stream_values(history_path)?;
    // 会话头校验与发现/导入同口径：非 pi 会话文件拒绝操作。
    if !raw_events
        .iter()
        .any(|entry| entry.get("type").and_then(Value::as_str) == Some("session"))
    {
        return Err(format!("Not a pi session file: {}", history_path.display()));
    }
    let not_found = || {
        format!(
            "Target rewind user message not found in session history {}",
            history_path.display()
        )
    };
    let users = collect_pi_rewindable_users(&raw_events);

    if let Some(id) = provider_message_id
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let user = users
            .iter()
            .find(|user| user.entry_id == id)
            .ok_or_else(not_found)?;
        // pi 树条目不可变，id 命中即目标：不校验指纹——展示层剥离（如附件
        // 富化包裹）会让时间线文本与原文产生合法差异。
        return Ok(user.entry_id.clone());
    }

    if let Some(ordinal) = turn_ordinal {
        let user = users
            .get(ordinal.checked_sub(1).ok_or_else(not_found)?)
            .ok_or_else(not_found)?;
        verify_pi_rewind_fingerprint(user, text_fingerprint)?;
        return Ok(user.entry_id.clone());
    }

    users
        .last()
        .map(|user| user.entry_id.clone())
        .ok_or_else(not_found)
}

/// Pi JSONL records one assistant `message` per speak/tool step. A single user
/// prompt can span many of those rows; only the end of the user turn should
/// receive `turn_finished`, not every intermediate assistant message.
fn inject_pi_turn_boundaries(mut events: Vec<Value>) -> Vec<Value> {
    if events.is_empty() {
        return events;
    }

    let turn_ranges = collect_pi_user_turn_ranges(&events);
    for (start, end) in turn_ranges.into_iter().rev() {
        if !pi_turn_segment_needs_boundary(&events[start..=end]) {
            continue;
        }
        if events[end].get("type").and_then(Value::as_str) == Some("turn_finished") {
            continue;
        }
        events.insert(end + 1, pi_turn_boundary_event(&events[start..=end]));
    }

    events
}

fn collect_pi_user_turn_ranges(events: &[Value]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut turn_start: Option<usize> = None;

    for (index, event) in events.iter().enumerate() {
        if !is_real_pi_user_turn_start(event) {
            continue;
        }
        if let Some(start) = turn_start {
            if index > start {
                ranges.push((start, index - 1));
            }
        }
        // 范围包含用户消息本身：pi_turn_boundary_event 依赖段首的
        // user_message 时间戳推算 turn 时长（duration_ms）。
        turn_start = Some(index);
    }

    if let Some(start) = turn_start {
        if start < events.len() {
            ranges.push((start, events.len() - 1));
        }
    } else {
        ranges.push((0, events.len() - 1));
    }

    ranges
}

fn is_real_pi_user_turn_start(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("user_message")
}

fn pi_turn_segment_needs_boundary(segment: &[Value]) -> bool {
    segment.iter().any(|event| {
        matches!(
            event.get("type").and_then(Value::as_str),
            Some("assistant_message") | Some("tool_started")
        )
    })
}

fn pi_turn_boundary_event(segment: &[Value]) -> Value {
    for event in segment.iter().rev() {
        if event.get("type").and_then(Value::as_str) != Some("assistant_message") {
            continue;
        }
        let stop_reason = event
            .get("stop_reason")
            .and_then(Value::as_str)
            .unwrap_or("stop");
        if stop_reason == "error" {
            let mut boundary = pi_turn_result_for_assistant_message(stop_reason, event);
            pi_attach_duration(&mut boundary, segment);
            return boundary;
        }
        break;
    }

    let mut boundary = pi_turn_completed_event();
    pi_attach_duration(&mut boundary, segment);
    boundary
}

/// 从段内事件时间戳推算 turn 时长（用户消息 → 最后一条助手消息），
/// 供前端 footer 的「耗时」展示，避免 duration_ms 缺失被当成 0。
fn pi_attach_duration(event: &mut Value, segment: &[Value]) {
    if let Some(duration_ms) = pi_segment_duration_ms(segment) {
        event["duration_ms"] = json!(duration_ms);
    }
}

fn pi_segment_duration_ms(segment: &[Value]) -> Option<u64> {
    let start = segment
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("user_message"))
        .and_then(|event| event.get("timestamp"))
        .and_then(pi_timestamp_ms)?;
    let end = segment
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("assistant_message"))
        .and_then(|event| event.get("timestamp"))
        .and_then(pi_timestamp_ms)?;
    (end > start).then_some(end - start)
}

fn pi_timestamp_ms(value: &Value) -> Option<u64> {
    if let Some(text) = value.as_str() {
        return chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|time| time.timestamp_millis().max(0) as u64);
    }
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|millis| u64::try_from(millis).ok()))
}

fn pi_turn_completed_event() -> Value {
    json!({
        "type": "turn_finished",
        "outcome": "completed",
    })
}

fn convert_pi_message_entry(raw: &Value) -> Option<Value> {
    let message = raw.get("message")?;
    let role = message.get("role").and_then(Value::as_str)?;
    // pi 把工具结果记录为独立的 `role:"toolResult"` 消息条目（toolCallId /
    // isError 在 message 层），必须转成 normalize 可配对的 tool_result 块，
    // 否则 tool_started 永远悬空（turn 卡在 running、工具状态/响应丢失）。
    if role == "toolResult" {
        return convert_pi_tool_result_entry(raw, message);
    }
    if role != "user" && role != "assistant" {
        return None;
    }

    let content = message
        .get("content")
        .map(convert_pi_content_blocks)
        .unwrap_or_else(|| json!([]));

    let mut converted = json!({
        "type": role,
        "message": {
            "role": role,
            "content": content,
        },
    });

    if let Some(id) = raw.get("id") {
        converted["uuid"] = id.clone();
        converted["provider_message_id"] = id.clone();
    }
    if let Some(timestamp) = raw.get("timestamp") {
        converted["timestamp"] = timestamp.clone();
    }
    if let Some(message) = raw.get("message") {
        if let Some(stop_reason) = message.get("stopReason").and_then(Value::as_str) {
            converted["stop_reason"] = json!(stop_reason);
        }
    }
    if let Some(line_index) = raw.get("__lineIndex") {
        converted["line_index"] = line_index.clone();
        converted["source_event_index"] = line_index.clone();
    }

    Some(converted)
}

/// pi 的工具结果条目 → normalize 可识别的 user tool_result 块。
/// `tool_finished_from_block` 会把 content 字符串化，这里把 pi 的
/// `[{type:"text",...}]` 块数组拍平为纯文本，避免渲染成 JSON 转储。
fn convert_pi_tool_result_entry(raw: &Value, message: &Value) -> Option<Value> {
    let tool_use_id = message.get("toolCallId").and_then(Value::as_str)?;
    let tool_name = message
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let content = pi_tool_result_content(tool_name, message);
    let mut converted = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": message.get("isError").and_then(Value::as_bool).unwrap_or(false),
            }],
        },
    });
    if let Some(timestamp) = raw.get("timestamp") {
        converted["timestamp"] = timestamp.clone();
    }
    if let Some(line_index) = raw.get("__lineIndex") {
        converted["line_index"] = line_index.clone();
        converted["source_event_index"] = line_index.clone();
    }
    Some(converted)
}

/// 提问工具的 tool result content：把 `details.answers` 归一化成 CodeMUX
/// 提问卡读的位置序形状 `{"answers":[["答案"], ...]}`；其余工具保持拍平文本。
///
/// pi 扩展只把答案写进 `details.answers`（`[{question, answer}]`），content
/// 是喂给模型的 `"问题: 答案"` 文本，直接拍平后前端解析不到答案、回显成
/// "未作答"。answer 全为 null 表示用户取消（`ctx.ui.select` 收到
/// cancelled），映射成提问卡支持的 `__cancelled__` 哨兵；空字符串是合法的
/// 自由文本答复，不算取消。存量会话文件同样带 `details`，一并受益。
///
/// 本函数是 pi 提问卡投影的**孪生实现**之一：另一侧是实时投影
/// `apps/sidecar/src/piEvents.ts` 的 `piAskToolResultContent`。同一份 pi 会话
/// 既会实时投影、也会被重放投影（导入 / 重开会话 / rewind），两侧对同一输入
/// 必须输出**逐字相同**的字符串，否则"重开会话"会渲染出与当时不同的内容：
/// - 全部 answer 为 null → 两侧都 `__cancelled__`（本侧测试
///   `normalizes_ask_user_question_answers_for_the_question_card`，TS 侧
///   `maps an all-null ask_user_question answer list to the cancelled sentinel`）；
/// - 部分作答（有的 answer 为 null、有的为字符串，用户在对话框中途取消）→
///   两侧都把未作答项落成空串 `[""]`，不落 `null`；
/// - 空字符串是合法答复，不算取消。
///
/// 改任一侧时必须同步改另一侧，并同时更新两侧测试。
///
/// 已知且刻意的差异：`details.answers` 为**空数组**时本侧返回拍平文本（不凭空
/// 造一张空答案卡），TS 侧返回 `{"answers":[]}`；真实 pi 不会写出空数组，且前端
/// 对两者都渲染成"未作答"（`AskUserQuestionCard.tsx` 的 `normalizeAnswerValues`
/// 把 null 与 `''` 一并归一成空），故不强行统一。
fn pi_tool_result_content(tool_name: &str, message: &Value) -> Value {
    let flattened = flatten_pi_content_text(message.get("content").unwrap_or(&Value::Null));
    if !is_ask_user_question_tool_name(tool_name) {
        return flattened;
    }
    let Some(Value::Array(entries)) = message
        .get("details")
        .and_then(|details| details.get("answers"))
    else {
        return flattened;
    };
    if entries.is_empty() {
        return flattened;
    }

    // 先判定"全部未作答"（= 用户取消），再落形状：映射时就把未作答项落成空串
    // 以与实时投影逐字一致，因此取消判定必须基于映射结果之外的标志位。
    let mut all_unanswered = true;
    let answers: Vec<Value> = entries
        .iter()
        .map(|entry| match entry.get("answer").and_then(Value::as_str) {
            Some(answer) => {
                all_unanswered = false;
                json!([answer])
            }
            None => json!([""]),
        })
        .collect();
    if all_unanswered {
        return json!("__cancelled__");
    }
    json!({ "answers": answers })
}

/// 把 pi 内容块数组拍平为纯文本（拼接 text 块）；字符串原样返回。
fn flatten_pi_content_text(content: &Value) -> Value {
    match content {
        Value::Array(blocks) => {
            let mut texts: Vec<String> = Vec::new();
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            texts.push(text.to_string());
                        }
                    }
                }
            }
            if texts.is_empty() {
                json!("")
            } else {
                json!(texts.join("\n\n"))
            }
        }
        Value::String(text) => json!(text),
        Value::Null => json!(""),
        other => other.clone(),
    }
}

fn convert_pi_content_blocks(content: &Value) -> Value {
    let Some(blocks) = content.as_array() else {
        return json!([]);
    };

    let converted: Vec<Value> = blocks
        .iter()
        .filter_map(|block| {
            let block_type = block.get("type").and_then(Value::as_str)?;
            match block_type {
                "text" | "thinking" | "image" => Some(block.clone()),
                "toolCall" => {
                    let id = block.get("id").and_then(Value::as_str)?;
                    let name = block.get("name").and_then(Value::as_str)?;
                    Some(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": block.get("arguments").cloned().unwrap_or_else(|| json!({})),
                    }))
                }
                "toolResult" => {
                    let tool_use_id = block
                        .get("toolCallId")
                        .or_else(|| block.get("tool_use_id"))
                        .and_then(Value::as_str)?;
                    let content = block
                        .get("content")
                        .or_else(|| block.get("result"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    Some(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": content,
                        "is_error": block.get("isError").and_then(Value::as_bool).unwrap_or(false),
                    }))
                }
                _ => None,
            }
        })
        .collect();

    json!(converted)
}

fn pi_turn_result_for_assistant_message(stop_reason: &str, _event: &Value) -> Value {
    let is_error = stop_reason == "error";
    json!({
        "type": "turn_finished",
        "outcome": if is_error { "failed" } else { "completed" },
        "is_error": is_error,
    })
}

pub(crate) fn looks_like_pi_session_path(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
}

/// pi 会话 JSONL 文件名常见格式：`{timestamp}_{session-id}.jsonl`。
pub(crate) fn extract_pi_session_id_from_filename(path: &str) -> Option<String> {
    let stem = Path::new(path)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())?;
    let (_, session_id) = stem.rsplit_once('_')?;
    if uuid::Uuid::parse_str(session_id).is_ok() {
        Some(session_id.to_string())
    } else {
        None
    }
}

/// 读取 pi 会话 JSONL 首条 `type: session` 记录的 `id` 字段。
pub(crate) fn read_pi_session_id_from_file(path: &Path) -> Option<String> {
    let values = read_json_stream_values(path).ok()?;
    for entry in &values {
        if entry.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        if let Some(id) = entry.get("id").and_then(Value::as_str) {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 将 DB 中存的 pi `agent_session_id`（多为 JSONL 绝对路径）拆成展示用会话 ID 与任务路径。
pub(crate) fn resolve_pi_agent_session_info(
    stored_agent_session_id: String,
) -> (Option<String>, Option<String>) {
    if looks_like_pi_session_path(&stored_agent_session_id) {
        let history_path = Path::new(&stored_agent_session_id);
        let session_id = read_pi_session_id_from_file(history_path)
            .or_else(|| extract_pi_session_id_from_filename(&stored_agent_session_id));
        return (session_id, Some(stored_agent_session_id));
    }

    if let Some(pending) = stored_agent_session_id.strip_prefix("pi:pending-") {
        return (Some(pending.to_string()), None);
    }

    if let Some(session_id) = stored_agent_session_id.strip_prefix("pi:") {
        let trimmed = session_id.trim();
        if !trimmed.is_empty() {
            return (Some(trimmed.to_string()), None);
        }
    }

    let trimmed = stored_agent_session_id.trim();
    if trimmed.is_empty() {
        (None, None)
    } else {
        (Some(trimmed.to_string()), None)
    }
}

async fn load_pi_session_events_impl(
    state: &crate::AppState,
    app_session_id: &str,
) -> Result<Vec<Value>, String> {
    debug!(
        target: "agent",
        "Loading pi session events for app_session_id={}",
        app_session_id
    );

    let Some(session_file) = get_agent_session_id(state, app_session_id, AgentKind::Pi)? else {
        info!(
            target: "agent",
            "No pi mapping found for app_session_id={}",
            app_session_id
        );
        return Ok(Vec::new());
    };

    if !looks_like_pi_session_path(&session_file) {
        return Err(format!(
            "Invalid pi session mapping for app_session_id={}: expected absolute .jsonl path",
            app_session_id
        ));
    }

    let path = Path::new(&session_file).to_path_buf();
    if !path.exists() {
        info!(
            target: "agent",
            "pi session file not found for app_session_id={} path={}",
            app_session_id,
            path.display()
        );
        return Ok(Vec::new());
    }

    let normalize_session_id = app_session_id.to_string();
    let normalized = tokio::task::spawn_blocking(move || -> Result<Vec<Value>, String> {
        let raw_events = read_json_stream_values(&path)?;
        Ok(convert_pi_history_values_to_events(
            &raw_events,
            &normalize_session_id,
        ))
    })
    .await
    .map_err(|error| format!("Failed to join pi history loader: {}", error))??;

    info!(
        target: "agent",
        "Loaded {} CodeMUX events from pi JSONL for app_session_id={}",
        normalized.len(),
        app_session_id
    );
    Ok(normalized)
}

pub(crate) async fn load_pi_session_events_internal(
    state: std::sync::Arc<crate::AppState>,
    app_session_id: &str,
) -> Result<Vec<Value>, String> {
    load_pi_session_events_impl(&state, app_session_id).await
}

/// 用户原生 pi CLI 的会话根目录（与 CodeMUX 托管目录 `<数据根>/pi-agent` 无关），
/// 解析顺序对齐 pi `config.js`/`main.js`：`PI_CODING_AGENT_SESSION_DIR` env →
/// `<agentDir>/settings.json` 的 `sessionDir` → `<agentDir>/sessions`；
/// agentDir 为 `PI_CODING_AGENT_DIR` env → `~/.pi/agent`。env/settings 里的
/// 相对路径依赖 pi 启动时的 cwd，无法在此复现，跳过走默认（宁漏勿错）。
pub(crate) fn pi_native_sessions_root(home: &Path) -> PathBuf {
    let session_dir_env = std::env::var("PI_CODING_AGENT_SESSION_DIR").ok();
    let agent_dir_env = std::env::var("PI_CODING_AGENT_DIR").ok();
    let agent_dir = pi_native_agent_dir(home, agent_dir_env.as_deref());
    let settings_session_dir = read_pi_native_settings_session_dir(&agent_dir);
    resolve_pi_native_sessions_root(
        home,
        session_dir_env.as_deref(),
        agent_dir_env.as_deref(),
        settings_session_dir.as_deref(),
    )
}

fn pi_native_agent_dir(home: &Path, agent_dir_env: Option<&str>) -> PathBuf {
    match agent_dir_env.map(|dir| expand_tilde(home, dir)) {
        Some(dir) => dir,
        None => home.join(".pi").join("agent"),
    }
}

fn resolve_pi_native_sessions_root(
    home: &Path,
    session_dir_env: Option<&str>,
    agent_dir_env: Option<&str>,
    settings_session_dir: Option<&str>,
) -> PathBuf {
    for candidate in [session_dir_env, settings_session_dir] {
        if let Some(dir) = candidate.map(str::trim).filter(|dir| !dir.is_empty()) {
            if is_discoverable_dir(dir) {
                return expand_tilde(home, dir);
            }
        }
    }
    pi_native_agent_dir(home, agent_dir_env).join("sessions")
}

/// 仅接受绝对路径或 `~`/`~/` 前缀；相对路径依赖进程 cwd，跳过。
fn is_discoverable_dir(value: &str) -> bool {
    Path::new(value).is_absolute() || value == "~" || value.starts_with("~/")
}

fn expand_tilde(home: &Path, value: &str) -> PathBuf {
    if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(value)
    }
}

fn read_pi_native_settings_session_dir(agent_dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(agent_dir.join("settings.json")).ok()?;
    let settings: Value = serde_json::from_str(&content).ok()?;
    settings
        .get("sessionDir")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    fn test_home(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("codemux-pi-history-{}-{}", name, Uuid::new_v4()))
    }

    #[test]
    fn converts_pi_message_entries_and_turn_boundaries() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "session",
                    "id": "pi-session-1",
                    "cwd": "C:/workspace"
                }),
                json!({
                    "type": "message",
                    "id": "user-1",
                    "timestamp": "2026-09-03T08:05:53.950Z",
                    "message": {
                        "role": "user",
                        "content": [{ "type": "text", "text": "你好" }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "timestamp": "2026-09-03T08:06:07.481Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [
                            { "type": "thinking", "thinking": "greeting" },
                            { "type": "text", "text": "你好！" }
                        ],
                        "usage": {
                            "input": 10,
                            "output": 5,
                            "cacheRead": 0,
                            "cacheWrite": 0
                        }
                    }
                }),
            ],
            "app-1",
        );

        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["user_message", "assistant_message", "turn_finished"]
        );
        assert_eq!(events[0]["provider_message_id"], "user-1");
        assert_eq!(events[1]["provider_message_id"], "assistant-1");
        assert_eq!(events[2]["outcome"], "completed");
        // turn 时长由段内条目时间戳推算（用户消息 → 最后一条助手消息）。
        assert_eq!(events[2]["duration_ms"], 13531);
        assert_eq!(events[0]["session_id"], "app-1");
    }

    #[test]
    fn reads_latest_pi_usage_from_active_chain_assistant_message() {
        let usage = latest_pi_usage_from_session_values(
            &[
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 100,
                            "output": 9,
                            "cacheRead": 20,
                            "cacheWrite": 0
                        }
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-2",
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 352,
                            "output": 152,
                            "cacheRead": 25088,
                            "cacheWrite": 0
                        }
                    }
                }),
            ],
            "live_synced",
        )
        .expect("latest pi usage should exist");

        assert_eq!(usage.last.input_tokens, 352);
        assert_eq!(usage.last.cached_input_tokens, 25_088);
        assert_eq!(usage.last.output_tokens, 152);
        assert_eq!(usage.last.total_tokens, 25_440);
        assert_eq!(usage.context_usage_source, "history_file");
        assert_eq!(usage.context_usage_freshness, "live_synced");
    }

    #[test]
    fn converts_tool_calls_and_results() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "message": {
                        "role": "assistant",
                        "stopReason": "toolUse",
                        "content": [
                            {
                                "type": "toolCall",
                                "id": "call-1",
                                "name": "read",
                                "arguments": { "path": "a.ts" }
                            }
                        ]
                    }
                }),
                // pi 真实形状：工具结果是独立的 role:"toolResult" 消息条目。
                json!({
                    "type": "message",
                    "id": "result-1",
                    "timestamp": "2026-09-03T08:34:23.014Z",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call-1",
                        "toolName": "read",
                        "content": [{ "type": "text", "text": "file body" }],
                        "isError": false
                    }
                }),
            ],
            "app-1",
        );

        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["tool_started", "tool_finished", "turn_finished"]
        );
        assert_eq!(events[1]["tool_use_id"], "call-1");
        assert_eq!(events[1]["content"], "file body");
        assert_eq!(events[1]["is_error"], false);
    }

    #[test]
    fn converts_ask_user_question_tool_calls_for_pi_history() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message",
                    "id": "user-1",
                    "timestamp": "2026-09-05T11:27:46.884Z",
                    "message": {
                        "role": "user",
                        "content": [{ "type": "text", "text": "使用ask_user_question工具随便问我几个问题" }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "timestamp": "2026-09-05T11:28:03.820Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "toolUse",
                        "content": [
                            { "type": "text", "text": "\n\n" },
                            {
                                "type": "toolCall",
                                "id": "call-775ead75336345cb8b3ff7b1",
                                "name": "ask_user_question",
                                "arguments": {
                                    "questions": [{
                                        "question": "你更喜欢哪种编程语言？",
                                        "options": [{ "label": "Python" }]
                                    }]
                                }
                            }
                        ]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "result-1",
                    "timestamp": "2026-09-05T11:28:12.381Z",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call-775ead75336345cb8b3ff7b1",
                        "toolName": "ask_user_question",
                        "content": [{ "type": "text", "text": "你更喜欢哪种编程语言？: Python" }],
                        "details": {
                            "answers": [{ "question": "你更喜欢哪种编程语言？", "answer": "Python" }]
                        },
                        "isError": false
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-2",
                    "timestamp": "2026-09-05T11:28:23.060Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [{ "type": "text", "text": "谢谢你的回答！" }]
                    }
                }),
            ],
            "app-1",
        );

        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "user_message",
                "user_input_requested",
                "tool_finished",
                "assistant_message",
                "turn_finished",
            ]
        );
        assert_eq!(events[1]["tool_use_id"], "call-775ead75336345cb8b3ff7b1");
        // 提问卡的答案靠 tool_finished.content 里的位置序 answers 渲染，
        // 不能退化成喂给模型的 `"问题: 答案"` 文本（否则回显"未作答"）。
        assert_eq!(events[2]["content"], r#"{"answers":[["Python"]]}"#);
    }

    #[test]
    fn normalizes_ask_user_question_answers_for_the_question_card() {
        let ask_result = |answers: Value| {
            json!({
                "type": "message",
                "id": "result-1",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "call-1",
                    "toolName": "ask_user_question",
                    "content": [{ "type": "text", "text": "Q1: a\nQ2: b" }],
                    "details": { "answers": answers },
                    "isError": false
                }
            })
        };
        let finished_content = |entry: &Value| {
            convert_pi_history_values_to_events(std::slice::from_ref(entry), "app-1")
                .into_iter()
                .find(|event| event["type"] == "tool_finished")
                .expect("tool_finished event")["content"]
                .clone()
        };

        // 多问题按位置序展开；自由文本空串是合法答复，不能当取消。
        assert_eq!(
            finished_content(&ask_result(json!([
                { "question": "Q1", "answer": "a" },
                { "question": "Q2", "answer": "" }
            ]))),
            r#"{"answers":[["a"],[""]]}"#
        );

        // answer 全为 null = 用户取消（select 收到 cancelled）。
        assert_eq!(
            finished_content(&ask_result(json!([
                { "question": "Q1", "answer": null },
                { "question": "Q2", "answer": null }
            ]))),
            json!("__cancelled__")
        );

        // 部分作答（用户在对话框中途取消）：未作答项落成空串而非 null，须与实时
        // 投影 `apps/sidecar/src/piEvents.ts` 的 `piAskToolResultContent` 逐字一致
        //（TS 侧同名断言在 `piEvents.test.ts` 的 `normalizes ask_user_question
        // answers into the question card shape`）。前端 `AskUserQuestionCard.tsx`
        // 把 null 与 '' 都渲染成"未作答"，但同一份会话在实时与重放两条路径上必须
        // 产出同一个字符串，否则两侧会各自演化。
        assert_eq!(
            finished_content(&ask_result(json!([
                { "question": "Q1", "answer": null },
                { "question": "Q2", "answer": "b" }
            ]))),
            r#"{"answers":[[""],["b"]]}"#
        );

        // 缺 details / 空 answers 时保持拍平文本，不产出半截 answers。
        let without_details = json!({
            "type": "message",
            "id": "result-2",
            "message": {
                "role": "toolResult",
                "toolCallId": "call-2",
                "toolName": "ask_user_question",
                "content": [{ "type": "text", "text": "Q1: a" }],
                "details": {},
                "isError": false
            }
        });
        assert_eq!(finished_content(&without_details), json!("Q1: a"));

        // 空 answers 数组同样保持拍平文本（真实 pi 不产出空数组；TS 侧此处返回
        // `{"answers":[]}`，是双方注释里明确记录的刻意差异）。
        let empty_answers = json!({
            "type": "message",
            "id": "result-3",
            "message": {
                "role": "toolResult",
                "toolCallId": "call-3",
                "toolName": "ask_user_question",
                "content": [{ "type": "text", "text": "Q1: a" }],
                "details": { "answers": [] },
                "isError": false
            }
        });
        assert_eq!(finished_content(&empty_answers), json!("Q1: a"));
    }

    #[test]
    fn flattens_error_tool_result_content() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "message": {
                        "role": "assistant",
                        "content": [{
                            "type": "toolCall",
                            "id": "call-err",
                            "name": "bash",
                            "arguments": { "command": "tree" }
                        }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "result-err",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call-err",
                        "toolName": "bash",
                        "content": [
                            { "type": "text", "text": "tree: command not found" },
                            { "type": "text", "text": "Command exited with code 127" }
                        ],
                        "details": {},
                        "isError": true
                    }
                }),
            ],
            "app-1",
        );

        let finished = events
            .iter()
            .find(|event| event["type"] == "tool_finished")
            .expect("tool_finished event");
        assert_eq!(finished["tool_use_id"], "call-err");
        assert_eq!(
            finished["content"],
            "tree: command not found\n\nCommand exited with code 127"
        );
        assert_eq!(finished["is_error"], true);
    }

    #[test]
    fn emits_one_turn_finished_after_a_multi_step_user_turn() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message",
                    "id": "user-1",
                    "timestamp": "2026-09-03T08:40:00.000Z",
                    "message": {
                        "role": "user",
                        "content": [{ "type": "text", "text": "按方案1改" }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-1",
                    "timestamp": "2026-09-03T08:40:03.000Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [
                            { "type": "thinking", "thinking": "planning" },
                            { "type": "text", "text": "好的，开始修改。" }
                        ]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-2",
                    "message": {
                        "role": "assistant",
                        "stopReason": "toolUse",
                        "content": [{
                            "type": "toolCall",
                            "id": "call-1",
                            "name": "bash",
                            "arguments": { "command": "ls" }
                        }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "result-1",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call-1",
                        "toolName": "bash",
                        "content": [{ "type": "text", "text": "ok" }],
                        "isError": false
                    }
                }),
                json!({
                    "type": "message",
                    "id": "assistant-3",
                    "timestamp": "2026-09-03T08:40:10.000Z",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [
                            { "type": "thinking", "thinking": "done" },
                            { "type": "text", "text": "修改完成。" }
                        ]
                    }
                }),
            ],
            "app-1",
        );

        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "user_message",
                "assistant_message",
                "tool_started",
                "tool_finished",
                "assistant_message",
                "turn_finished",
            ]
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"].as_str() == Some("turn_finished"))
                .count(),
            1
        );
        let boundary = events
            .iter()
            .find(|event| event["type"] == "turn_finished")
            .unwrap();
        assert_eq!(boundary["duration_ms"], 10000);
    }

    #[test]
    fn resolves_pi_agent_session_info_from_jsonl_mapping_path() {
        let home = test_home("resolve-info");
        fs::create_dir_all(&home).unwrap();
        let session_file =
            home.join("2026-09-05T09-17-57-962Z_01a070dc-4149-734f-ac29-b192160ab52e.jsonl");
        fs::write(
            &session_file,
            concat!(
                "{\"type\":\"session\",\"id\":\"pi-session-1\"}\n",
                "{\"type\":\"message\",\"id\":\"user-1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n",
            ),
        )
        .unwrap();

        let stored = session_file.to_string_lossy().to_string();
        let expected_path = stored.clone();
        let (session_id, message_path) = resolve_pi_agent_session_info(stored);

        assert_eq!(session_id.as_deref(), Some("pi-session-1"));
        assert_eq!(message_path.as_deref(), Some(expected_path.as_str()));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn resolves_pi_agent_session_info_from_filename_when_session_header_missing() {
        let home = test_home("resolve-filename");
        fs::create_dir_all(&home).unwrap();
        let session_file =
            home.join("2026-09-05T09-17-57-962Z_01a070dc-4149-734f-ac29-b192160ab52e.jsonl");
        fs::write(&session_file, "{}\n").unwrap();

        let stored = session_file.to_string_lossy().to_string();
        let (session_id, message_path) = resolve_pi_agent_session_info(stored.clone());

        assert_eq!(
            session_id.as_deref(),
            Some("01a070dc-4149-734f-ac29-b192160ab52e")
        );
        assert_eq!(message_path.as_deref(), Some(stored.as_str()));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn reads_pi_session_file_from_mapping_path() {
        let home = test_home("read");
        let session_dir = home.join("pi-agent/sessions/demo");
        fs::create_dir_all(&session_dir).unwrap();
        let session_file = session_dir.join("session.jsonl");
        fs::write(
            &session_file,
            concat!(
                "{\"type\":\"session\",\"id\":\"pi-session-1\"}\n",
                "{\"type\":\"message\",\"id\":\"user-1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n",
                "{\"type\":\"message\",\"id\":\"assistant-1\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n",
            ),
        )
        .unwrap();

        let raw = read_json_stream_values(&session_file).unwrap();
        let events = convert_pi_history_values_to_events(&raw, "app-1");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["type"], "user_message");
        assert_eq!(events[1]["type"], "assistant_message");

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn follows_active_branch_in_tree_sessions() {
        // v3 树形会话：a1 → a2 是被放弃的分支，活动链是 a1 → b1 → b2。
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "session",
                    "version": 3,
                    "id": "sess-uuid",
                    "timestamp": "2026-09-03T08:00:00.000Z",
                    "cwd": "C:/workspace"
                }),
                json!({
                    "type": "message", "id": "a1", "parentId": null,
                    "timestamp": "2026-09-03T08:00:01.000Z",
                    "message": { "role": "user", "content": [{ "type": "text", "text": "hello" }] }
                }),
                json!({
                    "type": "message", "id": "a2", "parentId": "a1",
                    "timestamp": "2026-09-03T08:00:05.000Z",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "branch A answer" }] }
                }),
                json!({
                    "type": "message", "id": "b1", "parentId": "a1",
                    "timestamp": "2026-09-03T08:01:00.000Z",
                    "message": { "role": "user", "content": [{ "type": "text", "text": "try B" }] }
                }),
                json!({
                    "type": "message", "id": "b2", "parentId": "b1",
                    "timestamp": "2026-09-03T08:01:05.000Z",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "branch B answer" }] }
                }),
            ],
            "app-1",
        );

        let texts: Vec<&str> = events
            .iter()
            .filter(|event| event["type"] == "user_message" || event["type"] == "assistant_message")
            .filter_map(|event| {
                event["content"]
                    .as_array()
                    .and_then(|blocks| blocks.first())
                    .and_then(|block| block["text"].as_str())
                    .or_else(|| {
                        event["message"]["content"]
                            .as_array()
                            .and_then(|blocks| blocks.first())
                            .and_then(|block| block["text"].as_str())
                    })
            })
            .collect();
        assert_eq!(texts, vec!["hello", "try B", "branch B answer"]);
        assert_eq!(events.last().unwrap()["type"], "turn_finished");
    }

    #[test]
    fn falls_back_to_linear_when_parent_chain_is_broken() {
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message", "id": "a1", "parentId": null,
                    "message": { "role": "user", "content": [{ "type": "text", "text": "hello" }] }
                }),
                // parentId 指向不存在的条目：断链，回退全量线性。
                json!({
                    "type": "message", "id": "b1", "parentId": "missing",
                    "message": { "role": "user", "content": [{ "type": "text", "text": "try B" }] }
                }),
                json!({
                    "type": "message", "id": "a2", "parentId": "b1",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "answer" }] }
                }),
            ],
            "app-1",
        );

        let serialized = serde_json::to_string(&events).unwrap();
        assert!(serialized.contains("hello"));
        assert!(serialized.contains("try B"));
        assert!(serialized.contains("answer"));
    }

    #[test]
    fn converts_persisted_compaction_entry_to_boundary() {
        let events = convert_pi_history_values_to_events(
            &[json!({
                "type": "compaction",
                "id": "c1",
                "parentId": null,
                "timestamp": "2026-09-03T09:00:00.000Z",
                "summary": "earlier context",
                "tokensBefore": 50000
            })],
            "app-1",
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "system_event");
        assert_eq!(events[0]["subtype"], "compact_boundary");
        assert_eq!(events[0]["compact_metadata"]["trigger"], "auto");
        assert_eq!(events[0]["timestamp"], "2026-09-03T09:00:00.000Z");
    }

    #[test]
    fn resolves_native_sessions_root_with_pi_precedence() {
        let home = Path::new("/home/user");

        // 默认：~/.pi/agent/sessions
        assert_eq!(
            resolve_pi_native_sessions_root(home, None, None, None),
            home.join(".pi/agent/sessions")
        );
        // PI_CODING_AGENT_SESSION_DIR 优先，并展开 ~
        assert_eq!(
            resolve_pi_native_sessions_root(home, Some("~/sess"), Some("~/pihome"), None),
            home.join("sess")
        );
        // settings.json sessionDir 次之（用 temp_dir 构造跨平台绝对路径）
        let absolute = std::env::temp_dir().join("pi-sessions");
        assert_eq!(
            resolve_pi_native_sessions_root(home, None, None, Some(absolute.to_str().unwrap())),
            absolute
        );
        // 相对路径依赖 pi 进程 cwd，跳过走默认
        assert_eq!(
            resolve_pi_native_sessions_root(home, Some("rel/dir"), None, Some("also/rel")),
            home.join(".pi/agent/sessions")
        );
        // PI_CODING_AGENT_DIR 影响 agentDir 默认
        assert_eq!(
            resolve_pi_native_sessions_root(home, None, Some("~/pihome"), None),
            home.join("pihome/sessions")
        );
    }

    /// 树形会话文件：线性主干 + 一条分叉分支（fork 目标解析只认活动链）。
    fn write_tree_session(path: &std::path::Path) {
        let lines = [
            json!({"type": "session", "id": "pi-session-1", "cwd": "C:/workspace"}),
            json!({
                "type": "message", "id": "u1", "parentId": "",
                "message": {"role": "user", "content": [{"type": "text", "text": "first  prompt"}]}
            }),
            json!({
                "type": "message", "id": "a1", "parentId": "u1",
                "message": {"role": "assistant", "stopReason": "stop",
                    "content": [{"type": "text", "text": "reply"}]}
            }),
            json!({
                "type": "message", "id": "u2", "parentId": "a1",
                "message": {"role": "user", "content": "second prompt"}
            }),
            json!({
                "type": "message", "id": "u2-branch", "parentId": "a1",
                "message": {"role": "user", "content": [{"type": "text", "text": "abandoned branch"}]}
            }),
            json!({
                // tool_result 条目：时间线上不构成用户消息，不应计入 turn 序数
                "type": "message", "id": "tr1", "parentId": "u2",
                "message": {"role": "user", "content": [{"type": "toolResult", "toolCallId": "t1"}]}
            }),
            json!({
                "type": "message", "id": "u3", "parentId": "tr1",
                "message": {"role": "user", "content": [{"type": "text", "text": "third prompt"}]}
            }),
        ];
        let content = lines
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n");
        fs::write(path, content).unwrap();
    }

    #[test]
    fn resolves_rewind_entry_by_provider_message_id() {
        let dir = test_home("rewind-by-id");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        write_tree_session(&path);

        let entry_id =
            resolve_pi_rewind_entry_id(&path, Some("u2"), Some(999), Some("wrong")).unwrap();
        assert_eq!(entry_id, "u2");

        // 非可回退条目（tool_result / 分支外的助手消息）不可命中
        assert!(resolve_pi_rewind_entry_id(&path, Some("tr1"), None, None).is_err());
        assert!(resolve_pi_rewind_entry_id(&path, Some("missing"), None, None).is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_rewind_entry_by_turn_ordinal_and_verifies_fingerprint() {
        let dir = test_home("rewind-by-ordinal");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        write_tree_session(&path);

        // 活动链可回退用户消息 = u1, u2, u3（分支 u2-branch 与 tool_result tr1 不计）
        // 指纹做空白归一化比较（大小写敏感）
        let entry_id =
            resolve_pi_rewind_entry_id(&path, None, Some(1), Some("first prompt")).unwrap();
        assert_eq!(entry_id, "u1");
        let entry_id =
            resolve_pi_rewind_entry_id(&path, None, Some(3), Some("third   prompt")).unwrap();
        assert_eq!(entry_id, "u3");

        // 序数越界 / 指纹不一致：报错而非猜测
        assert!(resolve_pi_rewind_entry_id(&path, None, Some(4), None).is_err());
        assert!(resolve_pi_rewind_entry_id(&path, None, Some(2), Some("different text")).is_err());
        assert!(resolve_pi_rewind_entry_id(&path, None, Some(0), None).is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_rewind_entry_latest_without_locator() {
        let dir = test_home("rewind-latest");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        write_tree_session(&path);

        // 无 locator：取活动链最新一条（u3，而非同层兄弟分支 u2-branch）
        assert_eq!(
            resolve_pi_rewind_entry_id(&path, None, None, None).unwrap(),
            "u3"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_rewind_on_non_pi_session_file() {
        let dir = test_home("rewind-not-pi");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        fs::write(&path, "{\"type\":\"message\",\"id\":\"x\"}\n").unwrap();

        assert!(resolve_pi_rewind_entry_id(&path, None, None, None)
            .unwrap_err()
            .contains("Not a pi session file"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keeps_resolved_chain_when_parent_links_cycle() {
        // 成环会话（a1 ↔ a2 互为父子）：不再整体退回全量线性，而是保留已经解析
        // 出来的那段链（a1 → a2 → b1 → b2）；被放弃分支 c1 不得进入结果。
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message", "id": "a1", "parentId": "a2",
                    "message": { "role": "user", "content": [{ "type": "text", "text": "cycle head" }] }
                }),
                json!({
                    "type": "message", "id": "a2", "parentId": "a1",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "cycle tail" }] }
                }),
                json!({
                    "type": "message", "id": "c1", "parentId": "a2",
                    "message": { "role": "user", "content": [{ "type": "text", "text": "abandoned branch" }] }
                }),
                json!({
                    "type": "message", "id": "b1", "parentId": "a2",
                    "message": { "role": "user", "content": [{ "type": "text", "text": "second prompt" }] }
                }),
                json!({
                    "type": "message", "id": "b2", "parentId": "b1",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "active answer" }] }
                }),
            ],
            "app-1",
        );

        let serialized = serde_json::to_string(&events).unwrap();
        assert!(serialized.contains("cycle head"));
        assert!(serialized.contains("cycle tail"));
        assert!(serialized.contains("second prompt"));
        assert!(serialized.contains("active answer"));
        assert!(!serialized.contains("abandoned branch"));
    }

    #[test]
    fn keeps_entries_without_id_or_parent_id_key_when_pruning_to_chain() {
        // 树会话里混入两类不参与树结构的条目：缺 `id` 的、缺 `parentId` 键的。
        // 它们不在活动链上，但按链裁剪时必须原样保留（不丢内容优先）；同层的被
        // 放弃分支仍要剔除。
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message", "id": "u1", "parentId": null,
                    "message": { "role": "user", "content": [{ "type": "text", "text": "first prompt" }] }
                }),
                json!({
                    "type": "message", "id": "a1", "parentId": "u1",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "first answer" }] }
                }),
                // 缺 id：不参与树结构
                json!({
                    "type": "message", "parentId": "a1",
                    "message": { "role": "user", "content": [{ "type": "text", "text": "entry without id" }] }
                }),
                // 有 id 但没有 parentId 键：同样不参与树结构
                json!({
                    "type": "message", "id": "detached-1",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "entry without parent key" }] }
                }),
                json!({
                    "type": "message", "id": "abandoned", "parentId": "a1",
                    "message": { "role": "user", "content": [{ "type": "text", "text": "abandoned branch" }] }
                }),
                json!({
                    "type": "message", "id": "u2", "parentId": "a1",
                    "message": { "role": "user", "content": [{ "type": "text", "text": "second prompt" }] }
                }),
                json!({
                    "type": "message", "id": "a2", "parentId": "u2",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "second answer" }] }
                }),
            ],
            "app-1",
        );

        let serialized = serde_json::to_string(&events).unwrap();
        assert!(serialized.contains("entry without id"));
        assert!(serialized.contains("entry without parent key"));
        assert!(serialized.contains("first prompt"));
        assert!(serialized.contains("second answer"));
        assert!(!serialized.contains("abandoned branch"));
    }

    #[test]
    fn follows_one_branch_when_session_has_two_null_parent_roots() {
        // pi 改写首条提问时会写出第二个 `parentId: null` 显式根：两个根都按分叉
        // 处理，活动链只含叶子自己那一支（被放弃的首条分支不进结果）。
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message", "id": "r1", "parentId": null,
                    "message": { "role": "user", "content": [{ "type": "text", "text": "original first prompt" }] }
                }),
                json!({
                    "type": "message", "id": "r1a", "parentId": "r1",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "original first answer" }] }
                }),
                json!({
                    "type": "message", "id": "r2", "parentId": null,
                    "message": { "role": "user", "content": [{ "type": "text", "text": "rewritten first prompt" }] }
                }),
                json!({
                    "type": "message", "id": "r2a", "parentId": "r2",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "rewritten first answer" }] }
                }),
            ],
            "app-1",
        );

        let serialized = serde_json::to_string(&events).unwrap();
        assert!(serialized.contains("rewritten first prompt"));
        assert!(serialized.contains("rewritten first answer"));
        assert!(!serialized.contains("original first prompt"));
        assert!(!serialized.contains("original first answer"));
    }

    #[test]
    fn strips_codemux_internal_markers_from_projected_history() {
        // marker 只应到达客户端、不写回会话文件；投影出口必须剥掉前缀并保留其后
        // 的可读文本（整条丢弃会误删对话内容）。
        let events = convert_pi_history_values_to_events(
            &[
                json!({
                    "type": "message", "id": "u1", "parentId": null,
                    "message": { "role": "user",
                        "content": [{ "type": "text", "text": "__codemux_ask__:请确认" }] }
                }),
                json!({
                    "type": "message", "id": "a1", "parentId": "u1",
                    "message": { "role": "assistant", "stopReason": "stop",
                        "content": [{ "type": "text", "text": "__codemux_approve__:允许执行 bash" }] }
                }),
            ],
            "app-1",
        );

        assert_eq!(events.len(), 3);
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(!serialized.contains("__codemux_"));
        assert!(serialized.contains("请确认"));
        assert!(serialized.contains("允许执行 bash"));
    }
}
