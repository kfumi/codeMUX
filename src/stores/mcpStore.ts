import { create } from 'zustand';
import type { McpServer, McpApps } from '../types/mcp';
import { daemonFacade } from '../lib/facades/daemon-facade';

interface McpStore {
  servers: McpServer[];
  probeStatus: Record<string, 'idle' | 'pending' | 'connected' | 'failed'>;
  /** 探测拿到的工具名(id → tools/list 结果),连接但未拉到工具的服务器无条目。 */
  probeTools: Record<string, string[]>;
  isLoading: boolean;
  isProbing: boolean;
  error: string | null;
  fetchServers: () => Promise<void>;
  upsertServer: (server: McpServer) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  toggleApp: (serverId: string, app: keyof McpApps, enabled: boolean) => Promise<void>;
  probeServer: (id: string) => Promise<void>;
  probeAll: () => Promise<void>;
  importFromApps: () => Promise<void>;
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  probeStatus: {},
  probeTools: {},
  isLoading: false,
  isProbing: false,
  error: null,

  fetchServers: async () => {
    set({ isLoading: true, error: null });
    try {
      const servers = await daemonFacade.mcp.getAll();
      console.log('[mcpStore] fetchServers got', servers.length, 'servers');
      set({ servers, isLoading: false });
    } catch (error) {
      console.error('[mcpStore] fetchServers failed:', error);
      set({ error: String(error), isLoading: false });
    }
  },

  upsertServer: async (server: McpServer) => {
    try {
      await daemonFacade.mcp.upsert(server);
      set((state) => {
        const exists = state.servers.some((s) => s.id === server.id);
        const servers = exists
          ? state.servers.map((s) => (s.id === server.id ? server : s))
          : [...state.servers, server];
        return { servers };
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteServer: async (id: string) => {
    try {
      await daemonFacade.mcp.delete(id);
      set((state) => ({
        servers: state.servers.filter((s) => s.id !== id),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  toggleApp: async (serverId: string, app: keyof McpApps, enabled: boolean) => {
    try {
      await daemonFacade.mcp.toggleApp(serverId, app, enabled);
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === serverId
            ? { ...s, apps: { ...s.apps, [app]: enabled } }
            : s
        ),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  probeServer: async (id: string) => {
    set((state) => ({
      probeStatus: { ...state.probeStatus, [id]: 'pending' },
    }));
    try {
      const result = await daemonFacade.mcp.probe(id);
      set((state) => ({
        probeStatus: {
          ...state.probeStatus,
          [id]: result.connected ? 'connected' : 'failed',
        },
        probeTools: result.connected && result.tools?.length
          ? { ...state.probeTools, [id]: result.tools }
          : state.probeTools,
      }));
    } catch {
      set((state) => ({
        probeStatus: { ...state.probeStatus, [id]: 'failed' },
      }));
    }
  },

  probeAll: async () => {
    if (get().isProbing) return;
    set({ isProbing: true });
    try {
      const results = await daemonFacade.mcp.probeAll();
      // Backend returns name→{connected, tools} map; match to server.id for UI
      const servers = get().servers;
      const probeStatus: Record<string, 'connected' | 'failed'> = {};
      const probeTools: Record<string, string[]> = {};
      for (const [name, result] of Object.entries(results)) {
        const server = servers.find((s) => s.name === name);
        if (server) {
          probeStatus[server.id] = result.connected ? 'connected' : 'failed';
          if (result.connected && result.tools?.length) {
            probeTools[server.id] = result.tools;
          }
        }
      }
      set({ probeStatus, probeTools });
    } catch {
      // ignore probe errors
    } finally {
      set({ isProbing: false });
    }
  },

  importFromApps: async () => {
    try {
      const result = await daemonFacade.mcp.importFromApps();
      console.log('[mcpStore] importFromApps result:', result);
      if (result.total > 0) {
        // Refresh the server list after import
        await get().fetchServers();
      }
    } catch (error) {
      console.error('[mcpStore] importFromApps failed:', error);
      set({ error: String(error) });
      throw error;
    }
  },
}));
