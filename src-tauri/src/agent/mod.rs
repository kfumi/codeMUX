pub mod commands;
pub mod context_usage;
pub(crate) mod history_events;
pub mod history_import;
pub(crate) mod opencode_history;

use log::{debug, info, warn};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex as AsyncMutex};

const SIDECAR_RELATIVE_DIR: &str = "sidecar";
const SIDECAR_ENTRYPOINT: &str = "dist/index.js";
const SIDECAR_STDERR_CAPTURE_LIMIT: usize = 200;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BuildEnvironment {
    Development,
    Release,
}

/// Handle to a running sidecar process.
pub struct SidecarHandle {
    child: Child,
    stdin_tx: mpsc::Sender<String>,
    /// The Tauri channel used by the forwarding task. Updated when the sidecar
    /// is reused for a new `start` command so events reach the new frontend channel.
    channel: Arc<AsyncMutex<tauri::ipc::Channel<String>>>,
    /// Captured stderr lines from the sidecar process.
    pub stderr_lines: Arc<AsyncMutex<Vec<String>>>,
}

impl SidecarHandle {
    pub fn command_sender(&self) -> mpsc::Sender<String> {
        self.stdin_tx.clone()
    }

    pub fn channel_handle(&self) -> Arc<AsyncMutex<tauri::ipc::Channel<String>>> {
        self.channel.clone()
    }

    /// Send a command string to the sidecar's stdin.
    pub async fn send_command(&self, cmd: &str) -> Result<(), String> {
        self.stdin_tx
            .send(cmd.to_string())
            .await
            .map_err(|_| "Failed to send command to sidecar".to_string())
    }

    /// Kill the sidecar process.
    pub async fn shutdown(&mut self) {
        let command = crate::agent_runtime::opencode::OpenCodeRuntime::shutdown_command();
        let _ = self.send_command(&command.to_string()).await;
        let _ = self.child.wait().await;
    }
}

fn build_environment() -> BuildEnvironment {
    if cfg!(debug_assertions) {
        BuildEnvironment::Development
    } else {
        BuildEnvironment::Release
    }
}

fn sidecar_relative_path() -> PathBuf {
    PathBuf::from(SIDECAR_RELATIVE_DIR).join(SIDECAR_ENTRYPOINT)
}

fn node_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

fn resolve_sidecar_script_path(
    resource_dir: Option<&Path>,
    manifest_dir: &Path,
    environment: BuildEnvironment,
) -> Result<PathBuf, String> {
    let sidecar_rel = sidecar_relative_path();

    if environment == BuildEnvironment::Development {
        return Ok(manifest_dir.join(sidecar_rel));
    }

    if let Some(resource_dir) = resource_dir {
        let resource_path = resource_dir.join(&sidecar_rel);
        if resource_path.exists() {
            return Ok(resource_path);
        }
    }

    Err(format!(
        "Bundled sidecar was not found at {}. Rebuild the installer with bundle.resources including the sidecar directory.",
        sidecar_rel.display()
    ))
}

fn resolve_node_runtime_path(
    _resource_dir: Option<&Path>,
    _environment: BuildEnvironment,
) -> Result<PathBuf, String> {
    Ok(PathBuf::from(node_binary_name()))
}

fn missing_node_prerequisite_error(node_command: &str, script_path: &str) -> String {
    format!(
        "Node.js 18+ is required to run agent sessions. Install Node.js from https://nodejs.org/, make sure `{}` is available in PATH, then restart CodeMUX. Sidecar script: {}",
        node_command, script_path
    )
}

fn configure_sidecar_command(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    command
}

/// Spawn the sidecar process and return a handle + event receiver.
///
/// Events are raw JSON strings (one per line) from the sidecar's stdout.
/// The first event MUST be `{"type":"sidecar_ready"}`.
pub async fn spawn_sidecar(
    app_handle: &tauri::AppHandle,
    channel: tauri::ipc::Channel<String>,
) -> Result<(SidecarHandle, mpsc::Receiver<String>), String> {
    let resource_dir = app_handle.path().resource_dir().ok();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let environment = build_environment();
    let script_path =
        resolve_sidecar_script_path(resource_dir.as_deref(), &manifest_dir, environment)?;
    let node_path = resolve_node_runtime_path(resource_dir.as_deref(), environment)?;

    info!(target: "agent", "Spawning sidecar from {}", script_path.display());
    info!(target: "agent", "Using node runtime {}", node_path.display());

    let mut command = Command::new(&node_path);
    configure_sidecar_command(
        command
            .arg(&script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            return missing_node_prerequisite_error(
                &node_path.display().to_string(),
                &script_path.display().to_string(),
            );
        }
        format!(
            "Failed to spawn sidecar with node={} script={}: {}",
            node_path.display(),
            script_path.display(),
            e
        )
    })?;

    // Set up stdin writer
    let stdin = child.stdin.take().ok_or("Failed to open sidecar stdin")?;
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);

    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let mut stdin = stdin;
        while let Some(msg) = stdin_rx.recv().await {
            let line = format!("{}\n", msg);
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
    });

    // Set up stdout reader — uses oneshot to signal when the first event (ready) arrives
    let stdout = child.stdout.take().ok_or("Failed to open sidecar stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to open sidecar stderr")?;
    let (event_tx, event_rx) = mpsc::channel::<String>(256);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    let stderr_lines = Arc::new(AsyncMutex::new(Vec::<String>::new()));
    let stderr_lines_for_task = stderr_lines.clone();

    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            {
                let mut captured = stderr_lines_for_task.lock().await;
                captured.push(line.clone());
                if captured.len() > SIDECAR_STDERR_CAPTURE_LIMIT {
                    let overflow = captured.len() - SIDECAR_STDERR_CAPTURE_LIMIT;
                    captured.drain(0..overflow);
                }
            }

            if line.contains("Stream closed") || line.contains("Error in hook callback") {
                debug!(target: "sidecar_stderr", "(suppressed abort cleanup) {}", line);
                continue;
            }
            if line.contains("[codex][compact") || line.contains("[opencode-task]") {
                info!(target: "sidecar_stderr", "{}", line);
            } else if line.to_ascii_lowercase().contains("error") {
                warn!(target: "sidecar_stderr", "{}", line);
            } else {
                debug!(target: "sidecar_stderr", "{}", line);
            }
        }
    });

    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut ready_tx = Some(ready_tx);

        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(tx) = ready_tx.take() {
                if line.contains("\"type\":\"sidecar_error\"") {
                    let _ = tx.send(Err(format!("Sidecar error: {}", line)));
                    return;
                }
                if !line.contains("\"type\":\"sidecar_ready\"") {
                    let _ = tx.send(Err(format!(
                        "Sidecar did not signal readiness before emitting: {}",
                        line
                    )));
                    return;
                }
                let _ = tx.send(Ok(()));
            }
            if event_tx.send(line).await.is_err() {
                break;
            }
        }
    });

    // Wait for sidecar to signal ready
    match ready_rx.await {
        Ok(Ok(())) => info!(target: "agent", "Sidecar reported ready"),
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            let stderr_summary = {
                let captured = stderr_lines.lock().await;
                captured
                    .iter()
                    .rev()
                    .take(5)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ")
            };

            if stderr_summary.is_empty() {
                return Err("Sidecar died before signaling ready".to_string());
            }

            return Err(format!(
                "Sidecar died before signaling ready. Recent stderr: {}",
                stderr_summary
            ));
        }
    }

    debug!(target: "agent", "Sidecar spawn completed successfully");
    let channel = Arc::new(AsyncMutex::new(channel));
    let handle = SidecarHandle {
        child,
        stdin_tx,
        channel,
        stderr_lines,
    };
    Ok((handle, event_rx))
}

#[cfg(test)]
mod tests {
    use super::{
        missing_node_prerequisite_error, resolve_node_runtime_path, resolve_sidecar_script_path,
        BuildEnvironment,
    };
    use std::path::Path;

    #[test]
    fn release_build_requires_bundled_sidecar_resources() {
        let manifest_dir = Path::new("manifest-root");
        let err = resolve_sidecar_script_path(None, manifest_dir, BuildEnvironment::Release)
            .expect_err("release builds should not fall back to the source tree");

        assert!(err.contains("Bundled sidecar was not found"));
    }

    #[test]
    fn development_build_falls_back_to_source_sidecar() {
        let manifest_dir = Path::new("manifest-root");
        let path = resolve_sidecar_script_path(None, manifest_dir, BuildEnvironment::Development)
            .expect("dev builds should fall back to the source tree");

        assert!(path.ends_with("sidecar/dist/index.js"));
    }

    #[test]
    fn development_build_prefers_source_sidecar_over_bundled_resource_copy() {
        let manifest_dir = Path::new("manifest-root");
        let resource_dir = Path::new("resource-root");
        let path = resolve_sidecar_script_path(
            Some(resource_dir),
            manifest_dir,
            BuildEnvironment::Development,
        )
        .expect("dev builds should always use the source tree sidecar");

        assert_eq!(
            path,
            manifest_dir.join("sidecar").join("dist").join("index.js")
        );
    }

    #[test]
    fn release_build_uses_system_node_command() {
        let path = resolve_node_runtime_path(None, BuildEnvironment::Release)
            .expect("release builds should use the system Node.js command");

        assert_eq!(path, std::path::PathBuf::from(super::node_binary_name()));
    }

    #[test]
    fn missing_node_error_tells_user_how_to_recover() {
        let message = missing_node_prerequisite_error("node.exe", "sidecar/dist/index.js");

        assert!(message.contains("Node.js 18+ is required"));
        assert!(message.contains("https://nodejs.org/"));
        assert!(message.contains("restart CodeMUX"));
    }
}
