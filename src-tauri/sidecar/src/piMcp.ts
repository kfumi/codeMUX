import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** CodeMUX / MCP 通用服务器描述（ensure_session 传入）。 */
export interface PiMcpServerSpec {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export type PiMcpServers = Record<string, PiMcpServerSpec>;

export interface PiMcpConfigFile {
  path: string;
  cleanup: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把 CodeMUX MCP spec 转成 pi-mcp-adapter / `--mcp-config` 条目。 */
export function toPiMcpConfig(spec: PiMcpServerSpec): Record<string, unknown> {
  if ((spec.type ?? 'stdio') === 'stdio' && typeof spec.command === 'string' && spec.command.trim()) {
    return {
      command: spec.command,
      ...(Array.isArray(spec.args) ? { args: spec.args } : {}),
      ...(spec.env && isRecord(spec.env) ? { env: spec.env } : {}),
    };
  }
  return {
    ...(typeof spec.url === 'string' ? { url: spec.url } : {}),
    ...(spec.headers && isRecord(spec.headers) ? { headers: spec.headers } : {}),
    auth: false,
    oauth: false,
  };
}

function readPiGlobalMcpConfig(piConfigDir: string | undefined): Record<string, unknown> {
  if (!piConfigDir) return {};
  const globalConfigPath = path.join(piConfigDir, 'mcp.json');
  if (!fs.existsSync(globalConfigPath)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`Pi MCP config must contain a JSON object: ${globalConfigPath}`);
  }
  return parsed;
}

/**
 * 生成会话级 `--mcp-config` 文件。`--mcp-config` 会替换 pi 全局 mcp.json，
 * 所以先合并托管目录里已有的条目，再叠 CodeMUX 为 pi 启用的服务器。
 */
export function createPiMcpConfigFile(
  servers: PiMcpServers,
  options: { piConfigDir?: string } = {},
): PiMcpConfigFile {
  const globalConfig = readPiGlobalMcpConfig(options.piConfigDir);
  let configuredServers: Record<string, unknown> = {};
  if (isRecord(globalConfig.mcpServers)) {
    configuredServers = globalConfig.mcpServers;
  } else if (isRecord(globalConfig['mcp-servers'])) {
    configuredServers = globalConfig['mcp-servers'];
  }
  const mcpServers: Record<string, unknown> = { ...configuredServers };
  for (const [name, spec] of Object.entries(servers)) {
    mcpServers[name] = toPiMcpConfig(spec);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemux-pi-mcp-'));
  const filePath = path.join(dir, 'mcp.json');
  const mergedConfig: Record<string, unknown> = { ...globalConfig, mcpServers };
  delete mergedConfig['mcp-servers'];
  fs.writeFileSync(filePath, `${JSON.stringify(mergedConfig, null, 2)}\n`, { encoding: 'utf8' });
  return {
    path: filePath,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function isPiMcpAdapterCommand(command: unknown): boolean {
  if (!isRecord(command)) return false;
  const name = typeof command.name === 'string' ? command.name : '';
  if (command.source !== 'extension' || !/^mcp(?::\d+)?$/.test(name)) {
    return false;
  }
  if (!command.sourceInfo) return true;
  return JSON.stringify(command.sourceInfo).includes('pi-mcp-adapter');
}

export function piCommandsIncludeMcpAdapter(payload: unknown): boolean {
  const commands = isRecord(payload) && Array.isArray(payload.commands)
    ? payload.commands
    : Array.isArray(payload)
      ? payload
      : [];
  return commands.some(isPiMcpAdapterCommand);
}
