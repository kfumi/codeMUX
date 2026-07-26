use chrono::Utc;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Single file entry in a Turn Artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFile {
    pub path: String,
    pub status: String, // "added" | "modified" | "deleted"
    pub additions: usize,
    pub deletions: usize,
    pub original: Option<String>,
    pub current: Option<String>,
    pub content_available: bool,
}

/// The summary_json content stored in the database (VER1: schemaVersion: 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub schema_version: u32,
    pub files: Vec<ArtifactFile>,
    pub reverted: bool,
    pub total_additions: usize,
    pub total_deletions: usize,
}

/// A Turn Artifact record as stored in SQLite and returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnArtifact {
    pub id: String,
    pub app_session_id: String,
    pub turn_ordinal: u32,
    pub project_path: String,
    pub summary: ArtifactSummary,
    pub created_at: String,
}

/// Idempotent upsert by (app_session_id, turn_ordinal). On conflict the
/// existing record's `id` and `created_at` are preserved; `project_path` and
/// `summary_json` are replaced (R1).
pub fn upsert_turn_artifact(
    conn: &Connection,
    app_session_id: &str,
    turn_ordinal: u32,
    project_path: &str,
    summary: &ArtifactSummary,
) -> Result<TurnArtifact> {
    let summary_json = serde_json::to_string(summary)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();

    conn.execute(
        "INSERT INTO turn_artifacts (id, app_session_id, turn_ordinal, project_path, summary_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(app_session_id, turn_ordinal) DO UPDATE SET
            project_path = excluded.project_path,
            summary_json = excluded.summary_json",
        params![id, app_session_id, turn_ordinal, project_path, summary_json, now],
    )?;

    // Read back — id/created_at may be from the original insert on conflict
    load_turn_artifacts(conn, app_session_id)?
        .into_iter()
        .find(|a| a.turn_ordinal == turn_ordinal)
        .ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Load all Turn Artifacts for a session, ordered by turn_ordinal ascending.
pub fn load_turn_artifacts(conn: &Connection, app_session_id: &str) -> Result<Vec<TurnArtifact>> {
    let mut stmt = conn.prepare(
        "SELECT id, app_session_id, turn_ordinal, project_path, summary_json, created_at
         FROM turn_artifacts
         WHERE app_session_id = ?1
         ORDER BY turn_ordinal ASC",
    )?;

    let rows = stmt.query_map(params![app_session_id], |row| {
        let summary_json: String = row.get(4)?;
        let summary: ArtifactSummary = serde_json::from_str(&summary_json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(TurnArtifact {
            id: row.get(0)?,
            app_session_id: row.get(1)?,
            turn_ordinal: row.get(2)?,
            project_path: row.get(3)?,
            summary,
            created_at: row.get(5)?,
        })
    })?;

    let mut artifacts = Vec::new();
    for row in rows {
        artifacts.push(row?);
    }
    Ok(artifacts)
}

/// Delete all Turn Artifacts with turn_ordinal >= cutoff (RW1 Rewind GC).
pub fn delete_turn_artifacts_from_ordinal(
    conn: &Connection,
    app_session_id: &str,
    cutoff_ordinal: u32,
) -> Result<usize> {
    conn.execute(
        "DELETE FROM turn_artifacts WHERE app_session_id = ?1 AND turn_ordinal >= ?2",
        params![app_session_id, cutoff_ordinal],
    )
}

/// Load a single Turn Artifact by its id (for Safe File Revert, RV1).
pub fn get_turn_artifact(conn: &Connection, artifact_id: &str) -> Result<Option<TurnArtifact>> {
    let mut stmt = conn.prepare(
        "SELECT id, app_session_id, turn_ordinal, project_path, summary_json, created_at
         FROM turn_artifacts WHERE id = ?1",
    )?;

    let row = stmt.query_row(params![artifact_id], |row| {
        let summary_json: String = row.get(4)?;
        let summary: ArtifactSummary = serde_json::from_str(&summary_json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(TurnArtifact {
            id: row.get(0)?,
            app_session_id: row.get(1)?,
            turn_ordinal: row.get(2)?,
            project_path: row.get(3)?,
            summary,
            created_at: row.get(5)?,
        })
    });

    match row {
        Ok(artifact) => Ok(Some(artifact)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Update the summary_json (including the `reverted` flag) of an existing
/// Turn Artifact. Used by Safe File Revert to persist reverted status (V2).
pub fn update_turn_artifact_summary(
    conn: &Connection,
    artifact_id: &str,
    summary: &ArtifactSummary,
) -> Result<()> {
    let summary_json = serde_json::to_string(summary)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "UPDATE turn_artifacts SET summary_json = ?1 WHERE id = ?2",
        params![summary_json, artifact_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::initialize_database;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        initialize_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                "session-1",
                "Test",
                "claude_code",
                "chat",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();
        conn
    }

    fn empty_summary() -> ArtifactSummary {
        ArtifactSummary {
            schema_version: 1,
            files: vec![],
            reverted: false,
            total_additions: 0,
            total_deletions: 0,
        }
    }

    #[test]
    fn upsert_inserts_and_returns_artifact() {
        let conn = setup_db();
        let summary = empty_summary();

        let artifact =
            upsert_turn_artifact(&conn, "session-1", 1, "/project/path", &summary).unwrap();

        assert_eq!(artifact.app_session_id, "session-1");
        assert_eq!(artifact.turn_ordinal, 1);
        assert_eq!(artifact.project_path, "/project/path");
        assert!(!artifact.id.is_empty());
        assert_eq!(artifact.summary.schema_version, 1);
        assert!(!artifact.created_at.is_empty());
    }

    #[test]
    fn upsert_is_idempotent_by_session_and_ordinal() {
        let conn = setup_db();
        let summary = empty_summary();

        let first = upsert_turn_artifact(&conn, "session-1", 1, "/path-a", &summary).unwrap();
        // Second upsert with same (session, ordinal) replaces content but keeps id
        let second = upsert_turn_artifact(&conn, "session-1", 1, "/path-b", &summary).unwrap();

        assert_eq!(first.id, second.id, "id should be preserved on conflict");
        assert_eq!(
            second.project_path, "/path-b",
            "project_path should be updated"
        );

        let all = load_turn_artifacts(&conn, "session-1").unwrap();
        assert_eq!(all.len(), 1, "should not create duplicate");
    }

    #[test]
    fn delete_from_ordinal_removes_tail_artifacts() {
        let conn = setup_db();
        let summary = empty_summary();

        upsert_turn_artifact(&conn, "session-1", 1, "/p", &summary).unwrap();
        upsert_turn_artifact(&conn, "session-1", 2, "/p", &summary).unwrap();
        upsert_turn_artifact(&conn, "session-1", 3, "/p", &summary).unwrap();

        let deleted = delete_turn_artifacts_from_ordinal(&conn, "session-1", 2).unwrap();
        assert_eq!(deleted, 2, "should delete ordinals 2 and 3");

        let remaining = load_turn_artifacts(&conn, "session-1").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].turn_ordinal, 1);
    }

    #[test]
    fn get_turn_artifact_returns_by_id() {
        let conn = setup_db();
        let summary = empty_summary();

        let stored = upsert_turn_artifact(&conn, "session-1", 1, "/project", &summary).unwrap();

        let loaded = get_turn_artifact(&conn, &stored.id).unwrap().unwrap();
        assert_eq!(loaded.id, stored.id);
        assert_eq!(loaded.turn_ordinal, 1);
        assert_eq!(loaded.project_path, "/project");

        // Non-existent id returns None
        assert!(get_turn_artifact(&conn, "nonexistent-id")
            .unwrap()
            .is_none());
    }

    #[test]
    fn update_summary_persists_reverted_flag() {
        let conn = setup_db();
        let mut summary = empty_summary();
        let stored = upsert_turn_artifact(&conn, "session-1", 1, "/project", &summary).unwrap();
        assert!(!stored.summary.reverted);

        summary.reverted = true;
        update_turn_artifact_summary(&conn, &stored.id, &summary).unwrap();

        let reloaded = get_turn_artifact(&conn, &stored.id).unwrap().unwrap();
        assert!(
            reloaded.summary.reverted,
            "reverted flag should be persisted"
        );
    }

    #[test]
    fn deleting_session_cascades_to_artifacts() {
        let conn = setup_db();
        let summary = empty_summary();

        upsert_turn_artifact(&conn, "session-1", 1, "/p", &summary).unwrap();
        upsert_turn_artifact(&conn, "session-1", 2, "/p", &summary).unwrap();

        // Delete the session — artifacts should cascade-delete (GC1)
        conn.execute("DELETE FROM sessions WHERE id = ?1", params!["session-1"])
            .unwrap();

        let remaining = load_turn_artifacts(&conn, "session-1").unwrap();
        assert!(remaining.is_empty(), "artifacts should be cascade-deleted");
    }
}
