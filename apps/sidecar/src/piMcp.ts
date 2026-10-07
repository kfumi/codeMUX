import * as fs from 'node:fs';
import * as path from 'node:path';

/** CodeMUX / MCP 通用服务器描述（ensure_session 传入）。 */
export interface PiMcpServerSpec {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** stdio 服务器的工作目录（相对路径按会话目录解析）。 */
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 原生 HTTP 条目的 OAuth 配置（对象透传，见 pi docs/mcp.md）。 */
  oauth?: Record<string, unknown>;
  /** 单请求超时（秒，默认 60）。 */
  timeout?: number;
  description?: string;
  /** 工具曝光度；CodeMUX 注入的一律默认 direct（模型直接可见）。 */
  exposure?: PiMcpExposure;
  toolExposure?: Record<string, string>;
  enabled?: boolean;
  [key: string]: unknown;
}

export type PiMcpServers = Record<string, PiMcpServerSpec>;

/** pi 原生工具曝光度（docs/mcp.md#control-tool-exposure）。 */
export type PiMcpExposure = 'direct' | 'deferred' | 'codemode' | 'hidden';

const PI_MCP_EXPOSURES: ReadonlySet<string> = new Set(['direct', 'deferred', 'codemode', 'hidden']);

const PI_MCP_VALID_TYPES: ReadonlySet<string> = new Set(['stdio', 'http', 'streamable-http']);

const PI_MCP_MANAGED_FILE = 'codemux-mcp-managed.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** pi 服务名规则：仅字母、数字、`_`、`-`（docs/mcp.md#configuration-rules）。 */
export function isValidPiMcpServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/**
 * 服务名归一化：仅 `-` / `_` 差异的两个名字在 pi 视为同一服务。
 * 归一键只用于冲突检测，写入时保留原名。
 */
export function normalizePiMcpServerName(name: string): string {
  return name.replace(/-/g, '_');
}

/**
 * 把 CodeMUX MCP spec 转成 pi 原生 `mcp.json` 条目（docs/mcp.md）。
 *
 * - stdio：`command` 必填，透传 `args/env/cwd`。
 * - http：`url` 必填，透传 `headers/oauth/timeout/description`；`sse` 原生拒绝。
 * - `exposure` 缺省为 `direct`：原生默认 `codemode` 会把工具藏到 codemode
 *   脚本之后、模型不可见，而 CodeMUX 注入的都是用户在设置里为 pi 勾选的
 *   服务器（含浏览器 MCP），应像内置工具一样直接声明给模型。
 * - 形状不对（无 command 又无 url、两者兼有、`sse`）返回 null，调用方跳过。
 */
export function toPiMcpConfig(spec: PiMcpServerSpec): Record<string, unknown> | null {
  const type = typeof spec.type === 'string' ? spec.type.trim() : '';
  if (type === 'sse') return null;

  const command = asNonEmptyString(spec.command);
  const url = asNonEmptyString(spec.url);
  // 含糊条目（两者都有/都没有）宁可跳过：原生会报告并跳过无效条目，
  // 但提前拦截能给出可归因的 skipped 名单。
  if ((command && url) || (!command && !url)) return null;
  if (type && !PI_MCP_VALID_TYPES.has(type)) return null;

  const exposure = normalizePiMcpExposure(spec.exposure) ?? 'direct';
  const common: Record<string, unknown> = { exposure };
  const description = asNonEmptyString(spec.description);
  if (description) common.description = description;
  if (typeof spec.enabled === 'boolean') common.enabled = spec.enabled;
  if (typeof spec.timeout === 'number' && Number.isFinite(spec.timeout) && spec.timeout > 0) {
    common.timeout = spec.timeout;
  }
  const toolExposure = normalizePiMcpToolExposure(spec.toolExposure);
  if (toolExposure) common.toolExposure = toolExposure;

  if (command) {
    const entry: Record<string, unknown> = { command, ...common };
    if (type === 'stdio') entry.type = type;
    if (Array.isArray(spec.args)) entry.args = spec.args;
    if (spec.env && isRecord(spec.env)) entry.env = spec.env;
    const cwd = asNonEmptyString(spec.cwd);
    if (cwd) entry.cwd = cwd;
    return entry;
  }

  const entry: Record<string, unknown> = { url, ...common };
  if (type === 'http' || type === 'streamable-http') entry.type = type;
  if (spec.headers && isRecord(spec.headers)) entry.headers = spec.headers;
  if (spec.oauth && isRecord(spec.oauth)) entry.oauth = spec.oauth;
  return entry;
}

function normalizePiMcpExposure(value: unknown): PiMcpExposure | null {
  return typeof value === 'string' && PI_MCP_EXPOSURES.has(value)
    ? (value as PiMcpExposure)
    : null;
}

function normalizePiMcpToolExposure(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [tool, exposure] of Object.entries(value)) {
    if (typeof exposure === 'string' && PI_MCP_EXPOSURES.has(exposure)) {
      out[tool] = exposure;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface PiMcpMergeResult {
  mcpServers: Record<string, unknown>;
  /** 本次实际写入的 CodeMUX 托管服务名。 */
  managed: string[];
  applied: string[];
  pruned: string[];
  skipped: string[];
}

/**
 * 纯函数合并：已落盘条目 + 上次托管名单 + 本次下发集合。
 *
 * - 非法名 / 非法形状 / 与他人条目归一冲突（仅 `-`/`_` 差异）的下发项跳过。
 * - 上次托管但本次不在下发集合中的名字，从文件中删除（对应设置里关掉）。
 * - 用户手写条目（非托管名）一律保留。
 */
export function mergePiMcpServers(
  existing: Record<string, unknown>,
  managed: string[],
  incoming: PiMcpServers,
): PiMcpMergeResult {
  const mcpServers: Record<string, unknown> = { ...existing };
  const applied: string[] = [];
  const skipped: string[] = [];
  const incomingNames = new Set(Object.keys(incoming ?? {}));

  // 已占用的归一键：先占先得；下发项与“他人”（非同名覆盖）的归一键撞车即跳过，
  // 否则 pi 会把后者当重复服务拒绝。
  const takenNormalized = new Map<string, string>();
  for (const name of Object.keys(mcpServers)) {
    takenNormalized.set(normalizePiMcpServerName(name), name);
  }

  for (const [name, spec] of Object.entries(incoming ?? {})) {
    if (!isValidPiMcpServerName(name)) {
      skipped.push(name);
      continue;
    }
    const entry = toPiMcpConfig(spec);
    if (!entry) {
      skipped.push(name);
      continue;
    }
    const normalized = normalizePiMcpServerName(name);
    const takenBy = takenNormalized.get(normalized);
    if (takenBy !== undefined && takenBy !== name) {
      skipped.push(name);
      continue;
    }
    mcpServers[name] = entry;
    takenNormalized.set(normalized, name);
    applied.push(name);
  }

  const pruned: string[] = [];
  for (const name of managed) {
    if (!incomingNames.has(name) && name in mcpServers) {
      delete mcpServers[name];
      pruned.push(name);
    }
  }

  return { mcpServers, managed: applied, applied, pruned, skipped };
}

export interface PiMcpSyncResult extends PiMcpMergeResult {
  path: string;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Pi MCP config is not valid JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Pi MCP config must contain a JSON object: ${filePath}`);
  }
  return parsed;
}

/**
 * 把 CodeMUX 为 pi 启用的 MCP 服务器同步进托管目录的 `mcp.json`
 *（即 pi 原生用户级配置，无需项目信任；`--mcp-config` 之类的 flag 不需要，
 * 1.0 也没有这个 flag）。
 *
 * 多个 pi 会话共享同一托管目录：以后写覆盖先写（与 models.json 同策略）；
 * 托管名单记在同目录的 `codemux-mcp-managed.json`，用于下次剪掉已关闭的服务。
 * 用户手写条目与其它顶层键（如 `autoEnableCodemode`）一律保留。
 */
export function syncPiMcpJson(
  piConfigDir: string,
  servers: PiMcpServers,
): PiMcpSyncResult {
  fs.mkdirSync(piConfigDir, { recursive: true });
  const filePath = path.join(piConfigDir, 'mcp.json');
  const managedPath = path.join(piConfigDir, PI_MCP_MANAGED_FILE);

  let base: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    base = readJsonRecord(filePath);
  }
  const existing = isRecord(base.mcpServers) ? base.mcpServers : {};

  let managed: string[] = [];
  if (fs.existsSync(managedPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(managedPath, 'utf8'));
      if (Array.isArray(parsed)) {
        managed = parsed.filter((name): name is string => typeof name === 'string');
      }
    } catch {
      managed = [];
    }
  }

  const merged = mergePiMcpServers(existing, managed, servers ?? {});
  const next: Record<string, unknown> = { ...base, mcpServers: merged.mcpServers };
  const tmp = path.join(piConfigDir, `mcp.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });
  fs.renameSync(tmp, filePath);
  fs.writeFileSync(managedPath, `${JSON.stringify(merged.managed, null, 2)}\n`, { encoding: 'utf8' });
  return { ...merged, path: filePath };
}

/** 是否为 pi 原生（builtin:mcp）的 MCP 命令（`get_commands` 探测用）。 */
export function isPiNativeMcpCommand(command: unknown): boolean {
  if (!isRecord(command)) return false;
  if (typeof command.name !== 'string' || command.name !== 'mcp') return false;
  if (command.source !== 'extension') return false;
  const info = command.sourceInfo;
  if (!isRecord(info)) return true;
  const origin = typeof info.path === 'string' ? info.path : '';
  return origin === 'builtin:mcp' || origin.startsWith('builtin:mcp@');
}

export function piCommandsIncludeNativeMcp(payload: unknown): boolean {
  const commands = isRecord(payload) && Array.isArray(payload.commands)
    ? payload.commands
    : Array.isArray(payload)
      ? payload
      : [];
  return commands.some(isPiNativeMcpCommand);
}
