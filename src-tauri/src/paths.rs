//! Daemon 核心的注入式环境根。
//!
//! 权威侧模块(db、config、agent sidecar 拉起、移动端静态资源)不直接
//! 依赖具体进程环境,而是消费调用方构造并注入的 [`PathRoots`]。
//! `codemux-daemon` 二进制从启动参数/环境变量构造;Electron 壳的
//! supervisor spawn 时显式传入。

use std::path::PathBuf;

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

    /// 移动端静态资源目录:打包环境优先资源根下的 dist-mobile,开发环境固定
    /// 回退源码树内的构建产物或源码目录(与 sidecar 脚本解析同一约定,避免
    /// 开发时 target 目录里的陈旧拷贝盖过新鲜构建)。
    pub fn mobile_static_dir(&self) -> PathBuf {
        self.mobile_static_dir_for(cfg!(debug_assertions))
    }

    fn mobile_static_dir_for(&self, development: bool) -> PathBuf {
        if !development {
            if let Some(resource_dir) = &self.resource_dir {
                let packaged = resource_dir.join("dist-mobile");
                if packaged.exists() {
                    return packaged;
                }
            }
        }
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let dev_dist = manifest_dir.join("../dist-mobile");
        if dev_dist.exists() {
            return dev_dist;
        }
        manifest_dir.join("../src-mobile/dist")
    }

    /// 网页端(统一前端)静态资源目录:打包环境用资源根下的 dist-web;
    /// 开发环境额外接受源码树里的 dist-web(由 `npm run build:web` 产出),
    /// 这样浏览器直接访问回环端口即可验收统一前端,不必手改 config.json。
    /// CompanionConfig 的 web_static_dir 仍是最高优先级覆盖(见 server.rs)。
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
            let dev_dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist-web");
            if dev_dist.exists() {
                return Some(dev_dist);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::PathRoots;
    use std::path::PathBuf;

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
    fn mobile_static_dir_prefers_existing_packaged_dir_in_release() {
        let temp = tempfile::tempdir().expect("tempdir");
        let packaged = temp.path().join("dist-mobile");
        std::fs::create_dir_all(&packaged).expect("mkdir");
        let roots = PathRoots {
            app_data_dir: temp.path().join("data"),
            resource_dir: Some(temp.path().to_path_buf()),
        };
        assert_eq!(
            roots.mobile_static_dir_for(false),
            packaged,
            "release should serve the bundled copy"
        );
    }

    #[test]
    fn mobile_static_dir_ignores_stale_packaged_copy_in_development() {
        let temp = tempfile::tempdir().expect("tempdir");
        let packaged = temp.path().join("dist-mobile");
        std::fs::create_dir_all(packaged.join("stale")).expect("mkdir");
        let roots = PathRoots {
            app_data_dir: temp.path().join("data"),
            resource_dir: Some(temp.path().to_path_buf()),
        };
        let resolved = roots.mobile_static_dir_for(true);
        assert!(
            !resolved.starts_with(temp.path()),
            "development should fall back to the source tree, not the target copy"
        );
    }

    #[test]
    fn mobile_static_dir_falls_back_to_source_tree() {
        let temp = tempfile::tempdir().expect("tempdir");
        let roots = PathRoots {
            app_data_dir: temp.path().join("data"),
            resource_dir: Some(temp.path().to_path_buf()),
        };
        // 源码树内 dist-mobile 或 src-mobile/dist 至少存在其一(仓库检出的常态)。
        let fallback = roots.mobile_static_dir();
        assert!(fallback.ends_with("dist-mobile") || fallback.ends_with("src-mobile/dist"));
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
            "missing dist-web should keep the mobile fallback"
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
        let dev_dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist-web");
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
