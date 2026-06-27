import { invoke, Channel } from '@tauri-apps/api/core';
import type { AgentKind, ReasoningEffort, Session, SessionMode } from '../types/session';
import type { AgentConfigUpdateMap, AppConfig, Provider, Theme } from '../types/provider';
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

export interface GitChangeBaseline {
  projectRoot: string;
  baselineTree: string;
}

export interface GitChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  originalContent: string | null;
  currentContent: string;
}

export type GitStatusArea = 'unstaged' | 'staged';

export interface GitStatusChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  originalContent: string | null;
  currentContent: string;
  additions: number;
  deletions: number;
}

export type TerminalEvent =
  | { type: 'output'; terminalId: string; data: string }
  | { type: 'exit'; terminalId: string; code: number | null }
  | { type: 'error'; terminalId: string; error: string };

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
  if (typeof args.reasoningEffort === 'string') summary.reasoningEffort = args.reasoningEffort;
  if (typeof args.theme === 'string') summary.theme = args.theme;
  if (typeof args.mode === 'string') summary.mode = args.mode;
  if (typeof args.name === 'string') summary.name = args.name;

  if (typeof args.prompt === 'string') summary.promptLength = args.prompt.length;
  if (typeof args.content === 'string') summary.contentLength = args.content.length;
  if (typeof args.eventsJson === 'string') summary.eventsLength = args.eventsJson.length;
  if (typeof args.apiKey === 'string') summary.hasApiKey = args.apiKey.length > 0;
  if (typeof args.baseUrl === 'string') summary.hasBaseUrl = args.baseUrl.length > 0;
  if (typeof args.codexNeedsProxy === 'boolean') summary.codexNeedsProxy = args.codexNeedsProxy;

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
  create: (title: string, agentKind: AgentKind, mode?: SessionMode, projectId?: string): Promise<Session> =>
    invokeLogged('create_session', { title, agentKind, mode, projectId: projectId ?? null }),
  getAll: (): Promise<Session[]> => invokeLogged('get_all_sessions'),
  getArchived: (): Promise<Session[]> => invokeLogged('get_archived_sessions'),
  delete: (sessionId: string): Promise<void> => invokeLogged('delete_session', { sessionId }),
  archive: (sessionId: string): Promise<void> => invokeLogged('archive_session', { sessionId }),
  unarchive: (sessionId: string): Promise<void> => invokeLogged('unarchive_session', { sessionId }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invokeLogged('update_session_title', { sessionId, title }),
  touch: (sessionId: string): Promise<void> => invokeLogged('touch_session', { sessionId }),
  updateProvider: (sessionId: string, providerId: string, model: string, reasoningEffort?: ReasoningEffort): Promise<void> =>
    invokeLogged('update_session_provider', { sessionId, providerId, model, reasoningEffort }),
};

export const agentApi = {
  ensureSession: (
    sessionId: string,
    cwd: string,
    onEvent?: (event: string) => void,
    apiKey?: string,
    baseUrl?: string,
    model?: string,
    reasoningEffort?: ReasoningEffort,
    codexNeedsProxy?: boolean,
  ): Promise<void> => {
    if (onEvent) {
      agentEventListeners.set(sessionId, onEvent);
    }
    const channel = getAgentChannel(sessionId);
    return invokeLogged('ensure_agent_session', { sessionId, cwd, channel, apiKey, baseUrl, model, reasoningEffort, codexNeedsProxy });
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
    reasoningEffort?: ReasoningEffort,
    codexNeedsProxy?: boolean,
  ): Promise<void> => {
    const channel = createAgentChannel(sessionId, onEvent);
    return invokeLogged('start_agent_session', { sessionId, prompt, cwd, channel, apiKey, baseUrl, model, reasoningEffort, codexNeedsProxy });
  },
  interrupt: (sessionId: string): Promise<void> => invokeLogged('interrupt_agent_session', { sessionId }),
  shutdown: (sessionId: string): Promise<void> => invokeLogged('shutdown_agent', { sessionId }),
  resetSession: (sessionId: string): Promise<void> => invokeLogged('reset_agent_session', { sessionId }),
  sendToolResponse: (sessionId: string, toolUseId: string, response: unknown): Promise<void> =>
    invokeLogged('send_tool_response', { sessionId, toolUseId, response }),
  /** Delete all Claude Code session files (history, file-history, etc.) for an app session. */
  deleteClaudeSessionFiles: (appSessionId: string): Promise<string[]> =>
    invokeLogged('delete_claude_session_files', { appSessionId }),
  /** Delete Codex session JSONL files for an app session. */
  deleteCodexSessionFiles: (appSessionId: string): Promise<string[]> =>
    invokeLogged('delete_codex_session_files', { appSessionId }),
  /** Load session events directly from Claude Code's JSONL session file. */
  loadClaudeSessionEvents: (appSessionId: string): Promise<Record<string, unknown>[]> =>
    invokeLogged('load_claude_session_events', { appSessionId }),
  /** Load session events from Codex's JSONL session file. */
  loadCodexSessionEvents: (appSessionId: string): Promise<Record<string, unknown>[]> =>
    invokeLogged('load_codex_session_events', { appSessionId }),
  startProxy: (apiKey: string, baseUrl: string, providerName: string, codexNeedsProxy?: boolean): Promise<number> =>
    invokeLogged('start_codex_proxy', { apiKey, baseUrl, providerName, codexNeedsProxy }),
  stopProxy: (): Promise<void> => invokeLogged('stop_codex_proxy'),
  getProxyPort: (): Promise<number | null> => invokeLogged('get_codex_proxy_port'),
};

export const configApi = {
  get: (): Promise<AppConfig> => invokeLogged('get_config'),
  updateProvider: (provider: Provider): Promise<void> => invokeLogged('update_provider', { provider }),
  deleteProvider: (providerId: string): Promise<void> => invokeLogged('delete_provider', { providerId }),
  setActiveProvider: (providerId: string): Promise<void> => invokeLogged('set_active_provider', { providerId }),
  setDefaultAgentKind: (agentKind: AgentKind): Promise<void> =>
    invokeLogged('set_default_agent_kind', { agentKind }),
  updateAgentConfig: <T extends keyof AgentConfigUpdateMap>(
    agentKind: T,
    config: AgentConfigUpdateMap[T],
  ): Promise<void> => invokeLogged('update_agent_config', { agentKind, config }),
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

export const gitApi = {
  createChangeBaseline: (projectPath: string): Promise<GitChangeBaseline> =>
    invokeLogged('create_git_change_baseline', { projectPath }),
  getChangedFiles: (projectPath: string, baselineTree: string): Promise<GitChangedFile[]> =>
    invokeLogged('get_git_changed_files', { projectPath, baselineTree }),
  getChangedFilesSinceHead: (projectPath: string): Promise<GitChangedFile[]> =>
    invokeLogged('get_git_changed_files_since_head', { projectPath }),
  getStatusChanges: (projectPath: string, area: GitStatusArea): Promise<GitStatusChange[]> =>
    invokeLogged('get_git_status_changes', { projectPath, area }),
  getStatusChangeDetail: (projectPath: string, area: GitStatusArea, filePath: string): Promise<GitStatusChange> =>
    invokeLogged('get_git_status_change_detail', { projectPath, area, filePath }),
};

export const terminalApi = {
  start: (
    projectPath: string,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<string> => {
    const channel = new Channel<string>();
    channel.onmessage = (event: string) => {
      try {
        onEvent(JSON.parse(event) as TerminalEvent);
      } catch {
        onEvent({ type: 'error', terminalId: '', error: event });
      }
    };
    return invokeLogged('start_terminal_session', { projectPath, cols, rows, channel });
  },
  write: (terminalId: string, data: string): Promise<void> =>
    invokeLogged('write_terminal_session', { terminalId, data }),
  resize: (terminalId: string, cols: number, rows: number): Promise<void> =>
    invokeLogged('resize_terminal_session', { terminalId, cols, rows }),
  close: (terminalId: string): Promise<void> =>
    invokeLogged('close_terminal_session', { terminalId }),
};

export const mcpApi = {
  getAll: (): Promise<McpServer[]> => invokeLogged('get_mcp_servers'),
  upsert: (server: McpServer): Promise<void> => invokeLogged('upsert_mcp_server', { server }),
  delete: (id: string): Promise<void> => invokeLogged('delete_mcp_server', { id }),
  toggleApp: (serverId: string, app: string, enabled: boolean): Promise<void> =>
    invokeLogged('toggle_mcp_app', { serverId, app, enabled }),
  probe: (id: string): Promise<{ connected: boolean; instructions?: string | null }> =>
    invokeLogged('probe_mcp_server', { id }),
  probeAll: (): Promise<Record<string, boolean>> => invokeLogged('probe_all_mcp_servers'),
  importFromApps: (): Promise<{ total: number }> => invokeLogged('import_mcp_from_apps'),
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

export interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  modified: string;
}

export type EnvironmentCheckStatus = 'ok' | 'warning' | 'missing' | 'error';

export interface EnvironmentToolCheck {
  name: 'Node.js' | 'Git';
  command: 'node' | 'git';
  status: EnvironmentCheckStatus;
  version: string | null;
  path: string | null;
  message: string;
}

export interface DevelopmentEnvironmentCheck {
  checkedAt: string;
  tools: EnvironmentToolCheck[];
}

export const appApi = {
  getLogDirectory: (): Promise<string> => invokeLogged('get_log_directory'),
  getAppDataDirectory: (): Promise<string> => invokeLogged('get_app_data_directory'),
  checkDevelopmentEnvironment: (): Promise<DevelopmentEnvironmentCheck> =>
    invokeLogged('check_development_environment'),
  getLogFiles: (): Promise<LogFileInfo[]> => invokeLogged('get_log_files'),
  readLogFile: (fileName: string): Promise<string> => invokeLogged('read_log_file', { fileName }),
};
