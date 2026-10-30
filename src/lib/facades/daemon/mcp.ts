import type { McpServer } from '../../../types/mcp';
import { ensureDaemonClient } from './lifecycle';

/** MCP 服务器管理。 */
export const mcp = {
  getAll: async () => (await ensureDaemonClient()).mcpList() as Promise<McpServer[]>,
  upsert: async (server: McpServer) => {
    await (await ensureDaemonClient()).mcpUpsert(server);
  },
  delete: async (id: string) => {
    await (await ensureDaemonClient()).mcpDelete(id);
  },
  toggleApp: async (serverId: string, app: string, enabled: boolean) => {
    await (await ensureDaemonClient()).mcpToggleApp(serverId, app, enabled);
  },
  probe: async (id: string) => (await ensureDaemonClient()).mcpProbe(id),
  probeSpec: async (spec: unknown) => (await ensureDaemonClient()).mcpProbeSpec(spec),
  probeAll: async () => (await ensureDaemonClient()).mcpProbeAll(),
  importFromApps: async () => (await ensureDaemonClient()).mcpImport(),
};

export type McpDomain = typeof mcp;
