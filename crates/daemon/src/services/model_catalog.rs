//! Public model capability catalog (models.dev).
//!
//! The catalog answers "what can this model actually do" — context window,
//! token limits, input modalities, and which thinking levels it exposes.
//! CodeMUX treats it as **advice only** (ADR 0015): `provider.models` stays the
//! user's own configuration and the sole authority, and a lookup that finds
//! nothing returns `found: false` rather than a guess. Relay and proxy endpoints
//! carry model ids no public catalog will ever list.
//!
//! Delivery mirrors PI-Desktop's `ModelsDevCatalog`: fetch on first use, cache in
//! process, and fall back to a snapshot shipped with the app so the feature works
//! offline and survives the upstream being down.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::{debug, info, warn};
use serde::Serialize;

use crate::model_providers::normalize_thinking_levels;
use crate::paths::PathRoots;

const CATALOG_URL: &str = "https://models.dev/api.json";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// The catalog changes a few times a month at most; a day-old snapshot is fine.
const SNAPSHOT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Thinking levels assumed when the catalog says a model reasons but publishes
/// no per-level detail. Same fallback PI-Desktop uses
/// (`thinkingLevelsFromModelsDev`).
const DEFAULT_REASONING_LEVELS: [&str; 3] = ["low", "medium", "high"];

/// One model's published capabilities.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct CatalogEntry {
    pub provider: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Whether the catalog published reasoning support at all. A model that does
    /// not publish it is treated as not reasoning — the same conservative
    /// default pi applies.
    pub reasoning: bool,
    pub reasoning_published: bool,
    /// Thinking levels in CodeMUX's vocabulary, normalized and ordered.
    pub thinking_levels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    pub input_modalities: Vec<String>,
}

/// A lookup result. `found: false` means "the catalog has no opinion" — callers
/// must fall back to whatever the user configured.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CatalogLookup {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<CatalogEntry>,
    /// Where the answer came from: `remote` (fetched) or `bundled` (shipped
    /// snapshot). Surfaced in Settings so the user knows whether the suggestion
    /// is live data or a possibly-stale fallback.
    pub source: &'static str,
}

#[derive(Clone)]
struct Snapshot {
    /// Provider key → (normalized model id → entry).
    by_provider: HashMap<String, HashMap<String, CatalogEntry>>,
    /// Every entry keyed by normalized model id, for lookups without a provider.
    by_model: HashMap<String, Vec<CatalogEntry>>,
    source: &'static str,
    loaded_at: Instant,
}

fn snapshot_cell() -> &'static Mutex<Option<Snapshot>> {
    static CELL: OnceLock<Mutex<Option<Snapshot>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// Lowercase and strip separators so `GLM-5.2`, `glm 5.2` and `zai-org/GLM-5.2`
/// collapse onto one key. Deliberately coarser than the frontend's
/// `normalizeModelId`: this only has to bridge casing and path prefixes, not
/// every aggregator suffix rule.
fn normalize_model_id(model_id: &str) -> String {
    let tail = model_id
        .rsplit('/')
        .next()
        .unwrap_or(model_id)
        .trim()
        .to_ascii_lowercase();
    tail.chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '.')
        .collect()
}

fn positive_u64(raw: Option<&serde_json::Value>) -> Option<u64> {
    raw.and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
}

fn string_field(raw: &serde_json::Value, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Thinking levels for a model, in CodeMUX's vocabulary.
///
/// `reasoning_options` describes *how* reasoning is controlled, not which levels
/// exist. The shapes actually published are:
/// - `{"type": "effort", "values": ["low", "medium", "high"]}` — the only one
///   that names levels. `values` can also carry `minimal` / `none`, which
///   `normalize_thinking_levels` folds onto our vocabulary.
/// - `{"type": "toggle"}` — a boolean switch with no levels.
/// - `[]` / `null` — nothing declared.
///
/// The latter two fall back to the conservative `low/medium/high` set.
fn thinking_levels_from_catalog(
    reasoning: bool,
    reasoning_published: bool,
    raw: &serde_json::Value,
) -> Vec<String> {
    if !reasoning || !reasoning_published {
        return Vec::new();
    }
    let mut levels: Vec<String> = raw
        .get("reasoning_options")
        .and_then(serde_json::Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter(|option| {
                    option.get("type").and_then(serde_json::Value::as_str) == Some("effort")
                })
                .filter_map(|option| option.get("values"))
                .filter_map(serde_json::Value::as_array)
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if levels.is_empty() {
        levels = DEFAULT_REASONING_LEVELS
            .iter()
            .map(|level| level.to_string())
            .collect();
    }
    normalize_thinking_levels(&levels)
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn input_modalities_from_catalog(raw: &serde_json::Value) -> Vec<String> {
    let mut modalities = vec!["text".to_string()];
    if let Some(input) = raw
        .get("modalities")
        .and_then(|modalities| modalities.get("input"))
        .and_then(serde_json::Value::as_array)
    {
        for modality in input {
            if let Some(name) = modality.as_str() {
                let name = name.trim().to_ascii_lowercase();
                if name == "image" && !modalities.iter().any(|entry| entry == "image") {
                    modalities.push("image".to_string());
                }
            }
        }
    }
    modalities
}

/// Parse a models.dev `api.json` payload into a snapshot.
///
/// Tolerant by construction: unknown shapes, non-boolean `reasoning`, and
/// providers without models are skipped rather than failing the whole document,
/// so one upstream schema change cannot blank the catalog.
fn parse_catalog(document: &serde_json::Value, source: &'static str) -> Snapshot {
    let mut by_provider: HashMap<String, HashMap<String, CatalogEntry>> = HashMap::new();
    let mut by_model: HashMap<String, Vec<CatalogEntry>> = HashMap::new();

    let Some(providers) = document.as_object() else {
        return Snapshot {
            by_provider,
            by_model,
            source,
            loaded_at: Instant::now(),
        };
    };

    for (provider_key, provider) in providers {
        let Some(models) = provider
            .get("models")
            .and_then(serde_json::Value::as_object)
        else {
            continue;
        };
        for (model_key, raw) in models {
            let model_id = string_field(raw, "id").unwrap_or_else(|| model_key.clone());
            let key = normalize_model_id(&model_id);
            if key.is_empty() {
                continue;
            }
            let reasoning_published = raw
                .get("reasoning")
                .and_then(serde_json::Value::as_bool)
                .is_some();
            let reasoning = raw
                .get("reasoning")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let entry = CatalogEntry {
                provider: provider_key.to_ascii_lowercase(),
                model_id,
                name: string_field(raw, "name"),
                reasoning,
                reasoning_published,
                thinking_levels: thinking_levels_from_catalog(reasoning, reasoning_published, raw),
                context_window: positive_u64(raw.get("limit").and_then(|l| l.get("context"))),
                max_input_tokens: positive_u64(raw.get("limit").and_then(|l| l.get("input"))),
                max_output_tokens: positive_u64(raw.get("limit").and_then(|l| l.get("output"))),
                input_modalities: input_modalities_from_catalog(raw),
            };
            by_provider
                .entry(provider_key.to_ascii_lowercase())
                .or_default()
                .insert(key.clone(), entry.clone());
            by_model.entry(key).or_default().push(entry);
        }
    }

    Snapshot {
        by_provider,
        by_model,
        source,
        loaded_at: Instant::now(),
    }
}

fn snapshot_is_fresh(snapshot: &Snapshot) -> bool {
    snapshot.loaded_at.elapsed() < SNAPSHOT_TTL
}

/// Read the snapshot shipped with the app.
///
/// The path comes from the injected [`PathRoots`], not from the process's
/// working directory: the daemon is spawned by the Electron shell with an
/// explicit resource root, and the packaged layout puts the snapshot beside
/// `dist-web` / `sidecar` / `daemon`.
fn read_bundled_snapshot(roots: &PathRoots) -> Option<Snapshot> {
    let path = roots.bundled_model_catalog()?;
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) => {
            warn!(
                target: "model_catalog",
                "读取打包的模型目录快照失败 ({}): {}",
                path.display(),
                error
            );
            return None;
        }
    };
    let document: serde_json::Value = match serde_json::from_str(&contents) {
        Ok(document) => document,
        Err(error) => {
            warn!(
                target: "model_catalog",
                "打包的模型目录快照无法解析 ({}): {}",
                path.display(),
                error
            );
            return None;
        }
    };
    let snapshot = parse_catalog(&document, "bundled");
    (!snapshot.by_model.is_empty()).then_some(snapshot)
}

async fn fetch_remote_snapshot() -> Option<Snapshot> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .get(CATALOG_URL)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        warn!(
            target: "model_catalog",
            "模型目录返回 HTTP {}，回落到打包快照",
            response.status()
        );
        return None;
    }
    let document = response.json::<serde_json::Value>().await.ok()?;
    let snapshot = parse_catalog(&document, "remote");
    if snapshot.by_model.is_empty() {
        warn!(target: "model_catalog", "模型目录没有可用条目，回落到打包快照");
        return None;
    }
    Some(snapshot)
}

/// Load the catalog, preferring a fresh in-process copy, then the network, then
/// the bundled snapshot. Never returns an error: a missing catalog degrades the
/// feature, it does not break the app.
async fn ensure_snapshot(roots: &PathRoots) -> Snapshot {
    if let Ok(guard) = snapshot_cell().lock() {
        if let Some(snapshot) = guard.as_ref() {
            if snapshot_is_fresh(snapshot) {
                return snapshot.clone();
            }
        }
    }

    let snapshot = fetch_remote_snapshot()
        .await
        .or_else(|| read_bundled_snapshot(roots));
    let Some(snapshot) = snapshot else {
        warn!(target: "model_catalog", "模型目录不可用，能力建议将退回到用户配置");
        return Snapshot {
            by_provider: HashMap::new(),
            by_model: HashMap::new(),
            source: "bundled",
            loaded_at: Instant::now(),
        };
    };

    info!(
        target: "model_catalog",
        "模型目录已加载 ({}), {} 个供应商, {} 个模型",
        snapshot.source,
        snapshot.by_provider.len(),
        snapshot.by_model.len()
    );
    if let Ok(mut guard) = snapshot_cell().lock() {
        *guard = Some(snapshot.clone());
    }
    snapshot
}

fn lookup_in(snapshot: &Snapshot, provider: Option<&str>, model_id: &str) -> Option<CatalogEntry> {
    let key = normalize_model_id(model_id);
    if key.is_empty() {
        return None;
    }
    if let Some(provider) = provider.map(str::to_ascii_lowercase) {
        if let Some(entry) = snapshot
            .by_provider
            .get(&provider)
            .and_then(|m| m.get(&key))
        {
            return Some(entry.clone());
        }
    }
    // No provider match: fall back to a global id lookup. Relay endpoints are
    // not the upstream vendor, so their model ids still have to resolve.
    let candidates = snapshot.by_model.get(&key)?;
    candidates
        .iter()
        // Prefer an entry that actually publishes capabilities over a stub row.
        .max_by_key(|entry| {
            u8::from(entry.reasoning_published) * 2 + u8::from(entry.context_window.is_some())
        })
        .cloned()
}

/// Look up one model's capabilities.
///
/// `provider` is the provider's builtin template id when it has one; custom and
/// relay providers pass `None` and match on the model id alone.
pub async fn lookup_model(
    roots: &PathRoots,
    provider: Option<&str>,
    model_id: &str,
) -> CatalogLookup {
    let snapshot = ensure_snapshot(roots).await;
    let entry = lookup_in(&snapshot, provider, model_id);
    debug!(
        target: "model_catalog",
        "模型目录查询 {}/{} -> {}",
        provider.unwrap_or("-"),
        model_id,
        if entry.is_some() { "命中" } else { "未命中" }
    );
    CatalogLookup {
        found: entry.is_some(),
        source: snapshot.source,
        entry,
    }
}

/// Input modalities for a batch of model ids, keyed by the id as given.
///
/// The fetch-models route joins this onto a freshly fetched `/models` list so
/// rows added from the picker carry the catalog's answer instead of a guess.
/// Same precedence as [`lookup_in`]: a scoped provider hit wins, then the
/// global id fallback; ids the catalog does not list are simply absent — a
/// miss stays "undeclared", never a fabricated text-only verdict.
pub async fn input_modalities_for_ids(
    roots: &PathRoots,
    provider: Option<&str>,
    ids: &[String],
) -> std::collections::BTreeMap<String, Vec<String>> {
    let snapshot = ensure_snapshot(roots).await;
    modalities_from_snapshot(&snapshot, provider, ids)
}

/// The synchronous join behind [`input_modalities_for_ids`], split out so the
/// precedence rules are testable against a fixture without touching the
/// network or the process-wide snapshot.
fn modalities_from_snapshot(
    snapshot: &Snapshot,
    provider: Option<&str>,
    ids: &[String],
) -> std::collections::BTreeMap<String, Vec<String>> {
    let mut result = std::collections::BTreeMap::new();
    for id in ids {
        if id.trim().is_empty() || result.contains_key(id) {
            continue;
        }
        if let Some(entry) = lookup_in(snapshot, provider, id) {
            result.insert(id.clone(), entry.input_modalities);
        }
    }
    result
}

/// Display names for the models a provider template can offer, keyed
/// `"<templateId>::<modelId>"`.
///
/// Scoped to the builtin template ids on purpose: those are the providers whose
/// models the user can pick, and the full catalog is 225 providers / 8276 rows
/// (~437 KB) against 547 rows / ~29 KB for ours. Custom providers fall back to
/// prettifying the id the user typed.
pub struct DisplayNames {
    pub names: std::collections::BTreeMap<String, String>,
    pub source: &'static str,
}

/// Upstream appends `(latest)` to the newest alias of a family. The suffix adds
/// nothing once the model is already shown inside a provider group, and our
/// own `deriveResolvedModelName` decoration used to strip it too.
fn clean_display_name(name: &str) -> String {
    let trimmed = name.trim();
    trimmed
        .strip_suffix("(latest)")
        .map(str::trim_end)
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

pub async fn display_names_for_templates(roots: &PathRoots) -> DisplayNames {
    let snapshot = ensure_snapshot(roots).await;
    let mut names = std::collections::BTreeMap::new();
    for template in crate::model_providers::builtin_templates() {
        for (model_id, entry) in snapshot
            .by_provider
            .get(&template.id.to_ascii_lowercase())
            .into_iter()
            .flatten()
        {
            if let Some(name) = entry.name.as_deref() {
                let cleaned = clean_display_name(name);
                if !cleaned.is_empty() {
                    names.insert(format!("{}::{}", template.id, model_id), cleaned);
                }
            }
        }
    }
    DisplayNames {
        names,
        source: snapshot.source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shapes copied verbatim from models.dev/api.json (2026-09-29): the
    // published `reasoning_options` are strategy descriptors, not level lists.
    const FIXTURE: &str = r#"{
        "anthropic": {
            "name": "Anthropic",
            "models": {
                "claude-sonnet-4-5": {
                    "id": "claude-sonnet-4-5",
                    "name": "Claude Sonnet 4.5 (latest)",
                    "reasoning": true,
                    "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high", "xhigh", "max"] }],
                    "limit": { "context": 1000000, "output": 64000 },
                    "modalities": { "input": ["text", "image", "pdf"] }
                },
                "toggle-model": {
                    "id": "toggle-model",
                    "reasoning": true,
                    "reasoning_options": [{ "type": "toggle" }]
                },
                "budget-model": {
                    "id": "budget-model",
                    "reasoning": true,
                    "reasoning_options": [{ "type": "budget_tokens", "min": 1024 }]
                },
                "minimal-model": {
                    "id": "minimal-model",
                    "reasoning": true,
                    "reasoning_options": [{ "type": "effort", "values": ["minimal", "low", "medium", "high"] }]
                },
                "plain-model": { "id": "plain-model", "name": "Plain" }
            }
        },
        "zhipu": {
            "name": "Zhipu",
            "models": { "glm-5.2": { "id": "glm-5.2", "reasoning": true } }
        },
        "broken": "not-an-object"
    }"#;

    fn fixture_snapshot() -> Snapshot {
        parse_catalog(&serde_json::from_str(FIXTURE).unwrap(), "remote")
    }

    #[test]
    fn parses_published_capabilities() {
        let snapshot = fixture_snapshot();
        let entry = lookup_in(&snapshot, Some("anthropic"), "claude-sonnet-4-5").unwrap();
        assert_eq!(entry.name.as_deref(), Some("Claude Sonnet 4.5 (latest)"));
        assert!(entry.reasoning && entry.reasoning_published);
        assert_eq!(
            entry.thinking_levels,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(entry.context_window, Some(1_000_000));
        assert_eq!(entry.max_output_tokens, Some(64_000));
        // pdf is not a modality we track for pi/codex input; only image counts.
        assert_eq!(entry.input_modalities, vec!["text", "image"]);
    }

    #[test]
    fn level_less_reasoning_options_fall_back_to_low_medium_high() {
        // `{"type":"toggle"}` and `{"type":"budget_tokens"}` name no levels, so
        // the model gets the conservative default rather than an empty set —
        // an empty set would mean "does not reason" and silently drop a model
        // that does.
        let snapshot = fixture_snapshot();
        for id in ["toggle-model", "budget-model"] {
            let entry = lookup_in(&snapshot, Some("anthropic"), id).unwrap();
            assert_eq!(entry.thinking_levels, vec!["low", "medium", "high"], "{id}");
        }
    }

    #[test]
    fn catalog_synonyms_fold_onto_our_vocabulary() {
        // `minimal` has no counterpart in our 6-tier vocabulary and folds onto
        // `low`; a duplicate must not appear twice.
        let snapshot = fixture_snapshot();
        let entry = lookup_in(&snapshot, Some("anthropic"), "minimal-model").unwrap();
        assert_eq!(entry.thinking_levels, vec!["low", "medium", "high"]);
    }

    #[test]
    fn unpublished_reasoning_is_treated_as_not_reasoning() {
        let snapshot = fixture_snapshot();
        let entry = lookup_in(&snapshot, Some("anthropic"), "plain-model").unwrap();
        assert!(!entry.reasoning_published);
        assert!(!entry.reasoning);
        assert!(entry.thinking_levels.is_empty());
    }

    #[test]
    fn reasoning_without_level_detail_falls_back_to_low_medium_high() {
        let snapshot = fixture_snapshot();
        let entry = lookup_in(&snapshot, Some("zhipu"), "glm-5.2").unwrap();
        assert_eq!(entry.thinking_levels, vec!["low", "medium", "high"]);
    }

    #[test]
    fn lookup_falls_back_to_model_id_when_provider_does_not_match() {
        // Relay providers are not the upstream vendor, so their models still
        // have to resolve by id alone.
        let snapshot = fixture_snapshot();
        assert!(lookup_in(&snapshot, Some("some-relay"), "claude-sonnet-4-5").is_some());
        assert!(lookup_in(&snapshot, None, "CLAUDE-SONNET-4-5").is_some());
        assert!(lookup_in(&snapshot, None, "anthropic/claude-sonnet-4-5").is_some());
    }

    #[test]
    fn lookup_reports_miss_instead_of_guessing() {
        let snapshot = fixture_snapshot();
        assert!(lookup_in(&snapshot, Some("anthropic"), "my-proxy/internal-7").is_none());
        assert!(lookup_in(&snapshot, None, "  ").is_none());
    }

    #[test]
    fn batch_modalities_join_scopes_then_falls_back_and_skips_misses() {
        let snapshot = fixture_snapshot();
        let ids = vec![
            "claude-sonnet-4-5".to_string(),
            "CLAUDE-SONNET-4-5".to_string(),
            "anthropic/claude-sonnet-4-5".to_string(),
            "my-proxy/internal-7".to_string(),
            "  ".to_string(),
        ];
        let result = modalities_from_snapshot(&snapshot, Some("some-relay"), &ids);
        // pdf is dropped and text is always seeded, matching the single lookup.
        assert_eq!(
            result.get("claude-sonnet-4-5"),
            Some(&vec!["text".to_string(), "image".to_string()])
        );
        // All normalizations of the same id resolve, each keyed as given.
        assert!(result.contains_key("CLAUDE-SONNET-4-5"));
        assert!(result.contains_key("anthropic/claude-sonnet-4-5"));
        // A miss is absent — the caller records "undeclared", not a guess.
        assert!(!result.contains_key("my-proxy/internal-7"));
        assert!(!result.contains_key("  "));
    }

    #[test]
    fn malformed_document_yields_an_empty_snapshot() {
        assert!(parse_catalog(&serde_json::json!([]), "remote")
            .by_model
            .is_empty());
        assert!(parse_catalog(&serde_json::json!({}), "remote")
            .by_model
            .is_empty());
    }

    #[test]
    fn strips_the_upstream_latest_suffix() {
        assert_eq!(
            clean_display_name("Claude Sonnet 4.5 (latest)"),
            "Claude Sonnet 4.5"
        );
        assert_eq!(clean_display_name("  GPT-4o  "), "GPT-4o");
        // Only a trailing "(latest)" is stripped; "(2024-07-18)" is a real
        // snapshot marker and must survive.
        assert_eq!(
            clean_display_name("GPT-4o-mini (2024-07-18)"),
            "GPT-4o-mini (2024-07-18)"
        );
    }

    #[test]
    fn shipped_snapshot_covers_our_builtin_templates() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/desktop/resources/models.dev/api.json"
        );
        let Ok(contents) = std::fs::read_to_string(path) else {
            eprintln!("skipping: bundled snapshot not present at {path}");
            return;
        };
        let document: serde_json::Value = serde_json::from_str(&contents).unwrap();
        let snapshot = parse_catalog(&document, "bundled");

        // The wire-id key a user actually types must resolve for the big
        // relay providers — this is what replaces the hand-written override
        // table.
        for (template, model_id) in [
            ("openrouter", "anthropic/claude-sonnet-4"),
            ("openrouter", "~anthropic/claude-fable-latest"),
            ("openrouter", "openai/gpt-4o"),
            ("siliconflow", "deepseek-ai/DeepSeek-V3"),
            ("opencode-go", "glm-5.1"),
            ("deepseek", "deepseek-v4-flash"),
        ] {
            assert!(
                lookup_in(&snapshot, Some(template), model_id).is_some(),
                "{template}:: {model_id} should be in the snapshot"
            );
        }
    }

    #[test]
    fn parses_the_shipped_catalog_snapshot() {
        // The bundled snapshot is a 5 MB third-party document; this pins that we
        // can read it and that its real-world entries land where we expect.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/desktop/resources/models.dev/api.json"
        );
        let Ok(contents) = std::fs::read_to_string(path) else {
            eprintln!("skipping: bundled snapshot not present at {path}");
            return;
        };
        let document: serde_json::Value =
            serde_json::from_str(&contents).expect("bundled snapshot must be valid JSON");
        let snapshot = parse_catalog(&document, "bundled");
        assert!(
            snapshot.by_provider.len() > 50,
            "expected a populated catalog, got {}",
            snapshot.by_provider.len()
        );

        let sonnet = lookup_in(&snapshot, Some("anthropic"), "claude-sonnet-4-5")
            .expect("claude-sonnet-4-5 should be in the snapshot");
        assert!(sonnet.reasoning_published && sonnet.reasoning);
        assert!(!sonnet.thinking_levels.is_empty());
        assert!(sonnet.context_window.unwrap_or(0) > 0);
        assert_eq!(sonnet.input_modalities, vec!["text", "image"]);

        // Every published thinking level must survive normalization, so the
        // composer can never offer a level pi will refuse.
        for entry in snapshot.by_model.values().flatten() {
            for level in &entry.thinking_levels {
                assert!(
                    crate::model_providers::types::THINKING_LEVELS.contains(&level.as_str()),
                    "{}: unexpected level {level}",
                    entry.model_id
                );
            }
        }
    }
}
