use crate::provider_profiles::native_config::{NativeConfigPaths, RenderedNativeConfig};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    message: String,
    pub backup_session_dir: Option<PathBuf>,
    pub rollback_status: RollbackStatus,
    pub failure_category: &'static str,
    pub target_identifier: Option<&'static str>,
}

impl NativeConfigWriteError {
    fn new(
        message: impl Into<String>,
        backup_session_dir: Option<PathBuf>,
        rollback_status: RollbackStatus,
    ) -> Self {
        Self {
            message: message.into(),
            backup_session_dir,
            rollback_status,
            failure_category: "事务",
            target_identifier: None,
        }
    }

    fn for_target(
        message: &'static str,
        failure_category: &'static str,
        target_identifier: &'static str,
        backup_session_dir: Option<PathBuf>,
        rollback_status: RollbackStatus,
    ) -> Self {
        Self {
            message: format!(
                "{message}（失败类别：{failure_category}，目标：{target_identifier}）"
            ),
            backup_session_dir,
            rollback_status,
            failure_category,
            target_identifier: Some(target_identifier),
        }
    }
}

impl fmt::Display for NativeConfigWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
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

    fn open_lock_file(&self, path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
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
        #[cfg(windows)]
        {
            replace_windows_file(source, destination)
        }
        #[cfg(not(windows))]
        {
            fs::rename(source, destination)
        }
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }

    fn sync_dir(&self, path: &Path) -> io::Result<()> {
        #[cfg(unix)]
        {
            File::open(path)?.sync_all()
        }
        #[cfg(windows)]
        {
            // Windows 目录句柄不能可靠地刷新；文件替换前已同步，MoveFileExW 使用写穿透。
            let _ = path;
            Ok(())
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = path;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "当前平台不支持目录持久化同步",
            ))
        }
    }

    fn restrict_directory_permissions(&self, path: &Path) -> io::Result<()> {
        set_restricted_permissions(path, true)
    }

    fn restrict_file_permissions(&self, path: &Path) -> io::Result<()> {
        set_restricted_permissions(path, false)
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
        let _ = directory;
        restrict_windows_acl_to_current_user(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, directory);
        Ok(())
    }
}

#[cfg(windows)]
fn replace_windows_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let wide_source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let wide_destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: 两个路径均以 NUL 结尾，并且 API 不会保留它们的指针。
    unsafe {
        if MoveFileExW(
            wide_source.as_ptr(),
            wide_destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
fn restrict_windows_acl_to_current_user(path: &Path) -> io::Result<()> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree, GENERIC_ALL},
        Security::{
            Authorization::{
                SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS,
                SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
            },
            GetTokenInformation, TokenUser, ACE_FLAGS, DACL_SECURITY_INFORMATION, NO_INHERITANCE,
            PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    let mut token = std::ptr::null_mut();
    // SAFETY: Windows API 按文档接收当前进程伪句柄与可写句柄指针。
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut size = 0;
            let _ = GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
            if size == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0_u8; size as usize];
            if GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                size,
                &mut size,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
            let access = EXPLICIT_ACCESS_W {
                grfAccessPermissions: GENERIC_ALL,
                grfAccessMode: GRANT_ACCESS,
                grfInheritance: NO_INHERITANCE as ACE_FLAGS,
                Trustee: windows_sys::Win32::Security::Authorization::TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_USER,
                    ptstrName: user.User.Sid.cast(),
                },
            };
            let mut acl = std::ptr::null_mut();
            let acl_result = SetEntriesInAclW(1, &access, std::ptr::null(), &mut acl);
            if acl_result != 0 {
                return Err(io::Error::from_raw_os_error(acl_result as i32));
            }
            let wide_path = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let security_result = SetNamedSecurityInfoW(
                wide_path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null(),
            );
            let _ = LocalFree(acl.cast::<c_void>());
            if security_result != 0 {
                return Err(io::Error::from_raw_os_error(security_result as i32));
            }
            Ok(())
        })();
        let close_result = if CloseHandle(token) == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
        result.and(close_result)
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
    #[serde(default)]
    replaced: bool,
    #[serde(default)]
    new_content_hash: Option<String>,
}

impl NativeConfigWriteService<StdFileOps> {
    pub fn new(paths: NativeConfigPaths, backup_root: PathBuf) -> Self {
        let lock_root = default_lock_root(&backup_root);
        Self::with_lock_root(paths, backup_root, lock_root)
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
        let lock_root = default_lock_root(&backup_root);
        Self::with_file_ops_and_lock_root(paths, backup_root, lock_root, file_ops)
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
                original_mode: None,
                replaced: false,
                new_content_hash: Some(content_hash(rendered.content.as_bytes())),
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

        for (index, rendered) in rendered_files.iter().enumerate() {
            match self.replace_target(&rendered.path, rendered.content.as_bytes()) {
                Ok(()) => {
                    manifest.files[index].replaced = true;
                    if self.write_manifest(&session_dir, &manifest).is_err() {
                        return self.abort_manifest(&session_dir, &manifest, None, None);
                    }
                    if self.file_ops.after_target_replace(&rendered.path).is_err() {
                        return self.abort_manifest(
                            &session_dir,
                            &manifest,
                            Some(&ApplyFailure::after_replace("写入后钩子")),
                            Some(&rendered.path),
                        );
                    }
                }
                Err(failure) => {
                    if failure.replaced {
                        manifest.files[index].replaced = true;
                        if self.write_manifest(&session_dir, &manifest).is_err() {
                            return self.abort_manifest(
                                &session_dir,
                                &manifest,
                                Some(&failure),
                                Some(&rendered.path),
                            );
                        }
                    }
                    return self.abort_manifest(
                        &session_dir,
                        &manifest,
                        Some(&failure),
                        Some(&rendered.path),
                    );
                }
            }
        }
        manifest.state = TransactionState::Committed;
        if self.write_manifest(&session_dir, &manifest).is_err() {
            return self.abort_manifest(&session_dir, &manifest, None, None);
        }
        Ok(NativeConfigWriteResult {
            backup_session_dir: session_dir,
        })
    }

    fn acquire_lock(&self) -> Result<File, NativeConfigWriteError> {
        if self.file_ops.create_dir_all(&self.lock_root).is_err()
            || self
                .file_ops
                .restrict_directory_permissions(&self.lock_root)
                .is_err()
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

    fn replace_target(&self, target: &Path, content: &[u8]) -> Result<(), ApplyFailure> {
        let parent = target
            .parent()
            .ok_or_else(|| ApplyFailure::before_replace("目标目录"))?;
        if self.file_ops.create_dir_all(parent).is_err() {
            return Err(ApplyFailure::before_replace("创建目录"));
        }
        let temporary_path = temporary_path(target);
        if self
            .write_new_secure_file(&temporary_path, content)
            .is_err()
        {
            let _ = self.file_ops.remove_file(&temporary_path);
            return Err(ApplyFailure::before_replace("写入临时文件"));
        }
        if self.file_ops.replace(&temporary_path, target).is_err() {
            let _ = self.file_ops.remove_file(&temporary_path);
            return Err(ApplyFailure::before_replace("原子替换"));
        }
        if self.file_ops.restrict_file_permissions(target).is_err() {
            return Err(ApplyFailure::after_replace("权限设置"));
        }
        if self.file_ops.sync_dir(parent).is_err() {
            return Err(ApplyFailure::after_replace("目录同步"));
        }
        Ok(())
    }

    fn abort_manifest(
        &self,
        session_dir: &Path,
        manifest: &TransactionManifest,
        failure: Option<&ApplyFailure>,
        failure_target: Option<&Path>,
    ) -> Result<NativeConfigWriteResult, NativeConfigWriteError> {
        let rollback_status = self.rollback_manifest(session_dir, manifest);
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
        match failure {
            Some(failure) => Err(NativeConfigWriteError::for_target(
                message,
                failure.failure_category,
                failure_target
                    .map(|target| self.target_identifier(target))
                    .unwrap_or("unknown-target"),
                Some(session_dir.to_path_buf()),
                rollback_status,
            )),
            None => Err(NativeConfigWriteError::new(
                message,
                Some(session_dir.to_path_buf()),
                rollback_status,
            )),
        }
    }

    fn rollback_manifest(
        &self,
        session_dir: &Path,
        manifest: &TransactionManifest,
    ) -> RollbackStatus {
        let replaced_files = manifest
            .files
            .iter()
            .filter(|file| file.replaced)
            .cloned()
            .collect::<Vec<_>>();
        if replaced_files
            .iter()
            .any(|file| !self.target_matches_new_content(file))
        {
            return RollbackStatus::Partial;
        }
        self.rollback_files(session_dir, &replaced_files)
    }

    fn rollback_files(&self, session_dir: &Path, files: &[ManifestFile]) -> RollbackStatus {
        if files.is_empty() {
            return RollbackStatus::Complete;
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
                        .replace_target_without_hook(&file.target, &content)
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

    fn target_matches_new_content(&self, file: &ManifestFile) -> bool {
        file.new_content_hash
            .as_deref()
            .is_some_and(|expected_hash| {
                self.file_ops
                    .read(&file.target)
                    .is_ok_and(|content| content_hash(&content) == expected_hash)
            })
    }

    fn replace_target_without_hook(&self, target: &Path, content: &[u8]) -> io::Result<()> {
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
        self.file_ops.restrict_file_permissions(target)?;
        self.file_ops.sync_dir(parent)
    }

    fn recover_unfinished_transactions(&self) -> Result<(), NativeConfigWriteError> {
        let sessions = self
            .file_ops
            .read_dir(&self.backup_root)
            .map_err(|_| self.error("原生配置恢复失败", None, RollbackStatus::NotAttempted))?;
        for session_dir in sessions {
            if !is_session_directory(&session_dir) {
                continue;
            }
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
                    || (file.replaced && file.new_content_hash.is_none())
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
                    if let Some(file) = manifest
                        .files
                        .iter()
                        .filter(|file| file.replaced)
                        .find(|file| !self.target_matches_new_content(file))
                    {
                        return Err(NativeConfigWriteError::for_target(
                            "原生配置恢复不完整",
                            "外部修改",
                            self.target_identifier(&file.target),
                            Some(session_dir),
                            RollbackStatus::Partial,
                        ));
                    }
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

    fn target_identifier(&self, path: &Path) -> &'static str {
        if path == self.paths.claude_settings_path() {
            "claude-settings"
        } else if path == self.paths.codex_auth_path() {
            "codex-auth"
        } else if path == self.paths.codex_config_path() {
            "codex-config"
        } else if path == self.paths.opencode_config_path() {
            "opencode-config"
        } else {
            "unknown-target"
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ApplyFailure {
    replaced: bool,
    failure_category: &'static str,
}

impl ApplyFailure {
    fn before_replace(failure_category: &'static str) -> Self {
        Self {
            replaced: false,
            failure_category,
        }
    }

    fn after_replace(failure_category: &'static str) -> Self {
        Self {
            replaced: true,
            failure_category,
        }
    }
}

fn has_duplicate_paths(rendered_files: &[RenderedNativeConfig]) -> bool {
    rendered_files.iter().enumerate().any(|(index, file)| {
        rendered_files[..index]
            .iter()
            .any(|prior| prior.path == file.path)
    })
}

fn content_hash(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn temporary_path(target: &Path) -> PathBuf {
    let file_name = target.file_name().unwrap_or_default().to_string_lossy();
    target.with_file_name(format!(".{file_name}.{}.tmp", Uuid::new_v4()))
}

fn backup_file_name(index: usize, target: &Path) -> String {
    let file_name = target.file_name().unwrap_or_default().to_string_lossy();
    format!("{index:03}-{file_name}")
}

fn default_lock_root(backup_root: &Path) -> PathBuf {
    let parent = backup_root.parent().unwrap_or_else(|| Path::new("."));
    let root_name = backup_root
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("native-config-backups"));
    parent.join(format!(".{}-locks", root_name.to_string_lossy()))
}

fn is_session_directory(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| Uuid::parse_str(name).is_ok())
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::StdFileOps;
    use super::{
        FileOps, NativeConfigWriteService, RollbackStatus, TransactionManifest, TransactionState,
    };
    use crate::provider_profiles::native_config::{NativeConfigPaths, RenderedNativeConfig};
    use std::{
        cell::Cell,
        fs,
        io::{self, Write as _},
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
        let service =
            NativeConfigWriteService::with_file_ops(paths.clone(), backup_root, TestFileOps);

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
        let service =
            NativeConfigWriteService::with_file_ops(paths.clone(), backup_root, TestFileOps);
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
    fn 默认锁目录独立于备份目录且首次写入成功() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        let backup_root = temp.path().join("backups");
        let service = NativeConfigWriteService::with_file_ops(
            paths.clone(),
            backup_root.clone(),
            TestFileOps,
        );

        assert_ne!(service.lock_root, backup_root);
        service
            .write(&[RenderedNativeConfig {
                path: paths.codex_auth_path(),
                content: "new auth".to_string(),
            }])
            .unwrap();
        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"new auth");
    }

    #[test]
    fn 锁被占用时拒绝第二个写入事务() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        let backup_root = temp.path().join("backups");
        let lock_root = temp.path().join("locks");
        let first = NativeConfigWriteService::with_file_ops_and_lock_root(
            paths.clone(),
            backup_root.clone(),
            lock_root.clone(),
            TestFileOps,
        );
        let _lock = first.acquire_lock().unwrap();
        let second = NativeConfigWriteService::with_file_ops_and_lock_root(
            paths,
            backup_root,
            lock_root,
            TestFileOps,
        );

        let error = second.write(&[]).unwrap_err();

        assert_eq!(error.to_string(), "原生配置正在写入");
    }

    #[test]
    fn 替换后钩子失败会回滚当前目标() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.codex_dir).unwrap();
        fs::write(paths.codex_auth_path(), b"old auth").unwrap();
        let service = NativeConfigWriteService::with_file_ops(
            paths.clone(),
            temp.path().join("backups"),
            FailHookAfterReplaceOps::default(),
        );

        let error = service
            .write(&[RenderedNativeConfig {
                path: paths.codex_auth_path(),
                content: "new auth".to_string(),
            }])
            .unwrap_err();

        assert_eq!(error.rollback_status, RollbackStatus::Complete);
        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"old auth");
    }

    #[test]
    fn 恢复空的_applying_事务视为完整回滚() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        let backup_root = temp.path().join("backups");
        let session_dir = backup_root.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(
            session_dir.join("manifest.json"),
            serde_json::to_vec(&TransactionManifest {
                state: TransactionState::Applying,
                files: Vec::new(),
            })
            .unwrap(),
        )
        .unwrap();
        let service =
            NativeConfigWriteService::with_file_ops(paths, backup_root.clone(), TestFileOps);

        service.write(&[]).unwrap();

        let manifest: TransactionManifest =
            serde_json::from_slice(&fs::read(session_dir.join("manifest.json")).unwrap()).unwrap();
        assert!(matches!(manifest.state, TransactionState::Committed));
    }

    #[test]
    fn 恢复_applying_事务只回滚已替换文件() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.codex_dir).unwrap();
        fs::write(paths.codex_auth_path(), b"new auth").unwrap();
        fs::write(paths.codex_config_path(), b"external config").unwrap();
        let backup_root = temp.path().join("backups");
        let session_dir = backup_root.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(session_dir.join("000-auth.json"), b"old auth").unwrap();
        fs::write(session_dir.join("001-config.toml"), b"old config").unwrap();
        fs::write(
            session_dir.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "state": "applying",
                "files": [
                    {
                        "target": paths.codex_auth_path(),
                        "backup_file": "000-auth.json",
                        "original_mode": null,
                        "replaced": true,
                        "new_content_hash": "5b1fc98f7cf4cd1e8ad29d73f726eb1f8dac778c675e5b9639f858151b948957"
                    },
                    {
                        "target": paths.codex_config_path(),
                        "backup_file": "001-config.toml",
                        "original_mode": null,
                        "replaced": false,
                        "new_content_hash": "unused"
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let service = NativeConfigWriteService::with_file_ops(
            paths.clone(),
            backup_root.clone(),
            TestFileOps,
        );

        service.write(&[]).unwrap();

        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"old auth");
        assert_eq!(
            fs::read(paths.codex_config_path()).unwrap(),
            b"external config"
        );
        let manifest: TransactionManifest =
            serde_json::from_slice(&fs::read(session_dir.join("manifest.json")).unwrap()).unwrap();
        assert!(matches!(manifest.state, TransactionState::Committed));
    }

    #[test]
    fn 恢复_applying_事务遇到外部修改会保留目标并返回部分回滚() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.codex_dir).unwrap();
        fs::write(paths.codex_auth_path(), b"externally modified").unwrap();
        let backup_root = temp.path().join("backups");
        let session_dir = backup_root.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(session_dir.join("000-auth.json"), b"old auth").unwrap();
        fs::write(
            session_dir.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "state": "applying",
                "files": [{
                    "target": paths.codex_auth_path(),
                    "backup_file": "000-auth.json",
                    "original_mode": null,
                    "replaced": true,
                    "new_content_hash": "5b1fc98f7cf4cd1e8ad29d73f726eb1f8dac778c675e5b9639f858151b948957"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let service =
            NativeConfigWriteService::with_file_ops(paths.clone(), backup_root, TestFileOps);

        let error = service.write(&[]).unwrap_err();

        assert_eq!(error.rollback_status, RollbackStatus::Partial);
        assert_eq!(error.failure_category, "外部修改");
        assert_eq!(error.target_identifier, Some("codex-auth"));
        assert_eq!(
            fs::read(paths.codex_auth_path()).unwrap(),
            b"externally modified"
        );
        let manifest: TransactionManifest =
            serde_json::from_slice(&fs::read(session_dir.join("manifest.json")).unwrap()).unwrap();
        assert!(matches!(manifest.state, TransactionState::Applying));
    }

    #[cfg(unix)]
    #[test]
    fn 更新既有宽松权限目标后强制收紧为_0600() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.codex_dir).unwrap();
        fs::write(paths.codex_auth_path(), b"old auth").unwrap();
        fs::set_permissions(paths.codex_auth_path(), fs::Permissions::from_mode(0o644)).unwrap();
        let backup_root = temp.path().join("backups");
        let service = NativeConfigWriteService::new(paths.clone(), backup_root);

        let result = service
            .write(&[RenderedNativeConfig {
                path: paths.codex_auth_path(),
                content: "new auth".to_string(),
            }])
            .unwrap();

        assert_eq!(
            fs::metadata(paths.codex_auth_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(result.backup_session_dir.join("000-auth.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_目录同步不阻止事务提交() {
        let temp = TestDirectory::new();
        let paths = test_paths(temp.path());
        let service = NativeConfigWriteService::new(paths.clone(), temp.path().join("backups"));

        service
            .write(&[RenderedNativeConfig {
                path: paths.codex_auth_path(),
                content: "new auth".to_string(),
            }])
            .unwrap();

        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"new auth");
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

        assert_eq!(error.failure_category, "原子替换");
        assert_eq!(error.target_identifier, Some("codex-config"));
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

        assert_eq!(error.failure_category, "原子替换");
        assert_eq!(error.target_identifier, Some("codex-config"));
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
        assert_eq!(error.failure_category, "原子替换");
        assert_eq!(error.target_identifier, Some("codex-config"));
        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"new auth");
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"old config");
    }

    #[test]
    fn 替换后中断会回滚当前目标() {
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

        assert_eq!(error.rollback_status, RollbackStatus::Complete);
        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"old auth");
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"old config");

        let recovery = NativeConfigWriteService::with_file_ops_and_lock_root(
            paths.clone(),
            backup_root,
            lock_root,
            TestFileOps,
        );
        recovery.write(&[]).unwrap();

        assert_eq!(fs::read(paths.codex_auth_path()).unwrap(), b"old auth");
        assert_eq!(fs::read(paths.codex_config_path()).unwrap(), b"old config");
    }

    #[derive(Default)]
    struct TestFileOps;

    impl FileOps for TestFileOps {
        fn create_dir_all(&self, path: &Path) -> io::Result<()> {
            fs::create_dir_all(path)
        }

        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            fs::read(path)
        }

        fn write_file_sync(&self, path: &Path, content: &[u8]) -> io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            file.write_all(content)?;
            file.sync_all()
        }

        fn replace(&self, source: &Path, destination: &Path) -> io::Result<()> {
            fs::rename(source, destination)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            fs::remove_file(path)
        }
    }

    #[derive(Default)]
    struct FailSecondReplaceOps {
        inner: TestFileOps,
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
        inner: TestFileOps,
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
        inner: TestFileOps,
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

    #[derive(Default)]
    struct FailHookAfterReplaceOps {
        inner: TestFileOps,
    }

    impl FileOps for FailHookAfterReplaceOps {
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
            Err(io::Error::other("simulated hook failure"))
        }
    }
}
