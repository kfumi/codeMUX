//! 官方 npm Runtime 来源与安装实现。
//!
//! Runtime 不再从 CodeMUX 的 GitHub Release 下载。每个 Provider 都从 npm registry
//! 解析版本，并在 CodeMUX 自有 Runtime 目录中执行隔离安装。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::Mutex;

use super::error::RuntimeError;
use super::seam::{FileSystemRuntimeRoots, NodeResolver, ProgressReporter, RuntimeFileSystem};
use super::types::{
    Arch, InstallStage, NodeDetection, Platform, Progress, Provider, RuntimeStatus,
};
/// npm Runtime 安装、升级或修复的结果。
#[derive(Debug, Clone)]
pub struct InstallOutcome {
    pub provider: Provider,
    pub previous_version: Option<String>,
    pub installed_version: String,
    pub install_path: PathBuf,
    pub switched: bool,
}

/// 单个 Provider 的 npm 安装规格。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmRuntimeSpec {
    pub provider: Provider,
    pub version: String,
    pub packages: Vec<String>,
    pub key_files: Vec<String>,
    pub candidate_binaries: Vec<String>,
}

impl NpmRuntimeSpec {
    pub fn for_version(provider: Provider, version: &str) -> Result<Self, RuntimeError> {
        if super::types::SemverVersion::parse(version).is_none() {
            return Err(RuntimeError::manifest_failed(
                Some(provider),
                format!("npm 版本号格式无效：{}", version),
            ));
        }

        let packages = match provider {
            Provider::ClaudeCode => {
                vec![format!("@anthropic-ai/claude-agent-sdk@{}", version)]
            }
            Provider::Codex => vec![format!("@openai/codex@{}", version)],
            Provider::OpenCode => vec![
                format!("@opencode-ai/sdk@{}", version),
                format!("opencode-ai@{}", version),
            ],
            Provider::Pi => vec![format!("@earendil-works/pi-coding-agent@{}", version)],
        };

        let key_files = vec![
            "package.json".to_string(),
            format!("node_modules/{}/package.json", primary_package(provider)),
        ];

        Ok(Self {
            provider,
            version: version.to_string(),
            packages,
            key_files,
            candidate_binaries: candidate_binaries(provider),
        })
    }
}

fn primary_package(provider: Provider) -> &'static str {
    match provider {
        Provider::ClaudeCode => "@anthropic-ai/claude-agent-sdk",
        Provider::Codex => "@openai/codex",
        Provider::OpenCode => "@opencode-ai/sdk",
        // pi 0.74 起发包从 `@mariozechner/pi-coding-agent`（已 deprecated，停更于 0.73.1）
        // 迁移到 `@earendil-works/pi-coding-agent`，CodeMUX 一律从新包安装。
        //
        // 不要回退到旧包名，也不要加「旧包兜底安装」：旧包既没有项目信任机制（会无条件
        // 加载 `<cwd>/.pi/extensions`，等于打开仓库就执行其代码），也没有 0.87 的 RPC 命令面。
        // 迁移过程、入口路径变化与 `--mcp-config` 变成致命参数的原因见
        // `docs/research/2026-09-28-pi-npm-package-migration.md`。
        //
        // 版本在安装时由调用方选定（`NpmRuntimeSpec::for_version`），代码里没有编译期版本
        // 常量可断言；被钉住的是**包名与入口相对路径**（见本文件与 `runtime/resolver.rs`
        // 的 `pi_runtime_*` 测试）。
        Provider::Pi => "@earendil-works/pi-coding-agent",
    }
}

fn candidate_binaries(provider: Provider) -> Vec<String> {
    match provider {
        Provider::ClaudeCode => {
            let platform = match Platform::current() {
                Platform::Windows => "win32",
                Platform::Macos => "darwin",
                Platform::Linux => "linux",
            };
            let arch = match Arch::current() {
                Arch::X64 => "x64",
                Arch::Arm64 => "arm64",
            };
            let binary = if cfg!(target_os = "windows") {
                "claude.exe"
            } else {
                "claude"
            };
            vec![format!(
                "node_modules/@anthropic-ai/claude-agent-sdk-{}-{}/{}",
                platform, arch, binary
            )]
        }
        // `@openai/codex` 元包通过 npm alias（如 `@openai/codex-win32-x64` →
        // `npm:@openai/codex@<version>-win32-x64`）分发平台二进制。alias 可能被
        // npm 提升到顶层 node_modules，也可能嵌套在元包内；元包自身亦内置
        // `vendor/<triple>/<binary>` 兜底布局。任一存在即视为完整。
        //
        // vendor 下的目录名有历史包袱：0.146 起二进制在 `bin/`，更早版本在 `codex/`。
        // **两种都必须接受**，且必须与 sidecar `runtimeLoader.ts` 的 `vendorLayouts`
        // 保持一致 —— 之前这里只认 `codex/`，于是 0.146 之后每一次 Codex 安装都会在
        // 校验环节被判「缺少平台二进制」并删掉装好的目录，而 sidecar 明明能正常启动它。
        Provider::Codex => {
            let platform = match Platform::current() {
                Platform::Windows => "win32",
                Platform::Macos => "darwin",
                Platform::Linux => "linux",
            };
            let arch = match Arch::current() {
                Arch::X64 => "x64",
                Arch::Arm64 => "arm64",
            };
            let binary = if cfg!(target_os = "windows") {
                "codex.exe"
            } else {
                "codex"
            };
            let target_triple = match (Platform::current(), Arch::current()) {
                (Platform::Windows, Arch::X64) => "x86_64-pc-windows-msvc",
                (Platform::Windows, Arch::Arm64) => "aarch64-pc-windows-msvc",
                (Platform::Macos, Arch::X64) => "x86_64-apple-darwin",
                (Platform::Macos, Arch::Arm64) => "aarch64-apple-darwin",
                (Platform::Linux, Arch::X64) => "x86_64-unknown-linux-musl",
                (Platform::Linux, Arch::Arm64) => "aarch64-unknown-linux-musl",
            };
            let platform_package = format!("@openai/codex-{}-{}", platform, arch);
            let roots = [
                // alias 被 npm 提升到顶层（实测 0.146.1 / 0.158.0 都是这个布局）。
                format!("node_modules/{}", platform_package),
                format!(
                    "node_modules/@openai/codex/node_modules/{}",
                    platform_package
                ),
                "node_modules/@openai/codex".to_string(),
            ];
            roots
                .iter()
                // 新布局 `bin` 排前面，让常见情况先命中。
                .flat_map(|root| {
                    ["bin", "codex"]
                        .iter()
                        .map(move |dir| format!("{root}/vendor/{target_triple}/{dir}/{binary}"))
                })
                .collect()
        }
        Provider::OpenCode => {
            let binary = if cfg!(target_os = "windows") {
                "opencode.exe"
            } else {
                "opencode"
            };
            vec![format!("node_modules/opencode-ai/bin/{}", binary)]
        }
        // `@earendil-works/pi-coding-agent` 是纯 Node 包：bin 入口为 bun bundle 的
        // `dist/bundle/cli.js`（无平台二进制），以该文件作为关键完整性凭证。
        // 运行时由 sidecar 以其自身 node 进程启动。
        // 注意不是 `@earendil-works/pi`——那不是 pi coding agent 的包。
        Provider::Pi => {
            vec!["node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js".to_string()]
        }
    }
}

/// 通过 npm CLI 查询官方 registry。使用 npm CLI 而不是硬编码 HTTP registry，
/// 这样用户配置的镜像、代理和认证方式都能自然生效。
#[derive(Debug, Clone, Default)]
pub struct NpmRuntimeSource;

impl NpmRuntimeSource {
    pub fn new() -> Self {
        Self
    }

    pub async fn latest(&self, provider: Provider) -> Result<NpmRuntimeSpec, RuntimeError> {
        let package = primary_package(provider).to_string();
        let output = run_npm(
            vec!["view".into(), package, "version".into(), "--json".into()],
            provider,
        )
        .await?;
        let version = parse_npm_string(&output).ok_or_else(|| {
            RuntimeError::manifest_failed(
                Some(provider),
                format!("npm 未返回 {} 的最新版本", provider.label()),
            )
        })?;
        NpmRuntimeSpec::for_version(provider, &version)
    }

    pub async fn versions(&self, provider: Provider) -> Result<Vec<String>, RuntimeError> {
        let package = primary_package(provider).to_string();
        let output = run_npm(
            vec!["view".into(), package, "versions".into(), "--json".into()],
            provider,
        )
        .await?;
        let mut versions = parse_npm_versions(&output).ok_or_else(|| {
            RuntimeError::manifest_failed(
                Some(provider),
                format!("解析 {} 的 npm 版本列表失败", provider.label()),
            )
        })?;
        // npm 的 versions 列表包含 beta、rc 等预发布版本；Runtime 设置页只展示稳定版。
        versions.retain(|v| is_stable_version(v));
        versions.sort_by(|a, b| compare_versions(b, a));
        versions.dedup();
        Ok(versions)
    }

    pub async fn version(
        &self,
        provider: Provider,
        version: &str,
    ) -> Result<NpmRuntimeSpec, RuntimeError> {
        let spec = NpmRuntimeSpec::for_version(provider, version)?;
        let package = primary_package(provider).to_string();
        let output = run_npm(
            vec![
                "view".into(),
                format!("{}@{}", package, version),
                "version".into(),
                "--json".into(),
            ],
            provider,
        )
        .await?;
        let resolved = parse_npm_string(&output).ok_or_else(|| {
            RuntimeError::manifest_failed(
                Some(provider),
                format!("npm 中不存在 {} 版本 {}", provider.label(), version),
            )
        })?;
        if resolved != version {
            return Err(RuntimeError::manifest_failed(
                Some(provider),
                format!("npm 返回版本 {}，与请求的 {} 不一致", resolved, version),
            ));
        }
        Ok(spec)
    }
}

/// npm 安装器。所有包都安装到指定 Runtime 版本目录，不污染 sidecar 或全局 npm。
#[derive(Debug, Clone, Default)]
pub struct NpmRuntimeInstaller;

impl NpmRuntimeInstaller {
    pub fn new() -> Self {
        Self
    }

    pub async fn install(
        &self,
        spec: &NpmRuntimeSpec,
        destination: &Path,
        progress: &dyn ProgressReporter,
    ) -> Result<(), RuntimeError> {
        let provider = spec.provider;
        let base_message = format!("正在从 npm 安装 {} {}", spec.provider.label(), spec.version);
        progress
            .report(Progress::new(InstallStage::Downloading).with_message(base_message.clone()))
            .await;

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<InstallStep>();
        let spec = spec.clone();
        let destination = destination.to_path_buf();
        let install = tokio::task::spawn_blocking(move || install_sync(&spec, &destination, &tx));

        // npm 没有可用的百分比接口，唯一真实的信号是它自己输出的逐包 fetch 行。
        // 这里刻意**不**填 percent：编造的百分比比"未知"更糟，前端会把它画成一条
        // 永远停在低位的进度条，看起来就像卡死了。缺 percent 时前端走不确定态。
        let mut last_sent = Instant::now();
        let mut pending: Option<InstallStep> = None;
        while let Some(step) = rx.recv().await {
            // 一次安装能刷出几百行 fetch，按固定节奏节流，避免刷爆 UI 事件通道。
            if step.done == 1 || last_sent.elapsed() >= PROGRESS_THROTTLE {
                progress
                    .report(
                        Progress::new(InstallStage::Downloading)
                            .with_message(step.describe(&base_message)),
                    )
                    .await;
                last_sent = Instant::now();
                pending = None;
            } else {
                pending = Some(step);
            }
        }
        // 补发最后一步，否则收尾时的最终计数会永远停在上一条节流消息上。
        if let Some(step) = pending {
            progress
                .report(
                    Progress::new(InstallStage::Downloading)
                        .with_message(step.describe(&base_message)),
                )
                .await;
        }

        install.await.map_err(|e| {
            RuntimeError::download_failed(Some(provider), format!("npm 安装任务异常：{}", e))
        })?
    }
}

/// npm 安装过程中的一次真实进展，对应一条 `npm http fetch` 输出。
#[derive(Debug, Clone)]
struct InstallStep {
    /// 已完成的下载步骤数。
    done: u64,
    /// 最近一次下载的包名，让"还在动"这件事对用户可见。
    label: Option<String>,
}

impl InstallStep {
    /// 拼成面向用户的一行消息，保留"正在从 npm 安装 X"这个主语。
    fn describe(&self, base: &str) -> String {
        match &self.label {
            Some(label) => format!("{base} · 已获取 {} 个依赖（{label}）", self.done),
            None => format!("{base} · 已获取 {} 个依赖", self.done),
        }
    }
}

/// 进度事件的最小转发间隔。npm 的 fetch 行来得很快，人眼和 UI 都不需要那么密。
const PROGRESS_THROTTLE: Duration = Duration::from_millis(400);

/// 解析一行 npm 输出，判断它是否代表一次可展示的下载进展。`done` 是当前已完成数。
///
/// npm 把 `--loglevel=http` 的逐包行写在 **stderr**（不是 stdout），实测有三种形态：
///
/// ```text
/// npm http fetch GET 200 https://registry.example.com/tiny-invariant 119ms (cache miss)
/// npm http cache tiny-invariant@https://…/tiny-invariant-1.3.3.tgz 0ms (cache hit)
/// npm http cache https://registry.example.com/is-number 20ms (cache hit)
/// ```
///
/// 所以 `fetch` / `cache` 都算一步，且包名要能从 `name@url` 前缀或任意镜像/registry
/// 的 URL 里取出来。`warn`、`notice`、空行都是噪音，当成进度会让计数虚高。
fn parse_install_progress_line(line: &str, done: u64) -> Option<InstallStep> {
    let rest = line.trim().strip_prefix("npm http ")?;
    // 不能按空格切词找 URL：`cache <name>@<url>` 形式里 token 是 `name@https://…`，
    // 并不以 `https://` 开头，按 token 匹配会把整行丢掉。
    let url_at = rest.find("https://")?;
    let prefix = &rest[..url_at];
    let url = rest[url_at..].split_whitespace().next()?;
    // tarball 命中缓存时 npm 会写成 `<name>@<url>`，这个包名比从 URL 反推可靠。
    // 末位 token 必须以 `@` 结尾才能当成包名，否则 `cache`（npm 自己的动词）和
    // `GET 200`（动作与状态码）会被误读成包名。
    let label = prefix
        .split_whitespace()
        .last()
        .filter(|token| token.ends_with('@'))
        .map(|token| token.trim_end_matches('@'))
        .filter(|name| !name.is_empty() && !name.starts_with(|c: char| c.is_ascii_digit()))
        .map(ToOwned::to_owned)
        .or_else(|| package_label_from_url(url));
    Some(InstallStep {
        done: done + 1,
        label: Some(label.unwrap_or_else(|| "依赖包".to_string())),
    })
}

/// 从任意 registry / 镜像的 URL 里反推包名。npm 默认源、npmmirror、私有源 URL 形态
/// 都不同，逐一匹配不现实，所以按可靠性从高到低试几种启发式。
fn package_label_from_url(url: &str) -> Option<String> {
    let path = url
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/'))
        .map(|(_, rest)| rest)?
        .split('?')
        .next()?;

    // 1) registry tarball 的标准形态：`<name>/-/<file>.tgz`，scope 也在这里面。
    if let Some((name, _)) = path.split_once("/-/") {
        let name = name.trim_matches('/');
        if !name.is_empty() {
            // scoped 包的 packument URL 把 `/` 编码成了 %2f。
            return Some(name.replace("%2f", "/").replace("%2F", "/"));
        }
    }

    // 2) packument 元数据：路径只有一段，那一段就是包名。
    //    必须限定"只有一段"——CDN 直链首段是 `packages`，当成包名会误导用户。
    if !path.contains('/') {
        let name = path.trim_matches('/');
        if !name.is_empty() {
            return Some(name.replace("%2f", "/").replace("%2F", "/"));
        }
    }

    // 3) CDN 直链：`/packages/<name>/<version>/<name>-<version>.tgz`，只能靠文件名反推。
    let file = path.rsplit('/').next()?;
    if !file.ends_with(".tgz") {
        return None;
    }
    let name = strip_trailing_version(file.trim_end_matches(".tgz"));
    (!name.is_empty()).then(|| name.to_string())
}

/// 去掉文件名尾部的版本号（`tiny-invariant-1.3.3-beta.1` → `tiny-invariant`）。
/// 包名本身可能带连字符，所以要从右往左找**最后一个**后面跟数字的连字符。
fn strip_trailing_version(stem: &str) -> &str {
    stem.char_indices()
        .rev()
        .find(|(_, ch)| *ch == '-')
        .filter(|(index, _)| stem[index + 1..].starts_with(|c: char| c.is_ascii_digit()))
        .map(|(index, _)| &stem[..index])
        .unwrap_or(stem)
}

/// 保留 stdout 末尾的少量有效行，供失败时给出可读上下文。
fn push_tail_line(tail: &mut Vec<String>, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("npm http ") {
        return;
    }
    tail.push(trimmed.to_string());
    if tail.len() > 8 {
        tail.remove(0);
    }
}

/// 合并 stderr 与 stdout 尾部，滤掉 http 噪音，只留下对用户有用的最后若干行。
fn failure_tail(stderr_tail: &[String], stdout_tail: &[String]) -> String {
    let lines: Vec<&str> = stderr_tail
        .iter()
        .chain(stdout_tail.iter())
        .map(String::as_str)
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("npm http "))
        .collect();
    if lines.is_empty() {
        return "npm 未输出错误详情".to_string();
    }
    let start = lines.len().saturating_sub(12);
    lines[start..].join("\n")
}

fn install_sync(
    spec: &NpmRuntimeSpec,
    destination: &Path,
    steps: &tokio::sync::mpsc::UnboundedSender<InstallStep>,
) -> Result<(), RuntimeError> {
    std::fs::create_dir_all(destination).map_err(|e| {
        RuntimeError::io_failed(
            Some(spec.provider),
            format!("无法创建 Runtime 目录 {}：{}", destination.display(), e),
        )
    })?;

    let package_json = serde_json::json!({
        "name": format!("codemux-runtime-{}", spec.provider.as_str()),
        "private": true,
        "version": "0.0.0",
        "dependencies": spec.packages.iter().map(|package| {
            let (name, version) = package.rsplit_once('@').unwrap_or((package.as_str(), "latest"));
            (name.to_string(), version.to_string())
        }).collect::<std::collections::BTreeMap<_, _>>(),
    });
    std::fs::write(
        destination.join("package.json"),
        serde_json::to_vec_pretty(&package_json).unwrap(),
    )
    .map_err(|e| {
        RuntimeError::io_failed(
            Some(spec.provider),
            format!("无法写入 npm package.json：{}", e),
        )
    })?;

    let mut command = Command::new(npm_command());
    command
        .arg("install")
        .arg("--prefix")
        .arg(destination)
        .arg("--include=optional")
        .arg("--no-audit")
        .arg("--no-fund")
        // 只有 http 级别日志才有逐包的 fetch 行，是 npm 唯一可用的实时进度信号。
        .arg("--loglevel=http")
        .current_dir(destination)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_command(&mut command);
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            RuntimeError::node_unavailable(
                "未找到 npm，请安装 Node.js 18+（npm 应随 Node.js 一起安装）",
            )
        } else {
            RuntimeError::download_failed(Some(spec.provider), format!("启动 npm 失败：{}", e))
        }
    })?;

    // stderr 才是进度信号的来源（npm 把 --loglevel=http 的逐包行写在这里），
    // 所以由当前线程逐行解析；stdout 另起线程排空 —— 两条管道都必须有人读，
    // 写满 64KB 后 npm 会直接阻塞。
    let stdout = child.stdout.take().expect("stdout 已配置为 piped");
    let stdout_tail = Arc::new(StdMutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&stdout_tail);
    let stdout_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let mut tail = match sink.lock() {
                Ok(guard) => guard,
                // 拿不到锁说明主流程已经结束，没必要再收集。
                Err(_) => return,
            };
            push_tail_line(&mut tail, &line);
        }
    });

    let stderr = child.stderr.take().expect("stderr 已配置为 piped");
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    let mut stderr_tail: Vec<String> = Vec::new();
    let mut done = 0u64;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        match parse_install_progress_line(&line, done) {
            Some(step) => {
                done = step.done;
                let _ = steps.send(step);
            }
            // 顺带留一份非 http 的尾部，安装失败时用来解释原因。
            None => push_tail_line(&mut stderr_tail, &line),
        }
    }

    let status = child.wait().map_err(|e| {
        RuntimeError::download_failed(Some(spec.provider), format!("等待 npm 进程结束失败：{}", e))
    })?;
    let _ = stdout_thread.join();

    if !status.success() {
        let stdout_lines = stdout_tail
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        return Err(RuntimeError::download_failed(
            Some(spec.provider),
            format!(
                "npm 安装失败（退出码 {}）：{}",
                status.code().unwrap_or(-1),
                failure_tail(&stderr_tail, &stdout_lines)
            ),
        ));
    }
    Ok(())
}

fn npm_command() -> &'static str {
    if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn configure_hidden_command(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    // unix 上函数体为空,不消费参数会报 unused_variables。
    #[cfg(not(target_os = "windows"))]
    let _ = command;
}

async fn run_npm(args: Vec<String>, provider: Provider) -> Result<String, RuntimeError> {
    tokio::task::spawn_blocking(move || {
        let mut command = Command::new(npm_command());
        command.args(args);
        configure_hidden_command(&mut command);
        let output = command.output().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                RuntimeError::node_unavailable(
                    "未找到 npm，请安装 Node.js 18+（npm 应随 Node.js 一起安装）",
                )
            } else {
                RuntimeError::manifest_failed(Some(provider), format!("启动 npm 失败：{}", e))
            }
        })?;
        if !output.status.success() {
            return Err(RuntimeError::manifest_failed(
                Some(provider),
                format!(
                    "npm registry 请求失败（退出码 {}）：{}",
                    output.status.code().unwrap_or(-1),
                    tail_output(&output)
                ),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|e| {
        RuntimeError::manifest_failed(Some(provider), format!("npm 查询任务异常：{}", e))
    })?
}

fn parse_npm_string(output: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<String>(output) {
        return Some(value.trim().to_string());
    }
    output
        .lines()
        .last()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_npm_versions(output: &str) -> Option<Vec<String>> {
    let value = serde_json::from_str::<serde_json::Value>(output).ok()?;
    match value {
        serde_json::Value::Array(values) => Some(
            values
                .into_iter()
                .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                .collect(),
        ),
        serde_json::Value::String(version) => Some(vec![version]),
        _ => None,
    }
}

fn tail_output(output: &std::process::Output) -> String {
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(12);
    lines[start..].join("\n")
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parsed = super::types::SemverVersion::parse(left);
    let right_parsed = super::types::SemverVersion::parse(right);
    match (left_parsed, right_parsed) {
        (Some(a), Some(b)) => (a.major, a.minor, a.patch).cmp(&(b.major, b.minor, b.patch)),
        _ => left.cmp(right),
    }
}

fn is_stable_version(value: &str) -> bool {
    super::types::SemverVersion::parse(value).is_some() && !value.contains('-')
}

/// npm 版 Runtime Manager。保留现有 Runtime 目录和 current 指针生命周期，
/// 但将“下载 Pack”替换为“在目标目录执行 npm install”。
pub struct NpmRuntimeManager<
    S = NpmRuntimeSource,
    I = NpmRuntimeInstaller,
    N = super::infra::SystemNodeResolver,
    F = FileSystemRuntimeRoots,
> {
    pub(crate) source: Arc<S>,
    pub(crate) installer: Arc<I>,
    pub(crate) node_resolver: Arc<N>,
    pub(crate) fs: Arc<F>,
    pub(crate) sidecar_version: String,
    pub(crate) locks: Mutex<std::collections::HashMap<Provider, Arc<Mutex<()>>>>,
    pub(crate) keep_old_versions: usize,
}

#[derive(Debug, Clone)]
pub struct NpmRuntimeStatusInfo {
    pub provider: Provider,
    pub status: RuntimeStatus,
    pub current_version: Option<String>,
    pub install_path: Option<PathBuf>,
    pub latest_version: Option<String>,
    pub available_versions: Vec<String>,
    pub node: NodeDetection,
    pub integrity_ok: bool,
}

impl
    NpmRuntimeManager<
        NpmRuntimeSource,
        NpmRuntimeInstaller,
        super::infra::SystemNodeResolver,
        FileSystemRuntimeRoots,
    >
{
    pub fn production(root: PathBuf, sidecar_version: impl Into<String>) -> Self {
        Self::new(
            Arc::new(NpmRuntimeSource::new()),
            Arc::new(NpmRuntimeInstaller::new()),
            Arc::new(super::infra::SystemNodeResolver::new()),
            Arc::new(FileSystemRuntimeRoots::new(root)),
            sidecar_version,
        )
    }
}

impl<S, I, N, F> NpmRuntimeManager<S, I, N, F>
where
    S: NpmSource + 'static,
    I: NpmInstaller + 'static,
    N: NodeResolver + 'static,
    F: RuntimeFileSystem + 'static,
{
    pub fn new(
        source: Arc<S>,
        installer: Arc<I>,
        node_resolver: Arc<N>,
        fs: Arc<F>,
        sidecar_version: impl Into<String>,
    ) -> Self {
        Self {
            source,
            installer,
            node_resolver,
            fs,
            sidecar_version: sidecar_version.into(),
            locks: Mutex::new(std::collections::HashMap::new()),
            keep_old_versions: 0,
        }
    }

    pub fn with_keep_old_versions(mut self, count: usize) -> Self {
        self.keep_old_versions = count;
        self
    }

    pub async fn list_available_versions(
        &self,
        provider: Provider,
    ) -> Result<Vec<String>, RuntimeError> {
        self.source.list_versions(provider).await
    }

    pub async fn check_status(
        &self,
        provider: Provider,
    ) -> Result<NpmRuntimeStatusInfo, RuntimeError> {
        let node = self.node_resolver.detect().await;
        if !node.satisfies_minimum {
            return Ok(NpmRuntimeStatusInfo {
                provider,
                status: RuntimeStatus::NodeUnavailable,
                current_version: None,
                install_path: None,
                latest_version: None,
                available_versions: Vec::new(),
                node,
                integrity_ok: false,
            });
        }

        let versions = self
            .source
            .list_versions(provider)
            .await
            .unwrap_or_default();
        let latest_version = versions.first().cloned();
        let current_version = self.fs.read_current_version(provider);
        let install_path = current_version
            .as_ref()
            .map(|version| self.fs.version_dir(provider, version));
        let integrity_ok = current_version
            .as_deref()
            .map(|version| self.verify_integrity(provider, version))
            .unwrap_or(false);
        let status = match (&current_version, integrity_ok) {
            (None, _) => RuntimeStatus::Missing,
            (Some(_), false) => RuntimeStatus::Corrupted,
            (Some(current), true)
                if latest_version
                    .as_deref()
                    .is_some_and(|latest| is_newer(latest, current)) =>
            {
                RuntimeStatus::Outdated
            }
            (Some(_), true) => RuntimeStatus::Ready,
        };
        // 已安装的 pi >= 0.75 在 Node < 22.19 的机器上无法运行：宁可亮红灯
        //（Node 不可用），也不显示绿灯“已就绪”。未安装时保持 Missing，
        // 安装按钮走 install_spec 的门禁报错指引。
        let status = match (&status, &current_version) {
            (RuntimeStatus::Ready | RuntimeStatus::Outdated, Some(current))
                if provider == Provider::Pi
                    && super::types::pi_requires_node_22(current)
                    && !node.satisfies_pi_runtime(current) =>
            {
                RuntimeStatus::NodeUnavailable
            }
            _ => status,
        };

        Ok(NpmRuntimeStatusInfo {
            provider,
            status,
            current_version,
            install_path,
            latest_version,
            available_versions: versions,
            node,
            integrity_ok,
        })
    }

    pub async fn install(
        &self,
        provider: Provider,
        progress: &dyn ProgressReporter,
    ) -> Result<InstallOutcome, RuntimeError> {
        let spec = self.source.latest(provider).await?;
        self.install_spec(spec, progress).await
    }

    pub async fn install_version(
        &self,
        provider: Provider,
        version: &str,
        progress: &dyn ProgressReporter,
    ) -> Result<InstallOutcome, RuntimeError> {
        let spec = self.source.version(provider, version).await?;
        self.install_spec(spec, progress).await
    }

    pub async fn upgrade(
        &self,
        provider: Provider,
        progress: &dyn ProgressReporter,
    ) -> Result<Option<InstallOutcome>, RuntimeError> {
        let spec = self.source.latest(provider).await?;
        if self.fs.read_current_version(provider).as_deref() == Some(spec.version.as_str())
            && self.verify_integrity(provider, &spec.version)
        {
            progress
                .report(Progress::new(InstallStage::Done).with_message(format!(
                    "{} 已是最新版本 {}",
                    provider.label(),
                    spec.version
                )))
                .await;
            return Ok(None);
        }
        self.install_spec(spec, progress).await.map(Some)
    }

    pub async fn repair(
        &self,
        provider: Provider,
        progress: &dyn ProgressReporter,
    ) -> Result<Option<InstallOutcome>, RuntimeError> {
        if let Some(version) = self.fs.read_current_version(provider) {
            if self.verify_integrity(provider, &version) {
                progress
                    .report(Progress::new(InstallStage::Done).with_message(format!(
                        "{} {} 完整性正常，无需修复",
                        provider.label(),
                        version
                    )))
                    .await;
                return Ok(None);
            }
            let spec = NpmRuntimeSpec::for_version(provider, &version)?;
            return self.install_spec(spec, progress).await.map(Some);
        }
        self.install(provider, progress).await.map(Some)
    }

    pub async fn remove(&self, provider: Provider) -> Result<(), RuntimeError> {
        let _guard = self.acquire_lock(provider).await?;
        self.fs.remove_provider(provider)
    }

    fn verify_integrity(&self, provider: Provider, version: &str) -> bool {
        let dir = self.fs.version_dir(provider, version);
        let Ok(spec) = NpmRuntimeSpec::for_version(provider, version) else {
            return false;
        };
        self.verify_integrity_at(&spec, &dir)
    }

    fn verify_integrity_at(&self, spec: &NpmRuntimeSpec, dir: &Path) -> bool {
        if !spec.key_files.iter().all(|file| dir.join(file).exists()) {
            return false;
        }
        // candidate_binaries 为同一 CLI 的候选安装布局（npm alias 提升或嵌套）；
        // 任一存在即通过。单一路径的 Provider 语义不变。
        if !spec.candidate_binaries.is_empty()
            && !spec
                .candidate_binaries
                .iter()
                .any(|file| dir.join(file).exists())
        {
            return false;
        }
        std::fs::read_to_string(dir.join(format!(
            "node_modules/{}/package.json",
            primary_package(spec.provider)
        )))
        .ok()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .and_then(|json| {
            json.get("version")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned)
        })
        .is_some_and(|installed| installed == spec.version)
    }

    async fn install_spec(
        &self,
        spec: NpmRuntimeSpec,
        progress: &dyn ProgressReporter,
    ) -> Result<InstallOutcome, RuntimeError> {
        let _guard = self.acquire_lock(spec.provider).await?;
        let node = self.node_resolver.detect().await;
        // pi >= 0.75.0 起 engines 要求 Node >= 22.19：全局 Node 18 门槛拦不住，
        // 这里按目标版本二次校验，不满足时指引升级 Node 或改装 legacy-node20 的 0.74.2。
        if spec.provider == Provider::Pi
            && super::types::pi_requires_node_22(&spec.version)
            && !node.satisfies_pi_runtime(&spec.version)
        {
            return Err(RuntimeError::new(
                crate::runtime::RuntimeErrorKind::NodeUnavailable,
                Some(Provider::Pi),
                None,
                format!(
                    "pi {} 需要 Node.js 22.19+（当前 Node：{}），请升级 Node 后重试；仍在用 Node 20 可改装 legacy-node20 通道的 0.74.2",
                    spec.version,
                    node.version.as_deref().unwrap_or("未知")
                ),
            ));
        }
        if !node.satisfies_minimum {
            return Err(RuntimeError::node_unavailable(format!(
                "Node.js 不可用或版本低于 18：{}",
                node.error.unwrap_or_else(|| "未知原因".to_string())
            )));
        }
        let previous_version = self.fs.read_current_version(spec.provider);
        let version_dir = self.fs.version_dir(spec.provider, &spec.version);
        let parent = version_dir.parent().ok_or_else(|| {
            RuntimeError::io_failed(
                Some(spec.provider),
                format!("Runtime 版本目录无有效父目录：{}", version_dir.display()),
            )
        })?;
        std::fs::create_dir_all(parent).map_err(|e| {
            RuntimeError::io_failed(Some(spec.provider), format!("无法创建 Runtime 目录：{}", e))
        })?;

        // npm 安装必须落在同一文件系统的临时目录。只有完整性校验通过后，
        // 才把它原子替换到版本目录，避免网络/安装失败破坏当前 Runtime。
        let staging_dir = create_staging_dir(parent, &spec.version, spec.provider)?;
        let install_result = self.installer.install(&spec, &staging_dir, progress).await;
        if let Err(error) = install_result {
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(error);
        }
        progress
            .report(
                Progress::new(InstallStage::VerifyingIntegrity)
                    .with_message("正在校验 npm Runtime 文件和二进制"),
            )
            .await;
        if !self.verify_integrity_at(&spec, &staging_dir) {
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(RuntimeError::integrity_failed(
                Some(spec.provider),
                "npm Runtime 缺少必要文件、平台二进制或版本不匹配",
            ));
        }

        let backup_dir = if version_dir.exists() {
            let backup = create_backup_path(parent, &spec.version, spec.provider)?;
            if let Err(error) = std::fs::rename(&version_dir, &backup) {
                let _ = std::fs::remove_dir_all(&staging_dir);
                return Err(RuntimeError::io_failed(
                    Some(spec.provider),
                    format!("无法暂存旧 Runtime {}：{}", version_dir.display(), error),
                ));
            }
            Some(backup)
        } else {
            None
        };

        if let Err(error) = std::fs::rename(&staging_dir, &version_dir) {
            let _ = std::fs::remove_dir_all(&staging_dir);
            if let Some(backup) = backup_dir.as_ref() {
                let _ = std::fs::rename(backup, &version_dir);
            }
            return Err(RuntimeError::io_failed(
                Some(spec.provider),
                format!("无法切换 npm Runtime 目录：{}", error),
            ));
        }

        progress
            .report(
                Progress::new(InstallStage::Switching)
                    .with_message(format!("正在切换到版本 {}", spec.version)),
            )
            .await;
        if let Err(error) = self.fs.write_current_version(spec.provider, &spec.version) {
            if let Err(rollback) = restore_replaced_version(
                self.fs.as_ref(),
                spec.provider,
                &spec.version,
                previous_version.as_deref(),
                backup_dir.as_deref(),
            ) {
                return Err(RuntimeError::rollback_failed(
                    Some(spec.provider),
                    format!(
                        "写入 current 指针失败：{}；旧 Runtime 恢复失败：{}",
                        error, rollback
                    ),
                ));
            }
            return Err(error);
        }
        if self.fs.read_current_version(spec.provider).as_deref() != Some(spec.version.as_str()) {
            if let Err(rollback) = restore_replaced_version(
                self.fs.as_ref(),
                spec.provider,
                &spec.version,
                previous_version.as_deref(),
                backup_dir.as_deref(),
            ) {
                return Err(RuntimeError::rollback_failed(
                    Some(spec.provider),
                    format!(
                        "切换 Runtime 版本指针失败；旧 Runtime 恢复失败：{}",
                        rollback
                    ),
                ));
            }
            return Err(RuntimeError::rollback_failed(
                Some(spec.provider),
                "切换 Runtime 版本指针失败",
            ));
        }
        if let Some(backup) = backup_dir {
            let _ = std::fs::remove_dir_all(backup);
        }
        let switched = previous_version.as_deref() != Some(spec.version.as_str());
        self.cleanup_old_versions(spec.provider);
        progress
            .report(Progress::new(InstallStage::Done).with_message(format!(
                "{} {} 安装完成",
                spec.provider.label(),
                spec.version
            )))
            .await;
        Ok(InstallOutcome {
            provider: spec.provider,
            previous_version,
            installed_version: spec.version,
            install_path: version_dir,
            switched,
        })
    }

    fn cleanup_old_versions(&self, provider: Provider) {
        let Some(current) = self.fs.read_current_version(provider) else {
            return;
        };
        let mut versions = self.fs.list_installed_versions(provider);
        versions.retain(|version| version != &current);
        versions.sort_by(|a, b| compare_versions(b, a));
        for version in versions.into_iter().skip(self.keep_old_versions) {
            let _ = self.fs.remove_version(provider, &version);
        }
    }

    async fn acquire_lock(
        &self,
        provider: Provider,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, RuntimeError> {
        let lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(provider)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        lock.try_lock_owned()
            .map_err(|_| RuntimeError::busy(provider))
    }
}

#[async_trait]
pub trait NpmSource: Send + Sync {
    async fn latest(&self, provider: Provider) -> Result<NpmRuntimeSpec, RuntimeError>;
    async fn versions(&self, provider: Provider) -> Result<Vec<String>, RuntimeError>;
    async fn version(
        &self,
        provider: Provider,
        version: &str,
    ) -> Result<NpmRuntimeSpec, RuntimeError>;
    async fn list_versions(&self, provider: Provider) -> Result<Vec<String>, RuntimeError> {
        self.versions(provider).await
    }
}

#[async_trait]
impl NpmSource for NpmRuntimeSource {
    async fn latest(&self, provider: Provider) -> Result<NpmRuntimeSpec, RuntimeError> {
        self.latest(provider).await
    }
    async fn versions(&self, provider: Provider) -> Result<Vec<String>, RuntimeError> {
        self.versions(provider).await
    }
    async fn version(
        &self,
        provider: Provider,
        version: &str,
    ) -> Result<NpmRuntimeSpec, RuntimeError> {
        self.version(provider, version).await
    }
}

#[async_trait]
pub trait NpmInstaller: Send + Sync {
    async fn install(
        &self,
        spec: &NpmRuntimeSpec,
        destination: &Path,
        progress: &dyn ProgressReporter,
    ) -> Result<(), RuntimeError>;
}

#[async_trait]
impl NpmInstaller for NpmRuntimeInstaller {
    async fn install(
        &self,
        spec: &NpmRuntimeSpec,
        destination: &Path,
        progress: &dyn ProgressReporter,
    ) -> Result<(), RuntimeError> {
        NpmRuntimeInstaller::install(self, spec, destination, progress).await
    }
}

fn is_newer(candidate: &str, current: &str) -> bool {
    compare_versions(candidate, current) == std::cmp::Ordering::Greater
}

fn create_staging_dir(
    parent: &Path,
    version: &str,
    provider: Provider,
) -> Result<PathBuf, RuntimeError> {
    for attempt in 0..100u32 {
        let path = parent.join(format!(
            ".codemux-install-{}-{}-{}-{}",
            provider.as_str(),
            version,
            std::process::id(),
            unique_suffix().saturating_add(u128::from(attempt)),
        ));
        if path.exists() {
            continue;
        }
        std::fs::create_dir_all(&path).map_err(|error| {
            RuntimeError::io_failed(
                Some(provider),
                format!(
                    "无法创建 npm 临时 Runtime 目录 {}：{}",
                    path.display(),
                    error
                ),
            )
        })?;
        return Ok(path);
    }
    Err(RuntimeError::io_failed(
        Some(provider),
        "无法分配唯一的 npm 临时 Runtime 目录",
    ))
}

fn create_backup_path(
    parent: &Path,
    version: &str,
    provider: Provider,
) -> Result<PathBuf, RuntimeError> {
    for attempt in 0..100u32 {
        let path = parent.join(format!(
            ".codemux-backup-{}-{}-{}-{}",
            provider.as_str(),
            version,
            std::process::id(),
            unique_suffix().saturating_add(u128::from(attempt)),
        ));
        if !path.exists() {
            return Ok(path);
        }
    }
    Err(RuntimeError::io_failed(
        Some(provider),
        "无法分配唯一的旧 Runtime 备份目录",
    ))
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn restore_replaced_version<F: RuntimeFileSystem>(
    fs: &F,
    provider: Provider,
    version: &str,
    previous_version: Option<&str>,
    backup_dir: Option<&Path>,
) -> Result<(), RuntimeError> {
    let version_dir = fs.version_dir(provider, version);
    if version_dir.exists() {
        std::fs::remove_dir_all(&version_dir).map_err(|error| {
            RuntimeError::io_failed(
                Some(provider),
                format!(
                    "无法删除待回滚 Runtime {}：{}",
                    version_dir.display(),
                    error
                ),
            )
        })?;
    }
    if let Some(backup_dir) = backup_dir {
        std::fs::rename(backup_dir, &version_dir).map_err(|error| {
            RuntimeError::io_failed(
                Some(provider),
                format!("无法恢复旧 Runtime {}：{}", version_dir.display(), error),
            )
        })?;
    }

    match previous_version {
        Some(previous) => fs.write_current_version(provider, previous)?,
        None => {
            let current = fs.current_version_file(provider);
            match std::fs::remove_file(&current) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(RuntimeError::io_failed(
                        Some(provider),
                        format!(
                            "无法清理回滚后的 current 指针 {}：{}",
                            current.display(),
                            error
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::fixtures::{FixedNodeResolver, TempRuntimeFileSystem};
    use crate::runtime::seam::{NoopProgressReporter, RuntimeFileSystem};
    use std::sync::Arc;

    struct TestSource {
        spec: NpmRuntimeSpec,
        versions: Vec<String>,
    }

    #[async_trait]
    impl NpmSource for TestSource {
        async fn latest(&self, _provider: Provider) -> Result<NpmRuntimeSpec, RuntimeError> {
            Ok(self.spec.clone())
        }

        async fn versions(&self, _provider: Provider) -> Result<Vec<String>, RuntimeError> {
            Ok(self.versions.clone())
        }

        async fn version(
            &self,
            _provider: Provider,
            version: &str,
        ) -> Result<NpmRuntimeSpec, RuntimeError> {
            if version == self.spec.version {
                Ok(self.spec.clone())
            } else {
                Err(RuntimeError::manifest_failed(None, "测试版本不存在"))
            }
        }
    }

    struct TestInstaller {
        fail: bool,
    }

    fn write_runtime_layout(spec: &NpmRuntimeSpec, destination: &Path) -> Result<(), RuntimeError> {
        let package_dir =
            destination.join(format!("node_modules/{}", primary_package(spec.provider)));
        std::fs::create_dir_all(&package_dir)
            .map_err(|error| RuntimeError::io_failed(Some(spec.provider), error.to_string()))?;
        std::fs::write(destination.join("package.json"), "{}")
            .map_err(|error| RuntimeError::io_failed(Some(spec.provider), error.to_string()))?;
        std::fs::write(
            package_dir.join("package.json"),
            format!(
                r#"{{"name":"{}","version":"{}"}}"#,
                primary_package(spec.provider),
                spec.version
            ),
        )
        .map_err(|error| RuntimeError::io_failed(Some(spec.provider), error.to_string()))?;
        // 模拟首个候选二进制布局（npm alias 提升到顶层）。
        if let Some(binary) = spec.candidate_binaries.first() {
            let binary_path = destination.join(binary);
            if let Some(parent) = binary_path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    RuntimeError::io_failed(Some(spec.provider), error.to_string())
                })?;
            }
            std::fs::write(&binary_path, b"fake-binary")
                .map_err(|error| RuntimeError::io_failed(Some(spec.provider), error.to_string()))?;
        }
        Ok(())
    }

    #[async_trait]
    impl NpmInstaller for TestInstaller {
        async fn install(
            &self,
            spec: &NpmRuntimeSpec,
            destination: &Path,
            _progress: &dyn ProgressReporter,
        ) -> Result<(), RuntimeError> {
            if self.fail {
                return Err(RuntimeError::download_failed(
                    Some(spec.provider),
                    "测试 npm 安装失败",
                ));
            }
            write_runtime_layout(spec, destination)
        }
    }

    fn test_manager(
        fs: Arc<TempRuntimeFileSystem>,
        installer: Arc<TestInstaller>,
        spec: NpmRuntimeSpec,
    ) -> NpmRuntimeManager<TestSource, TestInstaller, FixedNodeResolver, TempRuntimeFileSystem>
    {
        NpmRuntimeManager::new(
            Arc::new(TestSource {
                versions: vec![spec.version.clone()],
                spec,
            }),
            installer,
            Arc::new(FixedNodeResolver::satisfied()),
            fs,
            "0.2.0",
        )
    }

    #[test]
    fn maps_provider_to_official_npm_packages() {
        assert_eq!(
            NpmRuntimeSpec::for_version(Provider::ClaudeCode, "0.3.220")
                .unwrap()
                .packages,
            vec!["@anthropic-ai/claude-agent-sdk@0.3.220"]
        );
        assert_eq!(
            NpmRuntimeSpec::for_version(Provider::Codex, "0.139.0")
                .unwrap()
                .packages,
            vec!["@openai/codex@0.139.0"]
        );
        assert_eq!(
            NpmRuntimeSpec::for_version(Provider::OpenCode, "1.18.3")
                .unwrap()
                .packages,
            vec!["@opencode-ai/sdk@1.18.3", "opencode-ai@1.18.3"]
        );
        assert_eq!(
            NpmRuntimeSpec::for_version(Provider::Pi, "1.2.3")
                .unwrap()
                .packages,
            vec!["@earendil-works/pi-coding-agent@1.2.3"]
        );
    }

    #[test]
    fn pi_runtime_key_binary_is_the_node_entry() {
        let spec = NpmRuntimeSpec::for_version(Provider::Pi, "1.2.3").unwrap();
        assert_eq!(
            spec.candidate_binaries,
            vec!["node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"]
        );
    }

    #[test]
    fn codex_runtime_validates_any_candidate_binary_layout() {
        let spec = NpmRuntimeSpec::for_version(Provider::Codex, "0.139.0").unwrap();
        assert!(
            spec.candidate_binaries.len() >= 3,
            "Codex candidate_binaries 应包含提升、嵌套与内置 vendor 三种候选布局"
        );
        assert!(
            spec.candidate_binaries
                .iter()
                .all(|path| path.contains("vendor")),
            "Codex candidate_binaries 应指向平台 vendor 二进制：{:?}",
            spec.candidate_binaries
        );
        let binary_name = if cfg!(target_os = "windows") {
            "codex.exe"
        } else {
            "codex"
        };
        assert!(spec
            .candidate_binaries
            .iter()
            .any(|path| path.ends_with(binary_name)));
    }

    #[test]
    fn rejects_non_semver_versions_before_npm_execution() {
        let error = NpmRuntimeSpec::for_version(Provider::Codex, "latest").unwrap_err();
        assert_eq!(error.kind, crate::runtime::RuntimeErrorKind::ManifestFailed);
    }

    #[test]
    fn sorts_versions_semantically() {
        let mut versions = vec![
            "0.3.9".to_string(),
            "0.3.170".to_string(),
            "0.3.22".to_string(),
        ];
        versions.sort_by(|a, b| compare_versions(b, a));
        assert_eq!(versions, vec!["0.3.170", "0.3.22", "0.3.9"]);
    }

    #[test]
    fn parses_npm_version_list_in_array_or_singleton_form() {
        assert_eq!(
            parse_npm_versions(r#"["1.0.0","1.1.0"]"#),
            Some(vec!["1.0.0".to_string(), "1.1.0".to_string()])
        );
        assert_eq!(
            parse_npm_versions(r#""1.1.0""#),
            Some(vec!["1.1.0".to_string()])
        );
    }

    fn test_manager_with_node(
        fs: Arc<TempRuntimeFileSystem>,
        installer: Arc<TestInstaller>,
        spec: NpmRuntimeSpec,
        node_version: &str,
    ) -> NpmRuntimeManager<TestSource, TestInstaller, FixedNodeResolver, TempRuntimeFileSystem>
    {
        NpmRuntimeManager::new(
            Arc::new(TestSource {
                versions: vec![spec.version.clone()],
                spec,
            }),
            installer,
            Arc::new(FixedNodeResolver::new(NodeDetection::from_version(
                Some(node_version.to_string()),
                Some("/usr/bin/node".to_string()),
            ))),
            fs,
            "0.2.0",
        )
    }

    #[tokio::test]
    async fn pi_install_blocks_new_versions_on_old_node_with_guidance() {
        let fs = Arc::new(TempRuntimeFileSystem::new());
        let spec = NpmRuntimeSpec::for_version(Provider::Pi, "1.0.4").unwrap();
        let manager = test_manager_with_node(
            fs,
            Arc::new(TestInstaller { fail: false }),
            spec,
            "v20.19.0",
        );
        let error = manager
            .install_version(Provider::Pi, "1.0.4", &NoopProgressReporter)
            .await
            .unwrap_err();
        assert_eq!(
            error.kind,
            crate::runtime::RuntimeErrorKind::NodeUnavailable
        );
        assert_eq!(error.provider, Some(Provider::Pi));
        assert!(
            error.message.contains("22.19"),
            "指引应包含版本下限：{}",
            error.message
        );
        assert!(
            error.message.contains("0.74.2"),
            "指引应提及 legacy 通道：{}",
            error.message
        );
    }

    #[tokio::test]
    async fn pi_install_allows_new_versions_on_node_22() {
        let fs = Arc::new(TempRuntimeFileSystem::new());
        let spec = NpmRuntimeSpec::for_version(Provider::Pi, "1.0.4").unwrap();
        let manager = test_manager_with_node(
            fs.clone(),
            Arc::new(TestInstaller { fail: false }),
            spec,
            "v22.20.0",
        );
        manager
            .install_version(Provider::Pi, "1.0.4", &NoopProgressReporter)
            .await
            .unwrap();
        assert_eq!(
            fs.read_current_version(Provider::Pi).as_deref(),
            Some("1.0.4")
        );
    }

    #[tokio::test]
    async fn pi_install_allows_old_versions_on_node_20() {
        let fs = Arc::new(TempRuntimeFileSystem::new());
        let spec = NpmRuntimeSpec::for_version(Provider::Pi, "0.73.1").unwrap();
        let manager = test_manager_with_node(
            fs.clone(),
            Arc::new(TestInstaller { fail: false }),
            spec,
            "v20.19.0",
        );
        manager
            .install_version(Provider::Pi, "0.73.1", &NoopProgressReporter)
            .await
            .unwrap();
        assert_eq!(
            fs.read_current_version(Provider::Pi).as_deref(),
            Some("0.73.1")
        );
    }

    #[tokio::test]
    async fn pi_status_reports_node_unavailable_when_node_too_old_for_installed_pi() {
        let fs = Arc::new(TempRuntimeFileSystem::new());
        let spec = NpmRuntimeSpec::for_version(Provider::Pi, "1.0.4").unwrap();
        let dir = fs.version_dir(Provider::Pi, "1.0.4");
        write_runtime_layout(&spec, &dir).unwrap();
        fs.write_current_version(Provider::Pi, "1.0.4").unwrap();
        let manager = test_manager_with_node(
            fs,
            Arc::new(TestInstaller { fail: false }),
            spec,
            "v20.19.0",
        );
        let status = manager.check_status(Provider::Pi).await.unwrap();
        assert_eq!(status.status, RuntimeStatus::NodeUnavailable);
    }

    #[test]
    fn filters_prerelease_versions_from_available_versions() {
        assert!(is_stable_version("1.2.3"));
        assert!(is_stable_version("1.2.3+build.7"));
        assert!(!is_stable_version("1.2.3-beta.1"));
        assert!(!is_stable_version("not-a-version"));
    }

    #[tokio::test]
    async fn installs_without_requiring_a_lockfile() {
        let fs = Arc::new(TempRuntimeFileSystem::new());
        let spec = NpmRuntimeSpec::for_version(Provider::Codex, "0.139.0").unwrap();
        let manager = test_manager(fs.clone(), Arc::new(TestInstaller { fail: false }), spec);
        let progress = NoopProgressReporter;

        manager.install(Provider::Codex, &progress).await.unwrap();

        assert_eq!(
            fs.read_current_version(Provider::Codex).as_deref(),
            Some("0.139.0")
        );
        assert!(fs.version_dir(Provider::Codex, "0.139.0").exists());
        assert!(!fs
            .version_dir(Provider::Codex, "0.139.0")
            .join("package-lock.json")
            .exists());
    }

    #[tokio::test]
    async fn npm_failure_does_not_create_current_pointer_or_version_directory() {
        let fs = Arc::new(TempRuntimeFileSystem::new());
        let spec = NpmRuntimeSpec::for_version(Provider::Codex, "0.139.0").unwrap();
        let manager = test_manager(fs.clone(), Arc::new(TestInstaller { fail: true }), spec);
        let progress = NoopProgressReporter;

        assert!(manager.install(Provider::Codex, &progress).await.is_err());

        assert_eq!(fs.read_current_version(Provider::Codex), None);
        assert!(fs.list_installed_versions(Provider::Codex).is_empty());
    }

    #[tokio::test]
    async fn reinstall_failure_preserves_the_current_runtime() {
        let fs = Arc::new(TempRuntimeFileSystem::new());
        let version = "0.139.0";
        let old_dir = fs.version_dir(Provider::Codex, version);
        let old_spec = NpmRuntimeSpec::for_version(Provider::Codex, version).unwrap();
        write_runtime_layout(&old_spec, &old_dir).unwrap();
        fs.write_current_version(Provider::Codex, version).unwrap();

        let spec = NpmRuntimeSpec::for_version(Provider::Codex, version).unwrap();
        let manager = test_manager(fs.clone(), Arc::new(TestInstaller { fail: true }), spec);
        let progress = NoopProgressReporter;

        assert!(manager
            .install_version(Provider::Codex, version, &progress)
            .await
            .is_err());

        assert_eq!(
            fs.read_current_version(Provider::Codex).as_deref(),
            Some(version)
        );
        assert_eq!(
            std::fs::read_to_string(old_dir.join("package.json")).unwrap(),
            "{}"
        );
    }

    /// 0.146 起 `@openai/codex-<platform>-<arch>` 把二进制放在 `vendor/<triple>/bin/`，
    /// 0.145 及更早在 `vendor/<triple>/codex/`。两个布局都必须被判为完整。
    ///
    /// 回归：候选路径表曾只列 `codex/`，导致 0.146 之后每一次 Codex 安装都在校验
    /// 环节失败，报「npm Runtime 缺少必要文件、平台二进制或版本不匹配」并删掉刚装好的
    /// 目录——而同一时刻 sidecar 的 `runtimeLoader.ts` 却能正常启动它。
    #[test]
    fn codex_candidate_binaries_cover_both_vendor_layouts() {
        let spec = NpmRuntimeSpec::for_version(Provider::Codex, "0.158.0").unwrap();
        let binary = if cfg!(target_os = "windows") {
            "codex.exe"
        } else {
            "codex"
        };
        let triple = match (Platform::current(), Arch::current()) {
            (Platform::Windows, Arch::X64) => "x86_64-pc-windows-msvc",
            (Platform::Windows, Arch::Arm64) => "aarch64-pc-windows-msvc",
            (Platform::Macos, Arch::X64) => "x86_64-apple-darwin",
            (Platform::Macos, Arch::Arm64) => "aarch64-apple-darwin",
            (Platform::Linux, Arch::X64) => "x86_64-unknown-linux-musl",
            (Platform::Linux, Arch::Arm64) => "aarch64-unknown-linux-musl",
        };
        let platform = match Platform::current() {
            Platform::Windows => "win32",
            Platform::Macos => "darwin",
            Platform::Linux => "linux",
        };
        let arch = match Arch::current() {
            Arch::X64 => "x64",
            Arch::Arm64 => "arm64",
        };
        let hoisted = format!("node_modules/@openai/codex-{platform}-{arch}");

        for layout in ["bin", "codex"] {
            let path = format!("{hoisted}/vendor/{triple}/{layout}/{binary}");
            assert!(
                spec.candidate_binaries.contains(&path),
                "候选路径缺少 {layout} 布局：{path}"
            );
        }
        // 新布局要排在前面，让常见情况先命中。
        assert!(spec.candidate_binaries[0].contains("/bin/"));
    }

    /// 用真实安装布局（alias 提升到顶层 + `bin/`）跑一遍完整性校验。
    #[test]
    fn codex_integrity_accepts_the_real_0_146_layout() {
        let fs = Arc::new(TempRuntimeFileSystem::new());
        let version = "0.158.0";
        let spec = NpmRuntimeSpec::for_version(Provider::Codex, version).unwrap();
        let dir = fs.version_dir(Provider::Codex, version);
        // 只铺真实布局：hoisted alias 的 `bin/` 目录，其余候选一律不存在。
        write_runtime_layout(&spec, &dir).unwrap();
        for candidate in spec.candidate_binaries.iter().skip(1) {
            let _ = std::fs::remove_file(dir.join(candidate));
        }

        let manager = test_manager(
            fs.clone(),
            Arc::new(TestInstaller { fail: true }),
            spec.clone(),
        );
        assert!(
            manager.verify_integrity(Provider::Codex, version),
            "真实安装布局应通过完整性校验"
        );
    }

    #[tokio::test]
    async fn codex_integrity_requires_candidate_binary() {
        let fs = Arc::new(TempRuntimeFileSystem::new());
        let version = "0.139.0";
        let spec = NpmRuntimeSpec::for_version(Provider::Codex, version).unwrap();

        // 无任何二进制的布局应判为不完整。
        let bare_dir = fs.version_dir(Provider::Codex, "0.1.0");
        let bare_spec = NpmRuntimeSpec::for_version(Provider::Codex, "0.1.0").unwrap();
        write_runtime_layout(&bare_spec, &bare_dir).unwrap();
        for binary in &bare_spec.candidate_binaries {
            let _ = std::fs::remove_file(bare_dir.join(binary));
        }
        let manager = test_manager(
            fs.clone(),
            Arc::new(TestInstaller { fail: true }),
            spec.clone(),
        );
        assert!(!manager.verify_integrity(Provider::Codex, "0.1.0"));

        // 仅存在内置 vendor 布局（alias 未安装）也应判为完整。
        let nested_dir = fs.version_dir(Provider::Codex, "0.2.0");
        let nested_spec = NpmRuntimeSpec::for_version(Provider::Codex, "0.2.0").unwrap();
        write_runtime_layout(&nested_spec, &nested_dir).unwrap();
        let _ =
            std::fs::remove_file(nested_dir.join(nested_spec.candidate_binaries.first().unwrap()));
        let nested_binary = nested_spec.candidate_binaries.last().unwrap();
        let nested_path = nested_dir.join(nested_binary);
        std::fs::create_dir_all(nested_path.parent().unwrap()).unwrap();
        std::fs::write(&nested_path, b"fake-binary").unwrap();
        assert!(manager.verify_integrity(Provider::Codex, "0.2.0"));
    }
}

#[cfg(test)]
mod install_progress_tests {
    use super::*;

    /// 全部取自本机 `npm install --loglevel=http` 的真实输出（npmmirror 源）。
    /// npm 把这些行写在 stderr，且 URL 形态随 registry / 镜像而变，所以不能按
    /// npmjs 官方源硬编码去解析。
    const REAL_LINES: &[&str] = &[
        "npm http fetch GET 200 https://registry.npmmirror.com/tiny-invariant 119ms (cache miss)",
        "npm http cache tiny-invariant@https://registry.npmmirror.com/tiny-invariant/-/tiny-invariant-1.3.3.tgz 0ms (cache hit)",
        "npm http fetch GET 200 https://cdn.npmmirror.com/packages/tiny-invariant/1.3.3/tiny-invariant-1.3.3.tgz 139ms (cache miss)",
        "npm http cache https://registry.npmmirror.com/is-number 20ms (cache hit)",
    ];

    #[test]
    fn every_http_line_counts_as_one_step() {
        // fetch 和 cache 都算一步：命中缓存的 tarball 同样是"这个包已经就绪了"。
        let mut done = 0u64;
        for line in REAL_LINES {
            let step = parse_install_progress_line(line, done)
                .unwrap_or_else(|| panic!("应被识别为进展：{line}"));
            done = step.done;
        }
        assert_eq!(done, REAL_LINES.len() as u64);
    }

    #[test]
    fn every_real_line_yields_its_package_name() {
        // 回归：末位 token 曾经被无条件当成包名，于是 `cache`（npm 的动词）和
        // `GET 200`（动作与状态码）会显示成"正在下载 cache"。
        let expected = [
            "tiny-invariant",
            "tiny-invariant",
            "tiny-invariant",
            "is-number",
        ];
        for (line, name) in REAL_LINES.iter().zip(expected) {
            assert_eq!(
                parse_install_progress_line(line, 0)
                    .unwrap()
                    .label
                    .as_deref(),
                Some(name),
                "包名解析错误：{line}"
            );
        }
    }

    #[test]
    fn derives_labels_for_scoped_and_cdn_urls() {
        let cases = [
            (
                "npm http fetch GET 200 https://registry.npmjs.org/@babel%2fcore/-/core-7.24.0.tgz 9ms (cache miss)",
                Some("@babel/core"),
            ),
            (
                "npm http fetch GET 200 https://registry.npmmirror.com/tiny-invariant 119ms (cache miss)",
                Some("tiny-invariant"),
            ),
            // CDN 直链的路径里没有包名，只能从文件名反推。
            (
                "npm http fetch GET 200 https://cdn.npmmirror.com/packages/tiny-invariant/1.3.3/tiny-invariant-1.3.3.tgz 139ms (cache miss)",
                Some("tiny-invariant"),
            ),
        ];
        for (line, expected) in cases {
            assert_eq!(
                parse_install_progress_line(line, 0)
                    .unwrap()
                    .label
                    .as_deref(),
                expected,
                "包名解析错误：{line}"
            );
        }
    }

    #[test]
    fn falls_back_to_a_generic_label_for_unrecognisable_urls() {
        let step =
            parse_install_progress_line("npm http fetch GET 200 https://example.com/ 1ms", 0)
                .unwrap();
        assert_eq!(step.label.as_deref(), Some("依赖包"));
    }

    #[test]
    fn ignores_noise_lines() {
        for line in [
            "npm warn deprecated foo@1.0.0: no longer supported",
            "npm notice New major version of npm available! 10.9.3 -> 12.1.0",
            "added 152 packages, and audited 153 packages in 12s",
            "",
            "   ",
        ] {
            assert!(
                parse_install_progress_line(line, 3).is_none(),
                "噪音行不该被当成进展：{line}"
            );
        }
    }

    #[test]
    fn describes_step_without_faking_a_percentage() {
        let step = InstallStep {
            done: 12,
            label: Some("opencode".to_string()),
        };
        assert_eq!(
            step.describe("正在从 npm 安装 OpenCode 1.18.33"),
            "正在从 npm 安装 OpenCode 1.18.33 · 已获取 12 个依赖（opencode）"
        );
    }

    #[test]
    fn failure_tail_drops_http_noise_and_keeps_the_real_error() {
        let mut tail = Vec::new();
        push_tail_line(
            &mut tail,
            "npm http fetch GET 200 https://example.com/x 1ms",
        );
        push_tail_line(&mut tail, "npm ERR! code ELIFECYCLE");
        push_tail_line(&mut tail, "npm ERR! command failed: node install.js");
        assert_eq!(
            tail,
            vec![
                "npm ERR! code ELIFECYCLE",
                "npm ERR! command failed: node install.js"
            ]
        );

        let stdout = vec!["added 1 package".to_string()];
        assert_eq!(
            failure_tail(&tail, &stdout),
            "npm ERR! code ELIFECYCLE
npm ERR! command failed: node install.js
added 1 package"
        );
    }

    #[test]
    fn failure_tail_never_renders_empty() {
        assert_eq!(failure_tail(&[], &[]), "npm 未输出错误详情");
    }

    #[test]
    fn failure_tail_ignores_an_http_only_failure() {
        let mut tail = Vec::new();
        for line in REAL_LINES {
            push_tail_line(&mut tail, line);
        }
        assert!(tail.is_empty());
        assert_eq!(failure_tail(&tail, &[]), "npm 未输出错误详情");
    }
}
