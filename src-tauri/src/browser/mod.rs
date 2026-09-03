pub mod manager;
pub mod url;

#[cfg(test)]
mod tests {
    use super::manager::{parse_codemux_open_url, WEBVIEW_LABEL_PREFIX};
    use tauri::Url;

    #[test]
    fn default_capability_only_exposes_the_main_webview() {
        let raw = include_str!("../../capabilities/default.json");
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(value["webviews"], serde_json::json!(["main"]));
        assert!(value.get("windows").is_none());
        assert_ne!(WEBVIEW_LABEL_PREFIX, "main");
        assert!(WEBVIEW_LABEL_PREFIX.starts_with("cmx-b-"));
    }

    #[test]
    fn webview_mutating_commands_are_async_to_avoid_windows_deadlock() {
        let src = include_str!("../commands/browser.rs");
        for name in [
            "browser_create",
            "browser_destroy",
            "browser_navigate",
            "browser_back",
            "browser_forward",
            "browser_reload",
            "browser_set_bounds",
            "browser_show",
            "browser_hide",
            "browser_open_devtools",
            "browser_set_zoom",
            "browser_clear_data",
        ] {
            assert!(
                src.contains(&format!("pub async fn {name}")),
                "{name} must be async: creating or mutating a child WebView from a sync command deadlocks Windows (WebView2 / wry#583)"
            );
        }
        assert!(
            !src.contains("browser_show_viewport_menu"),
            "viewport scale must use the OS menu API, not a child WebView overlay that steals page clicks"
        );
    }

    #[test]
    fn parse_codemux_open_url_accepts_http_and_https_targets() {
        let target = Url::parse("codemux://browser/open?url=https%3A%2F%2Fexample.com%2Fpath").unwrap();
        assert_eq!(
            parse_codemux_open_url(&target).as_deref(),
            Some("https://example.com/path")
        );
    }

    #[test]
    fn parse_codemux_open_url_rejects_non_http_schemes() {
        let target = Url::parse("codemux://browser/open?url=file%3A%2F%2Ftmp").unwrap();
        assert!(parse_codemux_open_url(&target).is_none());
    }
}
