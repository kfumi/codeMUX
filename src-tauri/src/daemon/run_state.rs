//! Daemon 运行状态契约:独立 daemon 在应用数据目录写下的发现文件。
//!
//! 壳(supervisor)与排障者据它发现端口与版本;stale 条目按 pid 存活检测
//! 剔除。文件契约 append-only 演进:只加字段,不改既有字段语义。

use crate::paths::PathRoots;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const RUN_STATE_FILE: &str = "daemon-run-state.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DaemonRunState {
    pub port: u16,
    pub pid: u32,
    pub version: String,
    /// 谁在托管此 daemon:`standalone`(手工启动)或 `desktop`(壳 spawn)。
    pub managed_by: String,
    pub started_at: String,
}

fn run_state_path(roots: &PathRoots) -> PathBuf {
    roots.app_data_dir.join(RUN_STATE_FILE)
}

pub fn write(roots: &PathRoots, state: &DaemonRunState) -> Result<(), String> {
    roots.ensure_app_data_dir().map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(run_state_path(roots), bytes).map_err(|e| e.to_string())
}

pub fn clear(roots: &PathRoots) {
    let _ = std::fs::remove_file(run_state_path(roots));
}

/// 读取仍存活的 run-state:文件缺失、解析失败或 pid 已死一律视为 stale。
pub fn read(roots: &PathRoots) -> Option<DaemonRunState> {
    let bytes = std::fs::read(run_state_path(roots)).ok()?;
    let state = serde_json::from_slice::<DaemonRunState>(&bytes).ok()?;
    if !pid_is_alive(state.pid) {
        return None;
    }
    Some(state)
}

/// 进程存活探测:Windows 走 tasklist 过滤,unix 走 `kill -0`。
pub fn pid_is_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"])
            .output();
        match output {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout);
                text.lines()
                    .any(|line| line.split('"').any(|field| field.trim() == pid.to_string()))
            }
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::{clear, read, write, DaemonRunState};
    use crate::paths::PathRoots;

    fn sample(pid: u32) -> DaemonRunState {
        DaemonRunState {
            port: 6768,
            pid,
            version: "0.0.0-test".to_string(),
            managed_by: "standalone".to_string(),
            started_at: "2026-09-11T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn write_read_roundtrip_and_stale_pid_filtered() {
        let temp = tempfile::tempdir().expect("tempdir");
        let roots = PathRoots {
            app_data_dir: temp.path().to_path_buf(),
            resource_dir: None,
        };

        write(&roots, &sample(std::process::id())).expect("write");
        let state = read(&roots).expect("live run state");
        assert_eq!(state.port, 6768);
        assert_eq!(state.managed_by, "standalone");

        // 指向一个必然不存在的 pid:stale 条目应被剔除。
        let stale_pid = if cfg!(windows) {
            4_000_000
        } else {
            u32::MAX - 1
        };
        write(&roots, &sample(stale_pid)).expect("write stale");
        assert!(read(&roots).is_none(), "dead pid must be treated as stale");

        clear(&roots);
        assert!(read(&roots).is_none());
    }

    #[test]
    fn missing_or_corrupt_file_is_stale() {
        let temp = tempfile::tempdir().expect("tempdir");
        let roots = PathRoots {
            app_data_dir: temp.path().to_path_buf(),
            resource_dir: None,
        };
        assert!(read(&roots).is_none(), "missing file is stale");
        std::fs::write(roots.app_data_dir.join(super::RUN_STATE_FILE), b"{not json")
            .expect("write junk");
        assert!(read(&roots).is_none(), "corrupt file is stale");
    }
}
