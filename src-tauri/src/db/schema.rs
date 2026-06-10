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
            mode TEXT NOT NULL DEFAULT 'chat',
            project_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tool_calls (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            arguments TEXT,
            result TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
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
            is_builtin INTEGER NOT NULL DEFAULT 0
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
        "
    )?;

    // Migration: add mode column if missing
    let has_mode: bool = conn
        .prepare("SELECT mode FROM sessions LIMIT 0")
        .is_ok();
    if !has_mode {
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'", []);
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

    // Migration: add subtitle column to mcp_servers if missing
    let has_subtitle: bool = conn
        .prepare("SELECT subtitle FROM mcp_servers LIMIT 0")
        .is_ok();
    if !has_subtitle {
        let _ = conn.execute("ALTER TABLE mcp_servers ADD COLUMN subtitle TEXT DEFAULT ''", []);
    }

    // Migration: add always_load column to mcp_servers if missing
    let has_always_load: bool = conn
        .prepare("SELECT always_load FROM mcp_servers LIMIT 0")
        .is_ok();
    if !has_always_load {
        let _ = conn.execute("ALTER TABLE mcp_servers ADD COLUMN always_load INTEGER NOT NULL DEFAULT 0", []);
    }

    // Migration: add disk_path column to skills if missing
    let has_disk_path: bool = conn
        .prepare("SELECT disk_path FROM skills LIMIT 0")
        .is_ok();
    if !has_disk_path {
        let _ = conn.execute("ALTER TABLE skills ADD COLUMN disk_path TEXT", []);
    }

    // 创建索引（在所有迁移之后，确保列存在）
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_message_id ON tool_calls(message_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
        "
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
}
