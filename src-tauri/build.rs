fn main() {
    ensure_daemon_resource_placeholder();
    tauri_build::build()
}

/// tauri-build 会在每次 cargo 构建时校验 bundle.resources 的存在性并拷入
/// target 目录。release daemon 由打包前脚本(beforeBuildCommand →
/// build:daemon:release)产出;开发与 CI 环境里该产物往往还不存在,这里
/// 用 debug 产物(缺失时为空占位文件)补位,避免 `cargo check`、
/// `cargo test` 与 `tauri dev` 因资源缺失而失败。占位文件仅在构建校验期
/// 被读取;`tauri build` 必先运行 build:daemon:release 覆盖为真实产物,
/// 因此不会被打进安装包。
#[cfg(windows)]
fn ensure_daemon_resource_placeholder() {
    use std::path::PathBuf;

    let target_dir = std::env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
                .join("target")
        });
    let release_exe = target_dir.join("release").join("codemux-daemon.exe");
    if release_exe.exists() {
        return;
    }
    if let Some(parent) = release_exe.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            println!(
                "cargo:warning=无法创建 daemon 资源目录 {}: {}",
                parent.display(),
                error
            );
            return;
        }
    }
    let debug_exe = target_dir.join("debug").join("codemux-daemon.exe");
    if std::fs::copy(&debug_exe, &release_exe).is_err() {
        if let Err(error) = std::fs::write(&release_exe, []) {
            println!(
                "cargo:warning=无法写出 daemon 资源占位 {}: {}",
                release_exe.display(),
                error
            );
        }
    }
}

#[cfg(not(windows))]
fn ensure_daemon_resource_placeholder() {}
