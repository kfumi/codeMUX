//! codemux-daemon:无壳独立 daemon。
//!
//! 权威进程(SQLite、Session、Agent、Sidecar、MCP、skills、定时任务)。
//! 壳(Tauri/Electron supervisor)与本机开发者都以同一方式拉起它:
//! `codemux-daemon [--app-data-dir <dir>] [--resource-dir <dir>] [--port <n>]
//!                 [--managed-by <tag>]`
//! 同名环境变量 `CODEMUX_APP_DATA_DIR` / `CODEMUX_RESOURCE_DIR` /
//! `CODEMUX_DAEMON_MANAGED_BY` / `CODEMUX_DAEMON_PORT` 可替代旗标。

use codemux_lib::paths::PathRoots;

struct DaemonCli {
    app_data_dir: Option<std::path::PathBuf>,
    resource_dir: Option<std::path::PathBuf>,
    port: Option<u16>,
    managed_by: String,
}

fn parse_cli() -> Result<DaemonCli, String> {
    let env = |key: &str| std::env::var(key).ok().filter(|value| !value.is_empty());
    let mut cli = DaemonCli {
        app_data_dir: env("CODEMUX_APP_DATA_DIR").map(std::path::PathBuf::from),
        resource_dir: env("CODEMUX_RESOURCE_DIR").map(std::path::PathBuf::from),
        port: env("CODEMUX_DAEMON_PORT").and_then(|value| value.parse().ok()),
        managed_by: env("CODEMUX_DAEMON_MANAGED_BY").unwrap_or_else(|| "standalone".to_string()),
    };

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value_for = |flag: &str| -> Result<String, String> {
            args.next().ok_or_else(|| format!("旗标 {} 缺少取值", flag))
        };
        match arg.as_str() {
            "--app-data-dir" => cli.app_data_dir = Some(std::path::PathBuf::from(value_for(&arg)?)),
            "--resource-dir" => cli.resource_dir = Some(std::path::PathBuf::from(value_for(&arg)?)),
            "--port" => {
                cli.port = Some(
                    value_for(&arg)?
                        .parse()
                        .map_err(|e| format!("旗标 --port 的取值不是合法端口: {}", e))?,
                )
            }
            "--managed-by" => cli.managed_by = value_for(&arg)?,
            "--help" | "-h" => {
                println!("{}", USAGE);
                std::process::exit(0);
            }
            other => return Err(format!("未知旗标: {}(见 --help)", other)),
        }
    }
    Ok(cli)
}

const USAGE: &str = "codemux-daemon — CodeMUX 权威 daemon(无壳运行)

用法: codemux-daemon [--app-data-dir <dir>] [--resource-dir <dir>] [--port <n>] [--managed-by <tag>]

  --app-data-dir  应用数据目录(默认 %APPDATA%\\com.codemux.desktop / 平台等价目录)
  --resource-dir  打包资源根(默认:开发环境用源码树,release 必须提供 sidecar/dist)
  --port          回环监听端口(默认取应用配置的 companion.port)
  --managed-by    托管方标记,写入 run-state(壳 spawn 时传 desktop)
";

fn main() {
    init_stderr_logger();

    let cli = match parse_cli() {
        Ok(cli) => cli,
        Err(error) => {
            eprintln!("codemux-daemon: {}", error);
            std::process::exit(2);
        }
    };

    let app_data_dir = cli.app_data_dir.unwrap_or_else(|| {
        dirs::data_dir()
            .expect("无法定位应用数据目录(请用 --app-data-dir 显式指定)")
            .join("com.codemux.desktop")
    });
    let roots = PathRoots {
        app_data_dir,
        resource_dir: cli.resource_dir,
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("构建 tokio 运行时失败");
    if let Err(error) = runtime.block_on(codemux_lib::daemon::run_daemon_standalone(
        roots,
        cli.managed_by,
        cli.port,
    )) {
        eprintln!("codemux-daemon: 启动失败: {}", error);
        std::process::exit(1);
    }
}

/// 极简 stderr 日志:supervisor 会把 stderr 重定向到日志文件;
/// 完整日志体系随壳侧工单接入。
fn init_stderr_logger() {
    struct StderrLogger;

    impl log::Log for StderrLogger {
        fn enabled(&self, metadata: &log::Metadata) -> bool {
            metadata.level() <= log::Level::Info
        }

        fn log(&self, record: &log::Record) {
            if self.enabled(record.metadata()) {
                eprintln!("[{} {}] {}", record.level(), record.target(), record.args());
            }
        }

        fn flush(&self) {}
    }

    let _ = log::set_boxed_logger(Box::new(StderrLogger));
    log::set_max_level(log::LevelFilter::Info);
}
