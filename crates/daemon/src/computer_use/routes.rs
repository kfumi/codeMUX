//! 电脑控制治理接口(工单 06):驱动状态、一键诊断、启动/急停、更新确认、
//! 允许范围与审计查询。
//! 工单 08:零配置 —— `driver_command` 留空时自动探测官方安装位置与 PATH;
//! 一键安装官方驱动,与升级一样在接口层强制确认。
//!
//! 鉴权与自动化接缝一致:仅回环 + Local Daemon Token(桌面渲染层用的就是
//! 这个令牌;配对设备不参与驱动治理)。
//!
//! 更新语义:驱动的升级通道由用户配置(`driver_update_command`),daemon 不
//! 猜包管理器。接口层强制 `confirm: true` —— 「升级必须经我确认」不是界面
//! 礼貌,是这一层拒绝无确认调用。

use std::net::SocketAddr;
use std::process::Stdio;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::companion::browser_audit::{self, AuditRecord};
use crate::companion::server::{ApiError, ServerContext};

use super::driver::{DriverSpec, DriverStatus};
use super::policy::BUILTIN_DENY;

/// 驱动更新命令的等待上限。
const UPDATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// 一键安装(下载并执行官方脚本)的等待上限:下载可能慢,同样给足 5 分钟。
const INSTALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// 配置 → 驱动启动方式(工单 08):显式命令优先;留空则用探测到的默认安装,
/// 参数留空时取驱动的 `mcp` 子命令 —— 默认值不该让用户猜。
pub(crate) fn driver_spec_with(
    config: &crate::config::types::ComputerUseConfig,
    detected: Option<String>,
) -> Option<DriverSpec> {
    if let Some(command) = config.driver_command.as_ref() {
        return Some(DriverSpec::new(command.clone(), config.driver_args.clone()));
    }
    let command = detected?;
    let args = if config.driver_args.is_empty() {
        super::probe::DEFAULT_DRIVER_ARGS
            .iter()
            .map(|arg| (*arg).to_string())
            .collect()
    } else {
        config.driver_args.clone()
    };
    Some(DriverSpec::new(command, args))
}

/// 真实探测(文件系统)版;单测走 [`driver_spec_with`] 注入探测结果。
pub(crate) fn driver_spec_from_config(
    config: &crate::config::types::ComputerUseConfig,
) -> Option<DriverSpec> {
    driver_spec_with(config, super::probe::detect_default())
}

/// 给前端的解析结论:配置优先,其次自动探测,两者都没有才算缺失。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverResolution {
    /// `custom` = 用户显式配置;`auto` = 默认探测命中;`missing` = 都没有。
    pub mode: &'static str,
    /// 实际将使用的启动命令(缺失时为空)。
    pub command: Option<String>,
    /// 自动探测命中的路径(`auto` 时有)。
    pub detected_path: Option<String>,
}

/// 与 [`driver_spec_with`] 同一套输入,产出展示用结论(探测结果同样注入)。
pub(crate) fn driver_resolution_with(
    config: &crate::config::types::ComputerUseConfig,
    detected: Option<String>,
) -> DriverResolution {
    match (&config.driver_command, driver_spec_with(config, detected)) {
        (Some(command), _) => DriverResolution {
            mode: "custom",
            command: Some(command.clone()),
            detected_path: None,
        },
        (None, Some(spec)) => DriverResolution {
            mode: "auto",
            command: Some(spec.command.clone()),
            detected_path: Some(spec.command),
        },
        (None, None) => DriverResolution {
            mode: "missing",
            command: None,
            detected_path: None,
        },
    }
}

/// 一条诊断项。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub ok: bool,
    pub detail: String,
    /// 失败时怎么修(有人话可照做)。
    pub fix: Option<String>,
}

/// 一键诊断:驱动在不在、权限够不够、链路通不通(需求 11)。
///
/// 纯函数(状态 + 平台 → 检查项),便于逐项测试。
pub fn diagnose(
    status: &DriverStatus,
    platform_supported: bool,
    update_command_configured: bool,
) -> Vec<DiagnosticCheck> {
    let mut checks = Vec::new();

    checks.push(DiagnosticCheck {
        id: "configured",
        label: "驱动已配置",
        ok: status.configured,
        detail: match status.command.as_deref() {
            Some(command) => format!("驱动命令:{command}"),
            None => "未检测到 cua-driver(官方安装位置与 PATH 都没有)".to_string(),
        },
        fix: if status.configured {
            None
        } else {
            Some(
                "点「一键安装」装官方驱动,或在 设置 → 电脑控制 → 驱动命令 手动填写启动命令"
                    .to_string(),
            )
        },
    });

    checks.push(DiagnosticCheck {
        id: "platform",
        label: "当前平台受支持",
        ok: platform_supported,
        detail: if platform_supported {
            "系统级执行的本期支持范围:Windows".to_string()
        } else {
            "系统级执行本期只做 Windows".to_string()
        },
        fix: if platform_supported {
            None
        } else {
            Some("在 macOS / Linux 上请只使用浏览器级与桌面只读能力".to_string())
        },
    });

    checks.push(DiagnosticCheck {
        id: "running",
        label: "驱动进程存活",
        ok: status.running,
        detail: if status.running {
            "驱动子进程在运行".to_string()
        } else {
            status
                .last_error
                .clone()
                .unwrap_or_else(|| "驱动未启动".to_string())
        },
        fix: if status.running {
            None
        } else {
            Some(
                "点「启动驱动」;若仍失败,看下方最近错误并按提示排查(常见原因:路径不对、被杀毒拦截)"
                    .to_string(),
            )
        },
    });

    let handshake_ok = status.running && !status.tools.is_empty();
    checks.push(DiagnosticCheck {
        id: "handshake",
        label: "MCP 链路连通",
        ok: handshake_ok,
        detail: if handshake_ok {
            format!(
                "握手完成:{} 提供 {} 个工具",
                status.server_name.as_deref().unwrap_or("驱动"),
                status.tools.len()
            )
        } else if status.running {
            "握手完成但工具清单为空".to_string()
        } else {
            "未建立 MCP 通道".to_string()
        },
        fix: if handshake_ok {
            None
        } else {
            Some("确认驱动支持 stdio MCP(initialize / tools/list);不支持的话请换驱动".to_string())
        },
    });

    // 权限(需求 11):驱动能起来只说明能 spawn;输入注入在 Windows 上还受
    // 提权/完整性级别影响,驱动的错误里会带出来 —— 这里把已知的权限类失败
    // 翻成人话,而不是让用户对着 "Access is denied" 猜。
    let permission_failure = status
        .last_error
        .as_deref()
        .map(str::to_lowercase)
        .filter(|error| {
            [
                "access is denied",
                "拒绝访问",
                "elevation",
                "administrator",
                "权限",
            ]
            .iter()
            .any(|needle| error.contains(needle))
        });
    checks.push(DiagnosticCheck {
        id: "permissions",
        label: "权限够用",
        ok: permission_failure.is_none(),
        detail: match (&permission_failure, status.running) {
            (Some(error), _) => format!("驱动报过权限类错误:{error}"),
            (None, true) => "驱动以当前权限启动成功,未报权限错误".to_string(),
            (None, false) => "驱动尚未启动,权限待启动后才能确认".to_string(),
        },
        fix: if permission_failure.is_some() {
            Some(
                "关掉 CodeMUX 后以管理员身份重新启动(输入注入到高完整性级别的窗口需要同等权限)"
                    .to_string(),
            )
        } else {
            None
        },
    });

    checks.push(DiagnosticCheck {
        id: "update-channel",
        label: "升级通道已配置",
        ok: update_command_configured,
        detail: if update_command_configured {
            "已配置更新命令,可一键升级(每次升级都会先问你)".to_string()
        } else {
            "未配置更新命令:只能手动升级驱动".to_string()
        },
        fix: if update_command_configured {
            None
        } else {
            Some("如需一键升级,在 设置 → 电脑控制 → 更新命令 里填入升级命令".to_string())
        },
    });

    checks.push(DiagnosticCheck {
        id: "deny-list",
        label: "内置拒绝列表就位",
        ok: !BUILTIN_DENY.is_empty(),
        detail: format!(
            "内置拒绝 {} 条(密码管理器/终端/锁屏/安全中心/宿主自身),不可删除",
            BUILTIN_DENY.len()
        ),
        fix: None,
    });

    checks
}

pub(crate) fn extend_api_router(router: Router<ServerContext>) -> Router<ServerContext> {
    router
        .route("/computer-use/driver", get(driver_status))
        .route("/computer-use/driver/start", post(start_driver))
        .route("/computer-use/driver/estop", post(estop_driver))
        .route("/computer-use/driver/diagnose", post(diagnose_driver))
        .route("/computer-use/driver/update", post(update_driver))
        .route("/computer-use/driver/install", post(install_driver))
        .route("/computer-use/policy", get(policy_snapshot))
        .route("/computer-use/audit", get(list_computer_use_audit))
}

/// 鉴权复用审批端点那一份:同一道门(仅回环 + Local Daemon Token)。
fn authorize(
    ctx: &ServerContext,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Result<(), ApiError> {
    super::approval::authorize_local_request(&ctx.daemon.app.app_data_dir, headers, peer)
}

fn config_snapshot(ctx: &ServerContext) -> crate::config::types::ComputerUseConfig {
    ctx.daemon.app.config.lock().unwrap().computer_use.clone()
}

async fn driver_status(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let config = config_snapshot(&ctx);
    let detected = super::probe::detect_default();
    let spec = driver_spec_with(&config, detected.clone());
    let resolution = driver_resolution_with(&config, detected);
    let status = ctx
        .daemon
        .companion
        .inner
        .driver
        .status(spec.as_ref())
        .await;
    Ok(Json(serde_json::json!({
        "ok": true,
        "status": status,
        "enabled": config.enabled,
        "systemExecutionEnabled": config.system_execution_enabled,
        "allowlist": config.allowlist,
        "maxSteps": config.max_steps,
        "updateCommandConfigured": config.driver_update_command.is_some(),
        "driverResolution": resolution,
        "builtinDenyList": BUILTIN_DENY
            .iter()
            .map(|(needle, scope)| serde_json::json!({ "match": needle, "scope": scope }))
            .collect::<Vec<_>>(),
    })))
}

async fn start_driver(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let config = config_snapshot(&ctx);
    if !config.system_execution_enabled {
        return Err(ApiError::forbidden(
            "系统级执行未开启:先在 设置 → 电脑控制 打开「系统级执行」再启动驱动",
        ));
    }
    let spec = driver_spec_from_config(&config);
    let started = ctx.daemon.companion.inner.driver.start(spec.as_ref()).await;
    match started {
        Ok(status) => {
            audit(&ctx, "driver-start", true, None);
            Ok(Json(serde_json::json!({ "ok": true, "status": status })))
        }
        Err(error) => {
            audit(&ctx, "driver-start", false, Some(&error));
            Err(ApiError::bad_request(error))
        }
    }
}

async fn estop_driver(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let killed = ctx.daemon.companion.inner.driver.estop().await;
    audit(
        &ctx,
        "driver-estop",
        true,
        if killed {
            None
        } else {
            Some("急停时没有在跑的驱动")
        },
    );
    Ok(Json(serde_json::json!({ "ok": true, "killed": killed })))
}

async fn diagnose_driver(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let config = config_snapshot(&ctx);
    let spec = driver_spec_from_config(&config);
    let status = ctx
        .daemon
        .companion
        .inner
        .driver
        .status(spec.as_ref())
        .await;
    let checks = diagnose(
        &status,
        cfg!(target_os = "windows"),
        config.driver_update_command.is_some(),
    );
    Ok(Json(serde_json::json!({ "ok": true, "checks": checks })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDriverRequest {
    #[serde(default)]
    confirm: bool,
}

async fn update_driver(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<UpdateDriverRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    // 升级必须先经用户确认:无确认的调用一律拒绝,不靠界面自觉。
    if !body.confirm {
        return Err(ApiError::bad_request("升级驱动需要用户确认(confirm: true)"));
    }
    let config = config_snapshot(&ctx);
    let Some(update_command) = config.driver_update_command.clone() else {
        return Err(ApiError::bad_request(
            "未配置驱动更新命令:在 设置 → 电脑控制 → 更新命令 里填上升级方式",
        ));
    };

    // 升级期间先把驱动停下:避免升级替换二进制时有进程占着文件。
    let _ = ctx.daemon.companion.inner.driver.estop().await;

    let output = run_shell_command(&update_command).await;
    match output {
        Ok(detail) => {
            audit(&ctx, "driver-update", true, None);
            let spec = driver_spec_from_config(&config);
            let status = ctx
                .daemon
                .companion
                .inner
                .driver
                .status(spec.as_ref())
                .await;
            Ok(Json(
                serde_json::json!({ "ok": true, "detail": detail, "status": status }),
            ))
        }
        Err(error) => {
            audit(&ctx, "driver-update", false, Some(&error));
            Err(ApiError::bad_request(error))
        }
    }
}

/// 跑用户配置的更新命令:经平台 shell 执行(命令整行由用户提供)。
async fn run_shell_command(command: &str) -> Result<String, String> {
    #[cfg(windows)]
    let child = tokio::process::Command::new("cmd")
        .args(["/C", command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("执行更新命令失败: {}", error))?;
    #[cfg(not(windows))]
    let child = tokio::process::Command::new("sh")
        .args(["-c", command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("执行更新命令失败: {}", error))?;
    wait_command_output(child, UPDATE_TIMEOUT, "更新命令").await
}

/// 等一个已拉起的子进程收尾并把输出归一化(升级与一键安装共用同一套语义)。
async fn wait_command_output(
    child: tokio::process::Child,
    timeout: std::time::Duration,
    label: &str,
) -> Result<String, String> {
    let waited = tokio::time::timeout(timeout, child.wait_with_output()).await;
    match waited {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if output.status.success() {
                let summary = stdout.trim();
                Ok(if summary.is_empty() {
                    format!("{label}执行完成")
                } else {
                    summary.chars().take(500).collect()
                })
            } else {
                Err(format!(
                    "{label}退出码 {:?}: {}",
                    output.status.code(),
                    if stderr.trim().is_empty() {
                        stdout.trim().to_string()
                    } else {
                        stderr.trim().chars().take(500).collect::<String>()
                    }
                ))
            }
        }
        Ok(Err(error)) => Err(format!("等待{label}失败: {}", error)),
        Err(_) => Err(format!("{label}超时({}s)", timeout.as_secs())),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallDriverRequest {
    #[serde(default)]
    confirm: bool,
}

/// 一键安装官方驱动(工单 08):PowerShell 执行 cua.ai 官方安装脚本。
///
/// 与升级同一条铁律:接口层强制 `confirm: true`,审计留痕;完成后立即重新
/// 探测,装没装成不靠感觉。脚本从 `probe::INSTALL_SCRIPT_URL` 下载,在用户
/// 本机的 PowerShell 会话里执行,daemon 不代持任何凭据。
async fn install_driver(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<InstallDriverRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    // 安装 = 从远端拉脚本执行:无确认的调用一律拒绝,与升级同一道闸门。
    if !body.confirm {
        return Err(ApiError::bad_request("安装驱动需要用户确认(confirm: true)"));
    }
    match run_install_script().await {
        Ok(detail) => {
            audit(&ctx, "driver-install", true, None);
            let config = config_snapshot(&ctx);
            let spec = driver_spec_from_config(&config);
            if spec.is_none() {
                return Err(ApiError::bad_request(format!(
                    "安装脚本执行完成但没有检测到 cua-driver:{detail}"
                )));
            }
            let status = ctx
                .daemon
                .companion
                .inner
                .driver
                .status(spec.as_ref())
                .await;
            let resolution = driver_resolution_with(&config, super::probe::detect_default());
            Ok(Json(serde_json::json!({
                "ok": true,
                "detail": detail,
                "status": status,
                "driverResolution": resolution,
            })))
        }
        Err(error) => {
            audit(&ctx, "driver-install", false, Some(&error));
            Err(ApiError::bad_request(error))
        }
    }
}

/// 执行官方安装脚本(本期仅 Windows):`irm <INSTALL_SCRIPT_URL> | iex`。
async fn run_install_script() -> Result<String, String> {
    #[cfg(windows)]
    {
        let script = format!("irm {} | iex", super::probe::INSTALL_SCRIPT_URL);
        let child = tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("拉起 PowerShell 失败: {}", error))?;
        wait_command_output(child, INSTALL_TIMEOUT, "安装脚本").await
    }
    #[cfg(not(windows))]
    {
        let _ = INSTALL_TIMEOUT;
        Err("一键安装本期只支持 Windows(系统级执行本期也只覆盖 Windows)".to_string())
    }
}

async fn policy_snapshot(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let config = config_snapshot(&ctx);
    Ok(Json(serde_json::json!({
        "ok": true,
        "allowlist": config.allowlist,
        "maxSteps": config.max_steps,
        "builtinDenyList": BUILTIN_DENY
            .iter()
            .map(|(needle, scope)| serde_json::json!({ "match": needle, "scope": scope }))
            .collect::<Vec<_>>(),
    })))
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    session_id: Option<String>,
}

async fn list_computer_use_audit(
    State(ctx): State<ServerContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<AuditQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&ctx, &headers, Some(peer))?;
    let entries = {
        let db = ctx
            .daemon
            .app
            .db
            .lock()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        match query.session_id.as_deref() {
            Some(session_id) => {
                browser_audit::list_session_audit(&db, session_id, query.limit.unwrap_or(50))
            }
            None => browser_audit::list_automation_audit(&db, query.limit.unwrap_or(50)),
        }
        .map_err(ApiError::internal)?
    };
    Ok(Json(serde_json::json!({ "ok": true, "entries": entries })))
}

/// 驱动生命周期动作也进审计(需求 26:谁、何时、哪个会话、什么动作)。
fn audit(ctx: &ServerContext, action: &str, ok: bool, error: Option<&str>) {
    if let Ok(db) = ctx.daemon.app.db.lock() {
        browser_audit::record_audit(
            &db,
            &AuditRecord {
                op: action,
                tool: None,
                browser_id: None,
                session_id: None,
                actor: "local",
                ok,
                decision: None,
                error,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(running: bool, tools: Vec<&str>) -> DriverStatus {
        DriverStatus {
            configured: true,
            running,
            command: Some("cua-driver".to_string()),
            server_name: Some("cua-driver".to_string()),
            version: Some("1.2.3".to_string()),
            tools: tools.into_iter().map(str::to_string).collect(),
            last_error: None,
        }
    }

    fn check<'a>(checks: &'a [DiagnosticCheck], id: &str) -> &'a DiagnosticCheck {
        checks
            .iter()
            .find(|check| check.id == id)
            .expect("检查项存在")
    }

    #[test]
    fn a_started_driver_with_tools_passes_the_chain_checks() {
        let checks = diagnose(&status(true, vec!["click", "screenshot"]), true, true);
        assert!(check(&checks, "configured").ok);
        assert!(check(&checks, "running").ok);
        assert!(check(&checks, "handshake").ok);
        assert!(check(&checks, "platform").ok);
        assert!(check(&checks, "update-channel").ok);
        assert!(check(&checks, "deny-list").ok);
        assert!(checks.iter().all(|check| check.ok));
        // 通过项不该给「怎么修」。
        assert!(checks.iter().all(|check| check.fix.is_none()));
    }

    #[test]
    fn unconfigured_driver_fails_with_actionable_guidance() {
        let checks = diagnose(&DriverStatus::default(), true, false);
        let configured = check(&checks, "configured");
        assert!(!configured.ok);
        assert!(configured
            .fix
            .as_deref()
            .unwrap_or_default()
            .contains("设置 → 电脑控制"));
        assert!(!check(&checks, "handshake").ok);
    }

    #[test]
    fn handshake_failure_surfaces_the_last_error_and_a_fix() {
        let mut failing = status(false, Vec::new());
        failing.last_error = Some("拉起驱动失败(cua-driver): 系统找不到指定的文件。".to_string());
        let checks = diagnose(&failing, true, false);
        let running = check(&checks, "running");
        assert!(!running.ok);
        assert!(running.detail.contains("系统找不到指定的文件"));
        assert!(running.fix.as_deref().unwrap_or_default().contains("杀毒"));
    }

    #[test]
    fn running_driver_without_tools_is_a_broken_chain_not_a_pass() {
        let checks = diagnose(&status(true, vec![]), true, false);
        assert!(check(&checks, "running").ok);
        let handshake = check(&checks, "handshake");
        assert!(!handshake.ok);
        assert!(handshake.detail.contains("工具清单为空"));
    }

    #[test]
    fn permission_failures_are_translated_into_a_fix() {
        let mut failing = status(false, Vec::new());
        failing.last_error = Some("Access is denied. (os error 5)".to_string());
        let checks = diagnose(&failing, true, false);
        let permissions = check(&checks, "permissions");
        assert!(!permissions.ok);
        assert!(permissions
            .fix
            .as_deref()
            .unwrap_or_default()
            .contains("管理员"));

        let healthy = diagnose(&status(true, vec!["click"]), true, true);
        assert!(check(&healthy, "permissions").ok);
    }

    #[test]
    fn unsupported_platform_is_reported_honestly() {
        let checks = diagnose(&status(true, vec!["click"]), false, true);
        let platform = check(&checks, "platform");
        assert!(!platform.ok);
        assert!(platform.detail.contains("只做 Windows"));
    }

    #[test]
    fn empty_config_with_a_detected_binary_builds_the_default_spec() {
        let config = crate::config::types::ComputerUseConfig::default();
        let spec = driver_spec_with(&config, Some("C:\\tools\\cua-driver.exe".to_string()))
            .expect("探测命中就应可启动");
        assert_eq!(spec.command, "C:\\tools\\cua-driver.exe");
        assert_eq!(spec.args, vec!["mcp".to_string()], "参数留空 = mcp 子命令");
    }

    #[test]
    fn auto_mode_keeps_user_args_when_present() {
        let config = crate::config::types::ComputerUseConfig {
            driver_args: vec!["--stdio".to_string()],
            ..Default::default()
        };
        let spec = driver_spec_with(&config, Some("cua-driver".to_string())).expect("命中");
        assert_eq!(spec.args, vec!["--stdio".to_string()]);
    }

    #[test]
    fn explicit_config_still_wins_over_detection() {
        let config = crate::config::types::ComputerUseConfig {
            driver_command: Some("my-driver".to_string()),
            driver_args: vec!["--stdio".to_string()],
            ..Default::default()
        };
        let spec =
            driver_spec_with(&config, Some("detected.exe".to_string())).expect("配置了就用配置");
        assert_eq!(spec.command, "my-driver");
        assert_eq!(spec.args, vec!["--stdio".to_string()]);
    }

    #[test]
    fn missing_everything_is_missing_and_reports_no_command() {
        let config = crate::config::types::ComputerUseConfig::default();
        assert!(driver_spec_with(&config, None).is_none());
        let resolution = driver_resolution_with(&config, None);
        assert_eq!(resolution.mode, "missing");
        assert!(resolution.command.is_none());
        assert!(resolution.detected_path.is_none());
    }

    #[test]
    fn auto_resolution_carries_the_detected_path() {
        let config = crate::config::types::ComputerUseConfig::default();
        let resolution = driver_resolution_with(&config, Some("C:\\cua\\driver.exe".to_string()));
        assert_eq!(resolution.mode, "auto");
        assert_eq!(resolution.command.as_deref(), Some("C:\\cua\\driver.exe"));
        assert_eq!(
            resolution.detected_path.as_deref(),
            Some("C:\\cua\\driver.exe")
        );
    }

    #[test]
    fn custom_resolution_reports_the_user_command() {
        let config = crate::config::types::ComputerUseConfig {
            driver_command: Some("my-driver".to_string()),
            ..Default::default()
        };
        let resolution = driver_resolution_with(&config, Some("detected.exe".to_string()));
        assert_eq!(resolution.mode, "custom");
        assert_eq!(resolution.command.as_deref(), Some("my-driver"));
        assert!(resolution.detected_path.is_none());
    }
}
