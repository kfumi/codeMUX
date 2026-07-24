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
    pub heatmap_tokens: Vec<HeatmapTokenDay>,
    pub model_tokens: Vec<ModelTokenTotal>,
    pub agent_tokens: Vec<AgentTokenTotal>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapTokenDay {
    pub date: String,
    pub total_tokens: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelTokenTotal {
    pub model: String,
    pub total_tokens: u64,
    pub session_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentTokenTotal {
    pub agent_kind: String,
    pub total_tokens: u64,
    pub session_count: i64,
}

struct SessionTokenSource {
    agent_kind: String,
    agent_session_id: Option<String>,
    model: Option<String>,
    created_at: String,
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
    let heatmap_modifier = "-365 days";
    debug!(
        target: "usage",
        "Loading token breakdown agent_kind={:?} days={}",
        agent_kind, days
    );

    // Always query 365 days of sessions for heatmap token data;
    // model/created_at are needed for per-model aggregation and days-window filtering.
    let session_sources: Vec<SessionTokenSource> = {
        let db = state.db.lock().unwrap();
        if let Some(ref kind) = agent_kind {
            let mut stmt = db
                .prepare(
                    "SELECT s.agent_kind, m.agent_session_id, s.model, s.created_at \
                     FROM sessions s \
                     LEFT JOIN agent_session_mappings m \
                     ON s.id = m.app_session_id AND s.agent_kind = m.agent_kind \
                     WHERE s.created_at >= date('now', ?1) AND s.agent_kind = ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![heatmap_modifier, kind], |row| {
                    Ok(SessionTokenSource {
                        agent_kind: row.get(0)?,
                        agent_session_id: row.get(1)?,
                        model: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        } else {
            let mut stmt = db
                .prepare(
                    "SELECT s.agent_kind, m.agent_session_id, s.model, s.created_at \
                     FROM sessions s \
                     LEFT JOIN agent_session_mappings m \
                     ON s.id = m.app_session_id AND s.agent_kind = m.agent_kind \
                     WHERE s.created_at >= date('now', ?1)",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![heatmap_modifier], |row| {
                    Ok(SessionTokenSource {
                        agent_kind: row.get(0)?,
                        agent_session_id: row.get(1)?,
                        model: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        }
    };

    let home = home_dir()?;

    let (daily_map, model_map, agent_map) = tokio::task::spawn_blocking(move || {
        let mut daily_map: BTreeMap<String, DailyTokens> = BTreeMap::new();
        // model -> (total_tokens, session_count)
        let mut model_map: BTreeMap<String, (u64, i64)> = BTreeMap::new();
        // agent_kind -> (total_tokens, session_count)
        let mut agent_map: BTreeMap<String, (u64, i64)> = BTreeMap::new();
        let days_cutoff = format!(
            "{}",
            chrono::Utc::now()
                .checked_sub_signed(chrono::Duration::days(days as i64))
                .unwrap_or_else(chrono::Utc::now)
                .format("%Y-%m-%d")
        );

        for source in &session_sources {
            let agent_kind_enum = match AgentKind::from_str(&source.agent_kind) {
                Ok(k) => k,
                Err(_) => continue,
            };
            let Some(agent_session_id) = source.agent_session_id.as_ref() else {
                continue;
            };

            let session_daily_result = match agent_kind_enum {
                AgentKind::ClaudeCode => {
                    aggregate_claude_tokens(&home, agent_session_id)
                }
                AgentKind::Codex => aggregate_codex_tokens(&home, agent_session_id),
                AgentKind::Opencode => {
                    aggregate_opencode_tokens(&home, agent_session_id)
                }
                AgentKind::GeminiCli => Ok(BTreeMap::new()),
            };

            let session_daily = match session_daily_result {
                Ok(d) => d,
                Err(error) => {
                    warn!(
                        target: "usage",
                        "Failed to parse token usage for agent_kind={} agent_session_id={}: {}",
                        source.agent_kind,
                        agent_session_id,
                        error
                    );
                    continue;
                }
            };

            // Merge session daily tokens into global daily_map (for heatmap + chart)
            let mut session_total: u64 = 0;
            for (date, tokens) in &session_daily {
                let entry = daily_map.entry(date.clone()).or_default();
                entry.input_tokens += tokens.input_tokens;
                entry.cached_tokens += tokens.cached_tokens;
                entry.output_tokens += tokens.output_tokens;
                session_total +=
                    tokens.input_tokens + tokens.output_tokens + tokens.cached_tokens;
            }

            // Aggregate by model and agent_kind (only for sessions within the days window)
            let session_date = source.created_at.get(..10).unwrap_or(&source.created_at);
            if session_date >= days_cutoff.as_str() {
                let model_label = source
                    .model
                    .as_deref()
                    .filter(|m| !m.is_empty())
                    .unwrap_or("未知模型");
                let model_entry = model_map.entry(model_label.to_string()).or_insert((0, 0));
                model_entry.0 += session_total;
                model_entry.1 += 1;

                let agent_entry = agent_map.entry(source.agent_kind.clone()).or_insert((0, 0));
                agent_entry.0 += session_total;
                agent_entry.1 += 1;
            }
        }

        (daily_map, model_map, agent_map)
    })
    .await
    .map_err(|e| format!("Failed to join token breakdown task: {}", e))?;

    // Split daily_map into chart daily (days window) and heatmap_tokens (all 365 days)
    let days_cutoff_str = format!(
        "{}",
        chrono::Utc::now()
            .checked_sub_signed(chrono::Duration::days(days as i64))
            .unwrap_or_else(chrono::Utc::now)
            .format("%Y-%m-%d")
    );

    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut total_cached: u64 = 0;

    let mut daily: Vec<DailyTokenBreakdown> = Vec::new();
    let mut heatmap_tokens: Vec<HeatmapTokenDay> = Vec::new();

    for (date, tokens) in &daily_map {
        let day_total = tokens.input_tokens + tokens.output_tokens + tokens.cached_tokens;
        heatmap_tokens.push(HeatmapTokenDay {
            date: date.clone(),
            total_tokens: day_total,
        });

        if date.as_str() >= days_cutoff_str.as_str() {
            total_input += tokens.input_tokens;
            total_output += tokens.output_tokens;
            total_cached += tokens.cached_tokens;
            daily.push(DailyTokenBreakdown {
                date: date.clone(),
                input_tokens: tokens.input_tokens,
                output_tokens: tokens.output_tokens,
                cached_tokens: tokens.cached_tokens,
            });
        }
    }

    let total_tokens = total_input
        .saturating_add(total_output)
        .saturating_add(total_cached);
    let cache_rate = if total_input + total_cached > 0 {
        (total_cached as f64 / (total_input + total_cached) as f64) * 100.0
    } else {
        0.0
    };

    let mut model_tokens: Vec<ModelTokenTotal> = model_map
        .into_iter()
        .map(|(model, (total, count))| ModelTokenTotal {
            model,
            total_tokens: total,
            session_count: count,
        })
        .collect();
    model_tokens.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

    let mut agent_tokens: Vec<AgentTokenTotal> = agent_map
        .into_iter()
        .map(|(agent_kind, (total, count))| AgentTokenTotal {
            agent_kind,
            total_tokens: total,
            session_count: count,
        })
        .collect();
    agent_tokens.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

    info!(
        target: "usage",
        "Token breakdown complete: {} daily entries, {} heatmap entries, {} model entries, {} agent entries, total_tokens={}",
        daily.len(),
        heatmap_tokens.len(),
        model_tokens.len(),
        agent_tokens.len(),
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
        heatmap_tokens,
        model_tokens,
        agent_tokens,
    })
}

fn aggregate_claude_tokens(
    home: &Path,
    claude_session_id: &str,
) -> Result<BTreeMap<String, DailyTokens>, String> {
    use std::fs;

    let mut session_daily: BTreeMap<String, DailyTokens> = BTreeMap::new();

    let claude_dir = home.join(".claude");
    let Some(jsonl_path) = find_claude_session_jsonl(&claude_dir, claude_session_id) else {
        return Ok(session_daily);
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

        let entry = session_daily.entry(date).or_default();
        entry.input_tokens += input_tokens;
        entry.cached_tokens += cache_read;
        entry.output_tokens += output_tokens;
    }

    Ok(session_daily)
}

fn aggregate_codex_tokens(
    home: &Path,
    codex_session_id: &str,
) -> Result<BTreeMap<String, DailyTokens>, String> {
    use std::fs;

    let mut session_daily: BTreeMap<String, DailyTokens> = BTreeMap::new();

    let sessions_dir = home.join(".codex").join("sessions");
    let Some(jsonl_path) = find_codex_session_jsonl(&sessions_dir, codex_session_id) else {
        return Ok(session_daily);
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

        let entry = session_daily.entry(date).or_default();
        entry.input_tokens += delta_input;
        entry.cached_tokens += delta_cached;
        entry.output_tokens += delta_output;
    }

    Ok(session_daily)
}

fn aggregate_opencode_tokens(
    home: &Path,
    opencode_session_id: &str,
) -> Result<BTreeMap<String, DailyTokens>, String> {
    let mut session_daily: BTreeMap<String, DailyTokens> = BTreeMap::new();

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

        let entry = session_daily.entry(date).or_default();
        entry.input_tokens += input_tokens;
        entry.cached_tokens += cached_tokens;
        entry.output_tokens += output_tokens;
    }

    Ok(session_daily)
}
