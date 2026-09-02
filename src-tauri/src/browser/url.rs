pub fn normalize_browser_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("请输入网址".to_string());
    }

    if let Some(scheme) = extract_scheme(trimmed) {
        let lower = scheme.to_ascii_lowercase();
        if lower != "http" && lower != "https" {
            return Err("只允许 http 或 https 地址".to_string());
        }
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else if let Some(rest) = trimmed.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        format!("https://{trimmed}")
    };

    let parsed = tauri::Url::parse(&candidate).map_err(|_| "网址无效".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("只允许 http 或 https 地址".to_string());
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("网址无效".to_string());
    }
    Ok(parsed.to_string())
}

fn extract_scheme(input: &str) -> Option<&str> {
    let end = input.find(':')?;
    let scheme = &input[..end];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
        Some(scheme)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_browser_url;

    #[test]
    fn accepts_http_urls() {
        assert_eq!(
            normalize_browser_url("https://www.baidu.com/").unwrap(),
            "https://www.baidu.com/"
        );
        assert_eq!(
            normalize_browser_url("http://example.com").unwrap(),
            "http://example.com/"
        );
    }

    #[test]
    fn adds_https_when_protocol_is_missing() {
        assert_eq!(
            normalize_browser_url("www.baidu.com").unwrap(),
            "https://www.baidu.com/"
        );
        assert_eq!(
            normalize_browser_url("example.com/path?q=1").unwrap(),
            "https://example.com/path?q=1"
        );
    }

    #[test]
    fn rejects_empty_and_non_http_schemes() {
        assert_eq!(normalize_browser_url("   ").unwrap_err(), "请输入网址");
        assert_eq!(
            normalize_browser_url("file:///tmp/index.html").unwrap_err(),
            "只允许 http 或 https 地址"
        );
        assert_eq!(
            normalize_browser_url("javascript:alert(1)").unwrap_err(),
            "只允许 http 或 https 地址"
        );
        assert_eq!(
            normalize_browser_url("about:blank").unwrap_err(),
            "只允许 http 或 https 地址"
        );
    }
}
