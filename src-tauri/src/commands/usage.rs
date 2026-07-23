use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::str::FromStr;

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::agent::commands::{find_claude_session_jsonl, find_codex_session_jsonl, home_dir};
use crate::agent::opencode_history;
use crate::config::types::AgentKind;
use crate::db::operations;
use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsResponse {
    pub heatmap: Vec<operations::UsageHeatmapDay>,
    pub overview: operations::UsageOverview,
    pub agent_distribution: Vec<operations::AgentDistribution>,
    pub model_distribution: Vec<operations::ModelDistribution>,
}

#[tauri::command]
pub fn get_usage_stats(
    state: State<'_, AppState>,
    agent_kind: Option<String>,
    days: Option<u32>,
) -> Result<UsageStatsResponse, String> {
    let days = days.unwrap_or(30);
    info!(
        target: "usage",
        "Loading usage stats agent_kind={:?} days={}",
        agent_kind, days
    );

    let db = state.db.lock().unwrap();

    let heatmap = operations::get_usage_heatmap(&db).map_err(|e| e.to_string())?;
    let overview = operations::get_usage_overview(&db, agent_kind.as_deref(), days)
        .map_err(|e| e.to_string())?;
    let agent_distribution =
        operations::get_agent_distribution(&db, days).map_err(|e| e.to_string())?;
    let model_distribution = operations::get_model_distribution(&db, agent_kind.as_deref(), days)
        .map_err(|e| e.to_string())?;

    Ok(UsageStatsResponse {
        heatmap,
        overview,
        agent_distribution,
        model_distribution,
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DailyTokenBreakdown {
    pub date: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotal {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
    pub cache_rate: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdownResponse {
    pub daily: Vec<DailyTokenBreakdown>,
    pub total: TokenTotal,
}

struct SessionTokenSource {
    agent_kind: String,
    agent_session_id: Option<String>,
}

#[derive(Default)]
struct DailyTokens {
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
}

fn extract_date_from_timestamp(timestamp: &str) -> String {
    if timestamp.len() >= 10 {
        timestamp[..10].to_string()
    } else {
        timestamp.to_string()
    }
}

fn read_u64(value: Option<&serde_json::Value>) -> u64 {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(text)) => text.parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

#[tauri::command]
pub async fn get_usage_token_breakdown(
    state: State<'_, AppState>,
    agent_kind: Option<String>,
    days: Option<u32>,
) -> Result<TokenBreakdownResponse, String> {
    let days = days.unwrap_or(30);
    let days_modifier = format!("-{} days", days);
    debug!(
        target: "usage",
        "Loading token breakdown agent_kind={:?} days={}",
        agent_kind, days
    );

    let session_sources: Vec<SessionTokenSource> = {
        let db = state.db.lock().unwrap();
        if let Some(ref kind) = agent_kind {
            let mut stmt = db
                .prepare(
                    "SELECT s.agent_kind, m.agent_session_id \
                     FROM sessions s \
                     LEFT JOIN agent_session_mappings m \
                     ON s.id = m.app_session_id AND s.agent_kind = m.agent_kind \
                     WHERE s.created_at >= date('now', ?1) AND s.agent_kind = ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![days_modifier, kind], |row| {
                    Ok(SessionTokenSource {
                        agent_kind: row.get(0)?,
                        agent_session_id: row.get(1)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        } else {
            let mut stmt = db
                .prepare(
                    "SELECT s.agent_kind, m.agent_session_id \
                     FROM sessions s \
                     LEFT JOIN agent_session_mappings m \
                     ON s.id = m.app_session_id AND s.agent_kind = m.agent_kind \
                     WHERE s.created_at >= date('now', ?1)",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![days_modifier], |row| {
                    Ok(SessionTokenSource {
                        agent_kind: row.get(0)?,
                        agent_session_id: row.get(1)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        }
    };

    let home = home_dir()?;

    let daily_map = tokio::task::spawn_blocking(move || {
        let mut daily_map: BTreeMap<String, DailyTokens> = BTreeMap::new();

        for source in &session_sources {
            let agent_kind = match AgentKind::from_str(&source.agent_kind) {
                Ok(k) => k,
                Err(_) => continue,
            };
            let Some(agent_session_id) = source.agent_session_id.as_ref() else {
                continue;
            };

            let result = match agent_kind {
                AgentKind::ClaudeCode => {
                    aggregate_claude_tokens(&home, agent_session_id, &mut daily_map)
                }
                AgentKind::Codex => aggregate_codex_tokens(&home, agent_session_id, &mut daily_map),
                AgentKind::Opencode => {
                    aggregate_opencode_tokens(&home, agent_session_id, &mut daily_map)
                }
                AgentKind::GeminiCli => Ok(()),
            };

            if let Err(error) = result {
                warn!(
                    target: "usage",
                    "Failed to parse token usage for agent_kind={} agent_session_id={}: {}",
                    source.agent_kind,
                    agent_session_id,
                    error
                );
            }
        }

        daily_map
    })
    .await
    .map_err(|e| format!("Failed to join token breakdown task: {}", e))?;

    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut total_cached: u64 = 0;

    let mut daily: Vec<DailyTokenBreakdown> = Vec::new();
    for (date, tokens) in daily_map {
        total_input += tokens.input_tokens;
        total_output += tokens.output_tokens;
        total_cached += tokens.cached_tokens;
        daily.push(DailyTokenBreakdown {
            date,
            input_tokens: tokens.input_tokens,
            output_tokens: tokens.output_tokens,
            cached_tokens: tokens.cached_tokens,
        });
    }

    let total_tokens = total_input
        .saturating_add(total_output)
        .saturating_add(total_cached);
    let cache_rate = if total_input + total_cached > 0 {
        (total_cached as f64 / (total_input + total_cached) as f64) * 100.0
    } else {
        0.0
    };

    info!(
        target: "usage",
        "Token breakdown complete: {} daily entries, total_tokens={}",
        daily.len(),
        total_tokens
    );

    Ok(TokenBreakdownResponse {
        daily,
        total: TokenTotal {
            input_tokens: total_input,
            output_tokens: total_output,
            cached_tokens: total_cached,
            total_tokens,
            cache_rate,
        },
    })
}

fn aggregate_claude_tokens(
    home: &Path,
    claude_session_id: &str,
    daily_map: &mut BTreeMap<String, DailyTokens>,
) -> Result<(), String> {
    use std::fs;

    let claude_dir = home.join(".claude");
    let Some(jsonl_path) = find_claude_session_jsonl(&claude_dir, claude_session_id) else {
        return Ok(());
    };

    let file = fs::File::open(&jsonl_path).map_err(|e| format!("Failed to open JSONL: {}", e))?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let val: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if val
            .get("isSidechain")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }

        if val.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }

        let Some(message) = val.get("message") else {
            continue;
        };
        if message.get("role").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }

        let Some(usage) = message.get("usage") else {
            continue;
        };

        let input_tokens = read_u64(usage.get("input_tokens"));
        let cache_read = read_u64(usage.get("cache_read_input_tokens"));
        let output_tokens = read_u64(usage.get("output_tokens"));

        if input_tokens == 0 && cache_read == 0 && output_tokens == 0 {
            continue;
        }

        let timestamp = val.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let date = extract_date_from_timestamp(timestamp);

        let entry = daily_map.entry(date).or_default();
        entry.input_tokens += input_tokens;
        entry.cached_tokens += cache_read;
        entry.output_tokens += output_tokens;
    }

    Ok(())
}

fn aggregate_codex_tokens(
    home: &Path,
    codex_session_id: &str,
    daily_map: &mut BTreeMap<String, DailyTokens>,
) -> Result<(), String> {
    use std::fs;

    let sessions_dir = home.join(".codex").join("sessions");
    let Some(jsonl_path) = find_codex_session_jsonl(&sessions_dir, codex_session_id) else {
        return Ok(());
    };

    let file = fs::File::open(&jsonl_path).map_err(|e| format!("Failed to open JSONL: {}", e))?;
    let reader = BufReader::new(file);

    let mut prev_input: u64 = 0;
    let mut prev_cached: u64 = 0;
    let mut prev_output: u64 = 0;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let val: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if val.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(payload) = val.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
            continue;
        }
        let Some(info) = payload.get("info") else {
            continue;
        };
        let Some(usage) = info.get("last_token_usage") else {
            continue;
        };

        let input_tokens = read_u64(usage.get("input_tokens"));
        let cached_tokens = read_u64(usage.get("cached_input_tokens"));
        let output_tokens = read_u64(usage.get("output_tokens"));

        let delta_input = input_tokens.saturating_sub(prev_input);
        let delta_cached = cached_tokens.saturating_sub(prev_cached);
        let delta_output = output_tokens.saturating_sub(prev_output);

        prev_input = input_tokens;
        prev_cached = cached_tokens;
        prev_output = output_tokens;

        if delta_input == 0 && delta_cached == 0 && delta_output == 0 {
            continue;
        }

        let timestamp = val.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let date = extract_date_from_timestamp(timestamp);

        let entry = daily_map.entry(date).or_default();
        entry.input_tokens += delta_input;
        entry.cached_tokens += delta_cached;
        entry.output_tokens += delta_output;
    }

    Ok(())
}

fn aggregate_opencode_tokens(
    home: &Path,
    opencode_session_id: &str,
    daily_map: &mut BTreeMap<String, DailyTokens>,
) -> Result<(), String> {
    let events = opencode_history::load_opencode_session_events(home, opencode_session_id)?;

    for event in events {
        if event.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }

        let Some(usage) = event.get("usage") else {
            continue;
        };

        let input_tokens = read_u64(usage.get("input_tokens"));
        let output_tokens = read_u64(usage.get("output_tokens"));
        let cached_tokens = read_u64(usage.get("cached_input_tokens"));

        if input_tokens == 0 && cached_tokens == 0 && output_tokens == 0 {
            continue;
        }

        let timestamp = event
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let date = extract_date_from_timestamp(timestamp);

        let entry = daily_map.entry(date).or_default();
        entry.input_tokens += input_tokens;
        entry.cached_tokens += cached_tokens;
        entry.output_tokens += output_tokens;
    }

    Ok(())
}
