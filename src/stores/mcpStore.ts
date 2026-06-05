import { create } from 'zustand';
import type { McpServer } from '../types/mcp';
import { mcpApi } from '../lib/tauri';

interface McpStore {
  servers: McpServer[];
  isLoading: boolean;
  error: string | null;
  connectionStatus: Record<string, string>;
  fetchServers: () => Promise<void>;
  upsertServer: (server: McpServer) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  toggleServer: (id: string) => Promise<void>;
  updateConnectionStatus: (statuses: Record<string, string>) => void;
  probeAll: () => Promise<void>;
  probeNonConnected: () => Promise<void>;
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  isLoading: false,
  error: null,
  connectionStatus: {},

  fetchServers: async () => {
    set({ isLoading: true, error: null });
    try {
      const servers = await mcpApi.getAll();
      set({ servers, isLoading: false });
    } catch (error) {
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

  toggleServer: async (id: string) => {
    try {
      const newEnabled = await mcpApi.toggle(id);
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === id ? { ...s, enabled: newEnabled } : s
        ),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateConnectionStatus: (statuses: Record<string, string>) => {
    set({ connectionStatus: statuses });
  },

  probeAll: async () => {
    try {
      const results = await mcpApi.probeAll();
      const statuses: Record<string, string> = {};
      for (const [name, ok] of Object.entries(results)) {
        statuses[name] = ok ? 'connected' : 'failed';
      }
      set({ connectionStatus: statuses });
    } catch {
      // ignore probe errors
    }
  },

  probeNonConnected: async () => {
    try {
      const current = get().connectionStatus;
      // Skip if all enabled servers are already connected
      const hasNonConnected = get().servers.some(s => s.enabled && current[s.name] !== 'connected');
      if (!hasNonConnected) return;

      const results = await mcpApi.probeAll();
      const statuses = { ...current };
      for (const [name, ok] of Object.entries(results)) {
        // Only update non-connected servers, keep existing connected ones
        if (statuses[name] !== 'connected') {
          statuses[name] = ok ? 'connected' : 'failed';
        }
      }
      set({ connectionStatus: statuses });
    } catch {
      // ignore
    }
  },
}));
