//! npm Runtime 单元测试夹具。

use std::path::{Path, PathBuf};

use async_trait::async_trait;

use super::error::RuntimeError;
use super::seam::{NodeResolver, RuntimeFileSystem};
use super::types::{NodeDetection, Provider};

/// 基于临时目录的 Runtime 文件系统夹具。
pub struct TempRuntimeFileSystem {
    _tmp: tempfile::TempDir,
    roots: super::seam::FileSystemRuntimeRoots,
}

impl TempRuntimeFileSystem {
    pub fn new() -> Self {
        let tmp = tempfile::TempDir::new().expect("无法创建临时目录");
        let roots = super::seam::FileSystemRuntimeRoots::new(tmp.path().to_path_buf());
        Self { _tmp: tmp, roots }
    }

    pub fn root_path(&self) -> &Path {
        self.roots.root()
    }
}

impl Default for TempRuntimeFileSystem {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeFileSystem for TempRuntimeFileSystem {
    fn root(&self) -> PathBuf {
        self.roots.root().to_path_buf()
    }

    fn read_current_version(&self, provider: Provider) -> Option<String> {
        self.roots.read_current_version(provider)
    }

    fn write_current_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError> {
        self.roots.write_current_version(provider, version)
    }

    fn list_installed_versions(&self, provider: Provider) -> Vec<String> {
        self.roots.list_installed_versions(provider)
    }

    fn remove_version(&self, provider: Provider, version: &str) -> Result<(), RuntimeError> {
        self.roots.remove_version(provider, version)
    }

    fn remove_provider(&self, provider: Provider) -> Result<(), RuntimeError> {
        self.roots.remove_provider(provider)
    }
}

/// 固定 Node.js 解析器夹具，避免测试依赖机器 PATH。
pub struct FixedNodeResolver {
    detection: NodeDetection,
}

impl FixedNodeResolver {
    pub fn new(detection: NodeDetection) -> Self {
        Self { detection }
    }

    pub fn satisfied() -> Self {
        Self::new(NodeDetection::from_version(
            Some("v20.10.0".to_string()),
            Some("/usr/bin/node".to_string()),
        ))
    }
}

#[async_trait]
impl NodeResolver for FixedNodeResolver {
    async fn detect(&self) -> NodeDetection {
        self.detection.clone()
    }
}
