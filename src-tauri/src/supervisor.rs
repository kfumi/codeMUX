//! 壳侧 daemon supervisor:spawn / attach / restart / watch / stop 契约。
//!
//! 权威 daemon 是独立二进制(`codemux-daemon`,工单 03):壳不再进程内跑
//! companion 服务与定时任务,而是按 run-state(`daemon-run-state.json`)+
//! 回环健康探活决定 attach 还是 spawn。决策表:
//!
//! - run-state 缺失(或 stale)→ [`EnsureDecision::Spawned`]
//! - run-state 存在、版本匹配、健康探活通过 → [`EnsureDecision::Attached`]
//!   (不 spawn、不持 child,壳退出后外部 daemon 存活)
//! - run-state 存在但版本不匹配或不健康 → [`EnsureDecision::Restarted`]
//!   (强杀旧 pid → 清 run-state → spawn 新 daemon)
//!
//! 只有壳自己 spawn 的 child 会被 [`stop_managed`] 停止;attach 的外部
//! daemon 绝不动。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use log::{info, warn};
use serde::{Deserialize, Serialize};

use crate::daemon::run_state::{self, DaemonRunState};
use crate::daemon::DAEMON_VERSION;
use crate::paths::PathRoots;

/// 就绪等待:spawn 后轮询 run-state + 健康探活的总超时。
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// 健康探活单次超时。
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// 就绪轮询间隔。
const READY_POLL_INTERVAL: Duration = Duration::from_millis(200);
/// watcher 巡检间隔。
const WATCH_INTERVAL: Duration = Duration::from_secs(1);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 壳托管的 daemon 子进程与发现状态。字段不可 Default:必须显式给
/// roots / exe_path / managed_by 构造([`SupervisorState::new`])。
pub struct SupervisorState {
    pub child: Arc<Mutex<Option<std::process::Child>>>,
    pub port: Arc<Mutex<Option<u16>>>,
    pub roots: PathRoots,
    pub exe_path: PathBuf,
    pub managed_by: String,
    /// 主动 stop 期间置位,watcher 据此区分「我们杀的」与「意外退出」。
    stopping: Arc<AtomicBool>,
}

impl SupervisorState {
    pub fn new(roots: PathRoots, exe_path: PathBuf, managed_by: impl Into<String>) -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            port: Arc::new(Mutex::new(None)),
            roots,
            exe_path,
            managed_by: managed_by.into(),
            stopping: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// /api/health 响应中 supervisor 关心的字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHealth {
    pub ok: bool,
    pub version: String,
}

/// [`ensure_daemon`] 的决策结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureDecision {
    /// run-state 健康:复用已有 daemon,不持 child。
    Attached,
    /// 无 run-state:新 spawn。
    Spawned,
    /// 版本不匹配或不健康:杀旧起新。
    Restarted,
}

impl EnsureDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            EnsureDecision::Attached => "attached",
            EnsureDecision::Spawned => "spawned",
            EnsureDecision::Restarted => "restarted",
        }
    }
}

/// 回环健康探活:GET /api/health(Connection: close),2s 超时,
/// 解析 JSON;任何一步失败都返回 None(视为不可用)。
pub async fn probe_daemon_health(port: u16) -> Option<DaemonHealth> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let probe = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .ok()?;
        let request = b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
        stream.write_all(&request[..]).await.ok()?;
        let mut buffer = Vec::new();
        stream.read_to_end(&mut buffer).await.ok()?;
        let text = String::from_utf8_lossy(&buffer);
        let body = text.find('{')?;
        serde_json::from_str::<DaemonHealth>(&text[body..]).ok()
    };
    tokio::time::timeout(HEALTH_PROBE_TIMEOUT, probe)
        .await
        .ok()?
}

/// 解析 daemon 二进制路径:开发构建优先 `current_exe` 同目录的 sibling
/// (target/debug 下壳与 daemon 同产),否则回退打包资源 `daemon/` 子目录。
pub fn resolve_daemon_exe<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    use tauri::Manager;
    let binary_name = if cfg!(windows) {
        "codemux-daemon.exe"
    } else {
        "codemux-daemon"
    };

    let sibling = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(binary_name)));
    if sibling.as_ref().is_some_and(|path| path.exists()) {
        return sibling.expect("sibling checked above");
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("daemon").join(binary_name);
        if candidate.exists() {
            return candidate;
        }
    }

    sibling.unwrap_or_else(|| PathBuf::from(binary_name))
}

/// 决策表入口(带事件出口,测试可注入)。成功时向 sink 发
/// `daemon-lifecycle {status: "started", decision}`。
pub async fn ensure_daemon_with_sink(
    roots: PathRoots,
    exe_path: PathBuf,
    state: &SupervisorState,
    sink: &(dyn Fn(&str, serde_json::Value) + Send + Sync),
) -> Result<EnsureDecision, String> {
    match run_state::read(&roots) {
        Some(run_state) if run_state.version == DAEMON_VERSION => {
            match probe_daemon_health(run_state.port).await {
                Some(health) if health.ok => {
                    info!(target: "supervisor", "Attaching to healthy daemon on port {} (pid={})", run_state.port, run_state.pid);
                    *state.port.lock().unwrap() = Some(run_state.port);
                    let decision = EnsureDecision::Attached;
                    sink("daemon-lifecycle", started_payload(decision));
                    Ok(decision)
                }
                _ => {
                    warn!(target: "supervisor", "Run-state daemon on port {} is unhealthy; restarting", run_state.port);
                    restart_managed(&run_state, roots, exe_path, state, sink).await
                }
            }
        }
        Some(run_state) => {
            warn!(
                target: "supervisor",
                "Run-state daemon version {} != {} (pid={}); restarting",
                run_state.version, DAEMON_VERSION, run_state.pid
            );
            restart_managed(&run_state, roots, exe_path, state, sink).await
        }
        None => {
            spawn_managed_daemon(roots, exe_path, state).await?;
            let decision = EnsureDecision::Spawned;
            sink("daemon-lifecycle", started_payload(decision));
            Ok(decision)
        }
    }
}

/// 决策表入口:Tauri 壳用 AppHandle 把生命周期事件发到前端。
pub async fn ensure_daemon<R: tauri::Runtime>(
    roots: PathRoots,
    exe_path: PathBuf,
    state: &SupervisorState,
    app: &tauri::AppHandle<R>,
) -> Result<EnsureDecision, String> {
    use tauri::Emitter;
    ensure_daemon_with_sink(roots, exe_path, state, &|event, payload| {
        let _ = app.emit(event, payload);
    })
    .await
}

fn started_payload(decision: EnsureDecision) -> serde_json::Value {
    serde_json::json!({ "status": "started", "decision": decision.as_str() })
}

/// Restarted 路径:强杀旧 daemon(优先我们持有的 child 句柄,否则按 pid
/// 系统强杀)→ 清 run-state → spawn 新 daemon。
async fn restart_managed(
    run_state: &DaemonRunState,
    roots: PathRoots,
    exe_path: PathBuf,
    state: &SupervisorState,
    sink: &(dyn Fn(&str, serde_json::Value) + Send + Sync),
) -> Result<EnsureDecision, String> {
    kill_old_daemon(run_state, state);
    run_state::clear(&roots);
    spawn_managed_daemon(roots, exe_path, state).await?;
    let decision = EnsureDecision::Restarted;
    sink("daemon-lifecycle", started_payload(decision));
    Ok(decision)
}

fn kill_old_daemon(run_state: &DaemonRunState, state: &SupervisorState) {
    let mut child_guard = state.child.lock().unwrap();
    if let Some(child) = child_guard.as_mut() {
        let pid = child.id();
        info!(target: "supervisor", "Force-killing managed daemon child (pid={})", pid);
        if let Err(error) = child.kill() {
            warn!(target: "supervisor", "Failed to kill managed daemon child (pid={}): {}", pid, error);
        }
        if let Err(error) = child.wait() {
            warn!(target: "supervisor", "Failed to reap managed daemon child (pid={}): {}", pid, error);
        }
        *child_guard = None;
        return;
    }
    let pid = run_state.pid;
    warn!(target: "supervisor", "Force-killing external daemon by pid={}", pid);
    let killed = force_kill_pid(pid);
    if !killed {
        warn!(target: "supervisor", "Failed to force-kill daemon pid={}; continuing with spawn", pid);
    }
}

/// 跨进程强杀:Windows `taskkill /F /PID`,unix `kill -9`。
fn force_kill_pid(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}

/// spawn 独立 daemon:stdout/stderr 追加重定向到 `<app_data_dir>/logs/daemon.log`,
/// 轮询 run-state 直到出现本 child 的条目且健康探活通过。
async fn spawn_managed_daemon(
    roots: PathRoots,
    exe_path: PathBuf,
    state: &SupervisorState,
) -> Result<(), String> {
    roots
        .ensure_app_data_dir()
        .map_err(|error| format!("Failed to create app data dir: {}", error))?;
    let log_path = daemon_log_path(&roots);
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create daemon log dir: {}", error))?;
    }
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| {
            format!(
                "Failed to open daemon log {}: {}",
                log_path.display(),
                error
            )
        })?;
    let stdout_file = log_file
        .try_clone()
        .map_err(|error| format!("Failed to clone daemon log handle: {}", error))?;

    let app_data_dir = roots
        .app_data_dir
        .to_str()
        .ok_or_else(|| "app data dir is not valid UTF-8".to_string())?
        .to_string();

    let mut command = std::process::Command::new(&exe_path);
    command
        .args(["--app-data-dir", &app_data_dir])
        .args(["--managed-by", &state.managed_by])
        .stdout(std::process::Stdio::from(stdout_file))
        .stderr(std::process::Stdio::from(log_file));

    // 打包环境的资源根带 sidecar/dist 布局;开发构建回退源码树解析,不传。
    if !cfg!(debug_assertions) {
        if let Some(resource_dir) = &roots.resource_dir {
            if resource_dir.exists() {
                if let Some(resource_dir) = resource_dir.to_str() {
                    command.args(["--resource-dir", resource_dir]);
                }
            }
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn daemon ({}): {}", exe_path.display(), error))?;
    let pid = child.id();
    info!(target: "supervisor", "Spawned daemon (pid={}, exe={})", pid, exe_path.display());

    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Failed to poll daemon status: {}", error))?
        {
            *state.child.lock().unwrap() = None;
            return Err(format!("daemon exited during startup: {}", status));
        }
        if let Some(run_state) = run_state::read(&roots) {
            if run_state.pid == pid {
                match probe_daemon_health(run_state.port).await {
                    Some(health) if health.ok => {
                        *state.child.lock().unwrap() = Some(child);
                        *state.port.lock().unwrap() = Some(run_state.port);
                        state.stopping.store(false, Ordering::SeqCst);
                        info!(target: "supervisor", "Daemon ready on 127.0.0.1:{} (pid={}, version={})", run_state.port, pid, health.version);
                        return Ok(());
                    }
                    _ => {
                        warn!(target: "supervisor", "Daemon wrote run-state but health probe failed; retrying");
                    }
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            *state.child.lock().unwrap() = None;
            return Err(format!(
                "daemon did not become ready within {}s",
                READY_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

fn daemon_log_path(roots: &PathRoots) -> PathBuf {
    roots.app_data_dir.join("logs").join("daemon.log")
}

/// watcher:常驻巡检托管 child(每秒 try_wait)。观察到退出时按 stopping
/// 标记区分:主动 stop/restart 杀掉的是预期退出,静默;否则视为意外崩溃,
/// 清 run-state 并通知前端。循环不退出,stop→spawn 换上的新 child 继续被
/// 守望,直到壳进程结束。
pub async fn watch_managed<R: tauri::Runtime>(state: &SupervisorState, app: &tauri::AppHandle<R>) {
    use tauri::Emitter;
    loop {
        tokio::time::sleep(WATCH_INTERVAL).await;
        let exited = {
            let mut guard = state.child.lock().unwrap();
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        Some(status)
                    }
                    Ok(None) => None,
                    Err(error) => {
                        warn!(target: "supervisor", "Failed to poll daemon status: {}", error);
                        None
                    }
                },
                None => None,
            }
        };
        if let Some(status) = exited {
            if state.stopping.load(Ordering::SeqCst) {
                // 主动 stop / restart 杀掉的:预期退出,不惊扰前端。
                info!(target: "supervisor", "Managed daemon stopped as requested: {}", status);
                continue;
            }
            warn!(target: "supervisor", "Managed daemon exited unexpectedly: {}", status);
            run_state::clear(&state.roots);
            if let Err(error) = app.emit(
                "daemon-lifecycle",
                serde_json::json!({ "status": "exited" }),
            ) {
                warn!(target: "supervisor", "Failed to emit daemon-lifecycle: {}", error);
            }
        }
    }
}

/// 停掉壳托管的 daemon:强杀(SQLite journal 保证崩溃安全)→ wait →
/// 清 run-state。外部 attach 的 daemon(child=None)绝不动。
pub async fn stop_managed(state: &SupervisorState) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    let Some(child) = guard.as_mut() else {
        info!(target: "supervisor", "No managed daemon child; nothing to stop");
        return Ok(());
    };
    state.stopping.store(true, Ordering::SeqCst);
    let pid = child.id();
    info!(target: "supervisor", "Stopping managed daemon (pid={})", pid);
    if let Err(error) = child.kill() {
        warn!(target: "supervisor", "Failed to kill daemon (pid={}): {}", pid, error);
    }
    if let Err(error) = child.wait() {
        warn!(target: "supervisor", "Failed to reap daemon (pid={}): {}", pid, error);
    }
    *guard = None;
    run_state::clear(&state.roots);
    *state.port.lock().unwrap() = None;
    // watcher 按「观察到的退出 + 标记」判定预期退出;标记用完即复位,
    // 之后的 restart→spawn 出的新 child 崩溃仍要被当作意外上报。
    state.stopping.store(false, Ordering::SeqCst);
    info!(target: "supervisor", "Managed daemon stopped");
    Ok(())
}

#[tauri::command]
pub async fn daemon_status(
    state: tauri::State<'_, SupervisorState>,
) -> Result<serde_json::Value, String> {
    let run_state = run_state::read(&state.roots);
    let managed = state.child.lock().unwrap().is_some();
    let port = { *state.port.lock().unwrap() }.or_else(|| run_state.as_ref().map(|s| s.port));
    let health = match port {
        Some(port) => probe_daemon_health(port).await,
        None => None,
    };
    let running = health.as_ref().map(|h| h.ok).unwrap_or(false);
    Ok(serde_json::json!({
        "running": running,
        "port": port,
        "version": health
            .as_ref()
            .map(|h| h.version.clone())
            .or_else(|| run_state.as_ref().map(|s| s.version.clone())),
        "managedBy": run_state.as_ref().map(|s| s.managed_by.clone()),
        "managed": managed,
    }))
}

/// 前端「重试」入口:停掉托管 daemon(如有)再走一遍决策表。
#[tauri::command]
pub async fn daemon_restart<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, SupervisorState>,
) -> Result<serde_json::Value, String> {
    info!(target: "supervisor", "daemon_restart requested");
    stop_managed(&state).await?;
    let decision = ensure_daemon(state.roots.clone(), state.exe_path.clone(), &state, &app).await?;
    daemon_status(state).await.map(|mut status| {
        if let Some(object) = status.as_object_mut() {
            object.insert(
                "decision".to_string(),
                serde_json::Value::String(decision.as_str().to_string()),
            );
        }
        status
    })
}
