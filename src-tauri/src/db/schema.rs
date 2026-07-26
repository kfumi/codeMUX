use rusqlite::{Connection, Result};

pub fn initialize_database(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    // 创建表（新库直接包含所有列）
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            agent_kind TEXT NOT NULL DEFAULT 'claude_code',
            provider_id TEXT,
            model TEXT,
            reasoning_effort TEXT DEFAULT 'medium',
            mode TEXT NOT NULL DEFAULT 'chat',
            permission_config TEXT NOT NULL DEFAULT '',
            plan_mode TEXT NOT NULL DEFAULT 'off',
            project_id TEXT,
            is_archived INTEGER NOT NULL DEFAULT 0,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS agent_session_mappings (
            app_session_id TEXT NOT NULL,
            agent_kind TEXT NOT NULL,
            agent_session_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (app_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            UNIQUE(app_session_id, agent_kind),
            UNIQUE(agent_kind, agent_session_id)
        );

        CREATE TABLE IF NOT EXISTS mcp_servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            transport_type TEXT NOT NULL,
            transport_config TEXT NOT NULL,
            always_load INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);

        CREATE TABLE IF NOT EXISTS skills (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT,
            description TEXT,
            source_repo TEXT,
            source_path TEXT,
            version TEXT,
            installed_at TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            is_builtin INTEGER NOT NULL DEFAULT 0,
            enabled_claude INTEGER NOT NULL DEFAULT 0,
            enabled_codex INTEGER NOT NULL DEFAULT 0,
            enabled_gemini INTEGER NOT NULL DEFAULT 0,
            enabled_opencode INTEGER NOT NULL DEFAULT 0,
            disk_path TEXT,
            directory TEXT NOT NULL DEFAULT ''
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

        CREATE TABLE IF NOT EXISTS turn_artifacts (
            id TEXT PRIMARY KEY,
            app_session_id TEXT NOT NULL,
            turn_ordinal INTEGER NOT NULL,
            project_path TEXT NOT NULL,
            summary_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (app_session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_artifacts_session_ordinal
            ON turn_artifacts(app_session_id, turn_ordinal);
        ",
    )?;

    // Migration: add mode column if missing
    let has_mode: bool = conn.prepare("SELECT mode FROM sessions LIMIT 0").is_ok();
    if !has_mode {
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'",
            [],
        );
    }

    // Migration: add project_id column if missing
    let has_project_id: bool = conn
        .prepare("SELECT project_id FROM sessions LIMIT 0")
        .is_ok();
    if !has_project_id {
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL", []);
    }

    // Migration: add agent_kind column if missing
    let has_agent_kind: bool = conn
        .prepare("SELECT agent_kind FROM sessions LIMIT 0")
        .is_ok();
    if !has_agent_kind {
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'claude_code'",
            [],
        );
    }

    // Migration: add reasoning_effort column if missing
    let has_reasoning_effort: bool = conn
        .prepare("SELECT reasoning_effort FROM sessions LIMIT 0")
        .is_ok();
    if !has_reasoning_effort {
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT DEFAULT 'medium'",
            [],
        );
    }

    let has_permission_config: bool = conn
        .prepare("SELECT permission_config FROM sessions LIMIT 0")
        .is_ok();
    if !has_permission_config {
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN permission_config TEXT NOT NULL DEFAULT ''",
            [],
        );
    }

    let has_plan_mode: bool = conn
        .prepare("SELECT plan_mode FROM sessions LIMIT 0")
        .is_ok();
    if !has_plan_mode {
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN plan_mode TEXT NOT NULL DEFAULT 'off'",
            [],
        );
    }

    // Migration: archived_at → is_archived
    let has_archived_at: bool = conn
        .prepare("SELECT archived_at FROM sessions LIMIT 0")
        .is_ok();
    let has_is_archived: bool = conn
        .prepare("SELECT is_archived FROM sessions LIMIT 0")
        .is_ok();
    if has_archived_at && !has_is_archived {
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "UPDATE sessions SET is_archived = 1 WHERE archived_at IS NOT NULL",
            [],
        );
        // SQLite doesn't support DROP COLUMN before 3.35; leave archived_at in place
    } else if !has_is_archived {
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0",
            [],
        );
    }

    let has_is_pinned: bool = conn
        .prepare("SELECT is_pinned FROM sessions LIMIT 0")
        .is_ok();
    if !has_is_pinned {
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
            [],
        );
    }

    let _ = conn.execute("DROP TABLE IF EXISTS tool_calls", []);
    let _ = conn.execute("DROP TABLE IF EXISTS messages", []);

    // Migration: migrate mcp_servers from legacy schema to per-app schema
    // Must run BEFORE subtitle/always_load migrations since those columns
    // are dropped during the table rebuild.
    migrate_mcp_servers_table(conn)?;

    // Migration: add disk_path column to skills if missing
    let has_disk_path: bool = conn.prepare("SELECT disk_path FROM skills LIMIT 0").is_ok();
    if !has_disk_path {
        let _ = conn.execute("ALTER TABLE skills ADD COLUMN disk_path TEXT", []);
    }

    // Migration: add directory column to skills if missing
    let has_directory: bool = conn.prepare("SELECT directory FROM skills LIMIT 0").is_ok();
    if !has_directory {
        let _ = conn.execute(
            "ALTER TABLE skills ADD COLUMN directory TEXT NOT NULL DEFAULT ''",
            [],
        );
    }

    // Migration: migrate skills from legacy `enabled` column to per-app columns
    let has_enabled_claude: bool = conn
        .prepare("SELECT enabled_claude FROM skills LIMIT 0")
        .is_ok();
    if !has_enabled_claude {
        let _ = conn.execute(
            "ALTER TABLE skills ADD COLUMN enabled_claude INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE skills ADD COLUMN enabled_codex INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE skills ADD COLUMN enabled_gemini INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE skills ADD COLUMN enabled_opencode INTEGER NOT NULL DEFAULT 0",
            [],
        );
        // Migrate data: skills that were previously enabled get claude enabled
        let _ = conn.execute(
            "UPDATE skills SET enabled_claude = 1 WHERE enabled = 1 AND enabled_claude = 0",
            [],
        );
    }

    // 创建索引（在所有迁移之后，确保列存在）
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_agent_session_mappings_app_session_id ON agent_session_mappings(app_session_id);
        CREATE INDEX IF NOT EXISTS idx_turn_artifacts_app_session_id ON turn_artifacts(app_session_id);
        "
    )?;

    Ok(())
}

fn migrate_mcp_servers_table(conn: &Connection) -> Result<()> {
    let has_server_config = conn
        .prepare("SELECT server_config FROM mcp_servers LIMIT 0")
        .is_ok();

    if has_server_config {
        // Already on new schema — ensure description column exists
        let has_description = conn
            .prepare("SELECT description FROM mcp_servers LIMIT 0")
            .is_ok();
        if !has_description {
            conn.execute(
                "ALTER TABLE mcp_servers ADD COLUMN description TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        return Ok(());
    }

    // No legacy enabled column either — fresh DB before any rows were inserted
    let has_legacy_enabled = conn
        .prepare("SELECT enabled FROM mcp_servers LIMIT 0")
        .is_ok();
    if !has_legacy_enabled {
        return Ok(());
    }

    conn.execute_batch(
        r#"
        ALTER TABLE mcp_servers RENAME TO mcp_servers_legacy;

        CREATE TABLE mcp_servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            server_config TEXT NOT NULL,
            enabled_claude INTEGER NOT NULL DEFAULT 0,
            enabled_codex INTEGER NOT NULL DEFAULT 0,
            enabled_gemini INTEGER NOT NULL DEFAULT 0,
            enabled_opencode INTEGER NOT NULL DEFAULT 0
        );

        INSERT INTO mcp_servers (
            id, name, description, server_config,
            enabled_claude, enabled_codex, enabled_gemini, enabled_opencode
        )
        SELECT
            id,
            name,
            COALESCE(description, ''),
            transport_config,
            CASE WHEN enabled = 1 THEN 1 ELSE 0 END,
            0,
            0,
            0
        FROM mcp_servers_legacy;

        DROP TABLE mcp_servers_legacy;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
        "#,
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::initialize_database;
    use rusqlite::Connection;

    #[test]
    fn migrates_sessions_agent_kind_with_default() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT,
                model TEXT,
                project_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            ",
        )
        .unwrap();

        conn.execute(
            "INSERT INTO sessions (id, title, provider_id, model, project_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "session-1",
                "Test Session",
                Option::<String>::None,
                Option::<String>::None,
                Option::<String>::None,
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();

        initialize_database(&conn).unwrap();

        let agent_kind: String = conn
            .query_row(
                "SELECT agent_kind FROM sessions WHERE id = ?1",
                ["session-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(agent_kind, "claude_code");
    }

    #[test]
    fn migrates_sessions_permission_snapshot_columns_with_safe_defaults() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                agent_kind TEXT NOT NULL DEFAULT 'claude_code',
                provider_id TEXT,
                model TEXT,
                mode TEXT NOT NULL DEFAULT 'chat',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at)
            VALUES ('session-1', 'Legacy', 'codex', 'agent', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            ",
        )
        .unwrap();

        initialize_database(&conn).unwrap();

        let row = conn
            .query_row(
                "SELECT permission_config, plan_mode FROM sessions WHERE id = 'session-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();

        assert_eq!(row.0, "");
        assert_eq!(row.1, "off");
    }

    #[test]
    fn migrates_sessions_pinned_column_with_default_false() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                agent_kind TEXT NOT NULL DEFAULT 'codex',
                mode TEXT NOT NULL DEFAULT 'agent',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at)
            VALUES ('session-1', 'Legacy', 'codex', 'agent', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            ",
        )
        .unwrap();

        initialize_database(&conn).unwrap();

        let is_pinned: i64 = conn
            .query_row(
                "SELECT is_pinned FROM sessions WHERE id = 'session-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(is_pinned, 0);
    }

    #[test]
    fn migrates_legacy_mcp_rows_to_per_app_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE mcp_servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                transport_type TEXT NOT NULL,
                transport_config TEXT NOT NULL,
                always_load INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                subtitle TEXT DEFAULT ''
            );

            INSERT INTO mcp_servers (
                id, name, description, transport_type, transport_config,
                always_load, enabled, created_at, updated_at, subtitle
            ) VALUES (
                'fetch',
                'fetch',
                'legacy row',
                'stdio',
                '{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-fetch"]}',
                1,
                1,
                '2026-06-01T00:00:00Z',
                '2026-06-01T00:00:00Z',
                'old subtitle'
            );
            "#,
        )
        .unwrap();

        initialize_database(&conn).unwrap();

        let row = conn
            .query_row(
                "SELECT description, server_config, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode
                 FROM mcp_servers WHERE id = 'fetch'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(row.0, "legacy row");
        assert_eq!(
            row.1,
            r#"{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-fetch"]}"#
        );
        assert_eq!(row.2, 1);
        assert_eq!(row.3, 0);
        assert_eq!(row.4, 0);
        assert_eq!(row.5, 0);
    }

    #[test]
    fn drops_legacy_message_tables_and_creates_agent_session_mappings() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE tool_calls (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            ",
        )
        .unwrap();

        initialize_database(&conn).unwrap();

        assert!(conn
            .prepare("SELECT app_session_id FROM agent_session_mappings LIMIT 0")
            .is_ok());
        assert!(conn.prepare("SELECT id FROM messages LIMIT 0").is_err());
        assert!(conn.prepare("SELECT id FROM tool_calls LIMIT 0").is_err());
    }

    #[test]
    fn migrates_skills_enabled_to_per_app_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE skills (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                display_name TEXT,
                description TEXT,
                source_repo TEXT,
                source_path TEXT,
                version TEXT,
                installed_at TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                is_builtin INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO skills (id, name, display_name, description, installed_at, enabled, is_builtin)
            VALUES ('skill-1', 'skill-one', NULL, NULL, '2026-01-01T00:00:00Z', 1, 0);
            INSERT INTO skills (id, name, display_name, description, installed_at, enabled, is_builtin)
            VALUES ('skill-2', 'skill-two', NULL, NULL, '2026-01-01T00:00:00Z', 0, 0);
            ",
        )
        .unwrap();

        initialize_database(&conn).unwrap();

        // Verify all 4 per-app columns exist
        assert!(conn
            .prepare("SELECT enabled_claude FROM skills LIMIT 0")
            .is_ok());
        assert!(conn
            .prepare("SELECT enabled_codex FROM skills LIMIT 0")
            .is_ok());
        assert!(conn
            .prepare("SELECT enabled_gemini FROM skills LIMIT 0")
            .is_ok());
        assert!(conn
            .prepare("SELECT enabled_opencode FROM skills LIMIT 0")
            .is_ok());

        // Verify enabled_claude inherited the legacy `enabled` value
        let row1: i64 = conn
            .query_row(
                "SELECT enabled_claude FROM skills WHERE id = 'skill-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(row1, 1);

        let row2: i64 = conn
            .query_row(
                "SELECT enabled_claude FROM skills WHERE id = 'skill-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(row2, 0);

        // Other per-app columns should remain 0 after migration
        let other_apps: (i64, i64, i64) = conn
            .query_row(
                "SELECT enabled_codex, enabled_gemini, enabled_opencode FROM skills WHERE id = 'skill-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(other_apps.0, 0);
        assert_eq!(other_apps.1, 0);
        assert_eq!(other_apps.2, 0);
    }
}
