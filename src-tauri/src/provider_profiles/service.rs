use crate::provider_profiles::native_config::{NativeConfigPaths, RenderedNativeConfig};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub trait FileOps {
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()>;
    fn replace(&self, source: &Path, destination: &Path) -> io::Result<()>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
}

#[derive(Default)]
pub struct StdFileOps;

impl FileOps for StdFileOps {
    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        fs::create_dir_all(path)
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }

    fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(content)?;
        file.flush()?;
        file.sync_all()
    }

    fn replace(&self, source: &Path, destination: &Path) -> io::Result<()> {
        fs::rename(source, destination)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
}

pub struct NativeConfigWriteService<O = StdFileOps> {
    paths: NativeConfigPaths,
    backup_root: PathBuf,
    file_ops: O,
}

#[derive(Debug)]
pub struct NativeConfigWriteResult {
    pub backup_session_dir: PathBuf,
}

struct AppliedFile {
    path: PathBuf,
    original: Option<Vec<u8>>,
}

impl NativeConfigWriteService<StdFileOps> {
    pub fn new(paths: NativeConfigPaths, backup_root: PathBuf) -> Self {
        Self::with_file_ops(paths, backup_root, StdFileOps)
    }
}

impl<O: FileOps> NativeConfigWriteService<O> {
    pub fn with_file_ops(paths: NativeConfigPaths, backup_root: PathBuf, file_ops: O) -> Self {
        Self {
            paths,
            backup_root,
            file_ops,
        }
    }

    pub fn write(
        &self,
        rendered_files: &[RenderedNativeConfig],
    ) -> Result<NativeConfigWriteResult, String> {
        if rendered_files
            .iter()
            .any(|file| !self.is_allowed_target(&file.path))
            || has_duplicate_paths(rendered_files)
        {
            return Err("原生配置目标无效".to_string());
        }

        let session_dir = self.backup_root.join(Uuid::new_v4().to_string());
        if self.file_ops.create_dir_all(&session_dir).is_err() {
            return Err("原生配置备份失败".to_string());
        }

        let mut applied = Vec::with_capacity(rendered_files.len());
        for (index, rendered) in rendered_files.iter().enumerate() {
            let original = match self.file_ops.read(&rendered.path) {
                Ok(content) => Some(content),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(_) => return self.abort(applied),
            };

            if let Some(content) = original.as_ref() {
                let backup_path = session_dir.join(backup_file_name(index, &rendered.path));
                if self
                    .file_ops
                    .write_file_sync(&backup_path, content)
                    .is_err()
                {
                    return self.abort(applied);
                }
            }

            let Some(parent) = rendered.path.parent() else {
                return self.abort(applied);
            };
            if self.file_ops.create_dir_all(parent).is_err() {
                return self.abort(applied);
            }

            let temporary_path = temporary_path(&rendered.path);
            if self
                .file_ops
                .write_file_sync(&temporary_path, rendered.content.as_bytes())
                .is_err()
            {
                let _ = self.file_ops.remove_file(&temporary_path);
                return self.abort(applied);
            }
            if self
                .file_ops
                .replace(&temporary_path, &rendered.path)
                .is_err()
            {
                let _ = self.file_ops.remove_file(&temporary_path);
                return self.abort(applied);
            }

            applied.push(AppliedFile {
                path: rendered.path.clone(),
                original,
            });
        }

        Ok(NativeConfigWriteResult {
            backup_session_dir: session_dir,
        })
    }

    fn abort(&self, applied: Vec<AppliedFile>) -> Result<NativeConfigWriteResult, String> {
        self.rollback(applied);
        Err("原生配置写入失败，已尝试回滚".to_string())
    }

    fn rollback(&self, applied: Vec<AppliedFile>) {
        for applied_file in applied.into_iter().rev() {
            match applied_file.original {
                Some(content) => {
                    let temporary_path = temporary_path(&applied_file.path);
                    if self
                        .file_ops
                        .write_file_sync(&temporary_path, &content)
                        .is_ok()
                    {
                        let _ = self.file_ops.replace(&temporary_path, &applied_file.path);
                    }
                    let _ = self.file_ops.remove_file(&temporary_path);
                }
                None => {
                    let _ = self.file_ops.remove_file(&applied_file.path);
                }
            }
        }
    }

    fn is_allowed_target(&self, path: &Path) -> bool {
        path == self.paths.claude_settings_path()
            || path == self.paths.codex_auth_path()
            || path == self.paths.codex_config_path()
            || path == self.paths.opencode_config_path()
    }
}

fn has_duplicate_paths(rendered_files: &[RenderedNativeConfig]) -> bool {
    rendered_files.iter().enumerate().any(|(index, file)| {
        rendered_files[..index]
            .iter()
            .any(|prior| prior.path == file.path)
    })
}

fn temporary_path(target: &Path) -> PathBuf {
    let file_name = target.file_name().unwrap_or_default().to_string_lossy();
    target.with_file_name(format!(".{file_name}.{}.tmp", Uuid::new_v4()))
}

fn backup_file_name(index: usize, target: &Path) -> String {
    let file_name = target.file_name().unwrap_or_default().to_string_lossy();
    format!("{index:03}-{file_name}")
}

#[cfg(test)]
mod tests {
    use super::{FileOps, NativeConfigWriteService, StdFileOps};
    use crate::provider_profiles::native_config::{NativeConfigPaths, RenderedNativeConfig};
    use std::{
        cell::Cell,
        fs, io,
        path::{Path, PathBuf},
    };
    use uuid::Uuid;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("codemux-native-config-service-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_paths(root: &Path) -> NativeConfigPaths {
        NativeConfigPaths::new(
            root.join("claude"),
            root.join("codex"),
            root.join("opencode"),
        )
    }

    fn codex_files(paths: &NativeConfigPaths) -> Vec<RenderedNativeConfig> {
        vec![
            RenderedNativeConfig {
                path: paths.codex_auth_path(),
                content: "new auth".to_string(),
            },
            RenderedNativeConfig {
                path: paths.codex_config_path(),
                content: "new config".to_string(),
            },
        ]
    }

    #[test]
    fn 写入既有文件并在会话目录备份精确内容() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.codex_dir).unwrap();
        fs::write(paths.codex_auth_path(), b"old auth\r\n").unwrap();
        fs::write(paths.codex_config_path(), b"old config\0").unwrap();
        let backup_root = temp.path().join("backups");
        let service = NativeConfigWriteService::new(paths.clone(), backup_root);

        let result = service.write(&codex_files(&paths)).unwrap();

        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"new auth");
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"new config");
        assert_eq!(
            fs::read(result.backup_session_dir.join("000-auth.json")).unwrap(),
            b"old auth\r\n"
        );
        assert_eq!(
            fs::read(result.backup_session_dir.join("001-config.toml")).unwrap(),
            b"old config\0"
        );
    }

    #[test]
    fn 无原文件时创建目标且不产生备份文件() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        let backup_root = temp.path().join("backups");
        let service = NativeConfigWriteService::new(paths.clone(), backup_root);
        let file = RenderedNativeConfig {
            path: paths.codex_auth_path(),
            content: "new auth".to_string(),
        };

        let result = service.write(&[file]).unwrap();

        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"new auth");
        assert!(fs::read_dir(result.backup_session_dir)
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn 第二次替换失败时删除本次新建文件() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.codex_dir).unwrap();
        fs::write(paths.codex_config_path(), b"old config").unwrap();
        let service = NativeConfigWriteService::with_file_ops(
            paths.clone(),
            temp.path().join("backups"),
            FailSecondReplaceOps::default(),
        );

        let error = service.write(&codex_files(&paths)).unwrap_err();

        assert_eq!(error, "原生配置写入失败，已尝试回滚");
        assert!(!paths.codex_auth_path().exists());
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"old config");
    }

    #[test]
    fn 第二次替换失败时恢复_auth_json_和_config_toml() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.codex_dir).unwrap();
        fs::write(paths.codex_auth_path(), b"old auth").unwrap();
        fs::write(paths.codex_config_path(), b"old config").unwrap();
        let service = NativeConfigWriteService::with_file_ops(
            paths.clone(),
            temp.path().join("backups"),
            FailSecondReplaceOps::default(),
        );

        let error = service.write(&codex_files(&paths)).unwrap_err();

        assert_eq!(error, "原生配置写入失败，已尝试回滚");
        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"old auth");
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"old config");
    }

    #[derive(Default)]
    struct FailSecondReplaceOps {
        replace_count: Cell<usize>,
        inner: StdFileOps,
    }

    impl FileOps for FailSecondReplaceOps {
        fn create_dir_all(&self, path: &Path) -> io::Result<()> {
            self.inner.create_dir_all(path)
        }

        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            self.inner.read(path)
        }

        fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()> {
            self.inner.write_file_sync(path, content)
        }

        fn replace(&self, source: &Path, destination: &Path) -> io::Result<()> {
            let count = self.replace_count.get() + 1;
            self.replace_count.set(count);
            if count == 2 {
                return Err(io::Error::other("simulated replace failure"));
            }
            self.inner.replace(source, destination)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            self.inner.remove_file(path)
        }
    }
}
