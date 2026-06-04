use rusqlite::{Connection, Result, params};
use uuid::Uuid;
use chrono::Utc;

use super::types::{McpServer, McpTransport};

/// 从数据库行构建 McpServer
fn row_to_mcp_server(row: &rusqlite::Row) -> rusqlite::Result<McpServer> {
    let _transport_type: String = row.get(3)?;
    let transport_config: String = row.get(4)?;
    let enabled: i32 = row.get(5)?;

    let transport: McpTransport = serde_json::from_str(&transport_config)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(
            4, rusqlite::types::Type::Text, Box::new(e),
        ))?;

    Ok(McpServer {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        transport,
        enabled: enabled != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub fn get_all_mcp_servers(conn: &Connection) -> Result<Vec<McpServer>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, transport_type, transport_config, enabled, created_at, updated_at
         FROM mcp_servers ORDER BY name ASC"
    )?;

    let servers = stmt.query_map([], |row| row_to_mcp_server(row))?
        .collect::<Result<Vec<_>>>()?;
    Ok(servers)
}

pub fn get_enabled_mcp_servers(conn: &Connection) -> Result<Vec<McpServer>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, transport_type, transport_config, enabled, created_at, updated_at
         FROM mcp_servers WHERE enabled = 1 ORDER BY name ASC"
    )?;

    let servers = stmt.query_map([], |row| row_to_mcp_server(row))?
        .collect::<Result<Vec<_>>>()?;
    Ok(servers)
}

pub fn upsert_mcp_server(conn: &Connection, server: &McpServer) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let transport_config = server.transport.to_config_json().to_string();
    let transport_type = server.transport.transport_type();
    let enabled: i32 = if server.enabled { 1 } else { 0 };

    conn.execute(
        "INSERT INTO mcp_servers (id, name, description, transport_type, transport_config, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             transport_type = excluded.transport_type,
             transport_config = excluded.transport_config,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at",
        params![server.id, server.name, server.description, transport_type, transport_config, enabled,
                server.created_at, now],
    )?;
    Ok(())
}

pub fn delete_mcp_server(conn: &Connection, id: &str) -> Result<bool> {
    let rows = conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
    Ok(rows > 0)
}

pub fn toggle_mcp_server(conn: &Connection, id: &str) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE mcp_servers SET enabled = NOT enabled, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;

    let enabled: bool = conn.query_row(
        "SELECT enabled FROM mcp_servers WHERE id = ?1",
        params![id],
        |row| {
            let v: i32 = row.get(0)?;
            Ok(v != 0)
        },
    )?;
    Ok(enabled)
}

pub fn get_mcp_server(conn: &Connection, id: &str) -> Result<Option<McpServer>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, transport_type, transport_config, enabled, created_at, updated_at
         FROM mcp_servers WHERE id = ?1"
    )?;

    let mut rows = stmt.query_map(params![id], |row| row_to_mcp_server(row))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn create_mcp_server(conn: &Connection, name: &str, description: &str, transport: &McpTransport) -> Result<McpServer> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let server = McpServer {
        id,
        name: name.to_string(),
        description: description.to_string(),
        transport: transport.clone(),
        enabled: true,
        created_at: now.clone(),
        updated_at: now,
    };
    upsert_mcp_server(conn, &server)?;
    Ok(server)
}
