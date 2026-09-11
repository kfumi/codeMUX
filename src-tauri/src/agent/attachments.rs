//! Attachment enrichment: image recognition through a short-lived sidecar
//! that talks to an OpenAI-compatible vision endpoint.

use std::sync::Arc;

use tauri::State;

use super::spawn_sidecar;

struct EnrichmentResultEvent {
    request_id: String,
    result: Result<serde_json::Value, String>,
}

fn parse_enrichment_result_event(event: &str) -> Option<EnrichmentResultEvent> {
    let value = serde_json::from_str::<serde_json::Value>(event).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("enrichment_result") {
        return None;
    }
    let request_id = value.get("request_id")?.as_str()?.to_string();
    let ok = value
        .get("ok")
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false);
    let result = if ok {
        Ok(serde_json::json!({
            "blocks": value.get("blocks").cloned().unwrap_or_else(|| serde_json::json!([])),
        }))
    } else {
        Err(value
            .get("error")
            .and_then(|entry| entry.as_str())
            .unwrap_or("Attachment enrichment failed")
            .to_string())
    };
    Some(EnrichmentResultEvent { request_id, result })
}

#[tauri::command]
pub async fn enrich_attachments(
    daemon: State<'_, Arc<crate::daemon::DaemonState>>,
    attachments: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    enrich_attachments_for_companion(&daemon.roots, &daemon.app, attachments).await
}

pub async fn enrich_attachments_for_companion(
    roots: &crate::paths::PathRoots,
    state: &crate::AppState,
    attachments: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if attachments.is_empty() {
        return Ok(serde_json::json!({ "blocks": [] }));
    }

    let config = state.config.lock().unwrap().clone();
    let enrichment = &config.attachment_enrichment;
    if !enrichment.enabled {
        return Err("Image recognition is disabled".to_string());
    }
    let model = enrichment.model.trim();
    if model.is_empty() {
        return Err("Image recognition model is not configured".to_string());
    }
    let base_url = enrichment.base_url.trim();
    if base_url.is_empty() {
        return Err("Image recognition base URL is not configured".to_string());
    }
    let api_key = enrichment.api_key.trim();
    if api_key.is_empty() {
        return Err("Image recognition API key is not configured".to_string());
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let command = serde_json::json!({
        "type": "enrich_attachments",
        "requestId": request_id,
        "attachments": attachments,
        "protocol": "openai_compatible",
        "apiKey": api_key,
        "baseUrl": base_url,
        "model": model,
    });

    let (mut handle, mut events) =
        spawn_sidecar(roots, super::sidecar_events::SidecarEventBinding::unbound()).await?;
    if let Err(error) = handle.send_command(&command.to_string()).await {
        handle.shutdown().await;
        return Err(error);
    }

    let result = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        while let Some(event) = events.recv().await {
            if let Some(parsed) = parse_enrichment_result_event(&event) {
                if parsed.request_id == request_id {
                    return parsed.result;
                }
            }
        }
        Err("Sidecar stopped before enrichment completed".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for attachment enrichment".to_string())?;
    handle.shutdown().await;
    result
}
