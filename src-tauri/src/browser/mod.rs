pub mod manager;
pub mod url;

#[cfg(test)]
mod tests {
    use super::manager::WEBVIEW_LABEL_PREFIX;

    #[test]
    fn default_capability_only_exposes_the_main_webview() {
        let raw = include_str!("../../capabilities/default.json");
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(value["webviews"], serde_json::json!(["main"]));
        assert!(value.get("windows").is_none());
        assert_ne!(WEBVIEW_LABEL_PREFIX, "main");
        assert!(WEBVIEW_LABEL_PREFIX.starts_with("cmx-b-"));
    }
}
