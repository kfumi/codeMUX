use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokioConsoleInfo {
    pub enabled: bool,
    pub addr: String,
}

/// 返回 tokio-console 监听信息。未编译 tokio-console feature 时 enabled=false。
#[tauri::command]
pub fn get_tokio_console_info() -> TokioConsoleInfo {
    #[cfg(feature = "tokio-console")]
    {
        TokioConsoleInfo {
            enabled: true,
            addr: "127.0.0.1:6670".to_string(),
        }
    }
    #[cfg(not(feature = "tokio-console"))]
    {
        TokioConsoleInfo {
            enabled: false,
            addr: String::new(),
        }
    }
}

/// 将性能快照 JSON 写到指定绝对路径（开发期诊断用）。
#[tauri::command]
pub fn export_perf_snapshot(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(&target, content)
        .map_err(|e| format!("Failed to write snapshot {}: {}", target.display(), e))
}

/// 条件初始化 tracing subscriber。无 feature 时为空操作。
/// 必须在 tauri::Builder::default() 之前调用，避免 subscriber/logger 冲突。
pub fn init_tracing() {
    #[cfg(feature = "tokio-console")]
    {
        std::env::set_var("TOKIO_CONSOLE_BIND", "127.0.0.1:6670");
        console_subscriber::init();
        let _ = tracing_log::LogTracer::init();
    }
    #[cfg(all(feature = "cmd-tracing", not(feature = "tokio-console")))]
    {
        use tracing_subscriber::EnvFilter;
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("codemux_lib=warn"));
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
}

#[cfg(test)]
mod tests {
    use super::export_perf_snapshot;

    #[test]
    fn export_perf_snapshot_writes_file() {
        let dir = std::env::temp_dir();
        let target = dir.join(format!("codemux-perf-test-{}.json", std::process::id()));
        let result = export_perf_snapshot(
            target.to_string_lossy().to_string(),
            "{\"fps\":60}".to_string(),
        );
        assert!(result.is_ok());
        let written = std::fs::read_to_string(&target).unwrap();
        assert_eq!(written, "{\"fps\":60}");
        let _ = std::fs::remove_file(&target);
    }

    #[test]
    fn export_perf_snapshot_creates_parent_dirs() {
        let dir = std::env::temp_dir().join(format!("codemux-perf-nested-{}", std::process::id()));
        let target = dir.join("sub").join("snap.json");
        let result = export_perf_snapshot(target.to_string_lossy().to_string(), "{}".to_string());
        assert!(result.is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
