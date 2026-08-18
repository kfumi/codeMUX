use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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

struct TerminalOutputBuffer {
    chunks: VecDeque<String>,
    bytes: usize,
    max_bytes: usize,
}

impl TerminalOutputBuffer {
    fn new(max_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            max_bytes: max_bytes.max(1),
        }
    }

    fn push(&mut self, data: &str) {
        let data = if data.len() > self.max_bytes {
            String::from_utf8_lossy(&data.as_bytes()[data.len() - self.max_bytes..]).into_owned()
        } else {
            data.to_string()
        };

        self.bytes += data.len();
        self.chunks.push_back(data);

        while self.bytes > self.max_bytes {
            let overflow = self.bytes - self.max_bytes;
            let Some(front) = self.chunks.front_mut() else {
                self.bytes = 0;
                break;
            };

            if front.len() <= overflow {
                self.bytes -= front.len();
                self.chunks.pop_front();
            } else {
                let trimmed = String::from_utf8_lossy(&front.as_bytes()[overflow..]).into_owned();
                self.bytes -= overflow;
                *front = trimmed;
            }
        }
    }

    fn snapshot(&self) -> String {
        self.chunks.iter().map(String::as_str).collect()
    }
}

struct TerminalOutputState {
    channel: Option<tauri::ipc::Channel<String>>,
    buffer: TerminalOutputBuffer,
    exit_event: Option<TerminalEvent>,
}

impl TerminalOutputState {
    fn new(channel: tauri::ipc::Channel<String>) -> Self {
        Self {
            channel: Some(channel),
            buffer: TerminalOutputBuffer::new(TERMINAL_OUTPUT_BUFFER_LIMIT),
            exit_event: None,
        }
    }
}

fn send_event(channel: &tauri::ipc::Channel<String>, event: TerminalEvent) {
    if let Ok(payload) = serde_json::to_string(&event) {
        let _ = channel.send(payload);
    }
}

fn publish_event(output: &Arc<Mutex<TerminalOutputState>>, event: TerminalEvent) {
    let Ok(mut output) = output.lock() else {
        return;
    };

    if let TerminalEvent::Output { data, .. } = &event {
        output.buffer.push(data);
    }
    if matches!(&event, TerminalEvent::Exit { .. }) {
        output.exit_event = Some(event.clone());
    }
    if let Some(channel) = output.channel.as_ref() {
        send_event(channel, event);
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
    let output = Arc::new(Mutex::new(TerminalOutputState::new(channel)));
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

#[tauri::command]
pub fn attach_terminal_session(
    state: tauri::State<'_, TerminalState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
    channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let (master, output) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal state poisoned".to_string())?;
        let session = sessions
            .get(&terminal_id)
            .ok_or_else(|| "Terminal session not found".to_string())?;
        (session.master.clone(), session.output.clone())
    };

    master
        .lock()
        .map_err(|_| "Terminal master poisoned".to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize terminal: {}", error))?;

    let mut output = output
        .lock()
        .map_err(|_| "Terminal output state poisoned".to_string())?;
    output.channel = Some(channel);
    let replay = output.buffer.snapshot();
    if !replay.is_empty() {
        if let Some(channel) = output.channel.as_ref() {
            send_event(
                channel,
                TerminalEvent::Output {
                    terminal_id: terminal_id.clone(),
                    data: replay,
                },
            );
        }
    }
    if let Some(exit_event) = output.exit_event.clone() {
        if let Some(channel) = output.channel.as_ref() {
            send_event(channel, exit_event);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn detach_terminal_session(
    state: tauri::State<'_, TerminalState>,
    terminal_id: String,
) -> Result<(), String> {
    let output = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal state poisoned".to_string())?;
        sessions
            .get(&terminal_id)
            .ok_or_else(|| "Terminal session not found".to_string())?
            .output
            .clone()
    };

    output
        .lock()
        .map_err(|_| "Terminal output state poisoned".to_string())?
        .channel = None;

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::TerminalOutputBuffer;

    #[test]
    fn keeps_only_the_latest_output_within_the_byte_limit() {
        let mut buffer = TerminalOutputBuffer::new(8);

        buffer.push("1234");
        buffer.push("567890");

        assert_eq!(buffer.snapshot(), "34567890");
    }

    #[test]
    fn truncates_a_single_oversized_chunk_to_the_latest_bytes() {
        let mut buffer = TerminalOutputBuffer::new(4);

        buffer.push("abcdef");

        assert_eq!(buffer.snapshot(), "cdef");
    }
}
