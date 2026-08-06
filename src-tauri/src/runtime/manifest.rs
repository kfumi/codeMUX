//! Runtime Pack manifest schema。
//!
//! manifest 描述 Runtime 版本、Provider、平台、架构、下载资产、文件大小、SHA-256、签名、
//! 兼容的 sidecar 版本、关键文件和关键二进制。客户端据此执行完整性检查和版本选择。

use serde::{Deserialize, Serialize};

use super::types::{Arch, Platform, Provider};

/// manifest schema 版本。未来字段变更需要升级此版本号并提供迁移。
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Runtime Pack manifest。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    /// schema 版本，当前固定为 1。
    pub schema_version: u32,
    /// Provider 标识（claude_code / codex / opencode）。
    pub provider: Provider,
    /// Runtime 语义化版本（例如 `0.3.169`）。
    pub version: String,
    /// 目标平台。
    pub platform: Platform,
    /// 目标架构。
    pub arch: Arch,
    /// 下载资产信息。
    pub asset: RuntimeManifestAsset,
    /// 兼容的 sidecar 版本要求（语义化版本范围字符串，例如 `>=0.2.0`）。
    pub sidecar_compat: String,
    /// 关键文件列表（相对 Runtime 根目录的路径，例如 `package.json`）。
    /// 完整性校验时必须存在。
    pub key_files: Vec<String>,
    /// 关键二进制列表（相对 Runtime 根目录的路径，例如 `bin/claude.exe`）。
    /// 完整性校验时必须存在且可执行。
    pub key_binaries: Vec<String>,
    /// 发布时间（ISO 8601 字符串）。
    pub created_at: String,
}

/// manifest 中的下载资产描述。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifestAsset {
    /// 下载 URL（GitHub Release 资产地址）。
    pub url: String,
    /// 文件大小（字节），用于进度展示和下载前预判。
    pub size_bytes: u64,
    /// Pack 资产的 SHA-256（小写十六进制）。
    pub sha256: String,
    /// Pack 资产的离线签名（与项目现有签名体系一致）。
    pub signature: String,
}

impl RuntimeManifest {
    /// manifest 标识元组，用于比较与去重。
    pub fn target(&self) -> (Provider, Platform, Arch) {
        (self.provider, self.platform, self.arch)
    }

    /// manifest 是否匹配当前进程的平台和架构。
    pub fn matches_current_target(&self) -> bool {
        self.platform == Platform::current() && self.arch == Arch::current()
    }

    /// 校验 manifest 自身字段一致性（不依赖网络或文件系统）。
    ///
    /// 返回 `Err(message)` 表示 manifest 内容不可信，不应据此下载 Pack。
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(format!(
                "manifest schema_version 不匹配：期望 {}，实际 {}",
                MANIFEST_SCHEMA_VERSION, self.schema_version
            ));
        }
        if self.version.trim().is_empty() {
            return Err("manifest version 为空".to_string());
        }
        if self.asset.url.trim().is_empty() {
            return Err("manifest asset.url 为空".to_string());
        }
        if self.asset.size_bytes == 0 {
            return Err("manifest asset.size_bytes 为 0".to_string());
        }
        if self.asset.sha256.trim().is_empty() {
            return Err("manifest asset.sha256 为空".to_string());
        }
        if self.asset.signature.trim().is_empty() {
            return Err("manifest asset.signature 为空".to_string());
        }
        if self.sidecar_compat.trim().is_empty() {
            return Err("manifest sidecar_compat 为空".to_string());
        }
        // SHA-256 应为 64 位小写十六进制。
        let sha = self.asset.sha256.trim().to_lowercase();
        if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!(
                "manifest asset.sha256 不是合法的 SHA-256：{}",
                self.asset.sha256
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_manifest() -> RuntimeManifest {
        RuntimeManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            provider: Provider::ClaudeCode,
            version: "0.3.169".to_string(),
            platform: Platform::Windows,
            arch: Arch::X64,
            asset: RuntimeManifestAsset {
                url: "https://example.com/claude-0.3.169-win-x64.zip".to_string(),
                size_bytes: 1024,
                sha256: "a".repeat(64),
                signature: "sig".to_string(),
            },
            sidecar_compat: ">=0.2.0".to_string(),
            key_files: vec!["package.json".to_string()],
            key_binaries: vec!["bin/claude.exe".to_string()],
            created_at: "2026-08-05T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn validate_accepts_well_formed_manifest() {
        assert!(sample_manifest().validate().is_ok());
    }

    #[test]
    fn validate_rejects_wrong_schema_version() {
        let mut m = sample_manifest();
        m.schema_version = 99;
        assert!(m.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_version() {
        let mut m = sample_manifest();
        m.version = "  ".to_string();
        assert!(m.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_url() {
        let mut m = sample_manifest();
        m.asset.url = "".to_string();
        assert!(m.validate().is_err());
    }

    #[test]
    fn validate_rejects_zero_size() {
        let mut m = sample_manifest();
        m.asset.size_bytes = 0;
        assert!(m.validate().is_err());
    }

    #[test]
    fn validate_rejects_malformed_sha256() {
        let mut m = sample_manifest();
        m.asset.sha256 = "short".to_string();
        assert!(m.validate().is_err());

        m.asset.sha256 = "Z".repeat(64); // 非十六进制字符
        assert!(m.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_signature() {
        let mut m = sample_manifest();
        m.asset.signature = "".to_string();
        assert!(m.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_sidecar_compat() {
        let mut m = sample_manifest();
        m.sidecar_compat = "".to_string();
        assert!(m.validate().is_err());
    }

    #[test]
    fn target_tuple_groups_provider_platform_arch() {
        let m = sample_manifest();
        assert_eq!(
            m.target(),
            (Provider::ClaudeCode, Platform::Windows, Arch::X64)
        );
    }

    #[test]
    fn manifest_serializes_to_camel_case() {
        let m = sample_manifest();
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("schemaVersion"));
        assert!(json.contains("sidecarCompat"));
        assert!(json.contains("keyFiles"));
        assert!(json.contains("keyBinaries"));
        assert!(json.contains("sizeBytes"));
        assert!(json.contains("createdAt"));
    }

    #[test]
    fn manifest_round_trips_through_json() {
        let m = sample_manifest();
        let json = serde_json::to_string(&m).unwrap();
        let back: RuntimeManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.provider, m.provider);
        assert_eq!(back.version, m.version);
        assert_eq!(back.asset.sha256, m.asset.sha256);
    }
}
