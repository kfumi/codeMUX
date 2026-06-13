import { create } from 'zustand';
import type { McpServer, McpApps } from '../types/mcp';
import { mcpApi } from '../lib/tauri';

interface McpStore {
  servers: McpServer[];
  probeStatus: Record<string, 'idle' | 'pending' | 'connected' | 'failed'>;
  isLoading: boolean;
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
  isLoading: false,
  error: null,

  fetchServers: async () => {
    set({ isLoading: true, error: null });
    try {
      const servers = await mcpApi.getAll();
      console.log('[mcpStore] fetchServers got', servers.length, 'servers');
      set({ servers, isLoading: false });
    } catch (error) {
      console.error('[mcpStore] fetchServers failed:', error);
      set({ error: String(error), isLoading: false });
    }
  },

  upsertServer: async (server: McpServer) => {
    try {
      await mcpApi.upsert(server);
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
      await mcpApi.delete(id);
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
      await mcpApi.toggleApp(serverId, app, enabled);
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
      const result = await mcpApi.probe(id);
      set((state) => ({
        probeStatus: {
          ...state.probeStatus,
          [id]: result.connected ? 'connected' : 'failed',
        },
      }));
    } catch {
      set((state) => ({
        probeStatus: { ...state.probeStatus, [id]: 'failed' },
      }));
    }
  },

  probeAll: async () => {
    try {
      const results = await mcpApi.probeAll();
      // Backend returns name→connected map; match to server.id for UI
      const servers = get().servers;
      const probeStatus: Record<string, 'connected' | 'failed'> = {};
      for (const [name, ok] of Object.entries(results)) {
        const server = servers.find((s) => s.name === name);
        if (server) {
          probeStatus[server.id] = ok ? 'connected' : 'failed';
        }
      }
      set({ probeStatus });
    } catch {
      // ignore probe errors
    }
  },

  importFromApps: async () => {
    try {
      const result = await mcpApi.importFromApps();
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
