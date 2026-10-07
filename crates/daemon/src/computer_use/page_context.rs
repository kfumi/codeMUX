//! 浏览器快照喂给闸门的页面上下文缓存(工单 03)。
//!
//! 敏感场景判定需要页面 URL/标题与目标元素是不是密码框 —— 这些只在
//! snapshot 的回包里。daemon 在 execute 回包处截留一份,供随后的
//! click/type/select 审批判定使用。缓存键与壳侧元素快照一致:显式
//! browserId,缺省 `__recent__`(对应壳的「最近打开的页面」)。

use std::collections::HashMap;
use std::sync::RwLock;

use serde_json::Value;

use super::guard;

/// 缺省浏览器键(与壳侧 `snapshotCacheKey` 对齐)。
pub const RECENT_KEY: &str = "__recent__";

/// 与壳侧同规则的缓存键。
pub fn cache_key(browser_id: Option<&str>) -> String {
    match browser_id {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => RECENT_KEY.to_string(),
    }
}

/// 快照里的一个元素(闸门只关心能否指向密码框)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageElement {
    pub id: String,
    pub name: String,
    /// 密码框(壳侧按 `input[type=password]` 标记)。
    pub sensitive: bool,
}

/// 一次快照留下的页面上下文。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageContext {
    pub url: String,
    pub title: String,
    pub elements: Vec<PageElement>,
}

/// 页面上下文缓存(按浏览器键)。
#[derive(Default)]
pub struct PageContextCache {
    entries: RwLock<HashMap<String, PageContext>>,
}

impl PageContextCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 从一次 snapshot 回包里截留上下文;形状不符时静默忽略(不影响执行)。
    pub fn record_snapshot(&self, browser_id: Option<&str>, payload: &Value) {
        let Some(map) = payload.as_object() else {
            return;
        };
        let elements = map
            .get("elements")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let id = item.get("id")?.as_str()?.to_string();
                        Some(PageElement {
                            id,
                            name: item
                                .get("name")
                                .and_then(|value| value.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            sensitive: item
                                .get("sensitive")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(false),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let context = PageContext {
            url: map
                .get("url")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            title: map
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            elements,
        };
        self.entries
            .write()
            .expect("page context lock")
            .insert(cache_key(browser_id), context);
    }

    pub fn get(&self, browser_id: Option<&str>) -> Option<PageContext> {
        self.entries
            .read()
            .expect("page context lock")
            .get(&cache_key(browser_id))
            .cloned()
    }

    pub fn clear(&self) {
        self.entries.write().expect("page context lock").clear();
    }

    /// 面向元素操作(click/type/select)的敏感判定。
    ///
    /// 先看目标元素本身:快照标了密码框即敏感;再看它的标签、页面 URL 与
    /// 标题有没有命中敏感场景词。没有任何上下文(还没快照过)时返回 None,
    /// 此时仍按风险级走审批(输入动作本来就要放行)。
    pub fn sensitivity(
        &self,
        browser_id: Option<&str>,
        element_id: Option<&str>,
    ) -> Option<&'static str> {
        let context = self.get(browser_id)?;
        if let Some(element_id) = element_id {
            if let Some(element) = context.elements.iter().find(|item| item.id == element_id) {
                if element.sensitive {
                    return Some("密码");
                }
                if let Some(trigger) = guard::sensitive_trigger(&element.name) {
                    return Some(trigger);
                }
            }
        }
        guard::sensitivity_of(&[context.url.as_str(), context.title.as_str()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot_payload() -> Value {
        json!({
            "url": "https://shop.example.com/pay/checkout",
            "title": "订单结算",
            "elements": [
                { "id": "e1", "name": "确认支付" },
                { "id": "e2", "name": "银行卡号" },
                { "id": "e3", "name": "登录密码", "sensitive": true },
                { "id": "e4", "name": "取消" }
            ],
            "viewport": { "width": 1280, "height": 800 },
            "screenshot": "AAAA"
        })
    }

    #[test]
    fn cache_key_falls_back_to_recent() {
        assert_eq!(cache_key(Some("browser-1")), "browser-1");
        assert_eq!(cache_key(Some("")), RECENT_KEY);
        assert_eq!(cache_key(None), RECENT_KEY);
    }

    #[test]
    fn record_and_read_roundtrip() {
        let cache = PageContextCache::new();
        assert!(cache.get(None).is_none());
        cache.record_snapshot(None, &snapshot_payload());
        let context = cache.get(None).expect("缺省键应命中");
        assert_eq!(context.url, "https://shop.example.com/pay/checkout");
        assert_eq!(context.elements.len(), 4);
        assert!(context.elements[2].sensitive);
    }

    #[test]
    fn malformed_payload_is_ignored() {
        let cache = PageContextCache::new();
        cache.record_snapshot(None, &json!("not-an-object"));
        assert!(cache.get(None).is_none());
    }

    #[test]
    fn password_element_is_flagged_sensitive() {
        let cache = PageContextCache::new();
        cache.record_snapshot(None, &snapshot_payload());
        assert_eq!(cache.sensitivity(None, Some("e3")), Some("密码"));
    }

    #[test]
    fn element_label_can_trigger_a_scenario() {
        let cache = PageContextCache::new();
        cache.record_snapshot(None, &snapshot_payload());
        assert_eq!(cache.sensitivity(None, Some("e1")), Some("支付"));
    }

    #[test]
    fn page_url_and_title_feed_the_scan() {
        let cache = PageContextCache::new();
        cache.record_snapshot(None, &snapshot_payload());
        // 元素本身没命中,页面 URL(/pay/checkout)命中。
        assert_eq!(cache.sensitivity(None, Some("e4")), Some("支付"));
    }

    #[test]
    fn benign_page_is_not_sensitive() {
        let cache = PageContextCache::new();
        cache.record_snapshot(
            Some("browser-9"),
            &json!({
                "url": "https://example.com/dashboard",
                "title": "概览",
                "elements": [{ "id": "e1", "name": "刷新" }],
            }),
        );
        assert_eq!(cache.sensitivity(Some("browser-9"), Some("e1")), None);
        // 别的浏览器键没有上下文。
        assert_eq!(cache.sensitivity(Some("browser-8"), Some("e1")), None);
    }

    #[test]
    fn clear_drops_everything() {
        let cache = PageContextCache::new();
        cache.record_snapshot(None, &snapshot_payload());
        cache.clear();
        assert!(cache.get(None).is_none());
    }
}
