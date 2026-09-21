//! Daemon 核心的注入式环境根。
//!
//! 权威侧模块(db、config、agent sidecar 拉起、统一前端静态资源)不直接
//! 依赖具体进程环境,而是消费调用方构造并注入的 [`PathRoots`]。
//! `codemux-daemon` 二进制从启动参数/环境变量构造;Electron 壳的
//! supervisor spawn 时显式传入。

use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct PathRoots {
    pub app_data_dir: PathBuf,
    pub resource_dir: Option<PathBuf>,
}

impl PathRoots {
    pub fn database_path(&self) -> PathBuf {
        self.app_data_dir.join("codemux.db")
    }

    pub fn config_path(&self) -> PathBuf {
        self.app_data_dir.join("config.json")
    }

    pub fn ensure_app_data_dir(&self) -> Result<(), std::io::Error> {
        std::fs::create_dir_all(&self.app_data_dir)
    }

    /// 浏览器形态(统一前端)静态资源目录:打包环境用资源根下的 dist-web;
    /// 开发环境额外接受源码树里的 dist-web(由 `npm run build:web` 产出),
    /// 这样浏览器直接访问回环端口即可验收统一前端,不必手改 config.json。
    /// CompanionConfig 的 web_static_dir 仍是最高优先级覆盖(见 server.rs)。
    ///
    /// 工单 04 起这是**唯一**的前端产物来源:桌面壳、PC 浏览器、手机浏览器
    /// 共用同一份 dist-web,不再有独立的移动端构建。
    pub fn web_static_dir(&self) -> Option<PathBuf> {
        self.web_static_dir_for(cfg!(debug_assertions))
    }

    fn web_static_dir_for(&self, development: bool) -> Option<PathBuf> {
        if let Some(resource_dir) = &self.resource_dir {
            let packaged = resource_dir.join("dist-web");
            if packaged.exists() {
                return Some(packaged);
            }
        }
        if development {
            let dev_dist =
                repo_root_from_or_two_up(Path::new(env!("CARGO_MANIFEST_DIR"))).join("dist-web");
            if dev_dist.exists() {
                return Some(dev_dist);
            }
        }
        None
    }
}

/// 开发环境下的仓库根:从 crate 的 manifest 目录逐级向上,找同时含
/// `crates/` 与 `apps/` 的目录。
///
/// 布局重构(crates/daemon ↔ apps/sidecar)之后不能再假设 manifest_dir 的父
/// 目录就是仓库根——那是 `crates/`,拼出来的 `crates/apps/sidecar` 并不存在。
/// 认标记目录而不是数层数:测试里传入的假路径(`manifest-root`)找不到标记时
/// 由调用方回落到 `../..`,真仓库路径则永远命中。
pub fn repo_root_from(manifest_dir: &Path) -> Option<PathBuf> {
    let mut current = Some(manifest_dir);
    while let Some(dir) = current {
        if dir.join("crates").is_dir() && dir.join("apps").is_dir() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

/// `repo_root_from` 的回落版:`<manifest_dir>/../..`(= `crates/daemon` → 仓库根)。
pub fn repo_root_from_or_two_up(manifest_dir: &Path) -> PathBuf {
    repo_root_from(manifest_dir).unwrap_or_else(|| {
        manifest_dir
            .parent()
            .and_then(|parent| parent.parent())
            .unwrap_or(manifest_dir)
            .to_path_buf()
    })
}

#[cfg(test)]
mod tests {
    use super::{repo_root_from, repo_root_from_or_two_up, PathRoots};
    use std::path::{Path, PathBuf};

    #[test]
    fn repo_root_is_found_by_marker_dirs_not_by_depth() {
        // 真仓库:crate 在 crates/daemon,仓库根同时含 crates/ 与 apps/。
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = repo_root_from(manifest_dir).expect("real repo layout must carry the markers");
        assert!(root.join("crates").is_dir());
        assert!(root.join("apps").is_dir());
        let sidecar = root
            .join("apps")
            .join("sidecar")
            .join("dist")
            .join("index.js");
        assert!(
            !sidecar.to_string_lossy().contains("crates"),
            "仓库根解析错位会拼出 crates/apps/…:{}",
            sidecar.display()
        );
    }

    #[test]
    fn repo_root_falls_back_to_two_levels_up_for_foreign_paths() {
        // 标记目录找不到时(测试里的假路径/未来布局变化)回落到 ../..,而不是父目录。
        let fake = Path::new("manifest-root");
        assert_eq!(repo_root_from(fake), None);
        assert_eq!(
            repo_root_from_or_two_up(fake),
            PathBuf::from("manifest-root")
        );
    }

    #[test]
    fn derived_paths_live_under_app_data_dir() {
        let roots = PathRoots {
            app_data_dir: PathBuf::from(r"C:\app-data"),
            resource_dir: None,
        };
        assert_eq!(
            roots.database_path(),
            std::path::Path::new(r"C:\app-data").join("codemux.db")
        );
        assert_eq!(
            roots.config_path(),
            std::path::Path::new(r"C:\app-data").join("config.json")
        );
    }

    #[test]
    fn web_static_dir_serves_packaged_dir_only_when_present() {
        let temp = tempfile::tempdir().expect("tempdir");
        let roots = PathRoots {
            app_data_dir: temp.path().join("data"),
            resource_dir: Some(temp.path().to_path_buf()),
        };
        assert_eq!(
            roots.web_static_dir_for(false),
            None,
            "missing dist-web means no browser build is served"
        );

        let packaged = temp.path().join("dist-web");
        std::fs::create_dir_all(&packaged).expect("mkdir");
        assert_eq!(
            roots.web_static_dir_for(false),
            Some(packaged),
            "packaged dist-web should be served once present"
        );
    }

    #[test]
    fn web_static_dir_falls_back_to_source_tree_build_in_development() {
        let temp = tempfile::tempdir().expect("tempdir");
        let roots = PathRoots {
            app_data_dir: temp.path().join("data"),
            resource_dir: Some(temp.path().to_path_buf()),
        };
        let dev_dist =
            repo_root_from_or_two_up(Path::new(env!("CARGO_MANIFEST_DIR"))).join("dist-web");
        assert_eq!(
            roots.web_static_dir_for(true),
            dev_dist.exists().then_some(dev_dist),
            "开发环境按源码树里的 dist-web 是否存在决定是否接管网页端"
        );
    }

    #[test]
    fn ensure_app_data_dir_creates_missing_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_dir = temp.path().join("nested").join("data");
        let roots = PathRoots {
            app_data_dir: data_dir.clone(),
            resource_dir: None,
        };
        roots.ensure_app_data_dir().expect("mkdir");
        assert!(data_dir.is_dir());
    }
}
