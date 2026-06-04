use tauri::State;
use crate::AppState;
use crate::mcp::types::McpServer;
use crate::mcp::adapter::McpAdapter;
use crate::mcp::{db, adapters};

#[tauri::command]
pub fn get_mcp_servers(state: State<'_, AppState>) -> Result<Vec<McpServer>, String> {
    let db = state.db.lock().unwrap();
    db::get_all_mcp_servers(&db).map_err(|e| format!("Failed to get MCP servers: {}", e))
}

#[tauri::command]
pub fn upsert_mcp_server(state: State<'_, AppState>, server: McpServer) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db::upsert_mcp_server(&db, &server).map_err(|e| format!("Failed to save MCP server: {}", e))?;

    // 双写到 ~/.claude.json
    let all_servers = db::get_enabled_mcp_servers(&db)
        .map_err(|e| format!("Failed to get enabled servers: {}", e))?;
    drop(db);

    let adapter = adapters::claude::ClaudeAdapter;
    adapter.sync_to_config_file(&all_servers)?;
    Ok(())
}

#[tauri::command]
pub fn delete_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db::delete_mcp_server(&db, &id).map_err(|e| format!("Failed to delete MCP server: {}", e))?;

    // 双写
    let all_servers = db::get_enabled_mcp_servers(&db)
        .map_err(|e| format!("Failed to get enabled servers: {}", e))?;
    drop(db);

    let adapter = adapters::claude::ClaudeAdapter;
    adapter.sync_to_config_file(&all_servers)?;
    Ok(())
}

#[tauri::command]
pub fn toggle_mcp_server(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let db = state.db.lock().unwrap();
    let new_state = db::toggle_mcp_server(&db, &id)
        .map_err(|e| format!("Failed to toggle MCP server: {}", e))?;

    // 双写
    let all_servers = db::get_enabled_mcp_servers(&db)
        .map_err(|e| format!("Failed to get enabled servers: {}", e))?;
    drop(db);

    let adapter = adapters::claude::ClaudeAdapter;
    adapter.sync_to_config_file(&all_servers)?;
    Ok(new_state)
}
