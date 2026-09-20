//! 非回环 Companion 请求的 Origin/Host 校验(网页端接入的安全前置)。
//!
//! 威胁模型:daemon 一旦暴露 LAN,受害者浏览器中的恶意网页可向
//! `http://<lan-ip>:<port>` 发起跨域请求(携带受害者已配对的令牌),或借
//! DNS-rebinding 把域名解析到 LAN IP 绕过同源检查。因此对非回环来源:
//!
//! 1. Host 必须是 IP 字面量,或其 authority 明确出现在 `web_allowed_origins`
//!    的主机部分 —— 域名 Host 一律拒绝(rebinding 防御);
//! 2. 携带 Origin 头的请求仅接受"与请求同源"(daemon 自serve 的 SPA)或
//!    `web_allowed_origins` 内的完整 Origin;
//! 3. 回环请求与本模块无关(直接放行),令牌鉴权仍由 `authorize` 把守。

use std::net::{IpAddr, SocketAddr};

use axum::http::{header, HeaderMap};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WebOriginDecision {
    Allow,
    Reject,
}

pub(crate) fn validate_web_origin(
    peer: Option<SocketAddr>,
    headers: &HeaderMap,
    allowed: &AllowedOrigins,
) -> WebOriginDecision {
    let Some(peer) = peer else {
        return WebOriginDecision::Allow;
    };
    if peer.ip().is_loopback() {
        return WebOriginDecision::Allow;
    }

    if let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    {
        let Some(request_authority) = Authority::parse(host) else {
            return WebOriginDecision::Reject;
        };
        let host_is_ip = request_authority.host.parse::<IpAddr>().is_ok();
        if !host_is_ip && !allowed.hosts.contains(&request_authority) {
            return WebOriginDecision::Reject;
        }
    }

    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        if !origin_allows_request(origin, headers, allowed) {
            return WebOriginDecision::Reject;
        }
    }

    WebOriginDecision::Allow
}

fn origin_allows_request(origin: &str, headers: &HeaderMap, allowed: &AllowedOrigins) -> bool {
    let Ok(uri) = origin.parse::<axum::http::Uri>() else {
        // "null" 或畸形 Origin:非回环来源一律拒绝。
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    let Some(scheme) = uri.scheme_str() else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let Some(origin_authority) = Authority::parse(authority.as_str()) else {
        return false;
    };
    // Origin 带scheme,缺省端口按 scheme 补(https→443,http→80);
    // Host 头无 scheme,Companion 服务器仅 http,缺省补 80 即可。
    let origin_port = origin_authority
        .port
        .unwrap_or(if scheme == "https" { 443 } else { 80 });

    if let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(request_authority) = Authority::parse(host) {
            let request_port = request_authority.port.unwrap_or(80);
            if request_authority
                .host
                .eq_ignore_ascii_case(&origin_authority.host)
                && request_port == origin_port
            {
                return true;
            }
        }
    }

    allowed
        .origins
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(origin.trim()))
}

#[derive(Debug, PartialEq, Eq, Clone)]
struct Authority {
    host: String,
    port: Option<u16>,
}

impl Authority {
    /// 解析 Host/Origin authority(`host`、`host:port`、`[v6]:port`)。
    fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        let (host, port) = match value.rsplit_once(':') {
            // IPv6 无端口形如 `::1` 或 `[::1]`,rsplit 会切在冒号上。
            Some((maybe_host, maybe_port)) => {
                let bracketed_v6 = value.starts_with('[') || maybe_host.matches(':').count() >= 1;
                match maybe_port.parse::<u16>() {
                    Ok(port) if !bracketed_v6 || value.starts_with('[') => (maybe_host, Some(port)),
                    _ => (value, None),
                }
            }
            None => (value, None),
        };
        let host = host.trim().trim_start_matches('[').trim_end_matches(']');
        if host.is_empty() {
            return None;
        }
        Some(Self {
            host: host.to_ascii_lowercase(),
            port,
        })
    }
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub(crate) struct AllowedOrigins {
    /// 列表内 Origin 的完整串(用于 Origin 头匹配)。
    origins: Vec<String>,
    /// 列表内 Origin 推导出的允许 Host authority(用于 Host 头匹配,
    /// 让自列表来源的顶层导航——无 Origin 头——也能通过)。
    hosts: Vec<Authority>,
}

impl AllowedOrigins {
    /// 启动时解析一次配置列表,请求路径上只做匹配不做解析。
    pub(crate) fn parse(entries: &[String]) -> Self {
        let mut origins = Vec::new();
        let mut hosts = Vec::new();
        for entry in entries {
            let trimmed = entry.trim();
            if trimmed.is_empty() {
                continue;
            }
            origins.push(trimmed.to_string());
            if let Ok(uri) = trimmed.parse::<axum::http::Uri>() {
                if let Some(authority) = uri.authority() {
                    if let Some(parsed) = Authority::parse(authority.as_str()) {
                        hosts.push(parsed);
                    }
                }
            }
        }
        Self { origins, hosts }
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_web_origin, WebOriginDecision};
    use axum::http::{header, HeaderMap, HeaderValue};
    use std::net::{IpAddr, SocketAddr};

    fn peer(ip: &str) -> Option<SocketAddr> {
        let ip: IpAddr = ip.parse().expect("ip");
        Some(SocketAddr::new(ip, 51000))
    }

    fn request(host: Option<&str>, origin: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(host) = host {
            headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        }
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        headers
    }

    fn allowed(entries: &[&str]) -> super::AllowedOrigins {
        let owned: Vec<String> = entries.iter().map(|entry| entry.to_string()).collect();
        super::AllowedOrigins::parse(&owned)
    }

    #[test]
    fn loopback_peer_bypasses_validation() {
        assert_eq!(
            validate_web_origin(
                peer("127.0.0.1"),
                &request(Some("evil.example"), Some("http://evil.example")),
                &allowed(&[]),
            ),
            WebOriginDecision::Allow,
            "回环请求不做 Origin/Host 校验"
        );
        assert_eq!(
            validate_web_origin(None, &request(Some("evil.example"), None), &allowed(&[])),
            WebOriginDecision::Allow,
            "无 peer(嵌入调用方)视为回环"
        );
    }

    #[test]
    fn non_loopback_ip_host_without_origin_is_allowed() {
        assert_eq!(
            validate_web_origin(
                peer("192.168.1.8"),
                &request(Some("192.168.1.8:9240"), None),
                &allowed(&[]),
            ),
            WebOriginDecision::Allow,
            "顶层导航(GET)不带 Origin,IP Host 放行"
        );
    }

    #[test]
    fn non_loopback_domain_host_is_rejected_for_rebinding() {
        assert_eq!(
            validate_web_origin(
                peer("192.168.1.8"),
                &request(
                    Some("attacker.example:9240"),
                    Some("http://attacker.example:9240")
                ),
                &allowed(&[]),
            ),
            WebOriginDecision::Reject,
            "域名 Host(即使与 Origin 同源)一律拒绝,rebinding 无法绕过"
        );
    }

    #[test]
    fn non_loopback_cross_origin_is_rejected() {
        assert_eq!(
            validate_web_origin(
                peer("192.168.1.8"),
                &request(Some("192.168.1.8:9240"), Some("http://evil.example")),
                &allowed(&[]),
            ),
            WebOriginDecision::Reject,
            "IP Host + 恶意跨源 Origin 拒绝"
        );
        assert_eq!(
            validate_web_origin(
                peer("192.168.1.8"),
                &request(Some("192.168.1.8:9240"), Some("null")),
                &allowed(&[]),
            ),
            WebOriginDecision::Reject,
            "Origin: null(sandbox iframe)拒绝"
        );
    }

    #[test]
    fn non_loopback_same_origin_is_allowed() {
        assert_eq!(
            validate_web_origin(
                peer("192.168.1.8"),
                &request(Some("192.168.1.8:9240"), Some("http://192.168.1.8:9240")),
                &allowed(&[]),
            ),
            WebOriginDecision::Allow,
            "daemon 自 serve 的 SPA 同源请求放行"
        );
    }

    #[test]
    fn allowed_origin_list_grants_cross_origin_and_its_host() {
        let list = allowed(&["http://localhost:1420"]);
        assert_eq!(
            validate_web_origin(
                peer("192.168.1.8"),
                &request(Some("192.168.1.8:9240"), Some("http://localhost:1420")),
                &list,
            ),
            WebOriginDecision::Allow,
            "列表内 Origin 放行"
        );
        assert_eq!(
            validate_web_origin(
                peer("192.168.1.8"),
                &request(Some("localhost:1420"), None),
                &list,
            ),
            WebOriginDecision::Allow,
            "列表内 Origin 的 Host 顶层导航放行"
        );
        assert_eq!(
            validate_web_origin(
                peer("192.168.1.8"),
                &request(Some("localhost:1421"), Some("http://localhost:1421")),
                &list,
            ),
            WebOriginDecision::Reject,
            "列表外 Origin 仍拒绝"
        );
    }

    #[test]
    fn ipv6_authority_parsing_is_supported() {
        assert_eq!(
            validate_web_origin(
                peer("::ffff:192.168.1.8"),
                &request(Some("[::1]:9240"), Some("http://[::1]:9240")),
                &allowed(&[]),
            ),
            WebOriginDecision::Allow,
            "IPv6 bracket authority 同源放行"
        );
        assert_eq!(
            validate_web_origin(
                peer("192.168.1.8"),
                &request(Some("[2001:db8::1]:9240"), None),
                &allowed(&[]),
            ),
            WebOriginDecision::Allow,
            "IPv6 字面量视为 IP Host,无 Origin 时放行"
        );
    }
}
