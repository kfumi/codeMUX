//! Daemon 生命周期契约测试:以真实 `codemux-daemon` 二进制为被测对象
//! (cargo 经 CARGO_BIN_EXE 自动构建),覆盖 supervisor 决策所需的全部
//! 可观察行为:健康探活、run-state 写入、版本/端口契约、stale 剔除。

use codemux_lib::daemon::run_state;
use codemux_lib::paths::PathRoots;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("probe port")
        .local_addr()
        .expect("probe addr")
        .port()
}

fn spawn_daemon(app_data_dir: &std::path::Path, port: u16) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_codemux-daemon"))
        .args([
            "--app-data-dir",
            app_data_dir.to_str().expect("utf8 path"),
            "--port",
            &port.to_string(),
            "--managed-by",
            "supervisor-test",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn codemux-daemon")
}

/// 阻塞式探活:连上端口后请求 /api/health,期望 200。
fn probe_health(port: u16) -> bool {
    probe_health_opt(port) == Some(true)
}

fn probe_health_opt(port: u16) -> Option<bool> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 200"))
}

#[test]
fn daemon_binary_serves_loopback_and_writes_run_state() {
    let temp = tempfile::tempdir().expect("tempdir");
    let port = free_port();
    let mut child = spawn_daemon(temp.path(), port);

    let mut healthy = false;
    for _ in 0..150 {
        match child.try_wait() {
            Ok(Some(status)) => panic!("daemon 提前退出: {:?}", status),
            Ok(None) => {}
            Err(error) => panic!("轮询 daemon 状态失败: {}", error),
        }
        if probe_health(port) {
            healthy = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(healthy, "daemon 未在预期时间内探活");

    let roots = PathRoots {
        app_data_dir: temp.path().to_path_buf(),
        resource_dir: None,
    };
    let state = run_state::read(&roots).expect("run-state 应已写入且 pid 存活");
    assert_eq!(state.port, port, "run-state 记录实际服务端口");
    assert_eq!(state.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(state.managed_by, "supervisor-test");
    assert!(run_state::pid_is_alive(state.pid));

    // 强杀(非优雅退出):run-state 残留,但必须按 pid 判定为 stale。
    let _ = child.kill();
    let _ = child.wait();
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        run_state::read(&roots).is_none(),
        "强杀后的 run-state 必须按 pid 判定为 stale"
    );
}
