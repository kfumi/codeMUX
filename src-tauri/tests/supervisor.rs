//! Supervisor 决策表契约测试:以真实 `codemux-daemon` 二进制为被测对象
//! (cargo 经 CARGO_BIN_EXE 自动构建),经 `ensure_daemon_with_sink` 驱动
//! supervisor 的 spawn / attach / restart / stop 路径,验证:
//! - 无 run-state → Spawned;spawn 后二次 ensure → Attached(不重复 spawn);
//! - 伪造 run-state 版本 → Restarted,新 daemon 健康且 run-state 为当前版;
//! - stop_managed 后端口不再健康且 run-state 已清。
//!
//! 每个 tempdir 预写 config.json 固定一个空闲端口,避免并行测试抢默认端口。

use codemux_lib::daemon::{run_state, DAEMON_VERSION};
use codemux_lib::paths::PathRoots;
use codemux_lib::supervisor::{
    ensure_daemon_with_sink, probe_daemon_health, stop_managed, EnsureDecision, SupervisorState,
};
use std::time::Duration;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("probe port")
        .local_addr()
        .expect("probe addr")
        .port()
}

/// 预写配置:theme 必填(无 serde default),companion.port 固定空闲端口。
fn seed_config(roots: &PathRoots, port: u16) {
    roots.ensure_app_data_dir().expect("mkdir");
    let config = serde_json::json!({
        "theme": "System",
        "companion": { "port": port },
    });
    std::fs::write(
        roots.config_path(),
        serde_json::to_vec_pretty(&config).expect("serialize config"),
    )
    .expect("write config");
}

fn noop_sink(_event: &str, _payload: serde_json::Value) {}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Runtime::new()
        .expect("tokio runtime")
        .block_on(future)
}

/// spawn → 等待 run-state 出现且健康(与 daemon_binary 相同的探活节奏)。
fn wait_for_run_state(roots: &PathRoots) -> run_state::DaemonRunState {
    for _ in 0..150 {
        if let Some(state) = run_state::read(roots) {
            if probe_daemon_health_blocking(state.port) == Some(true) {
                return state;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("daemon 未在预期时间内写出健康 run-state");
}

/// 阻塞式探活(与 daemon_binary.rs 相同的报文)。
fn probe_daemon_health_blocking(port: u16) -> Option<bool> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let body = text.find('{')?;
    let health: serde_json::Value = serde_json::from_str(&text[body..]).ok()?;
    Some(health.get("ok")?.as_bool()?)
}

fn supervisor_for(temp: &tempfile::TempDir) -> SupervisorState {
    SupervisorState::new(
        PathRoots {
            app_data_dir: temp.path().to_path_buf(),
            resource_dir: None,
        },
        std::path::PathBuf::from(env!("CARGO_BIN_EXE_codemux-daemon")),
        "supervisor-test",
    )
}

/// 把 run-state 改写为指定版本(pid/端口保持指向存活 daemon)。
fn rewrite_run_state_version(roots: &PathRoots, state: &run_state::DaemonRunState, version: &str) {
    let forged = run_state::DaemonRunState {
        version: version.to_string(),
        ..state.clone()
    };
    run_state::write(roots, &forged).expect("rewrite run-state");
}

#[test]
fn ensure_spawns_then_attaches() {
    let temp = tempfile::tempdir().expect("tempdir");
    let roots = PathRoots {
        app_data_dir: temp.path().to_path_buf(),
        resource_dir: None,
    };
    seed_config(&roots, free_port());
    let supervisor = supervisor_for(&temp);
    let exe_path = supervisor.exe_path.clone();

    // 无 run-state → Spawned。
    let decision = block_on(ensure_daemon_with_sink(
        roots.clone(),
        exe_path.clone(),
        &supervisor,
        &noop_sink,
    ))
    .expect("first ensure");
    assert_eq!(decision, EnsureDecision::Spawned);

    let entry = wait_for_run_state(&roots);
    assert_eq!(entry.version, DAEMON_VERSION);
    assert_eq!(entry.managed_by, "supervisor-test");
    assert_eq!(*supervisor.port.lock().unwrap(), Some(entry.port));
    assert!(
        block_on(probe_daemon_health(entry.port)).is_some(),
        "daemon healthy after spawn"
    );

    // 二次 ensure:版本匹配且健康 → Attached(不 spawn 新进程,不持 child)。
    let managed_before = supervisor.child.lock().unwrap().is_some();
    let decision = block_on(ensure_daemon_with_sink(
        roots.clone(),
        exe_path.clone(),
        &supervisor,
        &noop_sink,
    ))
    .expect("second ensure");
    assert_eq!(decision, EnsureDecision::Attached);
    assert_eq!(
        supervisor.child.lock().unwrap().is_some(),
        managed_before,
        "attach must not spawn another child"
    );

    stop_managed_and_assert_cleared(&supervisor, &roots, entry.port);
}

#[test]
fn version_mismatch_restarts_and_replaces_run_state() {
    let temp = tempfile::tempdir().expect("tempdir");
    let roots = PathRoots {
        app_data_dir: temp.path().to_path_buf(),
        resource_dir: None,
    };
    seed_config(&roots, free_port());
    let supervisor = supervisor_for(&temp);
    let exe_path = supervisor.exe_path.clone();

    let decision = block_on(ensure_daemon_with_sink(
        roots.clone(),
        exe_path.clone(),
        &supervisor,
        &noop_sink,
    ))
    .expect("spawn ensure");
    assert_eq!(decision, EnsureDecision::Spawned);
    let entry = wait_for_run_state(&roots);

    // 版本不匹配(伪造旧版本)→ Restarted。
    rewrite_run_state_version(&roots, &entry, "0.0.0-fake-old");
    let decision = block_on(ensure_daemon_with_sink(
        roots.clone(),
        exe_path.clone(),
        &supervisor,
        &noop_sink,
    ))
    .expect("restart ensure");
    assert_eq!(decision, EnsureDecision::Restarted);

    let replaced = wait_for_run_state(&roots);
    assert_eq!(
        replaced.version, DAEMON_VERSION,
        "run-state must carry the current version after restart"
    );
    assert_eq!(replaced.managed_by, "supervisor-test");
    let health = block_on(probe_daemon_health(replaced.port)).expect("health probe after restart");
    assert!(health.ok, "restarted daemon must be healthy");
    assert_eq!(health.version, DAEMON_VERSION);

    stop_managed_and_assert_cleared(&supervisor, &roots, replaced.port);
}

#[test]
fn stop_managed_clears_run_state_and_closes_port() {
    let temp = tempfile::tempdir().expect("tempdir");
    let roots = PathRoots {
        app_data_dir: temp.path().to_path_buf(),
        resource_dir: None,
    };
    seed_config(&roots, free_port());
    let supervisor = supervisor_for(&temp);

    let decision = block_on(ensure_daemon_with_sink(
        roots.clone(),
        supervisor.exe_path.clone(),
        &supervisor,
        &noop_sink,
    ))
    .expect("spawn ensure");
    assert_eq!(decision, EnsureDecision::Spawned);
    let entry = wait_for_run_state(&roots);

    stop_managed_and_assert_cleared(&supervisor, &roots, entry.port);

    // 外部 attach 场景(child=None):stop_managed 必须无动作且不报错。
    block_on(stop_managed(&supervisor)).expect("stop without child is a no-op");
}

/// 停止托管 daemon 并断言:run-state 已清、端口不再应答健康检查。
fn stop_managed_and_assert_cleared(supervisor: &SupervisorState, roots: &PathRoots, port: u16) {
    block_on(stop_managed(supervisor)).expect("stop managed daemon");
    assert!(
        run_state::read(roots).is_none(),
        "run-state must be cleared after stop"
    );
    for _ in 0..25 {
        if block_on(probe_daemon_health(port)).is_none() {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("daemon port must stop answering health after stop_managed");
}
