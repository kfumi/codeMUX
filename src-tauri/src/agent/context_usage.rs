use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageBreakdown {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTokenUsageSnapshot {
    pub total: TokenUsageBreakdown,
    pub last: TokenUsageBreakdown,
    pub model_context_window: Option<u64>,
    pub context_usage_source: String,
    pub context_usage_freshness: String,
}

pub fn latest_claude_usage_from_values(
    values: &[serde_json::Value],
    freshness: &str,
) -> Option<ThreadTokenUsageSnapshot> {
    for value in values.iter().rev() {
        if value
            .get("isSidechain")
            .and_then(|entry| entry.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        if value.get("type").and_then(|entry| entry.as_str()) != Some("assistant") {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        if message.get("role").and_then(|entry| entry.as_str()) != Some("assistant") {
            continue;
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };

        let input = read_u64(usage.get("input_tokens"));
        let cached = read_u64(usage.get("cache_read_input_tokens"));
        let output = read_u64(usage.get("output_tokens"));
        if input == 0 && cached == 0 && output == 0 {
            continue;
        }

        let total = input.saturating_add(cached);
        return Some(snapshot(total, input, cached, output, None, freshness));
    }

    None
}

pub fn latest_codex_usage_from_values(
    values: &[serde_json::Value],
    freshness: &str,
) -> Option<ThreadTokenUsageSnapshot> {
    for value in values.iter().rev() {
        if value.get("type").and_then(|entry| entry.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(|entry| entry.as_str()) != Some("token_count") {
            continue;
        }
        let Some(info) = payload.get("info") else {
            continue;
        };
        let Some(usage) = info.get("last_token_usage") else {
            continue;
        };

        let input = read_u64(usage.get("input_tokens"));
        let cached = read_u64(usage.get("cached_input_tokens"));
        let output = read_u64(usage.get("output_tokens"));
        let explicit_total = read_u64(usage.get("total_tokens"));
        let total = if explicit_total > 0 {
            explicit_total
        } else {
            input.saturating_add(output)
        };
        if total == 0 && cached == 0 {
            continue;
        }

        let model_context_window = read_u64(
            info.get("model_context_window")
                .or_else(|| info.get("modelContextWindow")),
        );
        return Some(snapshot(
            total,
            input,
            cached,
            output,
            (model_context_window > 0).then_some(model_context_window),
            freshness,
        ));
    }

    None
}

fn snapshot(
    total_tokens: u64,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    model_context_window: Option<u64>,
    freshness: &str,
) -> ThreadTokenUsageSnapshot {
    let breakdown = TokenUsageBreakdown {
        total_tokens,
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens: 0,
    };

    ThreadTokenUsageSnapshot {
        total: breakdown.clone(),
        last: breakdown,
        model_context_window,
        context_usage_source: "history_file".to_string(),
        context_usage_freshness: freshness.to_string(),
    }
}

fn read_u64(value: Option<&serde_json::Value>) -> u64 {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(text)) => text.parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_uses_latest_assistant_message_usage_and_counts_input_plus_cache() {
        let values = vec![
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input_tokens": 100,
                        "cache_read_input_tokens": 20,
                        "output_tokens": 9
                    }
                }
            }),
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input_tokens": 352,
                        "cache_read_input_tokens": 25088,
                        "output_tokens": 152
                    }
                }
            }),
        ];

        let snapshot = latest_claude_usage_from_values(&values, "restored")
            .expect("latest Claude usage should be found");

        assert_eq!(snapshot.last.input_tokens, 352);
        assert_eq!(snapshot.last.cached_input_tokens, 25_088);
        assert_eq!(snapshot.last.output_tokens, 152);
        assert_eq!(snapshot.last.total_tokens, 25_440);
        assert_eq!(snapshot.context_usage_source, "history_file");
        assert_eq!(snapshot.context_usage_freshness, "restored");
    }

    #[test]
    fn claude_ignores_sidechain_and_non_assistant_usage() {
        let values = vec![
            json!({
                "type": "assistant",
                "isSidechain": true,
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input_tokens": 900,
                        "cache_read_input_tokens": 900,
                        "output_tokens": 900
                    }
                }
            }),
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "usage": {
                        "input_tokens": 1,
                        "cache_read_input_tokens": 1,
                        "output_tokens": 1
                    }
                }
            }),
        ];

        assert_eq!(latest_claude_usage_from_values(&values, "restored"), None);
    }

    #[test]
    fn codex_uses_latest_token_count_total_tokens_and_cache_detail() {
        let values = vec![
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 100,
                            "cached_input_tokens": 80,
                            "output_tokens": 10,
                            "reasoning_output_tokens": 999,
                            "total_tokens": 110
                        },
                        "model_context_window": 258400
                    }
                }
            }),
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 154933,
                            "cached_input_tokens": 148864,
                            "output_tokens": 1128,
                            "reasoning_output_tokens": 666,
                            "total_tokens": 156061
                        },
                        "model_context_window": 258400
                    }
                }
            }),
        ];

        let snapshot = latest_codex_usage_from_values(&values, "live_synced")
            .expect("latest Codex usage should be found");

        assert_eq!(snapshot.last.input_tokens, 154_933);
        assert_eq!(snapshot.last.cached_input_tokens, 148_864);
        assert_eq!(snapshot.last.output_tokens, 1_128);
        assert_eq!(snapshot.last.reasoning_output_tokens, 0);
        assert_eq!(snapshot.last.total_tokens, 156_061);
        assert_eq!(snapshot.model_context_window, Some(258_400));
        assert_eq!(snapshot.context_usage_source, "history_file");
        assert_eq!(snapshot.context_usage_freshness, "live_synced");
    }

    #[test]
    fn codex_falls_back_to_input_plus_output_when_total_tokens_is_missing() {
        let values = vec![json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 20,
                        "cached_input_tokens": 7,
                        "output_tokens": 5,
                        "reasoning_output_tokens": 999
                    }
                }
            }
        })];

        let snapshot = latest_codex_usage_from_values(&values, "restored")
            .expect("fallback Codex usage should be found");

        assert_eq!(snapshot.last.total_tokens, 25);
        assert_eq!(snapshot.last.reasoning_output_tokens, 0);
    }
}
