use rusqlite::{Connection, Result, params};

use super::types::{McpServer, McpApps};

const SELECT_COLUMNS: &str = "id, name, description, server_config, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode";

/// 从数据库行构建 McpServer（新 schema）
fn row_to_mcp_server(row: &rusqlite::Row) -> rusqlite::Result<McpServer> {
    let server_config_str: String = row.get(3)?;
    let server: serde_json::Value = serde_json::from_str(&server_config_str)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(
            3, rusqlite::types::Type::Text, Box::new(e),
        ))?;

    Ok(McpServer {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        server,
        apps: McpApps {
            claude: row.get::<_, i64>(4)? != 0,
            codex: row.get::<_, i64>(5)? != 0,
            gemini: row.get::<_, i64>(6)? != 0,
            opencode: row.get::<_, i64>(7)? != 0,
        },
    })
}

pub fn get_all_mcp_servers(conn: &Connection) -> Result<Vec<McpServer>> {
    let mut stmt = conn.prepare(
        &format!("SELECT {SELECT_COLUMNS} FROM mcp_servers ORDER BY name ASC")
    )?;
    let servers = stmt.query_map([], |row| row_to_mcp_server(row))?
        .collect::<Result<Vec<_>>>()?;
    Ok(servers)
}

#[allow(dead_code)]
pub fn get_servers_enabled_for_app(conn: &Connection, app: &str) -> Result<Vec<McpServer>> {
    let column = match app {
        "claude" => "enabled_claude",
        "codex" => "enabled_codex",
        "gemini" => "enabled_gemini",
        "opencode" => "enabled_opencode",
        _ => return Ok(Vec::new()),
    };

    let sql = format!("SELECT {SELECT_COLUMNS} FROM mcp_servers WHERE {column} = 1 ORDER BY name ASC");
    let mut stmt = conn.prepare(&sql)?;
    let servers = stmt.query_map([], |row| row_to_mcp_server(row))?
        .collect::<Result<Vec<_>>>()?;
    Ok(servers)
}

pub fn upsert_mcp_server(conn: &Connection, server: &McpServer) -> Result<()> {
    let server_config = serde_json::to_string(&server.server).unwrap_or_default();

    conn.execute(
        "INSERT INTO mcp_servers (id, name, description, server_config, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             server_config = excluded.server_config,
             enabled_claude = excluded.enabled_claude,
             enabled_codex = excluded.enabled_codex,
             enabled_gemini = excluded.enabled_gemini,
             enabled_opencode = excluded.enabled_opencode",
        params![
            server.id, server.name, server.description, server_config,
            server.apps.claude as i32, server.apps.codex as i32,
            server.apps.gemini as i32, server.apps.opencode as i32,
        ],
    )?;
    Ok(())
}

pub fn delete_mcp_server(conn: &Connection, id: &str) -> Result<bool> {
    let rows = conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
    Ok(rows > 0)
}

pub fn get_mcp_server(conn: &Connection, id: &str) -> Result<Option<McpServer>> {
    let mut stmt = conn.prepare(
        &format!("SELECT {SELECT_COLUMNS} FROM mcp_servers WHERE id = ?1")
    )?;
    let mut rows = stmt.query_map(params![id], |row| row_to_mcp_server(row))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn set_mcp_app_enabled(conn: &Connection, id: &str, app: &str, enabled: bool) -> Result<()> {
    let column = match app {
        "claude" => "enabled_claude",
        "codex" => "enabled_codex",
        "gemini" => "enabled_gemini",
        "opencode" => "enabled_opencode",
        _ => return Err(rusqlite::Error::InvalidParameterName(app.to_string())),
    };

    let sql = format!("UPDATE mcp_servers SET {column} = ?1 WHERE id = ?2");
    conn.execute(&sql, rusqlite::params![if enabled { 1i32 } else { 0i32 }, id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_mcp_app_enabled_updates_only_the_target_app() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();

        let server = McpServer {
            id: "fetch".into(),
            name: "fetch".into(),
            description: "Web fetcher".into(),
            server: serde_json::json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-fetch"]
            }),
            apps: McpApps {
                claude: true,
                codex: false,
                gemini: false,
                opencode: false,
            },
        };

        upsert_mcp_server(&conn, &server).unwrap();
        set_mcp_app_enabled(&conn, "fetch", "codex", true).unwrap();

        let updated = get_mcp_server(&conn, "fetch").unwrap().unwrap();
        assert_eq!(updated.description, "Web fetcher");
        assert!(updated.apps.claude);
        assert!(updated.apps.codex);
        assert!(!updated.apps.gemini);
        assert!(!updated.apps.opencode);
    }
}
