//! Turn Artifact core logic and Tauri commands (R1/S2/SIZ1/E1).

use crate::agent::commands::load_session_history_values;
use crate::agent::turn_meta::count_effective_user_turns;
use crate::agent_runtime::factory::session_runtime_kind_name;
use crate::commands::git::read_git_changed_files_for_tree;
use crate::config::types::AgentKind;
use crate::db::artifact::{upsert_turn_artifact, ArtifactFile, ArtifactSummary, TurnArtifact};
use crate::AppState;
use log::{info, warn};
use std::path::Path;
use std::str::FromStr;
use tauri::State;

/// Per-file UTF-8 byte limit for inline snapshots (SIZ1).
pub const FILE_SNAPSHOT_BYTE_LIMIT: usize = 1024 * 1024; // 1 MiB

/// Count added/removed lines between two text contents using a line-level LCS.
/// Mirrors the frontend `countDiffLines` semantics (drops a trailing empty
/// line introduced by `split('\n')` on content ending with `\n`).
pub fn count_line_diff(old: &str, new: &str) -> (usize, usize) {
    let old_lines = split_diff_lines(old);
    let new_lines = split_diff_lines(new);

    // LCS table — dp[i][j] = length of LCS of old_lines[..i] and new_lines[..j]
    let m = old_lines.len();
    let n = new_lines.len();
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if old_lines[i - 1] == new_lines[j - 1] {
                dp[i - 1][j - 1] + 1
            } else {
                dp[i - 1][j].max(dp[i][j - 1])
            };
        }
    }

    // Backtrack to count added/removed lines.
    let mut additions: usize = 0;
    let mut deletions: usize = 0;
    let mut i = m;
    let mut j = n;
    while i > 0 && j > 0 {
        if old_lines[i - 1] == new_lines[j - 1] {
            i -= 1;
            j -= 1;
        } else if dp[i - 1][j] >= dp[i][j - 1] {
            deletions += 1;
            i -= 1;
        } else {
            additions += 1;
            j -= 1;
        }
    }
    while i > 0 {
        deletions += 1;
        i -= 1;
    }
    while j > 0 {
        additions += 1;
        j -= 1;
    }

    (additions, deletions)
}

/// Split text into lines, dropping a trailing empty line produced by
/// `split('\n')` on content ending with `\n` (matches frontend
/// `splitDiffLines`).
fn split_diff_lines(value: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = value.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// Build the [`ArtifactSummary`] from a list of git-changed files. Applies the
/// SIZ1 1 MiB snapshot limit and aggregates totals.
pub fn build_artifact_summary(
    files: &[crate::commands::git::GitChangedFile],
    project_root: &Path,
) -> ArtifactSummary {
    let mut artifact_files = Vec::with_capacity(files.len());
    let mut total_additions = 0usize;
    let mut total_deletions = 0usize;

    for file in files {
        let original_text = file.original_content.as_deref();
        let current_text = if file.current_content.is_empty() && file.status == "deleted" {
            None
        } else {
            Some(file.current_content.as_str())
        };

        // SIZ1: skip inline snapshots for oversized or binary content.
        let original_bytes = original_text.map(|s| s.len()).unwrap_or(0);
        let current_bytes = current_text.map(|s| s.len()).unwrap_or(0);
        let over_limit =
            original_bytes > FILE_SNAPSHOT_BYTE_LIMIT || current_bytes > FILE_SNAPSHOT_BYTE_LIMIT;

        let (original_snapshot, current_snapshot, content_available) = if over_limit {
            (None, None, false)
        } else {
            (
                original_text.map(|s| s.to_string()),
                current_text.map(|s| s.to_string()),
                true,
            )
        };

        let (additions, deletions) = if content_available {
            let old = original_snapshot.as_deref().unwrap_or("");
            let new = current_snapshot.as_deref().unwrap_or("");
            count_line_diff(old, new)
        } else {
            // Oversized files can't be line-diffed from snapshots; report 0/+N
            // lines based on byte content is unreliable, so we report 0/0 and
            // rely on the card to show content_available=false.
            (0, 0)
        };

        total_additions += additions;
        total_deletions += deletions;

        artifact_files.push(ArtifactFile {
            path: relative_path_from(project_root, &file.path),
            status: file.status.clone(),
            additions,
            deletions,
            original: original_snapshot,
            current: current_snapshot,
            content_available,
        });
    }

    ArtifactSummary {
        schema_version: 1,
        files: artifact_files,
        reverted: false,
        total_additions,
        total_deletions,
    }
}

/// Best-effort conversion of an absolute path to a project-relative path for
/// stable cross-platform storage. Falls back to the original path if the
/// relative computation fails.
fn relative_path_from(project_root: &Path, absolute: &str) -> String {
    let abs = Path::new(absolute);
    match abs.strip_prefix(project_root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => absolute.replace('\\', "/"),
    }
}

/// Build a Turn Artifact for the just-completed turn (R1).
///
/// Computes the effective `turn_ordinal` from agent history, diffs the workspace
/// against the captured baseline tree, snapshots file contents (SIZ1 1 MiB
/// limit), and idempotently upserts to SQLite keyed by (app_session_id,
/// turn_ordinal). Returns `None` for zero-file turns (E1) or any failure
/// (FAIL1: silent degradation).
#[tauri::command]
pub async fn build_turn_artifact(
    state: State<'_, AppState>,
    app_session_id: String,
    project_path: String,
    _turn_id: Option<String>,
    baseline_tree: Option<String>,
) -> Result<Option<TurnArtifact>, String> {
    // F1/FAIL1: baseline missing or capture failed → no artifact, no error.
    let baseline_tree = match baseline_tree {
        Some(tree) if !tree.is_empty() => tree,
        _ => {
            info!(target: "artifact", "No baseline tree for session={}, skipping artifact", app_session_id);
            return Ok(None);
        }
    };

    let project_root = Path::new(&project_path);
    let canonical_root = match project_root.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            warn!(target: "artifact", "Cannot canonicalize project_path {} for session={}: {}", project_path, app_session_id, e);
            return Ok(None);
        }
    };

    // O3: compute effective turn ordinal from agent history.
    let (turn_ordinal, agent_kind) = {
        let db = state.db.lock().unwrap();
        let kind_name = session_runtime_kind_name(&db, &app_session_id)?;
        let agent_kind = AgentKind::from_str(&kind_name)
            .map_err(|e| format!("Cannot parse agent kind {}: {}", kind_name, e))?;
        let history = load_session_history_values(state.inner(), &app_session_id, agent_kind)?;
        let ordinal = count_effective_user_turns(&history);
        (ordinal, agent_kind)
    };
    let _ = agent_kind; // available for future agent-specific handling

    if turn_ordinal == 0 {
        warn!(target: "artifact", "turn_ordinal=0 for session={} (no effective user turns in history); skipping artifact", app_session_id);
        return Ok(None);
    }

    // Diff workspace against the baseline tree.
    let changed_files = match read_git_changed_files_for_tree(&canonical_root, &baseline_tree) {
        Ok(files) => files,
        Err(e) => {
            warn!(target: "artifact", "Git diff failed for session={}: {}", app_session_id, e);
            return Ok(None);
        }
    };

    // E1: zero-file turns do not render a card.
    if changed_files.is_empty() {
        info!(target: "artifact", "Zero file changes for session={} turn={}; no artifact card", app_session_id, turn_ordinal);
        return Ok(None);
    }

    let summary = build_artifact_summary(&changed_files, &canonical_root);

    // Idempotent upsert keyed by (app_session_id, turn_ordinal).
    let artifact = {
        let db = state.db.lock().unwrap();
        upsert_turn_artifact(
            &db,
            &app_session_id,
            turn_ordinal,
            &canonical_root.to_string_lossy(),
            &summary,
        )
        .map_err(|e| {
            warn!(target: "artifact", "DB upsert failed for session={} turn={}: {}", app_session_id, turn_ordinal, e);
            format!("Failed to persist turn artifact: {}", e)
        })?
    };

    info!(target: "artifact", "Built turn artifact for session={} turn={} files={}", app_session_id, turn_ordinal, summary.files.len());
    Ok(Some(artifact))
}

/// Result of a Safe File Revert attempt (RET1).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum RevertResult {
    /// Whole-turn revert succeeded; files restored and `reverted` persisted.
    Reverted { artifact: TurnArtifact },
    /// Pre-check failed for one or more files; zero files were written.
    Conflict { conflicts: Vec<RevertConflict> },
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertConflict {
    pub path: String,
    pub reason: String,
}

/// Perform an idempotent whole-turn Safe File Revert (RV1/RF2).
///
/// Pre-checks every file: must have a snapshot and the current disk content
/// must equal `artifact.current` (still modified) or `artifact.original`
/// (already reverted). On any conflict the whole turn is aborted with zero
/// files written. On success, files are restored and `reverted=true` is
/// persisted.
#[tauri::command]
pub async fn revert_turn_artifact(
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<RevertResult, String> {
    let artifact = {
        let db = state.db.lock().unwrap();
        crate::db::artifact::get_turn_artifact(&db, &artifact_id)
            .map_err(|e| format!("Failed to load artifact: {}", e))?
    }
    .ok_or_else(|| format!("Artifact not found: {}", artifact_id))?;

    match perform_safe_revert(artifact) {
        Ok(reverted) => {
            // Persist reverted flag.
            let db = state.db.lock().unwrap();
            crate::db::artifact::update_turn_artifact_summary(&db, &reverted.id, &reverted.summary)
                .map_err(|e| format!("Failed to persist reverted state: {}", e))?;
            Ok(RevertResult::Reverted { artifact: reverted })
        }
        Err(conflict) => Ok(conflict),
    }
}

/// Pure file-system Safe Revert: pre-check then restore. No DB access —
/// the caller persists the result. Returns the updated artifact (with
/// `reverted=true`) on success, or a `Conflict` result on failure.
#[allow(clippy::result_large_err)]
fn perform_safe_revert(mut artifact: TurnArtifact) -> Result<TurnArtifact, RevertResult> {
    let project_root = Path::new(&artifact.project_path);
    if !project_root.exists() {
        return Err(RevertResult::Conflict {
            conflicts: vec![RevertConflict {
                path: artifact.project_path.clone(),
                reason: "Project path is not accessible".to_string(),
            }],
        });
    }

    // Pre-check all files.
    let mut conflicts = Vec::new();
    let mut restores: Vec<(std::path::PathBuf, Option<String>)> = Vec::new();
    for file in &artifact.summary.files {
        if !file.content_available {
            conflicts.push(RevertConflict {
                path: file.path.clone(),
                reason: "No snapshot available (oversized or binary file)".to_string(),
            });
            continue;
        }
        let abs = project_root.join(&file.path);
        let current_disk = match std::fs::read_to_string(&abs) {
            Ok(content) => content,
            Err(_) if file.status == "added" || file.status == "deleted" => {
                // added file may be absent if already reverted;
                // deleted file is absent on disk (its current snapshot is empty).
                String::new()
            }
            Err(e) => {
                conflicts.push(RevertConflict {
                    path: file.path.clone(),
                    reason: format!("Cannot read current file: {}", e),
                });
                continue;
            }
        };

        let snapshot_current = file.current.clone().unwrap_or_default();
        let snapshot_original = file.original.clone();

        // Already reverted: current == original.
        if let Some(original) = &snapshot_original {
            if current_disk == *original {
                // Already restored — no action needed for this file.
                continue;
            }
        }

        // Conflict: current disk doesn't match artifact.current (modified since).
        if current_disk != snapshot_current {
            conflicts.push(RevertConflict {
                path: file.path.clone(),
                reason: "File was modified after the turn; cannot safely revert".to_string(),
            });
            continue;
        }

        // Plan restore: added→delete (None), deleted/modified→write original.
        match file.status.as_str() {
            "added" => restores.push((abs, None)),
            "deleted" | "modified" => {
                let original = snapshot_original.unwrap_or_default();
                restores.push((abs, Some(original)));
            }
            _ => conflicts.push(RevertConflict {
                path: file.path.clone(),
                reason: format!("Unknown status: {}", file.status),
            }),
        }
    }

    if !conflicts.is_empty() {
        return Err(RevertResult::Conflict { conflicts });
    }

    // Execute restores (atomic-ish: write all, fail loudly).
    for (path, content) in &restores {
        if let Some(content) = content {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(path, content).map_err(|e| RevertResult::Conflict {
                conflicts: vec![RevertConflict {
                    path: path.to_string_lossy().to_string(),
                    reason: format!("Write failed: {}", e),
                }],
            })?;
        } else {
            let _ = std::fs::remove_file(path);
        }
    }

    artifact.summary.reverted = true;
    Ok(artifact)
}

/// H3 filter: keep only artifacts whose `turn_ordinal` is `<= effective_turn_count`
/// (the current number of effective user turns in the agent history).
/// Artifacts with `turn_ordinal > effective_turn_count` represent turns that
/// no longer exist in history (e.g. after rewind) and must be filtered out
/// (H3 / RGC1 recovery path).
pub fn filter_artifacts_by_effective_turns(
    artifacts: Vec<TurnArtifact>,
    effective_turn_count: u32,
) -> Vec<TurnArtifact> {
    artifacts
        .into_iter()
        .filter(|a| a.turn_ordinal <= effective_turn_count)
        .collect()
}

/// Load all Turn Artifacts for a session, applying the H3 filter against the
/// current agent history's effective user turn count.
///
/// Loads artifacts from SQLite, loads agent history values, counts effective
/// user turns `N`, and returns only artifacts with `turn_ordinal <= N`.
/// Returns an error if DB or history loading fails; the frontend can fall
/// back to an empty list (A1/H3).
#[tauri::command]
pub async fn load_turn_artifacts(
    state: State<'_, AppState>,
    app_session_id: String,
) -> Result<Vec<TurnArtifact>, String> {
    let artifacts = {
        let db = state.db.lock().unwrap();
        crate::db::artifact::load_turn_artifacts(&db, &app_session_id).map_err(|e| {
            warn!(target: "artifact", "Failed to load artifacts for session={}: {}", app_session_id, e);
            format!("Failed to load turn artifacts: {}", e)
        })?
    };
    let total = artifacts.len();

    let kind_name = {
        let db = state.db.lock().unwrap();
        session_runtime_kind_name(&db, &app_session_id).map_err(|e| {
            warn!(target: "artifact", "Cannot resolve agent kind for session={}: {}", app_session_id, e);
            e
        })?
    };
    let agent_kind = AgentKind::from_str(&kind_name).map_err(|e| {
        warn!(target: "artifact", "Cannot parse agent kind {} for session={}: {}", kind_name, app_session_id, e);
        e
    })?;

    let history = load_session_history_values(state.inner(), &app_session_id, agent_kind).map_err(|e| {
        warn!(target: "artifact", "Failed to load history for H3 filter session={}: {}", app_session_id, e);
        e
    })?;
    let effective_turn_count = count_effective_user_turns(&history);

    let filtered = filter_artifacts_by_effective_turns(artifacts, effective_turn_count);
    info!(
        target: "artifact",
        "Loaded {} artifacts (of {} persisted) for session={} effective_turns={}",
        filtered.len(),
        total,
        app_session_id,
        effective_turn_count,
    );
    Ok(filtered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_line_diff_identical_content_has_zero_changes() {
        let content = "line1\nline2\nline3\n";
        assert_eq!(count_line_diff(content, content), (0, 0));
    }

    #[test]
    fn count_line_diff_adds_lines() {
        let old = "a\nb\n";
        let new = "a\nb\nc\nd\n";
        assert_eq!(count_line_diff(old, new), (2, 0));
    }

    #[test]
    fn count_line_diff_removes_lines() {
        let old = "a\nb\nc\nd\n";
        let new = "a\nb\n";
        assert_eq!(count_line_diff(old, new), (0, 2));
    }

    #[test]
    fn count_line_diff_modifies_line() {
        let old = "one\ntwo\nthree\n";
        let new = "ONE\ntwo\nthree\n";
        assert_eq!(count_line_diff(old, new), (1, 1));
    }

    #[test]
    fn build_summary_aggregates_files_and_totals() {
        use crate::commands::git::GitChangedFile;
        use std::path::Path;

        let files = vec![
            GitChangedFile {
                path: "/proj/modified.txt".into(),
                status: "modified".into(),
                original_content: Some("one\ntwo\n".into()),
                current_content: "ONE\ntwo\nTHREE\n".into(),
            },
            GitChangedFile {
                path: "/proj/added.txt".into(),
                status: "added".into(),
                original_content: None,
                current_content: "new\n".into(),
            },
        ];

        let summary = build_artifact_summary(&files, Path::new("/proj"));

        assert_eq!(summary.files.len(), 2);
        assert_eq!(summary.schema_version, 1);
        assert!(!summary.reverted);

        let modified = &summary.files[0];
        assert_eq!(modified.status, "modified");
        assert_eq!(modified.additions, 2);
        assert_eq!(modified.deletions, 1);
        assert_eq!(modified.original.as_deref(), Some("one\ntwo\n"));
        assert_eq!(modified.current.as_deref(), Some("ONE\ntwo\nTHREE\n"));
        assert!(modified.content_available);

        let added = &summary.files[1];
        assert_eq!(added.status, "added");
        assert_eq!(added.additions, 1);
        assert_eq!(added.deletions, 0);
        assert!(added.original.is_none());
        assert_eq!(added.current.as_deref(), Some("new\n"));
        assert!(added.content_available);

        assert_eq!(summary.total_additions, 3);
        assert_eq!(summary.total_deletions, 1);
    }

    #[test]
    fn build_summary_omits_snapshots_over_1mib() {
        use crate::commands::git::GitChangedFile;
        use std::path::Path;

        let big = "x".repeat(FILE_SNAPSHOT_BYTE_LIMIT + 1);
        let files = vec![GitChangedFile {
            path: "/proj/big.txt".into(),
            status: "modified".into(),
            original_content: Some("old\n".into()),
            current_content: big.clone(),
        }];

        let summary = build_artifact_summary(&files, Path::new("/proj"));

        let big_file = &summary.files[0];
        assert!(
            !big_file.content_available,
            "file over 1MiB should have content_available=false"
        );
        assert!(
            big_file.original.is_none(),
            "original snapshot should be omitted for oversized file"
        );
        assert!(
            big_file.current.is_none(),
            "current snapshot should be omitted for oversized file"
        );
        // Still carries status and a +/- count based on byte-size heuristic.
        assert_eq!(big_file.status, "modified");
    }

    fn make_artifact(project_root: &Path, files: Vec<ArtifactFile>) -> TurnArtifact {
        TurnArtifact {
            id: "test-id".to_string(),
            app_session_id: "session-1".to_string(),
            turn_ordinal: 1,
            project_path: project_root.to_string_lossy().to_string(),
            summary: ArtifactSummary {
                schema_version: 1,
                files,
                reverted: false,
                total_additions: 0,
                total_deletions: 0,
            },
            created_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn safe_revert_restores_modified_file_to_original() {
        let project =
            std::env::temp_dir().join(format!("codemux-revert-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("modified.txt"), "ONE\ntwo\nTHREE\n").unwrap();

        let files = vec![ArtifactFile {
            path: "modified.txt".into(),
            status: "modified".into(),
            additions: 2,
            deletions: 1,
            original: Some("one\ntwo\n".into()),
            current: Some("ONE\ntwo\nTHREE\n".into()),
            content_available: true,
        }];
        let artifact = make_artifact(&project, files);

        let result = perform_safe_revert(artifact).unwrap();
        assert!(result.summary.reverted);
        assert_eq!(
            std::fs::read_to_string(project.join("modified.txt")).unwrap(),
            "one\ntwo\n"
        );

        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn safe_revert_deletes_added_file() {
        let project =
            std::env::temp_dir().join(format!("codemux-revert-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("added.txt"), "new content\n").unwrap();

        let files = vec![ArtifactFile {
            path: "added.txt".into(),
            status: "added".into(),
            additions: 1,
            deletions: 0,
            original: None,
            current: Some("new content\n".into()),
            content_available: true,
        }];
        let artifact = make_artifact(&project, files);

        let result = perform_safe_revert(artifact).unwrap();
        assert!(result.summary.reverted);
        assert!(
            !project.join("added.txt").exists(),
            "added file should be deleted"
        );

        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn safe_revert_restores_deleted_file() {
        let project =
            std::env::temp_dir().join(format!("codemux-revert-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project).unwrap();
        // File is currently absent (was deleted during the turn)

        let files = vec![ArtifactFile {
            path: "deleted.txt".into(),
            status: "deleted".into(),
            additions: 0,
            deletions: 1,
            original: Some("gone\n".into()),
            current: Some(String::new()),
            content_available: true,
        }];
        let artifact = make_artifact(&project, files);

        let result = perform_safe_revert(artifact).unwrap();
        assert!(result.summary.reverted);
        assert_eq!(
            std::fs::read_to_string(project.join("deleted.txt")).unwrap(),
            "gone\n"
        );

        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn safe_revert_conflicts_when_file_modified_since_turn() {
        let project =
            std::env::temp_dir().join(format!("codemux-revert-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project).unwrap();
        // Disk content differs from both original and current snapshot
        std::fs::write(project.join("modified.txt"), "TOTALLY DIFFERENT\n").unwrap();

        let files = vec![ArtifactFile {
            path: "modified.txt".into(),
            status: "modified".into(),
            additions: 1,
            deletions: 1,
            original: Some("one\n".into()),
            current: Some("ONE\n".into()),
            content_available: true,
        }];
        let artifact = make_artifact(&project, files);

        let err = perform_safe_revert(artifact).unwrap_err();
        match err {
            RevertResult::Conflict { conflicts } => {
                assert_eq!(conflicts.len(), 1);
                assert!(conflicts[0].path.ends_with("modified.txt"));
                assert!(conflicts[0].reason.contains("modified after the turn"));
            }
            _ => panic!("expected Conflict"),
        }
        // File unchanged
        assert_eq!(
            std::fs::read_to_string(project.join("modified.txt")).unwrap(),
            "TOTALLY DIFFERENT\n"
        );

        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn safe_revert_is_idempotent_when_already_reverted() {
        let project =
            std::env::temp_dir().join(format!("codemux-revert-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project).unwrap();
        // Disk already matches original
        std::fs::write(project.join("modified.txt"), "one\ntwo\n").unwrap();

        let files = vec![ArtifactFile {
            path: "modified.txt".into(),
            status: "modified".into(),
            additions: 2,
            deletions: 1,
            original: Some("one\ntwo\n".into()),
            current: Some("ONE\ntwo\nTHREE\n".into()),
            content_available: true,
        }];
        let artifact = make_artifact(&project, files);

        let result = perform_safe_revert(artifact).unwrap();
        assert!(result.summary.reverted);
        // File still matches original (no write happened)
        assert_eq!(
            std::fs::read_to_string(project.join("modified.txt")).unwrap(),
            "one\ntwo\n"
        );

        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn safe_revert_conflicts_for_oversized_file_without_snapshot() {
        let project =
            std::env::temp_dir().join(format!("codemux-revert-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("big.txt"), "x".repeat(100)).unwrap();

        let files = vec![ArtifactFile {
            path: "big.txt".into(),
            status: "modified".into(),
            additions: 0,
            deletions: 0,
            original: None,
            current: None,
            content_available: false,
        }];
        let artifact = make_artifact(&project, files);

        let err = perform_safe_revert(artifact).unwrap_err();
        match err {
            RevertResult::Conflict { conflicts } => {
                assert_eq!(conflicts.len(), 1);
                assert!(conflicts[0].reason.contains("No snapshot"));
            }
            _ => panic!("expected Conflict"),
        }

        let _ = std::fs::remove_dir_all(project);
    }

    fn make_artifact_with_ordinal(ordinal: u32) -> TurnArtifact {
        TurnArtifact {
            id: format!("id-{}", ordinal),
            app_session_id: "session-1".to_string(),
            turn_ordinal: ordinal,
            project_path: "/project".to_string(),
            summary: ArtifactSummary {
                schema_version: 1,
                files: vec![],
                reverted: false,
                total_additions: 0,
                total_deletions: 0,
            },
            created_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn h3_filter_keeps_artifacts_with_ordinal_le_count() {
        let artifacts = vec![
            make_artifact_with_ordinal(1),
            make_artifact_with_ordinal(2),
            make_artifact_with_ordinal(3),
        ];
        let filtered = filter_artifacts_by_effective_turns(artifacts, 2);
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].turn_ordinal, 1);
        assert_eq!(filtered[1].turn_ordinal, 2);
    }

    #[test]
    fn h3_filter_drops_artifacts_with_ordinal_gt_count() {
        let artifacts = vec![
            make_artifact_with_ordinal(1),
            make_artifact_with_ordinal(2),
            make_artifact_with_ordinal(3),
            make_artifact_with_ordinal(4),
        ];
        let filtered = filter_artifacts_by_effective_turns(artifacts, 2);
        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().all(|a| a.turn_ordinal <= 2));
    }

    #[test]
    fn h3_filter_with_zero_count_returns_empty() {
        let artifacts = vec![make_artifact_with_ordinal(1), make_artifact_with_ordinal(2)];
        let filtered = filter_artifacts_by_effective_turns(artifacts, 0);
        assert!(filtered.is_empty(), "no effective turns → no artifacts");
    }

    #[test]
    fn h3_filter_keeps_all_when_count_ge_max_ordinal() {
        let artifacts = vec![
            make_artifact_with_ordinal(1),
            make_artifact_with_ordinal(2),
            make_artifact_with_ordinal(3),
        ];
        let filtered = filter_artifacts_by_effective_turns(artifacts, 5);
        assert_eq!(filtered.len(), 3);
        assert_eq!(filtered[0].turn_ordinal, 1);
        assert_eq!(filtered[1].turn_ordinal, 2);
        assert_eq!(filtered[2].turn_ordinal, 3);
    }

    #[test]
    fn h3_filter_preserves_input_order() {
        let artifacts = vec![
            make_artifact_with_ordinal(2),
            make_artifact_with_ordinal(1),
            make_artifact_with_ordinal(3),
        ];
        let filtered = filter_artifacts_by_effective_turns(artifacts, 2);
        assert_eq!(filtered.len(), 2);
        // Order preserved from input
        assert_eq!(filtered[0].turn_ordinal, 2);
        assert_eq!(filtered[1].turn_ordinal, 1);
    }

    #[test]
    fn h3_filter_empty_input_returns_empty() {
        let filtered = filter_artifacts_by_effective_turns(Vec::new(), 10);
        assert!(filtered.is_empty());
    }
}
