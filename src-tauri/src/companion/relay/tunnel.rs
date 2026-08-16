use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TunnelMessage {
    Http {
        id: String,
        method: String,
        path: String,
        headers: Option<std::collections::HashMap<String, String>>,
        body: Option<String>,
    },
}

pub async fn handle_tunnel_payload(
    client: &reqwest::Client,
    base_url: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let message: TunnelMessage =
        serde_json::from_slice(plaintext).map_err(|error| error.to_string())?;
    match message {
        TunnelMessage::Http {
            id,
            method,
            path,
            headers,
            body,
        } => {
            let url = format!("{base_url}{}", path);
            let mut request = match method.as_str() {
                "GET" => client.get(&url),
                "POST" => client.post(&url),
                "DELETE" => client.delete(&url),
                "PUT" => client.put(&url),
                "PATCH" => client.patch(&url),
                _ => return Err(format!("Unsupported method: {method}")),
            };
            if let Some(headers) = headers {
                for (key, value) in headers {
                    request = request.header(key, value);
                }
            }
            if let Some(body) = body {
                request = request.body(body);
            }
            let response = request
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let response_body = response
                .text()
                .await
                .map_err(|error| error.to_string())?;
            let payload = json!({
                "type": "http_res",
                "id": id,
                "status": status,
                "body": response_body,
            });
            serde_json::to_vec(&payload).map_err(|error| error.to_string())
        }
    }
}
