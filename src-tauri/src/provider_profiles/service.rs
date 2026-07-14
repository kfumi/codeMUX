use crate::provider_profiles::native_config::{NativeConfigPaths, RenderedNativeConfig};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackStatus {
    NotAttempted,
    Complete,
    Partial,
}

#[derive(Debug)]
pub struct NativeConfigWriteError {
    message: &'static str,
    pub backup_session_dir: Option<PathBuf>,
    pub rollback_status: RollbackStatus,
}

impl NativeConfigWriteError {
    fn new(
        message: &'static str,
        backup_session_dir: Option<PathBuf>,
        rollback_status: RollbackStatus,
    ) -> Self {
        Self {
            message,
            backup_session_dir,
            rollback_status,
        }
    }
}

impl fmt::Display for NativeConfigWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for NativeConfigWriteError {}

pub trait FileOps {
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()>;
    fn replace(&self, source: &Path, destination: &Path) -> io::Result<()>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;

    fn read_dir(&self, path: &Path) -> io::Result<Vec<PathBuf>> {
        fs::read_dir(path)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect()
    }

    fn sync_dir(&self, _path: &Path) -> io::Result<()> {
        Ok(())
    }

    fn restrict_directory_permissions(&self, _path: &Path) -> io::Result<()> {
        Ok(())
    }

    fn restrict_file_permissions(&self, _path: &Path) -> io::Result<()> {
        Ok(())
    }

    fn file_mode(&self, _path: &Path) -> io::Result<Option<u32>> {
        Ok(None)
    }

    fn set_file_mode(&self, _path: &Path, _mode: u32) -> io::Result<()> {
        Ok(())
    }

    fn open_lock_file(&self, path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)
    }

    fn try_lock_exclusive(&self, file: &File) -> io::Result<()> {
        file.try_lock().map_err(Into::into)
    }

    fn after_target_replace(&self, _target: &Path) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Default)]
pub struct StdFileOps;

impl FileOps for StdFileOps {
    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true).mode(0o700);
            builder.create(path)
        }
        #[cfg(not(unix))]
        {
            fs::create_dir_all(path)
        }
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }

    fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
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

    fn sync_dir(&self, path: &Path) -> io::Result<()> {
        #[cfg(unix)]
        {
            File::open(path)?.sync_all()
        }
        #[cfg(not(unix))]
        {
            // Windows 不支持对目录句柄调用 fsync；文件 replace 已由 MoveFileEx 保证，故显式降级。
            let _ = path;
            Ok(())
        }
    }

    fn restrict_directory_permissions(&self, path: &Path) -> io::Result<()> {
        set_restricted_permissions(path, true)
    }

    fn restrict_file_permissions(&self, path: &Path) -> io::Result<()> {
        set_restricted_permissions(path, false)
    }

    fn file_mode(&self, path: &Path) -> io::Result<Option<u32>> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            return Ok(Some(fs::metadata(path)?.permissions().mode()));
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Ok(None)
        }
    }

    fn set_file_mode(&self, path: &Path, mode: u32) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            return fs::set_permissions(path, fs::Permissions::from_mode(mode));
        }
        #[cfg(not(unix))]
        {
            let _ = (path, mode);
            Ok(())
        }
    }
}

fn set_restricted_permissions(path: &Path, directory: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        );
    }
    #[cfg(windows)]
    {
        // 标准库无法构造仅限当前用户的 DACL；这里不放宽继承 ACL，并移除只读标记。
        // 生产 Windows 版本仍依赖 CodeMUX 私有数据根的当前用户 ACL。
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(false);
        let _ = directory;
        return fs::set_permissions(path, permissions);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, directory);
        Ok(())
    }
}

pub struct NativeConfigWriteService<O = StdFileOps> {
    paths: NativeConfigPaths,
    backup_root: PathBuf,
    lock_root: PathBuf,
    file_ops: O,
}

#[derive(Debug)]
pub struct NativeConfigWriteResult {
    pub backup_session_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TransactionState {
    Prepared,
    Applying,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TransactionManifest {
    state: TransactionState,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestFile {
    target: PathBuf,
    backup_file: Option<String>,
    original_mode: Option<u32>,
}

impl NativeConfigWriteService<StdFileOps> {
    pub fn new(paths: NativeConfigPaths, backup_root: PathBuf) -> Self {
        Self::with_lock_root(paths, backup_root.clone(), backup_root)
    }

    pub fn with_lock_root(
        paths: NativeConfigPaths,
        backup_root: PathBuf,
        lock_root: PathBuf,
    ) -> Self {
        Self::with_file_ops_and_lock_root(paths, backup_root, lock_root, StdFileOps)
    }
}

impl<O: FileOps> NativeConfigWriteService<O> {
    pub fn with_file_ops(paths: NativeConfigPaths, backup_root: PathBuf, file_ops: O) -> Self {
        Self::with_file_ops_and_lock_root(paths, backup_root.clone(), backup_root, file_ops)
    }

    pub fn with_file_ops_and_lock_root(
        paths: NativeConfigPaths,
        backup_root: PathBuf,
        lock_root: PathBuf,
        file_ops: O,
    ) -> Self {
        Self {
            paths,
            backup_root,
            lock_root,
            file_ops,
        }
    }

    pub fn write(
        &self,
        rendered_files: &[RenderedNativeConfig],
    ) -> Result<NativeConfigWriteResult, NativeConfigWriteError> {
        if rendered_files
            .iter()
            .any(|file| !self.is_allowed_target(&file.path))
            || has_duplicate_paths(rendered_files)
        {
            return Err(NativeConfigWriteError::new(
                "原生配置目标无效",
                None,
                RollbackStatus::NotAttempted,
            ));
        }

        let _lock = self.acquire_lock()?;
        self.create_secure_directory(&self.backup_root)
            .map_err(|_| self.error("原生配置备份失败", None, RollbackStatus::NotAttempted))?;
        self.recover_unfinished_transactions()?;

        let session_dir = self.backup_root.join(Uuid::new_v4().to_string());
        self.create_secure_directory(&session_dir).map_err(|_| {
            self.error(
                "原生配置备份失败",
                Some(session_dir.clone()),
                RollbackStatus::NotAttempted,
            )
        })?;

        let mut manifest = TransactionManifest {
            state: TransactionState::Prepared,
            files: Vec::with_capacity(rendered_files.len()),
        };
        for (index, rendered) in rendered_files.iter().enumerate() {
            let original = match self.file_ops.read(&rendered.path) {
                Ok(content) => Some(content),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(_) => {
                    return Err(self.error(
                        "原生配置读取失败",
                        Some(session_dir),
                        RollbackStatus::NotAttempted,
                    ));
                }
            };
            let original_mode = if original.is_some() {
                match self.file_ops.file_mode(&rendered.path) {
                    Ok(mode) => mode,
                    Err(_) => {
                        return Err(self.error(
                            "原生配置读取失败",
                            Some(session_dir),
                            RollbackStatus::NotAttempted,
                        ));
                    }
                }
            } else {
                None
            };
            let backup_file = original.as_ref().map(|content| {
                let file_name = backup_file_name(index, &rendered.path);
                let backup_path = session_dir.join(&file_name);
                (file_name, backup_path, content)
            });
            if let Some((_, backup_path, content)) = backup_file.as_ref() {
                if self.write_new_secure_file(backup_path, content).is_err()
                    || self.file_ops.sync_dir(&session_dir).is_err()
                {
                    return Err(self.error(
                        "原生配置备份失败",
                        Some(session_dir),
                        RollbackStatus::NotAttempted,
                    ));
                }
            }
            manifest.files.push(ManifestFile {
                target: rendered.path.clone(),
                backup_file: backup_file.map(|(file_name, _, _)| file_name),
                original_mode,
            });
        }
        if self.write_manifest(&session_dir, &manifest).is_err() {
            return Err(self.error(
                "原生配置备份失败",
                Some(session_dir),
                RollbackStatus::NotAttempted,
            ));
        }
        manifest.state = TransactionState::Applying;
        if self.write_manifest(&session_dir, &manifest).is_err() {
            return Err(self.error(
                "原生配置写入失败",
                Some(session_dir),
                RollbackStatus::NotAttempted,
            ));
        }

        for (index, (rendered, file)) in rendered_files.iter().zip(&manifest.files).enumerate() {
            match self.replace_target(
                &rendered.path,
                rendered.content.as_bytes(),
                file.original_mode,
            ) {
                Ok(()) => {}
                Err(ApplyFailure::Interrupted) => {
                    return Err(self.error(
                        "原生配置写入中断，等待下次恢复",
                        Some(session_dir),
                        RollbackStatus::NotAttempted,
                    ));
                }
                Err(ApplyFailure::Failed) => {
                    return self.abort_manifest(&session_dir, &manifest, index)
                }
            }
        }
        manifest.state = TransactionState::Committed;
        if self.write_manifest(&session_dir, &manifest).is_err() {
            return self.abort_manifest(&session_dir, &manifest, manifest.files.len());
        }
        Ok(NativeConfigWriteResult {
            backup_session_dir: session_dir,
        })
    }

    fn acquire_lock(&self) -> Result<File, NativeConfigWriteError> {
        if self.file_ops.create_dir_all(&self.lock_root).is_err()
            || self.file_ops.sync_dir(&self.lock_root).is_err()
        {
            return Err(self.error("原生配置锁不可用", None, RollbackStatus::NotAttempted));
        }
        let lock_path = self.lock_root.join(".codemux-native-config.lock");
        let lock_file = self
            .file_ops
            .open_lock_file(&lock_path)
            .map_err(|_| self.error("原生配置锁不可用", None, RollbackStatus::NotAttempted))?;
        self.file_ops
            .try_lock_exclusive(&lock_file)
            .map_err(|_| self.error("原生配置正在写入", None, RollbackStatus::NotAttempted))?;
        Ok(lock_file)
    }

    fn create_secure_directory(&self, path: &Path) -> io::Result<()> {
        self.file_ops.create_dir_all(path)?;
        self.file_ops.restrict_directory_permissions(path)?;
        if let Some(parent) = path.parent() {
            self.file_ops.sync_dir(parent)?;
        }
        self.file_ops.sync_dir(path)
    }

    fn write_new_secure_file(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        self.file_ops.write_file_sync(path, content)?;
        self.file_ops.restrict_file_permissions(path)
    }

    fn write_manifest(&self, session_dir: &Path, manifest: &TransactionManifest) -> io::Result<()> {
        let content = serde_json::to_vec(manifest)
            .map_err(|_| io::Error::other("manifest serialization failed"))?;
        self.write_atomic_file(&session_dir.join("manifest.json"), &content)
    }

    fn write_atomic_file(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("missing parent"))?;
        let temporary_path = temporary_path(path);
        if let Err(error) = self.write_new_secure_file(&temporary_path, content) {
            let _ = self.file_ops.remove_file(&temporary_path);
            return Err(error);
        }
        if let Err(error) = self.file_ops.replace(&temporary_path, path) {
            let _ = self.file_ops.remove_file(&temporary_path);
            return Err(error);
        }
        self.file_ops.restrict_file_permissions(path)?;
        self.file_ops.sync_dir(parent)
    }

    fn replace_target(
        &self,
        target: &Path,
        content: &[u8],
        original_mode: Option<u32>,
    ) -> Result<(), ApplyFailure> {
        let parent = target.parent().ok_or(ApplyFailure::Failed)?;
        if self.file_ops.create_dir_all(parent).is_err() {
            return Err(ApplyFailure::Failed);
        }
        let temporary_path = temporary_path(target);
        if self
            .write_new_secure_file(&temporary_path, content)
            .is_err()
        {
            let _ = self.file_ops.remove_file(&temporary_path);
            return Err(ApplyFailure::Failed);
        }
        if self.file_ops.replace(&temporary_path, target).is_err() {
            let _ = self.file_ops.remove_file(&temporary_path);
            return Err(ApplyFailure::Failed);
        }
        let permissions = match original_mode {
            Some(mode) => self.file_ops.set_file_mode(target, mode),
            None => self.file_ops.restrict_file_permissions(target),
        };
        if permissions.is_err() || self.file_ops.sync_dir(parent).is_err() {
            return Err(ApplyFailure::Failed);
        }
        match self.file_ops.after_target_replace(target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                Err(ApplyFailure::Interrupted)
            }
            Err(_) => Err(ApplyFailure::Failed),
        }
    }

    fn abort_manifest(
        &self,
        session_dir: &Path,
        manifest: &TransactionManifest,
        applied_count: usize,
    ) -> Result<NativeConfigWriteResult, NativeConfigWriteError> {
        let rollback_status = self.rollback_files(session_dir, &manifest.files[..applied_count]);
        let message = match rollback_status {
            RollbackStatus::Partial => "原生配置写入失败，回滚不完整",
            RollbackStatus::Complete => "原生配置写入失败，已回滚",
            RollbackStatus::NotAttempted => "原生配置写入失败",
        };
        if rollback_status == RollbackStatus::Complete {
            let mut committed = manifest.clone();
            committed.state = TransactionState::Committed;
            if self.write_manifest(session_dir, &committed).is_err() {
                return Err(self.error(
                    "原生配置写入失败，回滚不完整",
                    Some(session_dir.to_path_buf()),
                    RollbackStatus::Partial,
                ));
            }
        }
        Err(NativeConfigWriteError::new(
            message,
            Some(session_dir.to_path_buf()),
            rollback_status,
        ))
    }

    fn rollback_manifest(
        &self,
        session_dir: &Path,
        manifest: &TransactionManifest,
    ) -> RollbackStatus {
        self.rollback_files(session_dir, &manifest.files)
    }

    fn rollback_files(&self, session_dir: &Path, files: &[ManifestFile]) -> RollbackStatus {
        if files.is_empty() {
            return RollbackStatus::NotAttempted;
        }
        let mut partial = false;
        for file in files.iter().rev() {
            match &file.backup_file {
                Some(backup_file) => {
                    let backup_path = session_dir.join(backup_file);
                    let Ok(content) = self.file_ops.read(&backup_path) else {
                        partial = true;
                        continue;
                    };
                    if self
                        .replace_target_without_hook(&file.target, &content, file.original_mode)
                        .is_err()
                    {
                        partial = true;
                    }
                }
                None => {
                    if let Err(error) = self.file_ops.remove_file(&file.target) {
                        if error.kind() != io::ErrorKind::NotFound {
                            partial = true;
                        }
                    } else if let Some(parent) = file.target.parent() {
                        if self.file_ops.sync_dir(parent).is_err() {
                            partial = true;
                        }
                    }
                }
            }
        }
        if partial {
            RollbackStatus::Partial
        } else {
            RollbackStatus::Complete
        }
    }

    fn replace_target_without_hook(
        &self,
        target: &Path,
        content: &[u8],
        original_mode: Option<u32>,
    ) -> io::Result<()> {
        let parent = target
            .parent()
            .ok_or_else(|| io::Error::other("missing parent"))?;
        self.file_ops.create_dir_all(parent)?;
        let temporary_path = temporary_path(target);
        if let Err(error) = self.write_new_secure_file(&temporary_path, content) {
            let _ = self.file_ops.remove_file(&temporary_path);
            return Err(error);
        }
        if let Err(error) = self.file_ops.replace(&temporary_path, target) {
            let _ = self.file_ops.remove_file(&temporary_path);
            return Err(error);
        }
        match original_mode {
            Some(mode) => self.file_ops.set_file_mode(target, mode)?,
            None => self.file_ops.restrict_file_permissions(target)?,
        }
        self.file_ops.sync_dir(parent)
    }

    fn recover_unfinished_transactions(&self) -> Result<(), NativeConfigWriteError> {
        let sessions = self
            .file_ops
            .read_dir(&self.backup_root)
            .map_err(|_| self.error("原生配置恢复失败", None, RollbackStatus::NotAttempted))?;
        for session_dir in sessions {
            let manifest_path = session_dir.join("manifest.json");
            let content = match self.file_ops.read(&manifest_path) {
                Ok(content) => content,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(_) => {
                    return Err(self.error(
                        "原生配置恢复失败",
                        Some(session_dir),
                        RollbackStatus::NotAttempted,
                    ));
                }
            };
            let mut manifest: TransactionManifest =
                serde_json::from_slice(&content).map_err(|_| {
                    self.error(
                        "原生配置恢复失败",
                        Some(session_dir.clone()),
                        RollbackStatus::NotAttempted,
                    )
                })?;
            if manifest.files.iter().any(|file| {
                !self.is_allowed_target(&file.target)
                    || file.backup_file.as_ref().is_some_and(|name| {
                        Path::new(name)
                            .file_name()
                            .is_none_or(|file_name| file_name != std::ffi::OsStr::new(name))
                    })
            }) {
                return Err(self.error(
                    "原生配置恢复记录无效",
                    Some(session_dir),
                    RollbackStatus::NotAttempted,
                ));
            }
            match manifest.state {
                TransactionState::Committed => {}
                TransactionState::Prepared => {
                    manifest.state = TransactionState::Committed;
                    self.write_manifest(&session_dir, &manifest).map_err(|_| {
                        self.error(
                            "原生配置恢复失败",
                            Some(session_dir.clone()),
                            RollbackStatus::NotAttempted,
                        )
                    })?;
                }
                TransactionState::Applying => {
                    let status = self.rollback_manifest(&session_dir, &manifest);
                    if status != RollbackStatus::Complete {
                        return Err(self.error("原生配置恢复不完整", Some(session_dir), status));
                    }
                    manifest.state = TransactionState::Committed;
                    self.write_manifest(&session_dir, &manifest).map_err(|_| {
                        self.error(
                            "原生配置恢复不完整",
                            Some(session_dir.clone()),
                            RollbackStatus::Partial,
                        )
                    })?;
                }
            }
        }
        Ok(())
    }

    fn error(
        &self,
        message: &'static str,
        backup_session_dir: Option<PathBuf>,
        rollback_status: RollbackStatus,
    ) -> NativeConfigWriteError {
        NativeConfigWriteError::new(message, backup_session_dir, rollback_status)
    }

    fn is_allowed_target(&self, path: &Path) -> bool {
        path == self.paths.claude_settings_path()
            || path == self.paths.codex_auth_path()
            || path == self.paths.codex_config_path()
            || path == self.paths.opencode_config_path()
    }
}

enum ApplyFailure {
    Failed,
    Interrupted,
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
    use super::{FileOps, NativeConfigWriteService, RollbackStatus, StdFileOps};
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
        let files = fs::read_dir(result.backup_session_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(files, vec![std::ffi::OsString::from("manifest.json")]);
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

        assert_eq!(error.to_string(), "原生配置写入失败，已回滚");
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

        assert_eq!(error.to_string(), "原生配置写入失败，已回滚");
        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"old auth");
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"old config");
    }

    #[test]
    fn 回滚替换失败时返回包含备份会话的部分回滚状态() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.codex_dir).unwrap();
        fs::write(paths.codex_auth_path(), b"old auth").unwrap();
        fs::write(paths.codex_config_path(), b"old config").unwrap();
        let service = NativeConfigWriteService::with_file_ops(
            paths.clone(),
            temp.path().join("backups"),
            FailRollbackReplaceOps::default(),
        );

        let error = service.write(&codex_files(&paths)).unwrap_err();

        assert_eq!(error.rollback_status, RollbackStatus::Partial);
        assert!(error.backup_session_dir.is_some());
        assert_eq!(error.to_string(), "原生配置写入失败，回滚不完整");
        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"new auth");
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"old config");
    }

    #[test]
    fn 中断后下一次写入会先恢复未完成事务() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.codex_dir).unwrap();
        fs::write(paths.codex_auth_path(), b"old auth").unwrap();
        fs::write(paths.codex_config_path(), b"old config").unwrap();
        let backup_root = temp.path().join("backups");
        let lock_root = temp.path().join("locks");
        let interrupted = NativeConfigWriteService::with_file_ops_and_lock_root(
            paths.clone(),
            backup_root.clone(),
            lock_root.clone(),
            InterruptAfterFirstTargetReplaceOps::default(),
        );

        let error = interrupted.write(&codex_files(&paths)).unwrap_err();

        assert_eq!(error.rollback_status, RollbackStatus::NotAttempted);
        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"new auth");
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"old config");

        let recovery =
            NativeConfigWriteService::with_lock_root(paths.clone(), backup_root, lock_root);
        recovery.write(&[]).unwrap();

        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"old auth");
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"old config");
    }

    #[derive(Default)]
    struct FailSecondReplaceOps {
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
            if destination.file_name() == Some(std::ffi::OsStr::new("config.toml")) {
                return Err(io::Error::other("simulated replace failure"));
            }
            self.inner.replace(source, destination)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            self.inner.remove_file(path)
        }
    }

    #[derive(Default)]
    struct FailRollbackReplaceOps {
        auth_replace_count: Cell<usize>,
        inner: StdFileOps,
    }

    impl FileOps for FailRollbackReplaceOps {
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
            if destination.file_name() == Some(std::ffi::OsStr::new("config.toml")) {
                return Err(io::Error::other("simulated replace failure"));
            }
            if destination.file_name() == Some(std::ffi::OsStr::new("auth.json")) {
                let count = self.auth_replace_count.get() + 1;
                self.auth_replace_count.set(count);
                if count == 2 {
                    return Err(io::Error::other("simulated rollback replace failure"));
                }
            }
            self.inner.replace(source, destination)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            self.inner.remove_file(path)
        }
    }

    #[derive(Default)]
    struct InterruptAfterFirstTargetReplaceOps {
        target_replace_count: Cell<usize>,
        inner: StdFileOps,
    }

    impl FileOps for InterruptAfterFirstTargetReplaceOps {
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
            self.inner.replace(source, destination)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            self.inner.remove_file(path)
        }

        fn after_target_replace(&self, _target: &Path) -> io::Result<()> {
            let count = self.target_replace_count.get() + 1;
            self.target_replace_count.set(count);
            if count == 1 {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "simulated interruption",
                ));
            }
            Ok(())
        }
    }
}
