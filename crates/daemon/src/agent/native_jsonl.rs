//! Shared utilities for reading and rewriting native agent JSONL history files.

use std::path::Path;

use log::warn;
use serde_json::Value;

/// Read the first non-empty line from a file.
pub(crate) fn first_non_empty_line(path: &Path) -> Option<String> {
    use std::fs::File;
    use std::io::{BufRead, BufReader};

    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let line = line.ok()?;
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Sanitize a string so it can be safely used as a file name segment.
pub(crate) fn sanitize_file_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

/// Split JSONL content into lines while preserving trailing newlines so the
/// concatenation of all lines reproduces the original content byte-for-byte.
pub(crate) fn split_jsonl_preserving_newlines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }

    content
        .split_inclusive('\n')
        .map(|line| line.to_string())
        .collect()
}

/// Parse a stream of JSON values from a file.
///
/// Accepts JSONL, pretty-printed, and concatenated value streams. Parsing stops
/// at the first malformed value instead of failing the whole read, and each
/// parsed value is tagged with a `__lineIndex` field.
pub(crate) fn read_json_stream_values(path: &Path) -> Result<Vec<Value>, String> {
    use std::fs;

    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read JSONL: {}", e))?;
    let stream = serde_json::Deserializer::from_str(&content).into_iter::<Value>();
    let mut values = Vec::new();

    for item in stream {
        match item {
            Ok(mut value) => {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("__lineIndex".to_string(), serde_json::json!(values.len()));
                }
                values.push(value);
            }
            Err(error) => {
                warn!(
                    target: "agent",
                    "Stopped parsing JSON stream from {} after {} values: {}",
                    path.display(),
                    values.len(),
                    error
                );
                break;
            }
        }
    }

    Ok(values)
}

pub(crate) fn event_timestamp_millis(value: &Value) -> Option<i64> {
    let timestamp = value.get("timestamp").and_then(|entry| entry.as_str())?;
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|entry| entry.timestamp_millis())
}

/// Sort events by timestamp while preserving the original order of events
/// that share the same timestamp (or lack one).
pub(crate) fn sort_events_by_timestamp_stable(events: &mut Vec<Value>) {
    let mut indexed: Vec<(usize, Value)> = events.drain(..).enumerate().collect();
    indexed
        .sort_by_key(|(index, value)| (event_timestamp_millis(value).unwrap_or(i64::MAX), *index));
    events.extend(indexed.into_iter().map(|(_, value)| value));
}

#[cfg(test)]
mod tests {
    use super::read_json_stream_values;

    #[test]
    fn read_json_stream_values_accepts_pretty_and_concatenated_values() {
        use std::fs;

        let path = std::env::temp_dir().join(format!(
            "codemux-json-stream-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session-1\"}}\n",
                "{\n",
                "  \"type\": \"response_item\",\n",
                "  \"payload\": {\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,abc\"}]}\n",
                "}{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\"}}\n"
            ),
        )
        .unwrap();

        let values = read_json_stream_values(&path).expect("stream should parse");

        assert_eq!(values.len(), 3);
        assert_eq!(
            values[1].get("type").and_then(|value| value.as_str()),
            Some("response_item")
        );

        let _ = fs::remove_file(path);
    }
}
