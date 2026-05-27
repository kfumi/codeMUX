use tauri::State;
use crate::AppState;
use crate::db::operations;
use crate::provider::{self, types::{AiProvider, ChatMessage}};

/// Send a user message and get the assistant's reply.
///
/// Loads conversation history from the DB, appends the new user message,
/// sends everything to the active provider, then persists both the user
/// message and the assistant response.
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    session_id: String,
    content: String,
    model: Option<String>,
) -> Result<String, String> {
    // 1. Resolve the active provider config
    let provider_config = {
        let config = state.config.lock().unwrap();
        let active_id = config
            .active_provider_id
            .as_deref()
            .ok_or("No active provider configured")?;
        config
            .providers
            .iter()
            .find(|p| p.id == active_id)
            .cloned()
            .ok_or_else(|| format!("Provider '{}' not found", active_id))?
    };

    // 2. Load existing message history for this session
    let history: Vec<ChatMessage> = {
        let db = state.db.lock().unwrap();
        operations::get_messages_by_session(&db, &session_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| ChatMessage {
                role: m.role,
                content: m.content,
            })
            .collect()
    };

    // 3. Save the user message to DB
    {
        let db = state.db.lock().unwrap();
        operations::create_message(&db, &session_id, "user", &content)
            .map_err(|e| e.to_string())?;
    }

    // 4. Build the full message list (history + new user message)
    let mut messages = history;
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: content.clone(),
    });

    // 5. Call the provider
    let prov = provider::create_provider(&provider_config);
    let model_str = model.as_deref().unwrap_or(&provider_config.default_model);
    let response = prov.send_message(messages, model_str).await?;

    // 6. Save the assistant response to DB
    {
        let db = state.db.lock().unwrap();
        operations::create_message(&db, &session_id, "assistant", &response)
            .map_err(|e| e.to_string())?;
    }

    Ok(response)
}
