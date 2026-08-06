//! Runtime Pack 签名与哈希校验。
//!
//! 提供 `SignatureVerifier` trait 的具体实现（ed25519）和 SHA-256 校验工具。
//! Runtime Manager（Ticket 03）在下载 Pack 后使用这些工具校验签名和哈希。

use std::path::Path;

use async_trait::async_trait;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use super::error::RuntimeError;
use super::manifest::RuntimeManifest;
use super::seam::SignatureVerifier;
use super::types::Provider;

/// CodeMUX Runtime Pack 签名公钥（ed25519，32 字节）。
///
/// 此公钥与 `scripts/build-runtime-pack.mjs` 的 `--signing-key` 对应私钥配对。
/// 正式发布前需要替换为 CodeMUX 项目实际的 Runtime 签名公钥。
/// 当此常量为全零时，`Ed25519SignatureVerifier` 将跳过签名校验（仅用于开发期）。
pub const CODEMUX_RUNTIME_PUBLIC_KEY: [u8; 32] = [0u8; 32];

/// ed25519 签名校验器。
///
/// 使用内嵌公钥校验 manifest 声明的 Pack 签名。签名是对 Pack 文件 SHA-256 哈希
/// （小写十六进制字符串的字节）的 ed25519 签名。
pub struct Ed25519SignatureVerifier {
    public_key: VerifyingKey,
    /// 是否跳过校验（公钥为全零时，开发期允许跳过）。
    skip_verification: bool,
}

impl Ed25519SignatureVerifier {
    /// 使用 CodeMUX 内嵌公钥创建校验器。
    pub fn with_embedded_key() -> Self {
        let skip = CODEMUX_RUNTIME_PUBLIC_KEY.iter().all(|&b| b == 0);
        let public_key = VerifyingKey::from_bytes(&CODEMUX_RUNTIME_PUBLIC_KEY)
            .expect("CODEMUX_RUNTIME_PUBLIC_KEY 必须是合法的 ed25519 公钥");
        Self {
            public_key,
            skip_verification: skip,
        }
    }

    /// 使用指定公钥创建校验器（测试用）。
    pub fn with_key(public_key: [u8; 32]) -> Result<Self, RuntimeError> {
        let public_key = VerifyingKey::from_bytes(&public_key).map_err(|e| {
            RuntimeError::signature_error(None, format!("非法的 ed25519 公钥: {}", e))
        })?;
        Ok(Self {
            public_key,
            skip_verification: false,
        })
    }
}

#[async_trait]
impl SignatureVerifier for Ed25519SignatureVerifier {
    async fn verify(
        &self,
        manifest: &RuntimeManifest,
        pack_path: &Path,
    ) -> Result<(), RuntimeError> {
        // 读取 Pack 文件并计算 SHA-256
        let pack_bytes = std::fs::read(pack_path).map_err(|e| {
            RuntimeError::io_failed(
                Some(manifest.provider),
                format!("无法读取 Pack 文件 {}: {}", pack_path.display(), e),
            )
        })?;
        let sha256 = Sha256::digest(&pack_bytes);
        let sha256_hex = hex_encode(&sha256);

        // SHA-256 校验始终执行，与签名公钥是否配置无关。
        // spec L23/L57/L62/L104：校验签名和 SHA-256 以避免损坏或被篡改的 Runtime 被启用。
        if sha256_hex != manifest.asset.sha256.to_lowercase() {
            return Err(RuntimeError::hash_mismatch(
                Some(manifest.provider),
                format!(
                    "Pack SHA-256 不匹配：期望 {}，实际 {}",
                    manifest.asset.sha256, sha256_hex
                ),
            ));
        }

        if self.skip_verification {
            // 开发期公钥未配置，跳过签名校验。生产构建必须配置有效公钥。
            return Ok(());
        }

        // 解码 base64 签名
        let signature_bytes = base64_decode(&manifest.asset.signature).map_err(|e| {
            RuntimeError::signature_error(
                Some(manifest.provider),
                format!("无法解码签名 base64: {}", e),
            )
        })?;
        if signature_bytes.len() != 64 {
            return Err(RuntimeError::signature_error(
                Some(manifest.provider),
                format!("签名长度非法：期望 64 字节，实际 {}", signature_bytes.len()),
            ));
        }
        let mut sig_array = [0u8; 64];
        sig_array.copy_from_slice(&signature_bytes);
        let signature = Signature::from_bytes(&sig_array);

        // 签名是对 SHA-256 哈希值（小写十六进制字节）的签名
        let message = sha256_hex.as_bytes();
        self.public_key.verify(message, &signature).map_err(|_| {
            RuntimeError::signature_error(
                Some(manifest.provider),
                "ed25519 签名校验失败".to_string(),
            )
        })
    }
}

/// 校验文件 SHA-256 是否与期望值匹配。
pub fn verify_sha256(file_path: &Path, expected_sha256: &str) -> Result<(), RuntimeError> {
    let bytes = std::fs::read(file_path).map_err(|e| {
        RuntimeError::io_failed(None, format!("无法读取文件 {}: {}", file_path.display(), e))
    })?;
    let actual = Sha256::digest(&bytes);
    let actual_hex = hex_encode(&actual);
    if actual_hex != expected_sha256.to_lowercase() {
        return Err(RuntimeError::hash_mismatch(
            None,
            format!(
                "SHA-256 不匹配：期望 {}，实际 {}",
                expected_sha256, actual_hex
            ),
        ));
    }
    Ok(())
}

/// 计算文件的 SHA-256（小写十六进制）。
pub fn compute_sha256(file_path: &Path) -> Result<String, RuntimeError> {
    let bytes = std::fs::read(file_path).map_err(|e| {
        RuntimeError::io_failed(None, format!("无法读取文件 {}: {}", file_path.display(), e))
    })?;
    let hash = Sha256::digest(&bytes);
    Ok(hex_encode(&hash))
}

/// 将字节数组编码为小写十六进制字符串。
pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 将字节数组编码为 base64 字符串（标准 base64，含填充）。
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let b = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        result.push(TABLE[((b >> 18) & 0x3f) as usize] as char);
        result.push(TABLE[((b >> 12) & 0x3f) as usize] as char);
        result.push(TABLE[((b >> 6) & 0x3f) as usize] as char);
        result.push(TABLE[(b & 0x3f) as usize] as char);
        i += 3;
    }
    let remaining = bytes.len() - i;
    if remaining == 1 {
        let b = (bytes[i] as u32) << 16;
        result.push(TABLE[((b >> 18) & 0x3f) as usize] as char);
        result.push(TABLE[((b >> 12) & 0x3f) as usize] as char);
        result.push('=');
        result.push('=');
    } else if remaining == 2 {
        let b = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        result.push(TABLE[((b >> 18) & 0x3f) as usize] as char);
        result.push(TABLE[((b >> 12) & 0x3f) as usize] as char);
        result.push(TABLE[((b >> 6) & 0x3f) as usize] as char);
        result.push('=');
    }
    result
}

/// 解码 base64 字符串（标准 base64，含填充）。
pub(crate) fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input = input.trim();
    let input = input.trim_end_matches('=');
    let mut result = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for ch in input.bytes() {
        let val = TABLE
            .iter()
            .position(|&t| t == ch)
            .ok_or_else(|| format!("非法 base64 字符: 0x{:02x}", ch))? as u32;
        buffer = (buffer << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            result.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(result)
}

/// 检查 Provider 的关键二进制是否存在且可执行。
///
/// 在 Windows 上检查文件是否存在；在 Unix 上额外检查可执行位。
/// 此函数由 Runtime Manager 在完整性校验阶段调用。
pub fn check_binary_executable(
    runtime_path: &Path,
    binary_rel: &str,
    provider: Provider,
) -> Result<(), RuntimeError> {
    let binary_path = runtime_path.join(binary_rel);
    if !binary_path.exists() {
        return Err(RuntimeError::integrity_failed(
            Some(provider),
            format!("关键二进制缺失: {}", binary_rel),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(&binary_path).map_err(|e| {
            RuntimeError::io_failed(
                Some(provider),
                format!("无法读取二进制元数据 {}: {}", binary_path.display(), e),
            )
        })?;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(RuntimeError::integrity_failed(
                Some(provider),
                format!("关键二进制不可执行: {}", binary_rel),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::fixtures::TempRuntimeFileSystem;
    use crate::runtime::manifest::RuntimeManifestAsset;
    use crate::runtime::types::{Arch, Platform};
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    fn sample_manifest_with_sha(
        provider: Provider,
        sha256: &str,
        signature: &str,
    ) -> RuntimeManifest {
        RuntimeManifest {
            schema_version: crate::runtime::manifest::MANIFEST_SCHEMA_VERSION,
            provider,
            version: "0.3.169".to_string(),
            platform: Platform::Windows,
            arch: Arch::X64,
            asset: RuntimeManifestAsset {
                url: "https://example.com/pack.tar.gz".to_string(),
                size_bytes: 100,
                sha256: sha256.to_string(),
                signature: signature.to_string(),
            },
            sidecar_compat: ">=0.2.0".to_string(),
            key_files: vec!["package.json".to_string()],
            key_binaries: vec!["bin/agent.exe".to_string()],
            created_at: "2026-08-05T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn hex_encode_produces_lowercase() {
        assert_eq!(hex_encode(&[0x0a, 0xff, 0x10]), "0aff10");
    }

    #[test]
    fn base64_round_trips() {
        let original = b"hello world";
        let encoded = base64_encode(original);
        assert_eq!(encoded, "aGVsbG8gd29ybGQ=");
        let decoded = base64_decode(&encoded).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn base64_decode_rejects_invalid_chars() {
        assert!(base64_decode("!!!invalid!!!").is_err());
    }

    #[test]
    fn sha256_computes_known_hash() {
        let fs = TempRuntimeFileSystem::new();
        let file_path = fs.root_path().join("test.txt");
        std::fs::write(&file_path, b"hello").unwrap();
        let hash = compute_sha256(&file_path).unwrap();
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn verify_sha256_passes_on_match() {
        let fs = TempRuntimeFileSystem::new();
        let file_path = fs.root_path().join("test.txt");
        std::fs::write(&file_path, b"hello").unwrap();
        verify_sha256(
            &file_path,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
        .unwrap();
    }

    #[test]
    fn verify_sha256_fails_on_mismatch() {
        let fs = TempRuntimeFileSystem::new();
        let file_path = fs.root_path().join("test.txt");
        std::fs::write(&file_path, b"hello").unwrap();
        let err = verify_sha256(&file_path, &"0".repeat(64)).unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::HashMismatch);
    }

    #[tokio::test]
    async fn ed25519_verifier_passes_with_valid_signature() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key = signing_key.verifying_key();
        let public_key_bytes = verifying_key.to_bytes();

        let fs = TempRuntimeFileSystem::new();
        let pack_path = fs.root_path().join("pack.tar.gz");
        let pack_bytes = b"fake-pack-content";
        std::fs::write(&pack_path, pack_bytes).unwrap();

        let sha256 = Sha256::digest(pack_bytes);
        let sha256_hex = hex_encode(&sha256);
        let message = sha256_hex.as_bytes();
        let signature = signing_key.sign(message);
        let signature_b64 = base64_encode(&signature.to_bytes());

        let manifest = sample_manifest_with_sha(Provider::ClaudeCode, &sha256_hex, &signature_b64);
        let verifier = Ed25519SignatureVerifier::with_key(public_key_bytes).unwrap();
        verifier.verify(&manifest, &pack_path).await.unwrap();
    }

    #[tokio::test]
    async fn ed25519_verifier_fails_with_wrong_signature() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key = signing_key.verifying_key();
        let public_key_bytes = verifying_key.to_bytes();

        let fs = TempRuntimeFileSystem::new();
        let pack_path = fs.root_path().join("pack.tar.gz");
        std::fs::write(&pack_path, b"fake-pack-content").unwrap();

        let sha256 = Sha256::digest(b"fake-pack-content");
        let sha256_hex = hex_encode(&sha256);

        // 用不同的消息签名
        let wrong_signature = signing_key.sign(b"different-message");
        let signature_b64 = base64_encode(&wrong_signature.to_bytes());

        let manifest = sample_manifest_with_sha(Provider::Codex, &sha256_hex, &signature_b64);
        let verifier = Ed25519SignatureVerifier::with_key(public_key_bytes).unwrap();
        let err = verifier.verify(&manifest, &pack_path).await.unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::SignatureError);
    }

    #[tokio::test]
    async fn ed25519_verifier_fails_on_sha_mismatch() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key = signing_key.verifying_key();
        let public_key_bytes = verifying_key.to_bytes();

        let fs = TempRuntimeFileSystem::new();
        let pack_path = fs.root_path().join("pack.tar.gz");
        std::fs::write(&pack_path, b"actual-content").unwrap();

        let wrong_sha = "0".repeat(64);
        let message = wrong_sha.as_bytes();
        let signature = signing_key.sign(message);
        let signature_b64 = base64_encode(&signature.to_bytes());

        let manifest = sample_manifest_with_sha(Provider::OpenCode, &wrong_sha, &signature_b64);
        let verifier = Ed25519SignatureVerifier::with_key(public_key_bytes).unwrap();
        let err = verifier.verify(&manifest, &pack_path).await.unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::HashMismatch);
    }

    #[tokio::test]
    async fn embedded_key_verifier_skips_signature_but_still_checks_sha256_when_key_is_zero() {
        // 公钥未配置时跳过签名校验，但 SHA-256 仍然必须校验通过。
        let verifier = Ed25519SignatureVerifier::with_embedded_key();
        let fs = TempRuntimeFileSystem::new();
        let pack_path = fs.root_path().join("pack.tar.gz");
        std::fs::write(&pack_path, b"content").unwrap();
        let sha256 = Sha256::digest(b"content");
        let sha256_hex = hex_encode(&sha256);
        let manifest =
            sample_manifest_with_sha(Provider::ClaudeCode, &sha256_hex, "placeholder-signature");
        verifier.verify(&manifest, &pack_path).await.unwrap();
    }

    #[tokio::test]
    async fn embedded_key_verifier_fails_on_sha_mismatch_even_when_signature_skipped() {
        // 公钥未配置跳过签名校验时，SHA-256 不匹配仍应失败。
        let verifier = Ed25519SignatureVerifier::with_embedded_key();
        let fs = TempRuntimeFileSystem::new();
        let pack_path = fs.root_path().join("pack.tar.gz");
        std::fs::write(&pack_path, b"content").unwrap();
        let manifest =
            sample_manifest_with_sha(Provider::ClaudeCode, &"0".repeat(64), "placeholder");
        let err = verifier.verify(&manifest, &pack_path).await.unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::HashMismatch);
    }

    #[test]
    fn check_binary_executable_detects_missing_binary() {
        let fs = TempRuntimeFileSystem::new();
        let err = check_binary_executable(fs.root_path(), "bin/missing.exe", Provider::ClaudeCode)
            .unwrap_err();
        assert_eq!(err.kind, crate::runtime::RuntimeErrorKind::IntegrityFailed);
    }

    #[test]
    fn check_binary_executable_passes_when_binary_exists() {
        let fs = TempRuntimeFileSystem::new();
        let bin_dir = fs.root_path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(bin_dir.join("agent.exe"), b"binary").unwrap();
        check_binary_executable(fs.root_path(), "bin/agent.exe", Provider::ClaudeCode).unwrap();
    }
}
