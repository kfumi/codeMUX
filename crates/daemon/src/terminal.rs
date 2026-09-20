//! 终端(PTY)会话核心:companion HTTP/WS 路由消费的进程内终端状态。
//!
//! 原壳进程 IPC 直投面已随壳下线退役;输出统一经
//! [`TerminalOutputState`] 的环形缓冲 + broadcast 扇出(见
//! `subscribe_terminal_for_companion`)。

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use uuid::Uuid;

const TERMINAL_OUTPUT_BUFFER_LIMIT: usize = 256 * 1024;

pub struct TerminalSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    output: Arc<Mutex<TerminalOutputState>>,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalEvent {
    Output {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        data: String,
    },
    Exit {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        code: Option<u32>,
    },
    Error {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        error: String,
    },
}

struct TerminalOutputBuffer {
    bytes: VecDeque<u8>,
    max_bytes: usize,
}

impl TerminalOutputBuffer {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            max_bytes: max_bytes.max(1),
        }
    }

    fn push(&mut self, data: &[u8]) {
        let start = data.len().saturating_sub(self.max_bytes);
        self.bytes.extend(&data[start..]);

        while self.bytes.len() > self.max_bytes {
            self.bytes.pop_front();
        }
    }

    fn snapshot(&self) -> String {
        let bytes: Vec<u8> = self.bytes.iter().copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

struct TerminalOutputState {
    broadcast_tx: broadcast::Sender<String>,
    buffer: TerminalOutputBuffer,
    exit_event: Option<TerminalEvent>,
}

impl TerminalOutputState {
    fn new() -> Self {
        let (broadcast_tx, _) = broadcast::channel(512);
        Self {
            broadcast_tx,
            buffer: TerminalOutputBuffer::new(TERMINAL_OUTPUT_BUFFER_LIMIT),
            exit_event: None,
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<String> {
        self.broadcast_tx.subscribe()
    }
}

fn publish_event(output: &Arc<Mutex<TerminalOutputState>>, event: TerminalEvent) {
    let Ok(mut output) = output.lock() else {
        return;
    };

    if let TerminalEvent::Output { data, .. } = &event {
        output.buffer.push(data.as_bytes());
    }
    if matches!(&event, TerminalEvent::Exit { .. }) {
        output.exit_event = Some(event.clone());
    }
    if let Ok(payload) = serde_json::to_string(&event) {
        let _ = output.broadcast_tx.send(payload);
    }
}

fn default_shell() -> (&'static str, Vec<&'static str>) {
    #[cfg(target_os = "windows")]
    {
        ("powershell.exe", Vec::new())
    }
    #[cfg(target_os = "macos")]
    {
        ("zsh", Vec::new())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        ("bash", Vec::new())
    }
}

fn normalize_windows_verbatim_path(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

impl Drop for TerminalState {
    fn drop(&mut self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };

        for (_, session) in sessions.drain() {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
        }
    }
}

pub fn start_terminal_for_companion(
    state: &TerminalState,
    project_path: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let cwd = normalize_windows_verbatim_path(PathBuf::from(&project_path));
    let canonical_cwd = cwd
        .canonicalize()
        .map_err(|e| format!("Project path not found: {}", e))?;
    if !canonical_cwd.is_dir() {
        return Err(format!("Not a directory: {}", cwd.display()));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let (program, args) = default_shell();
    let mut command = CommandBuilder::new(program);
    for arg in args {
        command.arg(arg);
    }
    command.cwd(cwd);

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Failed to start terminal: {}", e))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to read terminal output: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to open terminal input: {}", e))?;

    let terminal_id = Uuid::new_v4().to_string();
    let output = Arc::new(Mutex::new(TerminalOutputState::new()));
    let session = TerminalSession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
        output: output.clone(),
    };

    state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?
        .insert(terminal_id.clone(), session);

    let output_id = terminal_id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    publish_event(
                        &output,
                        TerminalEvent::Output {
                            terminal_id: output_id.clone(),
                            data,
                        },
                    );
                }
                Err(error) => {
                    publish_event(
                        &output,
                        TerminalEvent::Error {
                            terminal_id: output_id.clone(),
                            error: error.to_string(),
                        },
                    );
                    break;
                }
            }
        }
        publish_event(
            &output,
            TerminalEvent::Exit {
                terminal_id: output_id,
                code: None,
            },
        );
    });

    Ok(terminal_id)
}

pub fn subscribe_terminal_for_companion(
    state: &TerminalState,
    terminal_id: &str,
) -> Result<(broadcast::Receiver<String>, Option<String>), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?;
    let session = sessions
        .get(terminal_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    let output = session
        .output
        .lock()
        .map_err(|_| "Terminal output state poisoned".to_string())?;
    let replay = output.buffer.snapshot();
    Ok((
        output.subscribe(),
        if replay.is_empty() {
            None
        } else {
            Some(replay)
        },
    ))
}

pub fn write_terminal_for_companion(
    state: &TerminalState,
    terminal_id: &str,
    data: &str,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?;
    let session = sessions
        .get(terminal_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    session
        .writer
        .lock()
        .map_err(|_| "Terminal writer poisoned".to_string())?
        .write_all(data.as_bytes())
        .map_err(|error| format!("Failed to write to terminal: {}", error))?;
    Ok(())
}

pub fn resize_terminal_for_companion(
    state: &TerminalState,
    terminal_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let master = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal state poisoned".to_string())?;
        sessions
            .get(terminal_id)
            .ok_or_else(|| "Terminal session not found".to_string())?
            .master
            .clone()
    };
    let master = master
        .lock()
        .map_err(|_| "Terminal master poisoned".to_string())?;
    master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize terminal: {}", error))
}

pub fn close_terminal_for_companion(
    state: &TerminalState,
    terminal_id: &str,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?
        .remove(terminal_id);

    if let Some(session) = session {
        let _ = session
            .child
            .lock()
            .map_err(|_| "Terminal child poisoned".to_string())?
            .kill();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{publish_event, TerminalEvent, TerminalOutputBuffer, TerminalOutputState};
    use std::sync::{Arc, Mutex};

    #[test]
    fn keeps_only_the_latest_output_within_the_byte_limit() {
        let mut buffer = TerminalOutputBuffer::new(8);

        buffer.push(b"1234");
        buffer.push(b"567890");

        assert_eq!(buffer.snapshot(), "34567890");
    }

    #[test]
    fn truncates_a_single_oversized_chunk_to_the_latest_bytes() {
        let mut buffer = TerminalOutputBuffer::new(4);

        buffer.push(b"abcdef");

        assert_eq!(buffer.snapshot(), "cdef");
    }

    #[test]
    fn buffers_output_and_persists_the_exit_event() {
        let output = Arc::new(Mutex::new(TerminalOutputState::new()));
        let mut rx = output.lock().unwrap().subscribe();

        publish_event(
            &output,
            TerminalEvent::Output {
                terminal_id: "terminal-1".to_string(),
                data: "live".to_string(),
            },
        );
        assert_eq!(output.lock().unwrap().buffer.snapshot(), "live");

        publish_event(
            &output,
            TerminalEvent::Output {
                terminal_id: "terminal-1".to_string(),
                data: "offline".to_string(),
            },
        );
        publish_event(
            &output,
            TerminalEvent::Exit {
                terminal_id: "terminal-1".to_string(),
                code: None,
            },
        );

        {
            let guard = output.lock().unwrap();
            assert_eq!(guard.buffer.snapshot(), "liveoffline");
            assert!(guard.exit_event.is_some());
        }

        let first = rx.try_recv().expect("broadcast payload");
        let first: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(first["type"], "output");
        assert_eq!(first["data"], "live");
        let replay = rx.try_recv().expect("broadcast payload");
        let replay: serde_json::Value = serde_json::from_str(&replay).unwrap();
        assert_eq!(replay["type"], "output");
        assert_eq!(replay["terminalId"], "terminal-1");
        assert_eq!(replay["data"], "offline");
        let exit = rx.try_recv().expect("broadcast payload");
        let exit: serde_json::Value = serde_json::from_str(&exit).unwrap();
        assert_eq!(exit["type"], "exit");
    }
}
