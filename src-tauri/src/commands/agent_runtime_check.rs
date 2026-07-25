#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// CLI 检测状态。
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentRuntimeStatus {
    /// 已安装且版本不落后于最新版。
    Ok,
    /// 已安装但有可用的新版本。
    Outdated,
    /// 未在本机 PATH 中找到。
    Missing,
    /// 检测过程出现异常。
    Error,
}

/// 智能体安装来源（驱动前端徽章展示）。
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallSource {
    Nvm,
    Homebrew,
    Volta,
    Fnm,
    Mise,
    Bun,
    Pnpm,
    Scoop,
    System,
    /// 保留用于 TS 类型对齐与前端徽章映射；当前兜底归为 System，
    /// 此变体不会被构造。
    #[allow(dead_code)]
    Unknown,
}

/// 升级执行结果分级。
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpgradeOutcome {
    /// 命令成功且版本号变化。
    Success,
    /// 命令退出码 0 但版本未变。
    SoftVersionUnchanged,
    /// 命令退出码 0 但探不到版本。
    SoftNotRunnable,
    /// 命令非零退出码。
    HardFailure,
}

/// 单个智能体引擎的检测结果。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCheck {
    /// 智能体 ID（与 AgentKind 对齐）。
    pub agent_kind: String,
    /// 展示名（Claude Code / Codex / OpenCode）。
    pub label: String,
    /// CLI 命令名（claude / codex / opencode）。
    pub command: String,
    /// 检测状态。
    pub status: AgentRuntimeStatus,
    /// 已安装的本地版本（成功解析时为 Some）。
    pub current_version: Option<String>,
    /// npm registry 上的最新版本（拉取成功时为 Some）。
    pub latest_version: Option<String>,
    /// CLI 可执行文件绝对路径（未找到时为 None）。
    pub executable_path: Option<String>,
    /// 配置目录绝对路径（存在时为 Some）。
    pub config_path: Option<String>,
    /// npm 包名（用于升级）。
    pub npm_package: String,
    /// 面向用户的状态描述。
    pub message: String,
    /// 已安装但无法运行（CLI 存在但 `--version` 非零退出）。
    pub installed_but_broken: bool,
}

/// 一次检测的聚合结果。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCheckResult {
    pub checked_at: String,
    pub runtimes: Vec<AgentRuntimeCheck>,
}

/// 升级命令的执行结果。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeUpgradeResult {
    pub agent_kind: String,
    /// 兼容字段：`success` = `outcome == Success`。
    pub success: bool,
    /// 升级结果分级。
    pub outcome: UpgradeOutcome,
    pub message: String,
    /// 升级后重新解析得到的版本号。
    pub new_version: Option<String>,
}

/// 单处智能体安装的枚举信息。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallation {
    /// 原始路径（搜索时命中的路径，可能是符号链接）。
    pub path: String,
    /// canonicalize 后的真实路径。
    pub real: String,
    /// 解析到的版本号。
    pub version: Option<String>,
    /// 是否可运行（`--version` 退出码 0）。
    pub runnable: bool,
    /// 运行失败时的错误摘要。
    pub error: Option<String>,
    /// 安装来源。
    pub source: InstallSource,
    /// 是否为 PATH 实际命中那处。
    pub is_path_default: bool,
}

/// 多处安装枚举的报告。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallationReport {
    pub agent_kind: String,
    pub installs: Vec<AgentInstallation>,
    /// ≥2 处 && (版本分歧 || runnable 混合)。
    pub is_conflict: bool,
    /// ≥2 处。
    pub needs_confirmation: bool,
    /// 是否成功锚定到具体安装。
    pub anchored: bool,
    /// 锚定后将执行的升级命令（仅展示，后端执行时重新生成）。
    pub command: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum AgentSpec {
    ClaudeCode,
    Codex,
    Opencode,
}

impl AgentSpec {
    fn from_agent_kind(kind: &str) -> Option<Self> {
        match kind {
            "claude_code" => Some(AgentSpec::ClaudeCode),
            "codex" => Some(AgentSpec::Codex),
            "opencode" => Some(AgentSpec::Opencode),
            _ => None,
        }
    }

    fn agent_kind(self) -> &'static str {
        match self {
            AgentSpec::ClaudeCode => "claude_code",
            AgentSpec::Codex => "codex",
            AgentSpec::Opencode => "opencode",
        }
    }

    fn label(self) -> &'static str {
        match self {
            AgentSpec::ClaudeCode => "Claude Code",
            AgentSpec::Codex => "Codex",
            AgentSpec::Opencode => "OpenCode",
        }
    }

    fn command(self) -> &'static str {
        match self {
            AgentSpec::ClaudeCode => "claude",
            AgentSpec::Codex => "codex",
            AgentSpec::Opencode => "opencode",
        }
    }

    fn npm_package(self) -> &'static str {
        match self {
            AgentSpec::ClaudeCode => "@anthropic-ai/claude-code",
            AgentSpec::Codex => "@openai/codex",
            AgentSpec::Opencode => "opencode-ai",
        }
    }

    fn version_arg(self) -> &'static str {
        // 三个 CLI 均支持 `--version`
        "--version"
    }

    /// 是否支持官方自升级命令。
    /// - claude_code: 所有平台用 `<abs_path> update`
    /// - opencode: POSIX 用 `<abs_path> upgrade`;Windows 上禁用,因 anomalyco/opencode#17295
    ///   会弹交互 prompt 挂死静默执行,改走包管理器/npm 兜底(对齐 cc-switch 实现)
    fn supports_self_update(self) -> bool {
        match self {
            AgentSpec::ClaudeCode => true,
            AgentSpec::Opencode => !cfg!(target_os = "windows"),
            AgentSpec::Codex => false,
        }
    }

    /// 官方自升级子命令名(claude 用 `update`,opencode 用 `upgrade`)。
    fn self_update_subcommand(self) -> &'static str {
        match self {
            AgentSpec::ClaudeCode => "update",
            AgentSpec::Opencode => "upgrade",
            AgentSpec::Codex => "",
        }
    }

    fn config_dir(self, home: &Path) -> Option<PathBuf> {
        match self {
            AgentSpec::ClaudeCode => Some(home.join(".claude")),
            AgentSpec::Codex => Some(home.join(".codex")),
            AgentSpec::Opencode => {
                // OpenCode 配置目录(对齐 cc-switch 实现):
                //   1. $XDG_CONFIG_HOME/opencode(空字符串视为未设置)
                //   2. ~/.config/opencode(跨平台统一,Windows 同样使用此路径)
                // 注意:数据目录(AppData/Local、.local/share)用于 opencode.db 等,
                // 不应在此查询 — opencode.json 配置文件只在 .config/opencode 下。
                // 不检查目录存在性:由 resolve_config_path 检查 opencode.json 是否存在。
                if let Some(xdg_config) = std::env::var_os("XDG_CONFIG_HOME") {
                    let s = xdg_config.to_string_lossy();
                    if !s.is_empty() {
                        return Some(PathBuf::from(xdg_config).join("opencode"));
                    }
                }
                Some(home.join(".config").join("opencode"))
            }
        }
    }

    /// 配置文件名（相对配置目录）。
    fn config_file_name(self) -> &'static str {
        match self {
            AgentSpec::ClaudeCode => "settings.json",
            AgentSpec::Codex => "config.toml",
            AgentSpec::Opencode => "opencode.json",
        }
    }
}

const AGENT_SPECS: [AgentSpec; 3] = [AgentSpec::ClaudeCode, AgentSpec::Codex, AgentSpec::Opencode];

fn configure_command(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    command
}

/// 构建搜索路径列表，按 spec 顺序汇总去重。
///
/// 顺序：通用 → 平台 → OpenCode 专属 → PATH（Windows 排除 `Microsoft\WindowsApps`）。
fn build_tool_search_paths(agent_kind: &str, home_dir: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = vec![
        home_dir.join(".local").join("bin"),
        home_dir.join(".npm-global").join("bin"),
        home_dir.join("n").join("bin"),
        home_dir.join(".volta").join("bin"),
    ];

    // macOS
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/usr/local/bin"));
    }

    // Linux
    #[cfg(target_os = "linux")]
    {
        paths.push(PathBuf::from("/usr/local/bin"));
        paths.push(PathBuf::from("/usr/bin"));
    }

    // Windows
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join("npm"));
        }
        paths.push(PathBuf::from(r"C:\Program Files\nodejs"));
        if let Some(localappdata) = std::env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(&localappdata).join("pnpm"));
            paths.push(PathBuf::from(localappdata).join("fnm_multishells"));
        }
        if let Some(scoop) = std::env::var_os("SCOOP") {
            paths.push(PathBuf::from(scoop).join("shims"));
        } else {
            paths.push(home_dir.join("scoop").join("shims"));
        }
        if let Some(nvm_home) = std::env::var_os("NVM_HOME") {
            paths.push(PathBuf::from(nvm_home));
        }
        if let Some(nvm_symlink) = std::env::var_os("NVM_SYMLINK") {
            paths.push(PathBuf::from(nvm_symlink));
        }
    }

    // OpenCode 专属
    if agent_kind == "opencode" {
        if let Some(dir) = std::env::var_os("OPENCODE_INSTALL_DIR") {
            paths.push(PathBuf::from(dir));
        }
        if let Some(dir) = std::env::var_os("XDG_BIN_DIR") {
            paths.push(PathBuf::from(dir));
        }
        paths.push(home_dir.join("bin"));
        paths.push(home_dir.join(".opencode").join("bin"));
        paths.push(home_dir.join(".bun").join("bin"));
        paths.push(home_dir.join("go").join("bin"));
        if let Some(gopath) = std::env::var_os("GOPATH") {
            paths.push(PathBuf::from(gopath).join("bin"));
        }
    }

    // PATH 各目录
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            paths.push(dir);
        }
    }

    // 去重（保留首次出现的顺序）
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));

    // Windows: 排除 Microsoft\WindowsApps 目录（防 App Execution Alias 干扰）
    #[cfg(target_os = "windows")]
    {
        paths.retain(|p| {
            !p.to_string_lossy()
                .to_lowercase()
                .contains(r"microsoft\windowsapps")
        });
    }

    paths
}

/// 根据安装路径前缀推断安装来源。
fn infer_install_source(real_path: &Path) -> InstallSource {
    let path_str = real_path.to_string_lossy().to_lowercase();
    let normalized = path_str.replace('\\', "/");

    if normalized.contains("/.nvm/") || normalized.contains("/versions/node") {
        InstallSource::Nvm
    } else if normalized.contains("/homebrew/") || normalized.contains("/cellar/") {
        InstallSource::Homebrew
    // `.volta` 是 macOS/Linux 默认安装(`~/.volta/bin`),`/volta/` 兜底覆盖
    // Windows 的 `%LOCALAPPDATA%\Volta\bin` / `%VOLTA_HOME%\bin`(无前导点)。
    } else if normalized.contains("/.volta/") || normalized.contains("/volta/") {
        InstallSource::Volta
    } else if normalized.contains("fnm_multishells") {
        InstallSource::Fnm
    } else if normalized.contains("/mise/") {
        InstallSource::Mise
    } else if normalized.contains("/.bun/") {
        InstallSource::Bun
    // pnpm 全局包目录: macOS `~/.local/share/pnpm`、Windows `%LOCALAPPDATA%\pnpm`
    // 都命中 `/pnpm/`。
    } else if normalized.contains("/pnpm/") {
        InstallSource::Pnpm
    } else if normalized.contains("/scoop/") {
        InstallSource::Scoop
    } else if normalized.contains("/usr/local/bin")
        || normalized.contains("/usr/bin")
        || normalized.contains("c:/program files")
    {
        InstallSource::System
    } else {
        // 兜底归为 system:能被探测到但不匹配任何已知包管理器(如自定义 npm 全局目录)
        InstallSource::System
    }
}

/// 在指定目录下查找可执行文件。
/// - Windows: 扩展名优先 `.cmd` → `.exe` → 无扩展名
/// - 其它平台: 直接匹配无扩展名
fn find_executable_in_dir(dir: &Path, command: &str) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let candidates = [
            dir.join(format!("{}.cmd", command)),
            dir.join(format!("{}.exe", command)),
            dir.join(command),
        ];
        for candidate in &candidates {
            if candidate.is_file() {
                return Some(candidate.clone());
            }
        }
        None
    } else {
        let candidate = dir.join(command);
        if candidate.is_file() {
            Some(candidate)
        } else {
            None
        }
    }
}

/// 调用 `where`/`which` 解析 PATH 默认命中那处。
fn fallback_which(command: &str) -> Option<String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut cmd = Command::new("where");
        cmd.arg(command);
        cmd
    } else {
        let mut cmd = Command::new("which");
        cmd.arg(command);
        cmd
    };
    configure_command(&mut cmd);

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    parse_which_output(&String::from_utf8_lossy(&output.stdout), command)
}

/// 在 PATH 中查找命令的绝对路径。
/// 先扫 `build_tool_search_paths` 候选目录,再回退 `where/which`。
fn find_command_path(command: &str, agent_kind: &str, home_dir: &Path) -> Option<String> {
    let search_paths = build_tool_search_paths(agent_kind, home_dir);

    // 先扫候选目录
    for dir in &search_paths {
        if let Some(found) = find_executable_in_dir(dir, command) {
            return Some(found.to_string_lossy().to_string());
        }
    }

    // 回退 where/which
    fallback_which(command)
}

fn parse_which_output(stdout: &str, command: &str) -> Option<String> {
    let lines: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            // 排除 Windows App Execution Alias
            !line.to_lowercase().contains(r"microsoft\windowsapps")
        })
        .collect();

    if lines.is_empty() {
        return None;
    }

    // 优先返回 .cmd，其次 .exe，最后任意
    let cmd_suffix = format!("{}.cmd", command);
    let exe_suffix = format!("{}.exe", command);

    if let Some(cmd_match) = lines
        .iter()
        .find(|line| line.to_lowercase().ends_with(&cmd_suffix))
    {
        return Some(cmd_match.to_string());
    }
    if let Some(exe_match) = lines
        .iter()
        .find(|line| line.to_lowercase().ends_with(&exe_suffix))
    {
        return Some(exe_match.to_string());
    }
    lines.first().map(|line| line.to_string())
}

/// canonicalize 后去除 Windows extended-length prefix (`\\?\` 或 `\\?\UNC\`),
/// 避免污染命令字符串与 source 推断。canonicalize 失败时回退到原路径。
fn canonicalize_clean(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(p) => {
            #[cfg(target_os = "windows")]
            {
                let s = p.to_string_lossy();
                if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
                    PathBuf::from(format!(r"\\{}", unc))
                } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
                    PathBuf::from(stripped)
                } else {
                    p
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                p
            }
        }
        Err(_) => path.to_path_buf(),
    }
}

/// 解析 PATH 默认命中的真实路径（canonicalize 后，已 strip Windows 前缀）。
fn resolve_path_default_real(command: &str) -> Option<String> {
    let which_result = fallback_which(command)?;
    let path = PathBuf::from(which_result);
    Some(canonicalize_clean(&path).to_string_lossy().to_string())
}

/// 执行 `<command> --version` 并返回去除前后空白和换行的输出。
/// 失败时返回的 Err 字符串即为 stderr 内容（或退出码描述），不含命令前缀。
fn run_version_command(command: &str, arg: &str) -> Result<String, String> {
    let mut process = Command::new(command);
    configure_command(process.arg(arg));

    let output = process
        .output()
        .map_err(|err| format!("执行 {} {} 失败：{}", command, arg, err))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("退出码 {:?}", output.status.code())
        } else {
            stderr
        };
        return Err(detail);
    }

    // 部分工具（如 codex）会把版本信息打印到 stderr
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("{} {} 输出为空", command, arg));
        }
        return Ok(stderr);
    }
    Ok(stdout)
}

/// 从 `claude --version` / `codex --version` / `opencode --version` 的输出中解析出版本号。
/// 一般输出形如：
///   - `1.0.16 (Claude Code)`        (claude)
///   - `codex 0.139.0`               (codex)
///   - `opencode version 1.18.3`     (opencode)
///   - `1.2.3`
fn parse_version(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 直接就是纯版本号
    if is_pure_version(trimmed) {
        return Some(trimmed.to_string());
    }

    // 在字符串中查找第一个匹配 `X.Y.Z` 的子串
    let bytes = trimmed.as_bytes();
    for (idx, ch) in bytes.iter().enumerate() {
        if ch.is_ascii_digit() {
            if let Some(end) = scan_version(&trimmed[idx..]) {
                return Some(trimmed[idx..idx + end].to_string());
            }
        }
    }

    None
}

fn is_pure_version(value: &str) -> bool {
    scan_version(value).is_some_and(|end| end == value.len())
}

fn scan_version(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut idx = 0;
    let mut dots = 0;

    while idx < bytes.len() {
        let ch = bytes[idx];
        if ch.is_ascii_digit() {
            idx += 1;
            continue;
        }
        if ch == b'.' {
            // 拒绝以 . 开头或连续 .
            if idx == 0 || bytes[idx - 1] == b'.' {
                return None;
            }
            dots += 1;
            idx += 1;
            continue;
        }
        break;
    }

    if dots >= 1 && idx > 0 && bytes[idx - 1].is_ascii_digit() {
        Some(idx)
    } else {
        None
    }
}

/// 通过 npm registry 拉取最新版本号。
async fn fetch_latest_version(package: String) -> Option<String> {
    let url = format!("https://registry.npmjs.org/{}/latest", package);
    let result = reqwest::Client::builder()
        .user_agent("codemux-agent-runtime-check")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()?
        .get(&url)
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok();

    result.and_then(|v| {
        v.get("version")
            .and_then(|f| f.as_str())
            .map(str::to_string)
    })
}

/// 解析配置文件路径：返回 `<config_dir>/<config_file>`，文件存在时为 Some。
fn resolve_config_path(spec: AgentSpec, home: &Path) -> Option<String> {
    let dir = spec.config_dir(home)?;
    let file_path = dir.join(spec.config_file_name());
    if file_path.exists() {
        Some(file_path.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 取文本末尾 N 行（保留原顺序）。
fn last_n_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = if lines.len() > n { lines.len() - n } else { 0 };
    lines[start..].join("\n")
}

fn check_single_runtime(
    spec: AgentSpec,
    home: &Path,
    latest_version: Option<String>,
) -> AgentRuntimeCheck {
    let command = spec.command();
    let label = spec.label();
    let npm_package = spec.npm_package();
    let agent_kind = spec.agent_kind();

    let executable_path = find_command_path(command, agent_kind, home);
    let config_path = resolve_config_path(spec, home);

    let (status, current_version, installed_but_broken, message) = match &executable_path {
        // NotFound：无 exe 无 version
        None => (
            AgentRuntimeStatus::Missing,
            None,
            false,
            format!(
                "未在 PATH 中找到 {} CLI，可执行 `npm install -g {}` 安装。",
                label, npm_package
            ),
        ),
        Some(exe) => {
            // 在已定位的真实可执行文件上跑 `--version`
            match run_version_command(exe, spec.version_arg()) {
                Ok(out) => {
                    let current = parse_version(&out);
                    if let Some(cur) = &current {
                        // Found：有 version，按原逻辑判定 Ok/Outdated
                        let (st, msg) = if let Some(latest) = &latest_version {
                            if version_lt(cur, latest) {
                                (
                                    AgentRuntimeStatus::Outdated,
                                    format!(
                                        "{} 已安装（{}），最新版本为 {}，可一键升级。",
                                        label, cur, latest
                                    ),
                                )
                            } else {
                                (
                                    AgentRuntimeStatus::Ok,
                                    format!("{} 已是最新版本（{}）。", label, cur),
                                )
                            }
                        } else {
                            (
                                AgentRuntimeStatus::Ok,
                                format!("{} 已安装，无法获取最新版本信息。", label),
                            )
                        };
                        (st, current, false, msg)
                    } else {
                        // CLI 跑通了但版本号解析失败：算 Error 但不算 broken
                        (
                            AgentRuntimeStatus::Error,
                            None,
                            false,
                            format!("{} 已安装，但版本号解析失败：{}", label, out),
                        )
                    }
                }
                Err(err) => {
                    // FoundButFailed：有 exe 但 `--version` 非零退出
                    let detail = last_n_lines(&err, 8);
                    (
                        AgentRuntimeStatus::Error,
                        None,
                        true,
                        format!("{} 已安装但无法运行：{}", label, detail),
                    )
                }
            }
        }
    };

    AgentRuntimeCheck {
        agent_kind: agent_kind.to_string(),
        label: label.to_string(),
        command: command.to_string(),
        status,
        current_version,
        latest_version,
        executable_path,
        config_path,
        npm_package: npm_package.to_string(),
        message,
        installed_but_broken,
    }
}

/// 简单的语义版本比较：仅比较 `X.Y.Z` 形式的版本，left < right 时返回 true。
/// 任一非 `X.Y.Z` 形式则返回 false。
fn version_lt(left: &str, right: &str) -> bool {
    let parse = |v: &str| -> Option<(u64, u64, u64)> {
        let core = v.split('-').next().unwrap_or(v);
        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        Some((
            parts[0].parse::<u64>().ok()?,
            parts[1].parse::<u64>().ok()?,
            parts[2].parse::<u64>().ok()?,
        ))
    };
    match (parse(left), parse(right)) {
        (Some(l), Some(r)) => l < r,
        _ => false,
    }
}

/// 遍历搜索路径，枚举出指定智能体的所有安装位置（canonicalize 去重）。
fn enumerate_tool_installations(
    agent_kind: &str,
    command: &str,
    home_dir: &Path,
) -> Vec<AgentInstallation> {
    let search_paths = build_tool_search_paths(agent_kind, home_dir);

    // PATH 默认命中的真实路径
    let path_default_real = resolve_path_default_real(command);

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut installs: Vec<AgentInstallation> = Vec::new();

    for dir in &search_paths {
        let found = match find_executable_in_dir(dir, command) {
            Some(p) => p,
            None => continue,
        };

        let original = found.to_string_lossy().to_string();
        let real = canonicalize_clean(&found).to_string_lossy().to_string();

        if !seen.insert(real.clone()) {
            continue; // 已计数
        }

        // 在真实路径上跑 `--version`
        let (version, runnable, error) = match run_version_command(&real, "--version") {
            Ok(out) => (parse_version(&out), true, None),
            Err(err) => (None, false, Some(err)),
        };

        // source 推断用原始路径（未经 canonicalize），避免 `\\?\` 前缀等干扰
        let source = infer_install_source(&found);
        let is_path_default = path_default_real.as_deref() == Some(real.as_str());

        installs.push(AgentInstallation {
            path: original,
            real,
            version,
            runnable,
            error,
            source,
            is_path_default,
        });
    }

    // PATH 默认那处排第一位
    installs.sort_by_key(|b| std::cmp::Reverse(b.is_path_default));

    installs
}

/// 判定是否存在冲突：≥2 处 && (版本分歧 || runnable 混合)。
fn is_conflicting(installs: &[AgentInstallation]) -> bool {
    if installs.len() < 2 {
        return false;
    }

    // 版本分歧：至少两个不同的 Some(version)
    let mut version_set: std::collections::HashSet<&String> = std::collections::HashSet::new();
    let mut has_version = false;
    for install in installs {
        if let Some(v) = &install.version {
            version_set.insert(v);
            has_version = true;
        }
    }
    let version_differs = has_version && version_set.len() > 1;

    // runnable 混合：有 true 也有 false
    let runnable_mixed =
        installs.iter().any(|i| i.runnable) && installs.iter().any(|i| !i.runnable);

    version_differs || runnable_mixed
}

/// 取 PATH 默认那处，否则唯一一处。
fn default_install_from(installs: &[AgentInstallation]) -> Option<&AgentInstallation> {
    if let Some(install) = installs.iter().find(|i| i.is_path_default) {
        return Some(install);
    }
    if installs.len() == 1 {
        return Some(&installs[0]);
    }
    None
}

/// 路径含空格才加引号：POSIX 单引号，Windows 双引号。
fn quote_path(path: &str) -> String {
    if path.contains(' ') {
        if cfg!(target_os = "windows") {
            format!("\"{}\"", path)
        } else {
            format!("'{}'", path)
        }
    } else {
        path.to_string()
    }
}

/// Windows 下从同级目录挑选 sibling bin（`.cmd` 优先于 `.exe`，再退到无扩展名）。
fn sibling_bin_with_ext(dir: &Path, name: &str) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let candidates = [
            dir.join(format!("{}.cmd", name)),
            dir.join(format!("{}.exe", name)),
            dir.join(name),
        ];
        for candidate in &candidates {
            if candidate.is_file() {
                return Some(candidate.clone());
            }
        }
        None
    } else {
        let candidate = dir.join(name);
        if candidate.is_file() {
            Some(candidate)
        } else {
            None
        }
    }
}

/// 按来源推导同级包管理器调用。
/// - Volta → `<sibling>/volta install <pkg>`
/// - Bun → `<sibling>/bun add -g <pkg>@latest`
/// - Nvm/Fnm/Mise/Homebrew → `<sibling>/npm i -g <pkg>@latest`
/// - 其它 → None（由调用方走 npm 兜底）
fn package_manager_anchored_command_from_paths(
    install: &AgentInstallation,
    npm_package: &str,
) -> Option<String> {
    let sibling_dir = Path::new(&install.real).parent()?;

    match install.source {
        InstallSource::Volta => {
            let bin = sibling_bin_with_ext(sibling_dir, "volta")?;
            Some(format!(
                "{} install {}",
                quote_path(&bin.to_string_lossy()),
                npm_package
            ))
        }
        InstallSource::Bun => {
            let bin = sibling_bin_with_ext(sibling_dir, "bun")?;
            Some(format!(
                "{} add -g {}@latest",
                quote_path(&bin.to_string_lossy()),
                npm_package
            ))
        }
        InstallSource::Nvm | InstallSource::Fnm | InstallSource::Mise | InstallSource::Homebrew => {
            let bin = sibling_bin_with_ext(sibling_dir, "npm")?;
            Some(format!(
                "{} i -g {}@latest",
                quote_path(&bin.to_string_lossy()),
                npm_package
            ))
        }
        InstallSource::Pnpm
        | InstallSource::Scoop
        | InstallSource::System
        | InstallSource::Unknown => None,
    }
}

/// 按优先级生成锚定命令：
/// 1. 官方自升级（claude_code / opencode 用 `<abs_path> update`）
/// 2. 同级包管理器（volta/bun/npm）
/// 3. npm 兜底（返回 None，由调用方退到 static_fallback_command）
fn anchored_command_from_paths(
    spec: AgentSpec,
    install: &AgentInstallation,
    npm_package: &str,
) -> Option<String> {
    // 优先级 1：官方自升级
    if spec.supports_self_update() {
        return Some(format!(
            "{} {}",
            quote_path(&install.real),
            spec.self_update_subcommand()
        ));
    }

    // 优先级 2：同级包管理器
    if let Some(cmd) = package_manager_anchored_command_from_paths(install, npm_package) {
        return Some(cmd);
    }

    // 优先级 3：npm 兜底
    None
}

fn static_fallback_command(npm_package: &str) -> String {
    format!("npm install -g {}@latest", npm_package)
}

/// Windows 平台解码 stderr 字节流：优先 UTF-8，再退到 GBK（中文 Windows 常见 OEM/ANSI codepage），
/// 最后退到 lossy。
fn decode_windows_output(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
    if had_errors {
        String::from_utf8_lossy(bytes).to_string()
    } else {
        decoded.into_owned()
    }
}

/// 静默执行升级命令字符串。
/// - POSIX：`bash -c <cmd>`（强制 bash 避免用户默认 fish/zsh 的 `set -e` 语义差异）
/// - Windows：写临时 `.bat` → `cmd /C` + `CREATE_NO_WINDOW` → 删除 `.bat`
///
/// 返回 `(exit_ok, stderr_text)`。
fn run_upgrade_command(command_str: &str) -> Result<(bool, String), String> {
    #[cfg(target_os = "windows")]
    {
        let mut temp = std::env::temp_dir();
        let file_name = format!("codemux-upgrade-{}.bat", uuid::Uuid::new_v4());
        temp.push(&file_name);

        std::fs::write(&temp, command_str).map_err(|err| format!("写入临时 bat 失败：{}", err))?;

        let mut cmd = Command::new("cmd");
        cmd.args(["/C", &temp.to_string_lossy()]);
        configure_command(&mut cmd);

        let output = cmd
            .output()
            .map_err(|err| format!("启动升级命令失败：{}", err))?;

        let _ = std::fs::remove_file(&temp);

        let stderr_text = decode_windows_output(&output.stderr);
        Ok((output.status.success(), stderr_text))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("bash");
        cmd.args(["-c", command_str]);
        configure_command(&mut cmd);

        let output = cmd
            .output()
            .map_err(|err| format!("启动升级命令失败：{}", err))?;

        let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();
        Ok((output.status.success(), stderr_text))
    }
}

#[tauri::command]
pub async fn check_agent_runtimes() -> AgentRuntimeCheckResult {
    let checked_at = chrono::Local::now().to_rfc3339();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

    // 并发拉取三个 npm 包的最新版本，避免阻塞主线程。
    let mut latest_versions: Vec<Option<String>> = Vec::with_capacity(AGENT_SPECS.len());
    let mut fetch_futures = Vec::with_capacity(AGENT_SPECS.len());
    for spec in AGENT_SPECS {
        let package = spec.npm_package().to_string();
        fetch_futures.push(tokio::spawn(fetch_latest_version(package)));
    }
    for handle in fetch_futures {
        latest_versions.push(handle.await.unwrap_or(None));
    }

    // 阻塞型检测（命令执行、文件系统）放到 spawn_blocking 中运行，
    // 避免卡住 Tauri 的 async 命令线程导致 UI 响应变慢。
    let runtimes = tokio::task::spawn_blocking(move || {
        AGENT_SPECS
            .iter()
            .zip(latest_versions.iter())
            .map(|(spec, latest)| check_single_runtime(*spec, &home, latest.clone()))
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();

    AgentRuntimeCheckResult {
        checked_at,
        runtimes,
    }
}

#[tauri::command]
pub async fn probe_agent_installations(agent_kind: String) -> AgentInstallationReport {
    let kind_for_blocking = agent_kind.clone();
    let report = tokio::task::spawn_blocking(move || -> AgentInstallationReport {
        let spec = match AgentSpec::from_agent_kind(&kind_for_blocking) {
            Some(s) => s,
            None => {
                return AgentInstallationReport {
                    agent_kind: kind_for_blocking,
                    installs: Vec::new(),
                    is_conflict: false,
                    needs_confirmation: false,
                    anchored: false,
                    command: None,
                };
            }
        };
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let command = spec.command();
        let npm_package = spec.npm_package();

        let installs = enumerate_tool_installations(spec.agent_kind(), command, &home);
        let is_conflict = is_conflicting(&installs);
        let needs_confirmation = installs.len() >= 2;

        let (anchored, command_str) = if let Some(install) = default_install_from(&installs) {
            match anchored_command_from_paths(spec, install, npm_package) {
                Some(c) => (true, Some(c)),
                None => (false, Some(static_fallback_command(npm_package))),
            }
        } else {
            (false, Some(static_fallback_command(npm_package)))
        };

        AgentInstallationReport {
            agent_kind: spec.agent_kind().to_string(),
            installs,
            is_conflict,
            needs_confirmation,
            anchored,
            command: command_str,
        }
    })
    .await;

    match report {
        Ok(r) => r,
        Err(_) => AgentInstallationReport {
            agent_kind,
            installs: Vec::new(),
            is_conflict: false,
            needs_confirmation: false,
            anchored: false,
            command: None,
        },
    }
}

#[tauri::command]
pub async fn upgrade_agent_runtime(
    agent_kind: String,
) -> Result<AgentRuntimeUpgradeResult, String> {
    let spec = AgentSpec::from_agent_kind(&agent_kind)
        .ok_or_else(|| format!("不支持的智能体类型：{}", agent_kind))?;

    let npm_package = spec.npm_package().to_string();
    let label = spec.label().to_string();
    let command = spec.command().to_string();
    let version_arg = spec.version_arg().to_string();

    // 内部调用 probe 获取锚定信息（不信任前端回传命令）。
    let probe = probe_agent_installations(agent_kind.clone()).await;

    // 升级前版本（取 PATH 默认那处，否则取首处）。
    let default_install = probe
        .installs
        .iter()
        .find(|i| i.is_path_default)
        .or_else(|| probe.installs.first());

    let current_version = default_install.and_then(|i| i.version.clone());

    // 升级后版本检查用 probe 到的完整路径(Windows 上裸命令名 "opencode" 无法被
    // CreateProcess 解析到 .cmd/.ps1,检测阶段用完整路径所以能成功)。
    // 若 probe 未找到任何安装(理论上不该发生,因 upgrade 已执行),退回裸命令名。
    let version_check_target = default_install
        .map(|i| i.real.clone())
        .unwrap_or_else(|| command.clone());

    // 按 Task 4 优先级生成命令；有锚定用锚定的，否则退 npm 兜底。
    let anchored_cmd = probe
        .command
        .clone()
        .unwrap_or_else(|| static_fallback_command(&npm_package));

    let result =
        tokio::task::spawn_blocking(move || -> Result<AgentRuntimeUpgradeResult, String> {
            let (exit_ok, stderr_text) = match run_upgrade_command(&anchored_cmd) {
                Ok(v) => v,
                Err(err) => {
                    return Ok(AgentRuntimeUpgradeResult {
                        agent_kind,
                        success: false,
                        outcome: UpgradeOutcome::HardFailure,
                        message: format!("{} 升级失败：{}", label, err),
                        new_version: None,
                    });
                }
            };

            // 跑 `--version` 取 new_version。用 probe 到的完整路径,避免 Windows 上
            // Command::new("opencode") 找不到 .cmd/.ps1 导致 soft_not_runnable 误报。
            let new_version = run_version_command(&version_check_target, &version_arg)
                .ok()
                .and_then(|raw| parse_version(&raw));

            let (outcome, success, message) = if !exit_ok {
                let detail = last_n_lines(&stderr_text, 8);
                (
                    UpgradeOutcome::HardFailure,
                    false,
                    format!("{} 升级失败：{}", label, detail),
                )
            } else if new_version.is_none() {
                (
                    UpgradeOutcome::SoftNotRunnable,
                    false,
                    format!("{} 升级命令已执行，但无法运行，请检查安装。", label),
                )
            } else if current_version.is_some()
                && current_version.as_deref() == new_version.as_deref()
            {
                (
                    UpgradeOutcome::SoftVersionUnchanged,
                    false,
                    format!(
                        "{} 升级命令已执行，但版本未变化（{}）。",
                        label,
                        new_version.as_deref().unwrap_or("")
                    ),
                )
            } else {
                (
                    UpgradeOutcome::Success,
                    true,
                    format!(
                        "{} 升级完成，当前版本 {}。",
                        label,
                        new_version.as_deref().unwrap_or("")
                    ),
                )
            };

            Ok(AgentRuntimeUpgradeResult {
                agent_kind,
                success,
                outcome,
                message,
                new_version,
            })
        })
        .await
        .map_err(|err| format!("升级任务执行失败：{}", err))??;

    Ok(result)
}

/// 供前端调用的便利命令：返回用户主目录字符串，便于在 UI 中拼接其它路径。
#[tauri::command]
pub fn get_user_home_directory() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取用户主目录".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_version_with_label_suffix() {
        assert_eq!(
            parse_version("1.0.16 (Claude Code)"),
            Some("1.0.16".to_string())
        );
    }

    #[test]
    fn parses_codex_version_with_command_prefix() {
        assert_eq!(parse_version("codex 0.139.0"), Some("0.139.0".to_string()));
    }

    #[test]
    fn parses_opencode_version_with_label_prefix() {
        assert_eq!(
            parse_version("opencode version 1.18.3"),
            Some("1.18.3".to_string())
        );
    }

    #[test]
    fn parses_bare_version_string() {
        assert_eq!(parse_version("2.34.1"), Some("2.34.1".to_string()));
    }

    #[test]
    fn rejects_non_version_text() {
        assert_eq!(parse_version("not a version string"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn version_lt_compares_semantic_versions() {
        assert!(version_lt("1.0.0", "1.0.1"));
        assert!(version_lt("1.0.0", "1.1.0"));
        assert!(version_lt("1.0.0", "2.0.0"));
        assert!(!version_lt("1.0.0", "1.0.0"));
        assert!(!version_lt("2.0.0", "1.0.0"));
    }

    #[test]
    fn version_lt_handles_non_semantic_input_gracefully() {
        assert!(!version_lt("latest", "1.0.0"));
        assert!(!version_lt("1.0.0", "latest"));
    }

    // ----- Task 1: 三态相关辅助测试 -----

    #[test]
    fn last_n_lines_returns_tail_preserving_order() {
        let text = "line1\nline2\nline3\nline4\nline5";
        assert_eq!(last_n_lines(text, 3), "line3\nline4\nline5");
    }

    #[test]
    fn last_n_lines_returns_all_when_fewer_than_n() {
        let text = "line1\nline2";
        assert_eq!(last_n_lines(text, 8), "line1\nline2");
    }

    #[test]
    fn last_n_lines_handles_empty_text() {
        assert_eq!(last_n_lines("", 8), "");
    }

    // ----- Task 2: infer_install_source 分支覆盖 -----

    #[test]
    fn infer_install_source_detects_nvm() {
        assert_eq!(
            infer_install_source(Path::new(
                "/home/user/.nvm/versions/node/v20.10.0/bin/claude"
            )),
            InstallSource::Nvm
        );
    }

    #[test]
    fn infer_install_source_detects_versions_node() {
        assert_eq!(
            infer_install_source(Path::new("/usr/local/versions/node/v20/bin/claude")),
            InstallSource::Nvm
        );
    }

    #[test]
    fn infer_install_source_detects_homebrew_cellar() {
        assert_eq!(
            infer_install_source(Path::new("/opt/homebrew/Cellar/claude/1.0.16/bin/claude")),
            InstallSource::Homebrew
        );
    }

    #[test]
    fn infer_install_source_detects_homebrew_prefix() {
        assert_eq!(
            infer_install_source(Path::new("/opt/homebrew/bin/claude")),
            InstallSource::Homebrew
        );
    }

    #[test]
    fn infer_install_source_detects_volta() {
        assert_eq!(
            infer_install_source(Path::new("/home/user/.volta/bin/claude")),
            InstallSource::Volta
        );
    }

    #[test]
    fn infer_install_source_detects_fnm() {
        assert_eq!(
            infer_install_source(Path::new(
                "/home/user/.fnm/fnm_multishells/12345/bin/claude"
            )),
            InstallSource::Fnm
        );
    }

    #[test]
    fn infer_install_source_detects_mise() {
        // mise 数据目录默认在 ~/.local/share/mise(XDG)或 $MISE_DATA_DIR
        assert_eq!(
            infer_install_source(Path::new(
                "/home/user/.local/share/mise/installs/node/20.10.0/bin/claude"
            )),
            InstallSource::Mise
        );
    }

    #[test]
    fn infer_install_source_detects_bun() {
        assert_eq!(
            infer_install_source(Path::new("/home/user/.bun/bin/claude")),
            InstallSource::Bun
        );
    }

    #[test]
    fn infer_install_source_detects_pnpm() {
        assert_eq!(
            infer_install_source(Path::new("/home/user/.local/share/pnpm/claude")),
            InstallSource::Pnpm
        );
    }

    #[test]
    fn infer_install_source_detects_scoop() {
        assert_eq!(
            infer_install_source(Path::new("C:/Users/user/scoop/shims/claude.cmd")),
            InstallSource::Scoop
        );
    }

    #[test]
    fn infer_install_source_detects_system_unix() {
        assert_eq!(
            infer_install_source(Path::new("/usr/local/bin/claude")),
            InstallSource::System
        );
    }

    #[test]
    fn infer_install_source_detects_system_windows() {
        assert_eq!(
            infer_install_source(Path::new("C:/Program Files/nodejs/claude.cmd")),
            InstallSource::System
        );
    }

    #[test]
    fn infer_install_source_defaults_to_system_for_custom_path() {
        // 自定义 npm 全局目录(如 D:\nodejs\node_global)不匹配任何包管理器,兜底归为 system
        assert_eq!(
            infer_install_source(Path::new("/home/user/.local/bin/claude")),
            InstallSource::System
        );
    }

    #[test]
    fn infer_install_source_detects_system_windows_custom_npm_global() {
        // Windows 自定义 npm 全局目录(如 D:\nodejs\node_global\claude.cmd)
        assert_eq!(
            infer_install_source(Path::new("D:/nodejs/node_global/claude.cmd")),
            InstallSource::System
        );
    }

    // ----- Task 2: quote_path 测试 -----

    #[test]
    fn quote_path_no_spaces_returns_as_is() {
        assert_eq!(quote_path("/usr/local/bin/claude"), "/usr/local/bin/claude");
    }

    #[test]
    fn quote_path_with_spaces() {
        let path = if cfg!(target_os = "windows") {
            "C:\\Program Files\\nodejs\\npm.cmd"
        } else {
            "/opt/home brew/bin/claude"
        };
        let result = quote_path(path);
        if cfg!(target_os = "windows") {
            assert_eq!(result, format!("\"{}\"", path));
        } else {
            assert_eq!(result, format!("'{}'", path));
        }
    }

    // ----- Task 4: 锚定命令生成测试 -----

    #[test]
    fn static_fallback_command_uses_npm_install() {
        assert_eq!(
            static_fallback_command("@anthropic-ai/claude-code"),
            "npm install -g @anthropic-ai/claude-code@latest"
        );
    }

    fn make_install(real: &str, source: InstallSource, is_path_default: bool) -> AgentInstallation {
        AgentInstallation {
            path: real.to_string(),
            real: real.to_string(),
            version: Some("1.0.0".to_string()),
            runnable: true,
            error: None,
            source,
            is_path_default,
        }
    }

    #[test]
    fn anchored_command_claude_uses_self_update() {
        let install = make_install("/home/user/.local/bin/claude", InstallSource::Unknown, true);
        let cmd = anchored_command_from_paths(
            AgentSpec::ClaudeCode,
            &install,
            "@anthropic-ai/claude-code",
        );
        assert_eq!(cmd.as_deref(), Some("/home/user/.local/bin/claude update"));
    }

    #[test]
    fn anchored_command_opencode_uses_self_upgrade_or_npm_fallback() {
        let install = make_install(
            "/home/user/.opencode/bin/opencode",
            InstallSource::System,
            true,
        );
        let cmd = anchored_command_from_paths(AgentSpec::Opencode, &install, "opencode-ai");
        // POSIX: opencode 支持官方自升级,用 `<path> upgrade`(非 `update`)
        // Windows: opencode 因 anomalyco/opencode#17295 禁用官方 upgrade,
        //          System 来源无包管理器,返回 None 走 npm 兜底
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(
                cmd.as_deref(),
                Some("/home/user/.opencode/bin/opencode upgrade")
            );
        }
        #[cfg(target_os = "windows")]
        {
            assert_eq!(cmd.as_deref(), None);
        }
    }

    #[test]
    fn anchored_command_opencode_posix_uses_self_upgrade() {
        // 回归测试:opencode 在所有平台都应使用 `upgrade` 子命令(非 `update`)
        // 注:supports_self_update 在 Windows 上对 opencode 返回 false,
        // 但 self_update_subcommand 仍应返回 "upgrade"(供 anchored_command 使用)
        assert_eq!(AgentSpec::Opencode.self_update_subcommand(), "upgrade");
        assert_eq!(AgentSpec::ClaudeCode.self_update_subcommand(), "update");
    }

    #[test]
    fn anchored_command_codex_skips_self_update_no_source() {
        // Codex 不支持官方自升级；System/Unknown 来源返回 None。
        let install = make_install("/usr/local/bin/codex", InstallSource::Unknown, true);
        let cmd = anchored_command_from_paths(AgentSpec::Codex, &install, "@openai/codex");
        assert_eq!(cmd, None);
    }

    #[test]
    fn default_install_prefers_path_default() {
        let installs = vec![
            make_install("/a", InstallSource::Unknown, false),
            make_install("/b", InstallSource::Unknown, true),
        ];
        let default = default_install_from(&installs).unwrap();
        assert_eq!(default.real, "/b");
    }

    #[test]
    fn default_install_returns_single_when_no_path_default() {
        let installs = vec![make_install("/a", InstallSource::Unknown, false)];
        let default = default_install_from(&installs).unwrap();
        assert_eq!(default.real, "/a");
    }

    #[test]
    fn default_install_returns_none_when_multiple_no_default() {
        let installs = vec![
            make_install("/a", InstallSource::Unknown, false),
            make_install("/b", InstallSource::Unknown, false),
        ];
        assert!(default_install_from(&installs).is_none());
    }

    // ----- Task 3: is_conflicting 测试 -----

    #[test]
    fn is_conflicting_detects_version_difference() {
        let mut a = make_install("/a", InstallSource::Nvm, true);
        a.version = Some("1.0.0".to_string());
        let mut b = make_install("/b", InstallSource::System, false);
        b.version = Some("1.0.16".to_string());
        assert!(is_conflicting(&[a, b]));
    }

    #[test]
    fn is_conflicting_returns_false_when_same_version_all_runnable() {
        let mut a = make_install("/a", InstallSource::Homebrew, true);
        a.version = Some("1.0.16".to_string());
        let mut b = make_install("/b", InstallSource::Volta, false);
        b.version = Some("1.0.16".to_string());
        assert!(!is_conflicting(&[a, b]));
    }

    #[test]
    fn is_conflicting_detects_runnable_mixed() {
        let mut a = make_install("/a", InstallSource::Homebrew, true);
        a.version = Some("1.0.16".to_string());
        let mut b = make_install("/b", InstallSource::Volta, false);
        b.version = None;
        b.runnable = false;
        b.error = Some("broken".to_string());
        assert!(is_conflicting(&[a, b]));
    }

    #[test]
    fn is_conflicting_returns_false_for_single_install() {
        let a = make_install("/a", InstallSource::Homebrew, true);
        assert!(!is_conflicting(&[a]));
    }

    #[test]
    fn is_conflicting_returns_false_for_empty() {
        assert!(!is_conflicting(&[]));
    }

    #[test]
    fn opencode_config_dir_defaults_to_config_opencode() {
        // 默认(无 XDG_CONFIG_HOME)返回 ~/.config/opencode,跨平台统一
        // 临时清除 XDG_CONFIG_HOME 避免环境干扰(测试后恢复)
        let saved = std::env::var_os("XDG_CONFIG_HOME");
        std::env::remove_var("XDG_CONFIG_HOME");
        let home = Path::new("/home/user");
        let dir = AgentSpec::Opencode.config_dir(home).unwrap();
        // 恢复原值
        if let Some(v) = saved {
            std::env::set_var("XDG_CONFIG_HOME", v);
        }
        assert_eq!(dir, PathBuf::from("/home/user/.config/opencode"));
    }

    #[test]
    fn opencode_config_dir_does_not_return_data_dirs() {
        // 回归测试:OpenCode 配置目录不应返回数据目录(AppData/Local、.local/share)
        // 即使这些目录在文件系统上存在(此处用临时 home 验证路径构造,不依赖真实 FS)
        let home = Path::new("/fake/home/that/does/not/exist");
        let dir = AgentSpec::Opencode.config_dir(home);
        // config_dir 现在无条件返回 Some(~/.config/opencode),不检查存在性
        assert!(dir.is_some());
        let dir = dir.unwrap();
        assert!(dir.ends_with(".config/opencode"));
        // 确保不含数据目录关键字
        let s = dir.to_string_lossy().to_lowercase();
        assert!(
            !s.contains("appdata/local"),
            "不应返回 AppData/Local 数据目录"
        );
        assert!(
            !s.contains(".local/share"),
            "不应返回 .local/share 数据目录"
        );
    }

    #[test]
    fn claude_code_config_dir_returns_claude() {
        let home = Path::new("/home/user");
        assert_eq!(
            AgentSpec::ClaudeCode.config_dir(home),
            Some(PathBuf::from("/home/user/.claude"))
        );
    }
}
