import { invoke, Channel } from '@tauri-apps/api/core';
import type { Session } from '../types/session';
import type { AppConfig, Provider, Theme } from '../types/provider';
import type { Project } from '../types/project';
import type { McpServer } from '../types/mcp';

export interface ModelInfo {
  id: string;
  owned_by: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileTreeNode[];
}

export const projectApi = {
  create: (name: string, path: string): Promise<Project> => invoke('create_project', { name, path }),
  getAll: (): Promise<Project[]> => invoke('get_all_projects'),
  delete: (projectId: string): Promise<void> => invoke('delete_project', { projectId }),
  rename: (projectId: string, name: string): Promise<void> => invoke('rename_project', { projectId, name }),
};

export const sessionApi = {
  create: (title: string, mode?: string, projectId?: string): Promise<Session> =>
    invoke('create_session', { title, mode, projectId: projectId ?? null }),
  getAll: (): Promise<Session[]> => invoke('get_all_sessions'),
  delete: (sessionId: string): Promise<void> => invoke('delete_session', { sessionId }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invoke('update_session_title', { sessionId, title }),
  getMessages: (sessionId: string): Promise<unknown[]> => invoke('get_messages', { sessionId }),
};

export const agentApi = {
  startSession: (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
    apiKey?: string,
    baseUrl?: string,
    model?: string,
  ): Promise<void> => {
    const channel = new Channel<string>();
    channel.onmessage = (event: string) => {
      onEvent(event);
    };
    return invoke('start_agent_session', { sessionId, prompt, cwd, channel, apiKey, baseUrl, model });
  },
  interrupt: (sessionId: string): Promise<void> => invoke('interrupt_agent_session', { sessionId }),
  shutdown: (sessionId: string): Promise<void> => invoke('shutdown_agent', { sessionId }),
  resetSession: (sessionId: string): Promise<void> => invoke('reset_agent_session', { sessionId }),
  sendToolResponse: (sessionId: string, toolUseId: string, response: unknown): Promise<void> =>
    invoke('send_tool_response', { sessionId, toolUseId, response }),
  /** Delete all Claude Code session files (history, file-history, etc.) for an app session. */
  deleteClaudeSessionFiles: (appSessionId: string): Promise<string[]> =>
    invoke('delete_claude_session_files', { appSessionId }),
  saveEvents: (sessionId: string, eventsJson: string): Promise<void> =>
    invoke('save_agent_events', { sessionId, eventsJson }),
  getEvents: (sessionId: string): Promise<string> =>
    invoke('get_agent_events', { sessionId }),
};

export const configApi = {
  get: (): Promise<AppConfig> => invoke('get_config'),
  updateProvider: (provider: Provider): Promise<void> => invoke('update_provider', { provider }),
  deleteProvider: (providerId: string): Promise<void> => invoke('delete_provider', { providerId }),
  setActiveProvider: (providerId: string): Promise<void> => invoke('set_active_provider', { providerId }),
  setTheme: (theme: Theme): Promise<void> => invoke('set_theme', { theme: theme.toLowerCase() }),
  fetchModels: (apiKey: string, baseUrl: string): Promise<ModelInfo[]> =>
    invoke('fetch_provider_models', { apiKey, baseUrl }),
  testProvider: (providerId: string): Promise<string> =>
    invoke('test_provider', { providerId }),
};

export const fileApi = {
  readFile: (path: string, basePath?: string): Promise<string> => invoke('read_file', { path, basePath }),
  listDirectory: (path: string, depth?: number, basePath?: string): Promise<FileTreeNode[]> =>
    invoke('list_directory', { path, depth, basePath }),
};

export const mcpApi = {
  getAll: (): Promise<McpServer[]> => invoke('get_mcp_servers'),
  upsert: (server: McpServer): Promise<void> => invoke('upsert_mcp_server', { server }),
  delete: (id: string): Promise<void> => invoke('delete_mcp_server', { id }),
  toggle: (id: string): Promise<boolean> => invoke('toggle_mcp_server', { id }),
  probeAll: (): Promise<Record<string, boolean>> => invoke('probe_all_mcp_servers'),
};
