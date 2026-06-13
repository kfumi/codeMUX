use crate::mcp::types::{McpApps, McpServer};

pub struct AppDiff {
    pub enable: Vec<&'static str>,
    pub disable: Vec<&'static str>,
}

pub fn diff_apps(previous: &McpApps, next: &McpApps) -> AppDiff {
    let mut enable = Vec::new();
    let mut disable = Vec::new();

    for (app, before, after) in [
        ("claude", previous.claude, next.claude),
        ("codex", previous.codex, next.codex),
        ("gemini", previous.gemini, next.gemini),
        ("opencode", previous.opencode, next.opencode),
    ] {
        if before && !after {
            disable.push(app);
        }
        if !before && after {
            enable.push(app);
        }
    }

    AppDiff { enable, disable }
}

pub fn merge_imported_server(mut server: McpServer, app: &str) -> McpServer {
    match app {
        "claude" => server.apps.claude = true,
        "codex" => server.apps.codex = true,
        "gemini" => server.apps.gemini = true,
        "opencode" => server.apps.opencode = true,
        _ => {}
    }
    server
}

pub fn toggle_app(state: &crate::AppState, server_id: &str, app: &str, enabled: bool) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    crate::mcp::db::set_mcp_app_enabled(&db, server_id, app, enabled)
        .map_err(|e| format!("Failed to toggle app: {}", e))?;

    // Sync to native config
    let server = crate::mcp::db::get_mcp_server(&db, server_id)
        .map_err(|e| format!("Failed to get server: {}", e))?;
    drop(db);

    if let Some(server) = server {
        if let Some(adapter) = crate::mcp::adapters::get_adapter(app) {
            if adapter.should_sync() {
                if enabled {
                    let _ = adapter.sync_single_server(server_id, &server.server);
                } else {
                    let _ = adapter.remove_server(server_id);
                }
            }
        }
    }

    Ok(())
}

pub fn import_from_apps(state: &crate::AppState) -> Result<crate::commands::mcp::ImportResult, String> {
    use crate::mcp::adapters::all_apps;

    let mut result = crate::commands::mcp::ImportResult {
        claude: 0, codex: 0, gemini: 0, opencode: 0, total: 0,
    };

    let db = state.db.lock().unwrap();

    for app in all_apps() {
        let Some(adapter) = crate::mcp::adapters::get_adapter(app) else { continue };
        if !adapter.should_sync() { continue; }

        let entries = match adapter.import_from_tool() {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for (id, spec) in entries {
            if crate::mcp::validation::validate_server_spec(&spec).is_err() {
                continue;
            }

            let existing = crate::mcp::db::get_mcp_server(&db, &id)
                .ok()
                .flatten();

            if let Some(mut existing) = existing {
                // Already exists: just enable the source app
                match app {
                    "claude" => existing.apps.claude = true,
                    "codex" => existing.apps.codex = true,
                    "gemini" => existing.apps.gemini = true,
                    "opencode" => existing.apps.opencode = true,
                    _ => {}
                }
                let _ = crate::mcp::db::upsert_mcp_server(&db, &existing);
            } else {
                // New: create with only source app enabled
                let mut apps = McpApps::default();
                match app {
                    "claude" => apps.claude = true,
                    "codex" => apps.codex = true,
                    "gemini" => apps.gemini = true,
                    "opencode" => apps.opencode = true,
                    _ => {}
                }
                let server = McpServer {
                    id: id.clone(),
                    name: id.clone(),
                    server: spec,
                    apps,
                };
                let _ = crate::mcp::db::upsert_mcp_server(&db, &server);
            }

            match app {
                "claude" => result.claude += 1,
                "codex" => result.codex += 1,
                "gemini" => result.gemini += 1,
                "opencode" => result.opencode += 1,
                _ => {}
            }
            result.total += 1;
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_apps_reports_enable_and_disable_sets() {
        let previous = McpApps { claude: true, codex: false, gemini: true, opencode: false };
        let next = McpApps { claude: false, codex: true, gemini: true, opencode: false };

        let diff = diff_apps(&previous, &next);

        assert_eq!(diff.disable, vec!["claude"]);
        assert_eq!(diff.enable, vec!["codex"]);
    }

    #[test]
    fn merge_imported_server_only_enables_the_source_app_for_existing_rows() {
        let existing = McpServer {
            id: "fetch".into(),
            name: "fetch".into(),
            server: serde_json::json!({"type":"stdio","command":"npx"}),
            apps: McpApps { claude: true, codex: false, gemini: false, opencode: false },
        };

        let merged = merge_imported_server(existing, "codex");
        assert!(merged.apps.claude);
        assert!(merged.apps.codex);
        assert!(!merged.apps.gemini);
        assert!(!merged.apps.opencode);
    }
}
