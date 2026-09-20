/**
 * CodeMUX MCP spec → Claude Agent SDK `QueryOptions.mcpServers` 条目映射。
 *
 * daemon 在会话命令里带 `mcpServers`(pi 既有约定复用),claude 会话经本
 * 模块转成 SDK 的 stdio server 形状注入 `buildOptions`。仅做形状映射,不
 * 校验可达性;启动失败由 SDK 以 mcp_status_update 呈现。
 */
import type { PiMcpServerSpec, PiMcpServers } from './piMcp.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 单个 spec → SDK stdio server 配置。非 stdio(无 command)返回 null。 */
export function toClaudeSdkMcpServer(spec: PiMcpServerSpec): Record<string, unknown> | null {
  if (typeof spec.command !== 'string' || !spec.command.trim()) {
    return null;
  }
  return {
    type: 'stdio',
    command: spec.command,
    ...(Array.isArray(spec.args) ? { args: spec.args } : {}),
    ...(spec.env && isRecord(spec.env) ? { env: spec.env } : {}),
  };
}

/** 全量映射;无可用条目返回 null(调用方据此省略 mcpServers 键)。 */
export function mapClaudeMcpServers(servers?: PiMcpServers): Record<string, unknown> | null {
  if (!servers) {
    return null;
  }
  const mapped: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    const entry = toClaudeSdkMcpServer(spec);
    if (entry) {
      mapped[name] = entry;
    }
  }
  return Object.keys(mapped).length > 0 ? mapped : null;
}
