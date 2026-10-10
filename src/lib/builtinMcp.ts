/**
 * 内置 MCP server 的**前端唯一事实来源**:server 名(现名 + 改名前的历史名)。
 * 与 `crates/daemon/src/builtin_mcp.rs` 的 `SERVER_NAME` / `LEGACY_SERVER_NAMES` 同源。
 *
 * 为什么历史名也要留在前端:轨迹是持久数据 —— 老会话里存的是改名前的全名
 * (`mcp__codemux-browser__computer_click`),改名后仍要认得,否则回看时活动标记与
 * 急停判定会静默失效(工单 16)。
 */

export const BUILTIN_MCP_SERVER_NAME = 'codemux-control';

export const BUILTIN_MCP_LEGACY_SERVER_NAMES: readonly string[] = ['codemux-browser'];

/** 内置 server 的 server 段全集(现名在前)。 */
export const BUILTIN_MCP_SERVER_NAMES: readonly string[] = [
  BUILTIN_MCP_SERVER_NAME,
  ...BUILTIN_MCP_LEGACY_SERVER_NAMES,
];

/** 内置 server 的两族工具前缀:24 个工具就分这两族。 */
export const BROWSER_TOOL_PREFIX = 'browser_';
export const DESKTOP_TOOL_PREFIX = 'computer_';

/** 有的运行时把 server 名里的 `-` 洗成 `_`(OpenCode 一类连写形态),两种拼写都要认。 */
function serverNameVariants(server: string): string[] {
  return [server, server.replace(/-/g, '_')];
}

/**
 * 从工具名里取出「属于内置 server 的裸工具名」,不是内置工具就返回 `undefined`。
 *
 * 认两种带 server 段的形态:
 *   - `mcp__<server>__<tool>`(Claude / Codex)
 *   - `<server>_<tool>`(OpenCode 一类连写形态;按 `includes` 容忍前缀修饰)
 *
 * 裸工具名(`computer_click`,daemon 审批帧那种)不带 server 段,不在这里判 ——
 * 它由各调用点自己的裸名表处理。
 */
export function builtinMcpToolSegment(toolName: string): string | undefined {
  const lower = toolName.trim().toLowerCase();
  if (lower.length === 0) return undefined;

  if (lower.startsWith('mcp__')) {
    const segments = lower.split('__');
    const tool = segments[segments.length - 1] ?? '';
    const server = segments.slice(1, -1).join('__');
    return BUILTIN_MCP_SERVER_NAMES.includes(server) && tool.length > 0 ? tool : undefined;
  }

  for (const server of BUILTIN_MCP_SERVER_NAMES) {
    for (const variant of serverNameVariants(server)) {
      const marker = `${variant}_`;
      const at = lower.indexOf(marker);
      if (at < 0) continue;
      const tool = lower.slice(at + marker.length);
      if (tool.length > 0) return tool;
    }
  }
  return undefined;
}
