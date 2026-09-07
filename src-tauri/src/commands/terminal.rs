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
    channel: Option<tauri::ipc::Channel<String>>,
    broadcast_tx: broadcast::Sender<String>,
    buffer: TerminalOutputBuffer,
    exit_event: Option<TerminalEvent>,
}

impl TerminalOutputState {
    fn new(channel: Option<tauri::ipc::Channel<String>>) -> Self {
        let (broadcast_tx, _) = broadcast::channel(512);
        Self {
            channel,
            broadcast_tx,
            buffer: TerminalOutputBuffer::new(TERMINAL_OUTPUT_BUFFER_LIMIT),
            exit_event: None,
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<String> {
        self.broadcast_tx.subscribe()
    }
}

fn send_event(channel: &tauri::ipc::Channel<String>, event: TerminalEvent) {
    if let Ok(payload) = serde_json::to_string(&event) {
        let _ = channel.send(payload);
    }
}

fn bind_output_channel(
    output: &Arc<Mutex<TerminalOutputState>>,
    terminal_id: &str,
    channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
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
                    terminal_id: terminal_id.to_string(),
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

fn detach_output_channel(output: &Arc<Mutex<TerminalOutputState>>) -> Result<(), String> {
    output
        .lock()
        .map_err(|_| "Terminal output state poisoned".to_string())?
        .channel = None;
    Ok(())
}

fn resize_master(
    master: &Arc<Mutex<Box<dyn MasterPty + Send>>>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    master
        .lock()
        .map_err(|_| "Terminal master poisoned".to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize terminal: {}", error))
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
    let output = Arc::new(Mutex::new(TerminalOutputState::new(Some(channel))));
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

    let resize_result = resize_master(&master, cols, rows);

    bind_output_channel(&output, &terminal_id, channel)?;

    if let Err(error) = resize_result {
        let exited = output
            .lock()
            .map_err(|_| "Terminal output state poisoned".to_string())?
            .exit_event
            .is_some();
        if !exited {
            return Err(error);
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

    detach_output_channel(&output)
}

#[tauri::command]
pub fn write_terminal_session(
    state: tauri::State<'_, TerminalState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let (writer, output) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal state poisoned".to_string())?;
        sessions
            .get(&terminal_id)
            .map(|session| (session.writer.clone(), session.output.clone()))
            .ok_or_else(|| "Terminal session not found".to_string())?
    };
    ensure_attached(&output)?;

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
    let (master, output) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal state poisoned".to_string())?;
        sessions
            .get(&terminal_id)
            .map(|session| (session.master.clone(), session.output.clone()))
            .ok_or_else(|| "Terminal session not found".to_string())?
    };
    ensure_attached(&output)?;

    resize_master(&master, cols, rows)
}

fn ensure_attached(output: &Arc<Mutex<TerminalOutputState>>) -> Result<(), String> {
    if output
        .lock()
        .map_err(|_| "Terminal output state poisoned".to_string())?
        .channel
        .is_none()
    {
        return Err("Terminal session is detached".to_string());
    }
    Ok(())
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
    let output = Arc::new(Mutex::new(TerminalOutputState::new(None)));
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
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?;
    let master = sessions
        .get(terminal_id)
        .ok_or_else(|| "Terminal session not found".to_string())?
        .master
        .clone();
    resize_master(&master, cols, rows)
}

pub fn close_terminal_for_companion(state: &TerminalState, terminal_id: &str) -> Result<(), String> {
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
    use super::{
        bind_output_channel, detach_output_channel, publish_event, TerminalEvent,
        TerminalOutputBuffer, TerminalOutputState,
    };
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
    fn rejects_io_when_the_terminal_is_detached() {
        let output = Arc::new(Mutex::new(TerminalOutputState::new(
            Some(tauri::ipc::Channel::new(|_| Ok(()))),
        )));

        detach_output_channel(&output).unwrap();

        assert_eq!(
            super::ensure_attached(&output),
            Err("Terminal session is detached".to_string())
        );
    }

    #[test]
    fn replays_recent_output_when_binding_a_new_channel() {
        let received = Arc::new(Mutex::new(Vec::<tauri::ipc::InvokeResponseBody>::new()));
        let initial_received = received.clone();
        let initial_channel = tauri::ipc::Channel::new(move |payload| {
            initial_received.lock().unwrap().push(payload);
            Ok(())
        });
        let output = Arc::new(Mutex::new(TerminalOutputState::new(Some(initial_channel))));

        publish_event(
            &output,
            TerminalEvent::Output {
                terminal_id: "terminal-1".to_string(),
                data: "live".to_string(),
            },
        );
        assert_eq!(output.lock().unwrap().buffer.snapshot(), "live");

        detach_output_channel(&output).unwrap();
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

        let reconnect_received = received.clone();
        let reconnect_channel = tauri::ipc::Channel::new(move |payload| {
            reconnect_received.lock().unwrap().push(payload);
            Ok(())
        });
        bind_output_channel(&output, "terminal-1", reconnect_channel).unwrap();

        let messages = received.lock().unwrap();
        let body_as_json = |body: &tauri::ipc::InvokeResponseBody| match body {
            tauri::ipc::InvokeResponseBody::Json(payload) => {
                let payload =
                    serde_json::from_str::<String>(payload).unwrap_or_else(|_| payload.clone());
                serde_json::from_str(&payload).unwrap()
            }
            tauri::ipc::InvokeResponseBody::Raw(payload) => {
                serde_json::from_slice(payload).unwrap()
            }
        };
        let json_messages: Vec<serde_json::Value> = messages.iter().map(body_as_json).collect();
        let replay = json_messages
            .iter()
            .find(|message| message["type"] == "output" && message["data"] == "liveoffline")
            .unwrap();
        let exit = json_messages
            .iter()
            .find(|message| message["type"] == "exit")
            .unwrap();
        assert_eq!(replay["type"], "output");
        assert_eq!(replay["terminalId"], "terminal-1");
        assert_eq!(replay["data"], "liveoffline");
        assert_eq!(exit["type"], "exit");
        assert_eq!(output.lock().unwrap().buffer.snapshot(), "liveoffline");
    }
}
