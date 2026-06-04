import { create } from 'zustand';
import type { McpServer } from '../types/mcp';
import { mcpApi } from '../lib/tauri';

interface McpStore {
  servers: McpServer[];
  isLoading: boolean;
  error: string | null;
  fetchServers: () => Promise<void>;
  upsertServer: (server: McpServer) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  toggleServer: (id: string) => Promise<void>;
}

export const useMcpStore = create<McpStore>((set) => ({
  servers: [],
  isLoading: false,
  error: null,

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
}));
