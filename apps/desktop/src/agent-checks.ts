//! 壳能力的纯 Node 实现件(不 import electron,可被 vitest 直接测试)。
//!
//! 当前实现「最小面」:
//! - checkDevelopmentEnvironment:node/npm/git 版本探测;
//! - checkAgentRuntimes / probeAgentInstallations:PATH 锚定 + `--version`
//!   探测 + npm registry 最新版比对(移植自 Tauri 壳时代的
//!   agent_runtime_check.rs;多处安装枚举/冲突仲裁暂缺,后续按需增强);
//! - upgradeAgentRuntime:不假成功,返回明确的 hard_failure 结构。

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 壳载荷契约:与 src/lib/desktop-bridge.ts(唯一归属)同形。壳侧有意不 import
// 渲染层模块 —— apps/desktop 是独立包,双份定义是包边界的一部分。
// ---------------------------------------------------------------------------

export type EnvironmentCheckStatus = 'ok' | 'warning' | 'missing' | 'error';

export interface EnvironmentToolCheck {
  name: 'Node.js' | 'npm' | 'Git';
  command: 'node' | 'npm' | 'git';
  status: EnvironmentCheckStatus;
  version: string | null;
  path: string | null;
  message: string;
}

export interface DevelopmentEnvironmentCheck {
  checkedAt: string;
  tools: EnvironmentToolCheck[];
}

export type AgentRuntimeStatus = 'ok' | 'outdated' | 'missing' | 'error';
export type InstallSource =
  | 'nvm' | 'homebrew' | 'volta' | 'fnm' | 'mise'
  | 'bun' | 'pnpm' | 'scoop' | 'system' | 'unknown';

export interface AgentInstallation {
  path: string;
  real: string;
  version: string | null;
  runnable: boolean;
  error: string | null;
  source: InstallSource;
  isPathDefault: boolean;
}

export interface AgentInstallationReport {
  agentKind: string;
  installs: AgentInstallation[];
  isConflict: boolean;
  needsConfirmation: boolean;
  anchored: boolean;
  command: string | null;
}

export interface AgentRuntimeCheck {
  agentKind: string;
  label: string;
  command: string;
  status: AgentRuntimeStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  executablePath: string | null;
  configPath: string | null;
  npmPackage: string;
  message: string;
  installedButBroken: boolean;
}

export interface AgentRuntimeCheckResult {
  checkedAt: string;
  runtimes: AgentRuntimeCheck[];
}

export interface AgentRuntimeUpgradeResult {
  agentKind: string;
  success: boolean;
  outcome: 'success' | 'soft_version_unchanged' | 'soft_not_runnable' | 'hard_failure';
  message: string;
  newVersion: string | null;
}

// ---------------------------------------------------------------------------
// 智能体 CLI 规格。
// ---------------------------------------------------------------------------

interface AgentSpec {
  agentKind: string;
  label: string;
  command: string;
  npmPackage: string;
  configDirName: string | null;
}

const AGENT_SPECS: AgentSpec[] = [
  { agentKind: 'claude_code', label: 'Claude Code', command: 'claude', npmPackage: '@anthropic-ai/claude-code', configDirName: '.claude' },
  { agentKind: 'codex', label: 'Codex', command: 'codex', npmPackage: '@openai/codex', configDirName: '.codex' },
  { agentKind: 'opencode', label: 'OpenCode', command: 'opencode', npmPackage: 'opencode-ai', configDirName: '.config/opencode' },
];

function specFor(agentKind: string): AgentSpec {
  const spec = AGENT_SPECS.find((entry) => entry.agentKind === agentKind);
  if (!spec) {
    throw new Error(`未知的智能体类型: ${agentKind}`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// 子进程探测工具(Windows CREATE_NO_WINDOW 等价:windowsHide)。
// ---------------------------------------------------------------------------

function isWindows(): boolean {
  return process.platform === 'win32';
}

/** 在 PATH 中定位命令(Windows `where`,unix `which`);未找到返回 null。 */
export function findCommandPath(command: string): Promise<string | null> {
  const tool = isWindows() ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(tool, [command], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const first = String(stdout).split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
      resolve(first ?? null);
    });
  });
}

/**
 * 运行 `<exe> --version` 捕获 stdout。Windows 上 npm 顶层命令是 .cmd,
 * 直接 spawn 会 EINVAL(Node ≥18.20),改走 `cmd /d /s /c` 包装。
 */
export function runVersionCommand(exePath: string, timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    if (isWindows() && /\.cmd$/i.test(exePath)) {
      child = spawn(process.env.comspec ?? 'cmd.exe', ['/d', '/s', '/c', `"${exePath}" --version`], {
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(exePath, ['--version'], { windowsHide: true });
    }
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('version probe timed out'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8').trim();
      if (code === 0 && stdout) {
        resolve(stdout);
      } else {
        const stderr = Buffer.concat(errors).toString('utf8').trim();
        reject(new Error(stderr || `exit code ${code}`));
      }
    });
  });
}

/** 从 `--version` 输出解析语义化版本(容忍 v 前缀与构建元数据)。 */
export function parseVersion(output: string): string | null {
  const match = output.match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

/** 数值化 semver 比较:-1/0/1;无法解析时返回 null。 */
export function compareSemver(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const core = value.split('+')[0].split('-')[0].split('.');
    if (!core.every((part) => /^\d+$/.test(part))) return null;
    return core.map(Number);
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** npm registry 最新版本;失败返回 null(与 Rust 行为一致:latest 拉不到不影响检测)。 */
function fetchLatestNpmVersion(npmPackage: string, timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    const request = https.get(
      { host: 'registry.npmjs.org', path: `/${encodeURIComponent(npmPackage)}/latest`, timeout: timeoutMs },
      (response) => {
        if (response.statusCode !== 200) {
          resolve(null);
          response.resume();
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { version?: unknown };
            resolve(typeof parsed.version === 'string' ? parsed.version : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

/** 按安装路径前缀推断安装来源(Rust infer_install_source 的移植)。 */
export function inferInstallSource(realPath: string): InstallSource {
  const normalized = realPath.toLowerCase().replace(/\\/g, '/');
  if (normalized.includes('/.nvm/') || normalized.includes('/versions/node')) return 'nvm';
  if (normalized.includes('/homebrew/') || normalized.includes('/cellar/')) return 'homebrew';
  if (normalized.includes('/.volta/') || normalized.includes('/volta/')) return 'volta';
  if (normalized.includes('fnm_multishells')) return 'fnm';
  if (normalized.includes('/mise/')) return 'mise';
  if (normalized.includes('/.bun/')) return 'bun';
  if (normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/scoop/')) return 'scoop';
  if (normalized.includes('/usr/local/bin') || normalized.includes('/usr/bin') || normalized.includes('c:/program files')) return 'system';
  return 'system';
}

function configPathFor(spec: AgentSpec): string | null {
  if (!spec.configDirName) return null;
  // OpenCode 用 XDG_CONFIG_HOME 优先(对齐 Rust config_dir)。
  if (spec.agentKind === 'opencode') {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return path.join(xdg, 'opencode');
  }
  return path.join(os.homedir(), spec.configDirName);
}

// ---------------------------------------------------------------------------
// 壳门面入口。
// ---------------------------------------------------------------------------

/** node/npm/git 开发环境探测(对齐 commands/app.rs 的最小面)。 */
export async function checkDevelopmentEnvironment(): Promise<DevelopmentEnvironmentCheck> {
  const check = async (
    name: EnvironmentToolCheck['name'],
    command: EnvironmentToolCheck['command'],
    okMessage: string,
    missingMessage: string,
  ): Promise<EnvironmentToolCheck> => {
    const exePath = await findCommandPath(command);
    if (!exePath) {
      return { name, command, status: 'missing', version: null, path: null, message: missingMessage };
    }
    try {
      const output = await runVersionCommand(exePath);
      const version = parseVersion(output);
      return {
        name,
        command,
        status: 'ok',
        version,
        path: exePath,
        message: version ? okMessage : `无法解析 ${name} 版本输出：${output}`,
      };
    } catch (error) {
      return { name, command, status: 'error', version: null, path: exePath, message: String(error) };
    }
  };

  const [node, npm, git] = await Promise.all([
    check('Node.js', 'node', 'Node.js 可用。', '未找到 Node.js，请安装 Node.js 18+ 并确认 PATH 已生效。'),
    check('npm', 'npm', 'npm 可用。', '未找到 npm，请安装 Node.js（含 npm）并确认 PATH 已生效。'),
    check('Git', 'git', 'Git 可用。', '未找到 Git，请安装 Git 并确认 PATH 已生效。'),
  ]);
  // Node 版本低于 18 → warning(对齐 Rust classify_node_version 的语义)。
  if (node.status === 'ok' && node.version) {
    const major = Number(node.version.split('.')[0]);
    if (Number.isFinite(major) && major < 18) {
      node.status = 'warning';
      node.message = 'Node.js 版本低于 18，请升级到 Node.js 18+。';
    }
  }
  return { checkedAt: new Date().toISOString(), tools: [node, npm, git] };
}

/** 三个智能体 CLI 的检测(最小面:PATH 锚定单安装 + npm 最新版比对)。 */
export async function checkAgentRuntimes(): Promise<AgentRuntimeCheckResult> {
  const runtimes = await Promise.all(AGENT_SPECS.map(async (spec): Promise<AgentRuntimeCheck> => {
    const configPath = configPathFor(spec);
    const base = {
      agentKind: spec.agentKind,
      label: spec.label,
      command: spec.command,
      npmPackage: spec.npmPackage,
      configPath: configPath && existsSync(configPath) ? configPath : null,
    };
    const exePath = await findCommandPath(spec.command);
    if (!exePath) {
      return {
        ...base,
        status: 'missing',
        currentVersion: null,
        latestVersion: null,
        executablePath: null,
        message: `未在 PATH 中找到 ${spec.command}`,
        installedButBroken: false,
      };
    }
    let currentVersion: string | null = null;
    let brokenError: string | null = null;
    try {
      currentVersion = parseVersion(await runVersionCommand(exePath));
      if (!currentVersion) brokenError = `无法解析 ${spec.command} --version 输出`;
    } catch (error) {
      brokenError = String(error);
    }
    const latestVersion = await fetchLatestNpmVersion(spec.npmPackage);
    if (brokenError) {
      return {
        ...base,
        status: 'error',
        currentVersion,
        latestVersion,
        executablePath: exePath,
        message: `${spec.command} 已安装但无法运行：${brokenError}`,
        installedButBroken: true,
      };
    }
    const comparison = currentVersion && latestVersion ? compareSemver(currentVersion, latestVersion) : null;
    const outdated = comparison === -1;
    return {
      ...base,
      status: outdated ? 'outdated' : 'ok',
      currentVersion,
      latestVersion,
      executablePath: exePath,
      message: outdated
        ? `${spec.label} 可升级：${currentVersion} → ${latestVersion}`
        : `${spec.label} 已就绪（${currentVersion ?? '未知版本'}）。`,
      installedButBroken: false,
    };
  }));
  return { checkedAt: new Date().toISOString(), runtimes };
}

/**
 * 单个智能体安装的枚举(最小面:仅 PATH 锚定那处;多处安装/冲突仲裁
 * 待后续按需对齐 Rust 版 build_tool_search_paths 的全量枚举)。
 */
export async function probeAgentInstallations(agentKind: string): Promise<AgentInstallationReport> {
  const spec = specFor(agentKind);
  const exePath = await findCommandPath(spec.command);
  if (!exePath) {
    return { agentKind, installs: [], isConflict: false, needsConfirmation: false, anchored: false, command: null };
  }
  let real = exePath;
  try {
    real = realpathSync(exePath);
  } catch {
    // realpath 失败时退回原始路径。
  }
  let version: string | null = null;
  let error: string | null = null;
  try {
    version = parseVersion(await runVersionCommand(exePath));
    if (!version) error = '无法解析版本输出';
  } catch (probeError) {
    error = String(probeError);
  }
  return {
    agentKind,
    installs: [{
      path: exePath,
      real,
      version,
      runnable: version !== null,
      error,
      source: inferInstallSource(real),
      isPathDefault: true,
    }],
    isConflict: false,
    needsConfirmation: false,
    anchored: version !== null,
    command: version !== null ? `${real} install ${spec.npmPackage}@latest` : null,
  };
}

/**
 * 升级入口:尚未实现升级执行,但不得静默假成功 —— 返回明确的
 * hard_failure 结构,由用户手动执行安装命令。
 */
export function upgradeAgentRuntime(agentKind: string): AgentRuntimeUpgradeResult {
  // 校验 agentKind,未知的仍然显式报错。
  specFor(agentKind);
  return {
    agentKind,
    success: false,
    outcome: 'hard_failure',
    message: `Electron 壳的运行时升级尚未实现;请手动执行安装命令(如 npm install -g ${specFor(agentKind).npmPackage}@latest)升级。`,
    newVersion: null,
  };
}
