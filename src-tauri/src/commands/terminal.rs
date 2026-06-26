use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub struct TerminalSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalEvent {
    Output {
        terminal_id: String,
        data: String,
    },
    Exit {
        terminal_id: String,
        code: Option<u32>,
    },
    Error {
        terminal_id: String,
        error: String,
    },
}

fn send_event(channel: &tauri::ipc::Channel<String>, event: TerminalEvent) {
    if let Ok(payload) = serde_json::to_string(&event) {
        let _ = channel.send(payload);
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

#[tauri::command]
pub fn start_terminal_session(
    state: tauri::State<'_, TerminalState>,
    project_path: String,
    cols: u16,
    rows: u16,
    channel: tauri::ipc::Channel<String>,
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
    let session = TerminalSession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
    };

    state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?
        .insert(terminal_id.clone(), session);

    let output_id = terminal_id.clone();
    let output_channel = channel.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    send_event(
                        &output_channel,
                        TerminalEvent::Output {
                            terminal_id: output_id.clone(),
                            data,
                        },
                    );
                }
                Err(error) => {
                    send_event(
                        &output_channel,
                        TerminalEvent::Error {
                            terminal_id: output_id.clone(),
                            error: error.to_string(),
                        },
                    );
                    break;
                }
            }
        }
        send_event(
            &output_channel,
            TerminalEvent::Exit {
                terminal_id: output_id,
                code: None,
            },
        );
    });

    Ok(terminal_id)
}

#[tauri::command]
pub fn write_terminal_session(
    state: tauri::State<'_, TerminalState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let writer = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal state poisoned".to_string())?;
        sessions
            .get(&terminal_id)
            .ok_or_else(|| "Terminal session not found".to_string())?
            .writer
            .clone()
    };

    let result = writer
        .lock()
        .map_err(|_| "Terminal writer poisoned".to_string())?
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write terminal input: {}", e));
    result
}

#[tauri::command]
pub fn resize_terminal_session(
    state: tauri::State<'_, TerminalState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let master = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal state poisoned".to_string())?;
        sessions
            .get(&terminal_id)
            .ok_or_else(|| "Terminal session not found".to_string())?
            .master
            .clone()
    };

    let result = master
        .lock()
        .map_err(|_| "Terminal master poisoned".to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize terminal: {}", e));
    result
}

#[tauri::command]
pub fn close_terminal_session(
    state: tauri::State<'_, TerminalState>,
    terminal_id: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?
        .remove(&terminal_id);

    if let Some(session) = session {
        let _ = session
            .child
            .lock()
            .map_err(|_| "Terminal child poisoned".to_string())?
            .kill();
    }

    Ok(())
}
