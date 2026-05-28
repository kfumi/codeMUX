pub mod commands;

use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tauri::Manager;
use tokio::sync::mpsc;

/// Handle to a running sidecar process.
pub struct SidecarHandle {
    child: Child,
    stdin_tx: mpsc::Sender<String>,
}

impl SidecarHandle {
    /// Send a command string to the sidecar's stdin.
    pub async fn send_command(&self, cmd: &str) -> Result<(), String> {
        self.stdin_tx
            .send(cmd.to_string())
            .await
            .map_err(|_| "Failed to send command to sidecar".to_string())
    }

    /// Kill the sidecar process.
    pub async fn shutdown(&mut self) {
        let _ = self.send_command(r#"{"type":"shutdown"}"#).await;
        let _ = self.child.wait().await;
    }
}

/// Path to the sidecar script (dist/index.js).
///
/// In production, uses `resource_dir()`. In dev mode (debug), falls back to
/// the Cargo manifest directory so the sidecar is found in the source tree.
fn sidecar_script_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let sidecar_rel = PathBuf::from("sidecar").join("dist").join("index.js");

    // Try resource_dir first (production)
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let path = resource_dir.join(&sidecar_rel);
        if path.exists() {
            return path;
        }
    }

    // Fall back to CARGO_MANIFEST_DIR (dev mode)
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join(sidecar_rel)
}

/// Spawn the sidecar process and return a handle + event receiver.
///
/// Events are raw JSON strings (one per line) from the sidecar's stdout.
/// The first event MUST be `{"type":"sidecar_ready"}`.
pub async fn spawn_sidecar(
    app_handle: &tauri::AppHandle,
) -> Result<(SidecarHandle, mpsc::Receiver<String>), String> {
    let script_path = sidecar_script_path(app_handle);

    // Try to find node executable
    let node_cmd = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };

    let mut child = Command::new(node_cmd)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}. Is Node.js installed?", e))?;

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
    let (event_tx, event_rx) = mpsc::channel::<String>(256);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut ready_tx = Some(ready_tx);

        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(tx) = ready_tx.take() {
                if line.contains("sidecar_error") {
                    let _ = tx.send(Err(format!("Sidecar error: {}", line)));
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
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("Sidecar died before signaling ready".to_string()),
    }

    // Log stderr
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[sidecar stderr] {}", line);
            }
        });
    }

    let handle = SidecarHandle { child, stdin_tx };
    Ok((handle, event_rx))
}
