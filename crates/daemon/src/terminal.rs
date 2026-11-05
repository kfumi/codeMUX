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

fn default_shell_candidates() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates = vec!["pwsh.exe".to_string(), "powershell.exe".to_string()];
        if let Some(comspec) = std::env::var_os("ComSpec") {
            candidates.push(comspec.to_string_lossy().into_owned());
        }
        candidates.push("cmd.exe".to_string());
        candidates
    }
    #[cfg(target_os = "macos")]
    {
        let mut candidates = Vec::new();
        if let Some(shell) = std::env::var_os("SHELL") {
            candidates.push(shell.to_string_lossy().into_owned());
        }
        candidates.extend(["/bin/zsh", "/bin/bash", "/bin/sh"].map(str::to_string));
        candidates
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut candidates = Vec::new();
        if let Some(shell) = std::env::var_os("SHELL") {
            candidates.push(shell.to_string_lossy().into_owned());
        }
        candidates.extend(["/bin/bash", "/bin/zsh", "/bin/sh"].map(str::to_string));
        candidates
    }
}

/// 候选路径是否可执行：带分隔符的按路径判断，裸名字扫 PATH。
fn is_executable_candidate(candidate: &str) -> bool {
    let path = PathBuf::from(candidate);
    if path.components().count() > 1 {
        return is_executable_file(&path);
    }

    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| is_executable_file(&dir.join(candidate)))
}

#[cfg(unix)]
fn is_executable_file(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &std::path::Path) -> bool {
    path.is_file()
}

/// 纯选择逻辑：按顺序返回第一个通过校验的候选。可注入校验函数以便测试。
fn pick_shell(
    candidates: impl IntoIterator<Item = String>,
    is_executable: impl Fn(&str) -> bool,
) -> Option<String> {
    candidates
        .into_iter()
        .find(|candidate| is_executable(candidate))
}

fn resolve_shell() -> Result<String, String> {
    pick_shell(default_shell_candidates(), is_executable_candidate).ok_or_else(|| {
        #[cfg(target_os = "windows")]
        {
            "No usable Windows shell found for terminal startup".to_string()
        }
        #[cfg(not(target_os = "windows"))]
        {
            "No usable shell found for terminal startup".to_string()
        }
    })
}

/// 变量缺失或为 `C`/`POSIX` 时补成 `C.UTF-8`；其它值保持原样。
///
/// 只有 Unix 的 `apply_terminal_env` 会调用它；Windows 上仅测试使用。
#[cfg_attr(not(unix), allow(dead_code))]
fn utf8_locale_override(current: Option<&str>) -> Option<&'static str> {
    match current {
        None | Some("") | Some("C") | Some("POSIX") => Some("C.UTF-8"),
        Some(_) => None,
    }
}

fn apply_terminal_env(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    if std::env::var_os("COLORTERM").is_none() {
        command.env("COLORTERM", "truecolor");
    }

    #[cfg(unix)]
    {
        for variable in ["LANG", "LC_CTYPE"] {
            let current = std::env::var(variable).ok();
            if let Some(value) = utf8_locale_override(current.as_deref()) {
                command.env(variable, value);
            }
        }
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
) -> Result<(String, String), String> {
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

    let shell = resolve_shell()?;
    let mut command = CommandBuilder::new(&shell);
    apply_terminal_env(&mut command);
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
    let output_for_exit = output.clone();
    let child_handle = Arc::new(Mutex::new(child));
    let session = TerminalSession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: child_handle.clone(),
        output: output.clone(),
    };

    state
        .sessions
        .lock()
        .map_err(|_| "Terminal state poisoned".to_string())?
        .insert(terminal_id.clone(), session);

    let output_id = terminal_id.clone();
    let child_for_wait = child_handle;
    // 输出线程：只负责把 PTY 的输出转发出去。它在 EOF/错误时结束，但**不发 Exit**——
    // ConPTY 下 shell 退出后输出管道不一定会 EOF（要等 master 释放），据此判断退出会
    // 永远等不到事件。
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
    });

    // 退出线程：以子进程真正被回收为准。拿不到退出码（例如被 close 杀掉）时保持
    // `None`，前端仍按「已退出」处理。
    //
    // 这里**不能**用 `wait()`：child 锁在 session 里是共享的，`wait()` 会一直持锁到
    // shell 退出，而 `close_terminal` 也要拿这把锁去 `kill()` —— 两者互相等待；更糟的是
    // close 在 async handler 里同步阻塞 std Mutex，会把 tokio worker 一直占住，连带
    // 控制面 WS 的 Ping/Pong 也停摆。改成短锁轮询，锁只在一次 `try_wait` 期间持有。
    let exit_id = terminal_id.clone();
    let exit_output = output_for_exit;
    std::thread::spawn(move || {
        let mut code = None;
        loop {
            let status = match child_for_wait.lock() {
                Ok(mut child) => child.try_wait(),
                Err(_) => break,
            };

            match status {
                Ok(Some(status)) => {
                    code = Some(status.exit_code());
                    break;
                }
                Ok(None) => {}
                // 已被 close 杀掉 / 句柄失效：不再轮询，直接报一个无退出码的结束事件。
                Err(_) => break,
            }

            std::thread::sleep(std::time::Duration::from_millis(250));
        }

        publish_event(
            &exit_output,
            TerminalEvent::Exit {
                terminal_id: exit_id,
                code,
            },
        );
    });

    Ok((terminal_id, shell))
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
    use super::{
        pick_shell, publish_event, utf8_locale_override, TerminalEvent, TerminalOutputBuffer,
        TerminalOutputState,
    };
    use std::sync::{Arc, Mutex};

    #[test]
    fn picks_the_first_executable_shell_candidate() {
        let picked = pick_shell(
            vec![
                "pwsh.exe".to_string(),
                "powershell.exe".to_string(),
                "cmd.exe".to_string(),
            ],
            |candidate| candidate == "powershell.exe" || candidate == "cmd.exe",
        );

        assert_eq!(picked.as_deref(), Some("powershell.exe"));
    }

    #[test]
    fn falls_back_through_the_candidate_list_in_order() {
        let picked = pick_shell(
            vec![
                "$SHELL".to_string(),
                "/bin/zsh".to_string(),
                "/bin/bash".to_string(),
            ],
            |candidate| candidate == "/bin/bash",
        );

        assert_eq!(picked.as_deref(), Some("/bin/bash"));
    }

    #[test]
    fn reports_when_no_shell_candidate_is_usable() {
        let picked = pick_shell(vec!["a".to_string(), "b".to_string()], |_| false);
        assert_eq!(picked, None);
    }

    #[test]
    fn replaces_missing_or_c_locales_only() {
        assert_eq!(utf8_locale_override(None), Some("C.UTF-8"));
        assert_eq!(utf8_locale_override(Some("")), Some("C.UTF-8"));
        assert_eq!(utf8_locale_override(Some("C")), Some("C.UTF-8"));
        assert_eq!(utf8_locale_override(Some("POSIX")), Some("C.UTF-8"));
        assert_eq!(utf8_locale_override(Some("en_US.UTF-8")), None);
    }

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
