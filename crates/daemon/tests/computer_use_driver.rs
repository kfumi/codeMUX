//! 驱动宿主概念验证(工单 05):以真实子进程为被测对象,验证 daemon 能拉起
//! 一个 stdio MCP 程序、完成握手、拿到工具清单,并且急停真的把进程杀掉。
//!
//! 驱动替身用 daemon 自己的 `mcp-control` 子命令 —— 它就是一个讲 MCP 的
//! stdio 程序(initialize / tools/list 不依赖运行中的 daemon)。这样这条测试
//! 跨平台、无外部下载,验的是宿主本身:spawn、按行分帧、id 配对、握手超时、
//! 进程级急停。真实第三方驱动(cua-driver 等)接入时,配置成同一形态即可。

use codemux_lib::computer_use::driver::{DriverHost, DriverSpec};
use std::process::Command;
use std::time::{Duration, Instant};

fn driver_spec() -> DriverSpec {
    DriverSpec::new(
        env!("CARGO_BIN_EXE_codemux-daemon"),
        vec![
            "mcp-control".to_string(),
            "--app-data-dir".to_string(),
            std::env::temp_dir().to_string_lossy().into_owned(),
        ],
    )
}

#[tokio::test]
async fn daemon_spawns_a_stdio_mcp_driver_and_lists_its_tools() {
    let host = DriverHost::new();
    let spec = driver_spec();

    let status = host
        .start(Some(&spec))
        .await
        .expect("驱动应能拉起并完成握手");
    assert!(status.configured);
    assert!(status.running);
    assert_eq!(status.server_name.as_deref(), Some("codemux-control"));
    assert!(status.version.is_some(), "握手应带回驱动版本");
    assert!(
        status
            .tools
            .iter()
            .any(|tool| tool == "computer_screenshot"),
        "驱动工具清单应被读到: {:?}",
        status.tools
    );
    assert!(host.is_running().await);

    // 急停:进程级刹车,停完就不可再调用。
    assert!(host.estop().await, "急停应报告杀掉了进程");
    assert!(!host.is_running().await);
    let error = host
        .call_tool("computer_screenshot", serde_json::json!({}))
        .await
        .expect_err("急停后不得再调用驱动");
    assert!(error.contains("急停"), "{error}");

    // 重启:急停是刹车不是终点。
    let restarted = host.start(Some(&spec)).await.expect("急停后应能重新拉起");
    assert!(restarted.running);
    host.estop().await;
}

#[tokio::test]
async fn unstartable_driver_reports_the_failure_and_leaves_no_process() {
    let host = DriverHost::new();
    let spec = DriverSpec::new("codemux-driver-does-not-exist", Vec::new());

    let error = host
        .start(Some(&spec))
        .await
        .expect_err("不存在的命令必须报错");
    assert!(error.contains("拉起驱动失败"), "{error}");
    assert!(!host.is_running().await);
    assert!(host.status(Some(&spec)).await.last_error.is_some());

    // 失败信息留在状态里,供设置页诊断展示。
    let status = host.status(Some(&spec)).await;
    assert!(status
        .last_error
        .as_deref()
        .unwrap_or_default()
        .contains("拉起驱动失败"));
}

#[tokio::test]
async fn estop_kills_a_handshaken_driver_within_a_second() {
    let host = DriverHost::new();
    let spec = driver_spec();
    host.start(Some(&spec)).await.expect("先拉起");

    let started = Instant::now();
    assert!(host.estop().await);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "急停必须在 1 秒内收敛(实际 {:?})",
        started.elapsed()
    );
    assert!(!host.is_running().await);
}

/// 手工诊断用:确认替身确实是个 stdio MCP 程序(与宿主实现无关的旁证)。
#[test]
fn the_stand_in_driver_speaks_mcp_on_stdio() {
    use std::io::{BufRead, BufReader, Write};

    let spec = driver_spec();
    let mut child = Command::new(&spec.command)
        .args(&spec.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn 替身驱动");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2024-11-05","capabilities":{{}},"clientInfo":{{"name":"test","version":"0"}}}}}}"#
    )
    .expect("写 initialize");
    stdin.flush().expect("flush");
    let mut line = String::new();
    stdout.read_line(&mut line).expect("读应答");
    assert!(line.contains("protocolVersion"), "initialize 应答: {line}");

    let _ = child.kill();
    let _ = child.wait();
}
