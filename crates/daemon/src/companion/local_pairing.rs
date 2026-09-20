//! 回环浏览器的简化配对(工单 02)。
//!
//! 同机浏览器首次打开统一前端时没有壳桥可注入 Local Daemon Token,按 ADR 0011
//! 也不为浏览器新增 Local Daemon Token 下发途径:改为由浏览器在 loopback 上申请
//! 一次「本机配对请求」,daemon 把请求作为 UI 事件推给桌面壳(或由 CLI 列出),
//! 用户确认后 daemon 用既有 [`complete_pairing`](crate::companion::pairing)
//! 颁发普通 Pairing Token 给该浏览器。
//!
//! 本模块只承载请求表与状态流转,不碰 HTTP/鉴权(那些在 server.rs):
//! 纯逻辑便于单测(过期、重复确认、拒绝)。

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};

/// 本机配对请求的有效窗口:用户需要在窗口内完成一次确认。
pub const LOCAL_PAIRING_TTL_SECS: i64 = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalPairingStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

impl LocalPairingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LocalPairingStatus::Pending => "pending",
            LocalPairingStatus::Approved => "approved",
            LocalPairingStatus::Denied => "denied",
            LocalPairingStatus::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LocalPairingRecord {
    pub id: String,
    pub code: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub status: LocalPairingStatus,
    pub token: Option<String>,
    pub device_id: Option<String>,
}

impl LocalPairingRecord {
    /// 过期是时间函数而非存储状态:首次观察到过期即固化下来,避免请求表
    /// 永远停留在 pending 让确认方误以为还能批准。
    pub fn status_at(&self, now: DateTime<Utc>) -> LocalPairingStatus {
        if self.status == LocalPairingStatus::Pending && now >= self.expires_at {
            return LocalPairingStatus::Expired;
        }
        self.status
    }

    pub fn is_actionable(&self, now: DateTime<Utc>) -> bool {
        self.status_at(now) == LocalPairingStatus::Pending
    }
}

#[derive(Default)]
pub struct LocalPairingRegistry {
    requests: Mutex<HashMap<String, LocalPairingRecord>>,
}

impl LocalPairingRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn sweep(requests: &mut HashMap<String, LocalPairingRecord>, now: DateTime<Utc>) {
        for record in requests.values_mut() {
            if record.status == LocalPairingStatus::Pending && now >= record.expires_at {
                record.status = LocalPairingStatus::Expired;
            }
        }
        // 结束态保留一个 TTL 让浏览器/壳能读到最终结果,过期后再回收。
        let retain_window = Duration::seconds(LOCAL_PAIRING_TTL_SECS);
        requests.retain(|_, record| match record.status_at(now) {
            LocalPairingStatus::Pending => true,
            _ => now - record.expires_at < retain_window,
        });
    }

    pub fn create(&self, id: String, code: String, name: Option<&str>) -> LocalPairingRecord {
        let now = Utc::now();
        let name = name.map(str::trim).filter(|value| !value.is_empty());
        let record = LocalPairingRecord {
            id: id.clone(),
            code,
            name: name.unwrap_or("浏览器").to_string(),
            created_at: now,
            expires_at: now + Duration::seconds(LOCAL_PAIRING_TTL_SECS),
            status: LocalPairingStatus::Pending,
            token: None,
            device_id: None,
        };
        let mut requests = self.requests.lock().unwrap();
        Self::sweep(&mut requests, now);
        requests.insert(id, record.clone());
        record
    }

    pub fn get(&self, id: &str) -> Option<LocalPairingRecord> {
        let now = Utc::now();
        let mut requests = self.requests.lock().unwrap();
        Self::sweep(&mut requests, now);
        requests.get(id).cloned()
    }

    /// 待确认列表:桌面壳/CLI 据此呈现一次确认入口。
    pub fn pending(&self) -> Vec<LocalPairingRecord> {
        let now = Utc::now();
        let mut requests = self.requests.lock().unwrap();
        Self::sweep(&mut requests, now);
        let mut pending: Vec<LocalPairingRecord> = requests
            .values()
            .filter(|record| record.is_actionable(now))
            .cloned()
            .collect();
        pending.sort_by_key(|record| record.created_at);
        pending
    }

    /// 批准:写入 Pairing Token。重复批准/已拒绝/已过期一律报错,不覆盖结果。
    pub fn approve(
        &self,
        id: &str,
        device_id: String,
        token: String,
    ) -> Result<LocalPairingRecord, String> {
        let now = Utc::now();
        let mut requests = self.requests.lock().unwrap();
        Self::sweep(&mut requests, now);
        let record = requests
            .get_mut(id)
            .ok_or_else(|| "Unknown pairing request".to_string())?;
        match record.status_at(now) {
            LocalPairingStatus::Pending => {}
            LocalPairingStatus::Approved => {
                return Err("Pairing request already approved".to_string())
            }
            LocalPairingStatus::Denied => return Err("Pairing request was denied".to_string()),
            LocalPairingStatus::Expired => return Err("Pairing request expired".to_string()),
        }
        record.status = LocalPairingStatus::Approved;
        record.device_id = Some(device_id);
        record.token = Some(token);
        Ok(record.clone())
    }

    pub fn deny(&self, id: &str) -> Result<LocalPairingRecord, String> {
        let now = Utc::now();
        let mut requests = self.requests.lock().unwrap();
        Self::sweep(&mut requests, now);
        let record = requests
            .get_mut(id)
            .ok_or_else(|| "Unknown pairing request".to_string())?;
        match record.status_at(now) {
            LocalPairingStatus::Pending => {}
            LocalPairingStatus::Denied => return Err("Pairing request already denied".to_string()),
            LocalPairingStatus::Approved => {
                return Err("Pairing request already approved".to_string())
            }
            LocalPairingStatus::Expired => return Err("Pairing request expired".to_string()),
        }
        record.status = LocalPairingStatus::Denied;
        Ok(record.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_with_request(id: &str) -> LocalPairingRegistry {
        let registry = LocalPairingRegistry::new();
        registry.create(id.to_string(), "123456".to_string(), Some("Chrome"));
        registry
    }

    #[test]
    fn approve_hands_out_token_once_then_rejects_second_decision() {
        let registry = registry_with_request("req-1");
        let approved = registry
            .approve("req-1", "device-1".to_string(), "cmx_token".to_string())
            .expect("approve");
        assert_eq!(approved.status, LocalPairingStatus::Approved);
        assert_eq!(approved.token.as_deref(), Some("cmx_token"));
        assert_eq!(approved.device_id.as_deref(), Some("device-1"));

        let again = registry.approve("req-1", "device-2".to_string(), "cmx_other".to_string());
        assert!(again.is_err());
        assert_eq!(
            registry.get("req-1").unwrap().token.as_deref(),
            Some("cmx_token"),
            "重复批准不得覆盖已颁发的 token"
        );
    }

    #[test]
    fn deny_is_terminal_and_pending_list_shrinks() {
        let registry = registry_with_request("req-1");
        assert_eq!(registry.pending().len(), 1);

        registry.deny("req-1").expect("deny");
        assert!(registry.pending().is_empty());
        assert_eq!(
            registry.get("req-1").unwrap().status,
            LocalPairingStatus::Denied
        );
        assert!(registry.deny("req-1").is_err());
        assert!(registry
            .approve("req-1", "device".to_string(), "token".to_string())
            .is_err());
    }

    #[test]
    fn unknown_request_is_not_approvable() {
        let registry = LocalPairingRegistry::new();
        assert!(registry
            .approve("missing", "device".to_string(), "token".to_string())
            .is_err());
        assert!(registry.pending().is_empty());
    }

    #[test]
    fn expired_request_reports_expired_and_cannot_be_approved() {
        let registry = registry_with_request("req-1");
        {
            let mut requests = registry.requests.lock().unwrap();
            let record = requests.get_mut("req-1").unwrap();
            record.expires_at = Utc::now() - Duration::seconds(1);
        }
        assert_eq!(
            registry.get("req-1").unwrap().status,
            LocalPairingStatus::Expired
        );
        assert!(registry.pending().is_empty());
        assert!(registry
            .approve("req-1", "device".to_string(), "token".to_string())
            .is_err());
    }

    #[test]
    fn lingering_finished_requests_are_swept_after_retention_window() {
        let registry = registry_with_request("req-1");
        registry.deny("req-1").expect("deny");
        {
            let mut requests = registry.requests.lock().unwrap();
            let record = requests.get_mut("req-1").unwrap();
            record.expires_at = Utc::now() - Duration::seconds(LOCAL_PAIRING_TTL_SECS + 5);
        }
        assert!(registry.get("req-1").is_none(), "结束态超过保留窗口即回收");
    }

    #[test]
    fn blank_device_name_falls_back_to_default_label() {
        let registry = LocalPairingRegistry::new();
        let record = registry.create("req-1".to_string(), "000000".to_string(), Some("   "));
        assert_eq!(record.name, "浏览器");
    }
}
