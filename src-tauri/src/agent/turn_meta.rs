/// Returns true if a Claude-shaped history event is an effective user turn
/// (real user input), aligned with the frontend's `isHiddenAssistantThreadUserEvent` (C2).
///
/// Excludes: tool-result-only events, compact summaries, task notifications,
/// meta events, transcript-only events, injected AGENTS.md/skill messages, and
/// `/compact` commands.
pub fn is_effective_user_turn(event: &serde_json::Value) -> bool {
    if event.get("type").and_then(|t| t.as_str()) != Some("user") {
        return false;
    }
    // Sidechain / subagent events are never effective turns.
    if event
        .get("isSidechain")
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
    {
        return false;
    }
    // Meta events (slash-command auto-generated) are not real user input.
    if event
        .get("isMeta")
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
    {
        return false;
    }
    // Compact summary / transcript-only events.
    if event
        .get("isCompactSummary")
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
        || event
            .get("isVisibleInTranscriptOnly")
            .and_then(|e| e.as_bool())
            .unwrap_or(false)
    {
        return false;
    }

    let content = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());

    // Tool-result-only user events are internal (mid-turn), not turn boundaries.
    if let Some(blocks) = content {
        if !blocks.is_empty()
            && blocks
                .iter()
                .all(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
        {
            return false;
        }
    }

    // /compact and other compact-command user inputs are not effective turns.
    let text = extract_user_text(event);
    let trimmed = text.trim();
    if trimmed == "/compact" {
        return false;
    }

    true
}

/// Extract the user-facing text of a Claude-shaped user event, joining the
/// `text`/`input_text` content blocks (or string content).
fn extract_user_text(event: &serde_json::Value) -> String {
    let Some(content) = event.get("message").and_then(|m| m.get("content")) else {
        return String::new();
    };

    if let Some(text) = content.as_str() {
        return text.to_string();
    }

    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if block_type == "text" || block_type == "input_text" {
                        block.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Count effective user turns in a history of Claude-shaped events (O3).
/// Returns the 1-based ordinal that the *next* successful turn will receive.
pub fn count_effective_user_turns(events: &[serde_json::Value]) -> u32 {
    events.iter().filter(|e| is_effective_user_turn(e)).count() as u32
}

/// Annotate each event in place with `turn_ordinal` and `is_effective_user_turn`
/// (META1/NORM1). The `turn_ordinal` is the 1-based ordinal of the effective
/// user turn the event belongs to. Events before the first effective user
/// turn (e.g. system init) receive `turn_ordinal = 0`. Real user input events
/// receive `is_effective_user_turn = true`; all other events receive `false`.
///
/// The function scans events in order and increments the ordinal each time it
/// encounters an effective user turn. All subsequent events (assistant replies,
/// tool results, result events) inherit the current ordinal until the next
/// effective user turn arrives.
pub fn annotate_events_with_turn_ordinal(events: &mut [serde_json::Value]) {
    let mut current_ordinal: u32 = 0;
    for event in events.iter_mut() {
        let is_effective = is_effective_user_turn(event);
        if is_effective {
            current_ordinal = current_ordinal.saturating_add(1);
        }
        if let Some(obj) = event.as_object_mut() {
            obj.insert(
                "turnOrdinal".to_string(),
                serde_json::json!(current_ordinal),
            );
            obj.insert(
                "isEffectiveUserTurn".to_string(),
                serde_json::json!(is_effective),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normal_user_message_is_effective_turn() {
        let event = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "Hello, how are you?"}]
            }
        });
        assert!(is_effective_user_turn(&event));
    }

    #[test]
    fn tool_result_only_user_event_is_not_effective_turn() {
        let event = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "x", "content": "done"}]
            }
        });
        assert!(!is_effective_user_turn(&event));
    }

    #[test]
    fn count_skips_internal_user_events() {
        let events = vec![
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "hello1"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "x"}]}}),
            json!({"type": "user", "isCompactSummary": true, "message": {"content": "compacted..."}}),
            json!({"type": "user", "isMeta": true, "message": {"content": "auto"}}),
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "hello2"}]}}),
        ];
        // Two real user messages → ordinal for the next turn = 2
        assert_eq!(count_effective_user_turns(&events), 2);
    }

    #[test]
    fn assistant_and_result_events_are_not_user_turns() {
        assert!(!is_effective_user_turn(&json!({"type": "assistant"})));
        assert!(!is_effective_user_turn(&json!({"type": "result"})));
        assert!(!is_effective_user_turn(&json!({"type": "system"})));
    }

    #[test]
    fn compact_command_text_is_not_effective_turn() {
        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": "/compact"}
        });
        assert!(!is_effective_user_turn(&event));
    }

    #[test]
    fn annotate_assigns_ordinal_1_to_first_turn_events() {
        let mut events = vec![
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "hello"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}),
            json!({"type": "result", "subtype": "success"}),
        ];
        annotate_events_with_turn_ordinal(&mut events);
        // All events belong to turn 1.
        for event in &events {
            assert_eq!(event["turnOrdinal"], json!(1));
        }
        // First event (user) is the effective turn; others are not.
        assert_eq!(events[0]["isEffectiveUserTurn"], json!(true));
        assert_eq!(events[1]["isEffectiveUserTurn"], json!(false));
        assert_eq!(events[2]["isEffectiveUserTurn"], json!(false));
    }

    #[test]
    fn annotate_increments_ordinal_per_effective_user_turn() {
        let mut events = vec![
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "first"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "reply1"}]}}),
            json!({"type": "result"}),
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "second"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "reply2"}]}}),
        ];
        annotate_events_with_turn_ordinal(&mut events);
        // Turn 1: user1, assistant1, result
        assert_eq!(events[0]["turnOrdinal"], json!(1));
        assert_eq!(events[0]["isEffectiveUserTurn"], json!(true));
        assert_eq!(events[1]["turnOrdinal"], json!(1));
        assert_eq!(events[1]["isEffectiveUserTurn"], json!(false));
        assert_eq!(events[2]["turnOrdinal"], json!(1));
        // Turn 2: user2, assistant2
        assert_eq!(events[3]["turnOrdinal"], json!(2));
        assert_eq!(events[3]["isEffectiveUserTurn"], json!(true));
        assert_eq!(events[4]["turnOrdinal"], json!(2));
    }

    #[test]
    fn annotate_assigns_zero_to_events_before_first_user_turn() {
        let mut events = vec![
            json!({"type": "system", "subtype": "init", "session_id": "s1"}),
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "first"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "reply"}]}}),
        ];
        annotate_events_with_turn_ordinal(&mut events);
        assert_eq!(
            events[0]["turnOrdinal"],
            json!(0),
            "system init before any user turn"
        );
        assert_eq!(events[0]["isEffectiveUserTurn"], json!(false));
        assert_eq!(events[1]["turnOrdinal"], json!(1));
        assert_eq!(events[1]["isEffectiveUserTurn"], json!(true));
        assert_eq!(events[2]["turnOrdinal"], json!(1));
    }

    #[test]
    fn annotate_marks_tool_result_user_events_as_not_effective() {
        let mut events = vec![
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "use skill"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Skill"}]}}),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "done"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "answer"}]}}),
        ];
        annotate_events_with_turn_ordinal(&mut events);
        // All events belong to turn 1 (single user turn with mid-turn tool result)
        for event in &events {
            assert_eq!(event["turnOrdinal"], json!(1));
        }
        // Only the first user event is an effective user turn
        assert_eq!(events[0]["isEffectiveUserTurn"], json!(true));
        assert_eq!(
            events[2]["isEffectiveUserTurn"],
            json!(false),
            "tool_result is not effective"
        );
    }

    #[test]
    fn annotate_skips_meta_and_compact_user_events_for_ordinal_increment() {
        let mut events = vec![
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "first"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "reply1"}]}}),
            json!({"type": "user", "isMeta": true, "message": {"content": "auto expanded"}}),
            json!({"type": "user", "isCompactSummary": true, "message": {"content": "compacted"}}),
            json!({"type": "user", "message": {"content": "/compact"}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "compacted reply"}]}}),
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "second"}]}}),
        ];
        annotate_events_with_turn_ordinal(&mut events);
        // First user → turn 1
        assert_eq!(events[0]["turnOrdinal"], json!(1));
        assert_eq!(events[0]["isEffectiveUserTurn"], json!(true));
        // Assistant reply → turn 1
        assert_eq!(events[1]["turnOrdinal"], json!(1));
        // Meta / compact / compact-command user events → still turn 1, not effective
        assert_eq!(events[2]["turnOrdinal"], json!(1));
        assert_eq!(events[2]["isEffectiveUserTurn"], json!(false));
        assert_eq!(events[3]["turnOrdinal"], json!(1));
        assert_eq!(events[3]["isEffectiveUserTurn"], json!(false));
        assert_eq!(events[4]["turnOrdinal"], json!(1));
        assert_eq!(events[4]["isEffectiveUserTurn"], json!(false));
        // Compact reply assistant → turn 1
        assert_eq!(events[5]["turnOrdinal"], json!(1));
        // Second real user → turn 2
        assert_eq!(events[6]["turnOrdinal"], json!(2));
        assert_eq!(events[6]["isEffectiveUserTurn"], json!(true));
    }

    #[test]
    fn annotate_handles_empty_history() {
        let mut events: Vec<serde_json::Value> = vec![];
        annotate_events_with_turn_ordinal(&mut events);
        assert!(events.is_empty());
    }

    #[test]
    fn annotate_preserves_existing_fields() {
        let mut events = vec![json!({
            "type": "user",
            "uuid": "u1",
            "message": {"content": [{"type": "text", "text": "first"}]},
            "customField": "preserve me"
        })];
        annotate_events_with_turn_ordinal(&mut events);
        assert_eq!(events[0]["uuid"], json!("u1"));
        assert_eq!(events[0]["customField"], json!("preserve me"));
        assert_eq!(events[0]["turnOrdinal"], json!(1));
        assert_eq!(events[0]["isEffectiveUserTurn"], json!(true));
    }
}
