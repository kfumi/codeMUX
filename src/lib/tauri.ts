import { invoke, Channel } from '@tauri-apps/api/core';
import type { AgentKind, Session } from '../types/session';
import type { AppConfig, Provider, Theme } from '../types/provider';
import type { Project } from '../types/project';
import type { McpServer } from '../types/mcp';
import type { Skill } from '../types/skill';
import { createLogger, serializeError } from './logger';

const logger = createLogger('tauri');
const agentChannels = new Map<string, Channel<string>>();
const agentEventListeners = new Map<string, (event: string) => void>();

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

function getAgentChannel(sessionId: string): Channel<string> {
  let channel = agentChannels.get(sessionId);
  if (!channel) {
    channel = new Channel<string>();
    channel.onmessage = (event: string) => {
      const listener = agentEventListeners.get(sessionId);
      if (listener) {
        listener(event);
      }
    };
    agentChannels.set(sessionId, channel);
  }
  return channel;
}

function createAgentChannel(sessionId: string, onEvent?: (event: string) => void): Channel<string> {
  const channel = new Channel<string>();
  if (onEvent) {
    agentEventListeners.set(sessionId, onEvent);
  }
  channel.onmessage = (event: string) => {
    const listener = agentEventListeners.get(sessionId);
    if (listener) {
      listener(event);
    }
  };
  agentChannels.set(sessionId, channel);
  return channel;
}

function summarizeInvokeArgs(args?: Record<string, unknown>) {
  if (!args) {
    return undefined;
  }

  const summary: Record<string, unknown> = {};

  if (typeof args.sessionId === 'string') summary.sessionId = args.sessionId;
  if (typeof args.projectId === 'string') summary.projectId = args.projectId;
  if (typeof args.providerId === 'string') summary.providerId = args.providerId;
  if (typeof args.id === 'string') summary.id = args.id;
  if (typeof args.path === 'string') summary.path = args.path;
  if (typeof args.basePath === 'string') summary.basePath = args.basePath;
  if (typeof args.cwd === 'string') summary.cwd = args.cwd;
  if (typeof args.model === 'string') summary.model = args.model;
  if (typeof args.theme === 'string') summary.theme = args.theme;
  if (typeof args.mode === 'string') summary.mode = args.mode;
  if (typeof args.name === 'string') summary.name = args.name;

  if (typeof args.prompt === 'string') summary.promptLength = args.prompt.length;
  if (typeof args.content === 'string') summary.contentLength = args.content.length;
  if (typeof args.eventsJson === 'string') summary.eventsLength = args.eventsJson.length;
  if (typeof args.apiKey === 'string') summary.hasApiKey = args.apiKey.length > 0;
  if (typeof args.baseUrl === 'string') summary.hasBaseUrl = args.baseUrl.length > 0;

  return Object.keys(summary).length > 0 ? summary : undefined;
}

async function invokeLogged<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    logger.error('Tauri command failed', {
      command,
      ...summarizeInvokeArgs(args),
    }, serializeError(error));
    throw error;
  }
}

export const projectApi = {
  create: (name: string, path: string): Promise<Project> => invokeLogged('create_project', { name, path }),
  getAll: (): Promise<Project[]> => invokeLogged('get_all_projects'),
  delete: (projectId: string): Promise<void> => invokeLogged('delete_project', { projectId }),
  rename: (projectId: string, name: string): Promise<void> => invokeLogged('rename_project', { projectId, name }),
};

export const sessionApi = {
  create: (title: string, agentKind: AgentKind, mode?: string, projectId?: string): Promise<Session> =>
    invokeLogged('create_session', { title, agentKind, mode, projectId: projectId ?? null }),
  getAll: (): Promise<Session[]> => invokeLogged('get_all_sessions'),
  delete: (sessionId: string): Promise<void> => invokeLogged('delete_session', { sessionId }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invokeLogged('update_session_title', { sessionId, title }),
  updateProvider: (sessionId: string, providerId: string, model: string): Promise<void> => invokeLogged('update_session_provider', { sessionId, providerId, model }),
  getMessages: (sessionId: string): Promise<unknown[]> => invokeLogged('get_messages', { sessionId }),
};

export const agentApi = {
  ensureSession: (
    sessionId: string,
    cwd: string,
    onEvent?: (event: string) => void,
    apiKey?: string,
    baseUrl?: string,
    model?: string,
  ): Promise<void> => {
    if (onEvent) {
      agentEventListeners.set(sessionId, onEvent);
    }
    const channel = getAgentChannel(sessionId);
    return invokeLogged('ensure_agent_session', { sessionId, cwd, channel, apiKey, baseUrl, model });
  },
  sendInput: (
    sessionId: string,
    prompt: string,
  ): Promise<void> => invokeLogged('send_agent_input', { sessionId, prompt }),
  startSession: (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
    apiKey?: string,
    baseUrl?: string,
    model?: string,
  ): Promise<void> => {
    const channel = createAgentChannel(sessionId, onEvent);
    return invokeLogged('start_agent_session', { sessionId, prompt, cwd, channel, apiKey, baseUrl, model });
  },
  interrupt: (sessionId: string): Promise<void> => invokeLogged('interrupt_agent_session', { sessionId }),
  shutdown: (sessionId: string): Promise<void> => invokeLogged('shutdown_agent', { sessionId }),
  resetSession: (sessionId: string): Promise<void> => invokeLogged('reset_agent_session', { sessionId }),
  sendToolResponse: (sessionId: string, toolUseId: string, response: unknown): Promise<void> =>
    invokeLogged('send_tool_response', { sessionId, toolUseId, response }),
  /** Delete all Claude Code session files (history, file-history, etc.) for an app session. */
  deleteClaudeSessionFiles: (appSessionId: string): Promise<string[]> =>
    invokeLogged('delete_claude_session_files', { appSessionId }),
  saveEvents: (sessionId: string, eventsJson: string): Promise<void> =>
    invokeLogged('save_agent_events', { sessionId, eventsJson }),
  getEvents: (sessionId: string): Promise<string> =>
    invokeLogged('get_agent_events', { sessionId }),
  /** Load session events directly from Claude Code's JSONL session file. */
  loadClaudeSessionEvents: (appSessionId: string): Promise<Record<string, unknown>[]> =>
    invokeLogged('load_claude_session_events', { appSessionId }),
};

export const configApi = {
  get: (): Promise<AppConfig> => invokeLogged('get_config'),
  updateProvider: (provider: Provider): Promise<void> => invokeLogged('update_provider', { provider }),
  deleteProvider: (providerId: string): Promise<void> => invokeLogged('delete_provider', { providerId }),
  setActiveProvider: (providerId: string): Promise<void> => invokeLogged('set_active_provider', { providerId }),
  setTheme: (theme: Theme): Promise<void> => invokeLogged('set_theme', { theme: theme.toLowerCase() }),
  fetchModels: (apiKey: string, baseUrl: string): Promise<ModelInfo[]> =>
    invokeLogged('fetch_provider_models', { apiKey, baseUrl }),
  testProvider: (providerId: string): Promise<string> =>
    invokeLogged('test_provider', { providerId }),
};

export const fileApi = {
  readFile: (path: string, basePath?: string): Promise<string> => invokeLogged('read_file', { path, basePath }),
  writeFile: (path: string, content: string, basePath?: string): Promise<void> =>
    invokeLogged('write_file', { path, content, basePath }),
  deleteFile: (path: string, basePath?: string): Promise<void> =>
    invokeLogged('delete_file', { path, basePath }),
  listDirectory: (path: string, depth?: number, basePath?: string): Promise<FileTreeNode[]> =>
    invokeLogged('list_directory', { path, depth, basePath }),
};

export const mcpApi = {
  getAll: (): Promise<McpServer[]> => invokeLogged('get_mcp_servers'),
  upsert: (server: McpServer): Promise<void> => invokeLogged('upsert_mcp_server', { server }),
  delete: (id: string): Promise<void> => invokeLogged('delete_mcp_server', { id }),
  toggle: (id: string): Promise<boolean> => invokeLogged('toggle_mcp_server', { id }),
  probeAll: (): Promise<Record<string, boolean>> => invokeLogged('probe_all_mcp_servers'),
};

export const skillApi = {
  listInstalled: (): Promise<Skill[]> => invokeLogged('list_installed_skills'),
  uninstall: (id: string): Promise<boolean> => invokeLogged('uninstall_skill', { id }),
  toggle: (id: string, enabled: boolean): Promise<boolean> =>
    invokeLogged('toggle_skill', { id, enabled }),
  getContent: (id: string): Promise<string> => invokeLogged('get_skill_content', { id }),
  syncBuiltins: (): Promise<Skill[]> => invokeLogged('sync_builtin_skills'),
  registerFromDisk: (name: string): Promise<Skill> =>
    invokeLogged('register_skill_from_disk', { name }),
  getEnabledNames: (): Promise<string[]> => invokeLogged('get_enabled_skill_names'),
};

export const appApi = {
  getLogDirectory: (): Promise<string> => invokeLogged('get_log_directory'),
};
