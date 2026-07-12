import { invoke, Channel } from '@tauri-apps/api/core';
import type { AgentKind, ReasoningEffort, Session, SessionMode } from '../types/session';
import type { AgentUserMessageLocator } from '../types/agent';
import type { AgentInputPayload } from '../types/agentInput';
import type { AgentConfigUpdateMap, AppConfig, NotificationSettings, Provider, Theme } from '../types/provider';
import type { OpenTarget } from './openTargets';
import type { AgentPermissionConfig, AgentPlanMode } from './agentPermissions';
import type { Project } from '../types/project';
import type { McpServer } from '../types/mcp';
import type { ImportableSkill, Skill } from '../types/skill';
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

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitRepositoryState {
  currentBranch: string | null;
  branches: GitBranch[];
  detached: boolean;
  hasUncommittedChanges: boolean;
  aheadCount: number;
  hasUnpushedCommits: boolean;
}

export interface GitCommitMessageSuggestion {
  message: string;
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
  if (typeof args.planMode === 'string') summary.planMode = args.planMode;
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
  const isAgentCommand = command.startsWith('agent_') || command.startsWith('ensure_agent') || command.startsWith('start_agent') || command.startsWith('send_agent') || command.startsWith('interrupt_agent') || command.startsWith('reset_agent') || command.startsWith('shutdown_agent') || command.startsWith('rewind_agent');
  
  if (isAgentCommand) {
    logger.debug('Tauri command invoked', {
      command,
      ...summarizeInvokeArgs(args),
    });
  }
  
  try {
    const result = await invoke<T>(command, args);
    if (isAgentCommand) {
      logger.debug('Tauri command succeeded', {
        command,
        ...summarizeInvokeArgs(args),
        resultType: result !== undefined ? typeof result : 'void',
      });
    }
    return result;
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
  create: (
    title: string,
    agentKind: AgentKind,
    mode?: SessionMode,
    projectId?: string,
    permissionConfig?: AgentPermissionConfig,
    planMode?: AgentPlanMode,
  ): Promise<Session> =>
    invokeLogged('create_session', {
      title,
      agentKind,
      mode,
      projectId: projectId ?? null,
      permissionConfig: permissionConfig ? JSON.stringify(permissionConfig) : null,
      planMode: planMode ?? null,
    }),
  getAll: (): Promise<Session[]> => invokeLogged('get_all_sessions'),
  getArchived: (): Promise<Session[]> => invokeLogged('get_archived_sessions'),
  delete: (sessionId: string): Promise<void> => invokeLogged('delete_session', { sessionId }),
  archive: (sessionId: string): Promise<void> => invokeLogged('archive_session', { sessionId }),
  unarchive: (sessionId: string): Promise<void> => invokeLogged('unarchive_session', { sessionId }),
  setPinned: (sessionId: string, pinned: boolean): Promise<void> => invokeLogged('set_session_pinned', { sessionId, pinned }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invokeLogged('update_session_title', { sessionId, title }),
  touch: (sessionId: string): Promise<void> => invokeLogged('touch_session', { sessionId }),
  updateProvider: (sessionId: string, providerId: string, model: string, reasoningEffort?: ReasoningEffort): Promise<void> =>
    invokeLogged('update_session_provider', { sessionId, providerId, model, reasoningEffort }),
  updatePermissions: (
    sessionId: string,
    permissionConfig?: AgentPermissionConfig,
    planMode?: AgentPlanMode,
  ): Promise<void> =>
    invokeLogged('update_session_permissions', {
      sessionId,
      permissionConfig: permissionConfig ? JSON.stringify(permissionConfig) : null,
      planMode: planMode ?? null,
    }),
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
    provider?: string,
    credentialSource?: 'codemux' | 'environment' | 'opencode' | 'none',
  ): Promise<void> => {
    if (onEvent) {
      agentEventListeners.set(sessionId, onEvent);
    }
    const channel = getAgentChannel(sessionId);
    return invokeLogged('ensure_agent_session', { sessionId, cwd, channel, apiKey, baseUrl, model, reasoningEffort, codexNeedsProxy, provider, credentialSource });
  },
  sendInput: (
    sessionId: string,
    prompt: string,
    inputPayload?: AgentInputPayload,
  ): Promise<void> => invokeLogged('send_agent_input', { sessionId, prompt, inputPayload }),
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
    inputPayload?: AgentInputPayload,
  ): Promise<void> => {
    const channel = createAgentChannel(sessionId, onEvent);
    return invokeLogged('start_agent_session', { sessionId, prompt, cwd, channel, apiKey, baseUrl, model, reasoningEffort, codexNeedsProxy, inputPayload });
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
  /** Load latest token usage snapshot directly from the agent history file. */
  loadLatestTokenUsage: (
    appSessionId: string,
    agentKind: AgentKind,
    freshness: 'live_synced' | 'restored',
  ): Promise<Record<string, unknown> | null> =>
    invokeLogged('load_agent_latest_token_usage', { appSessionId, agentKind, freshness }),
  /** Rewind the latest visible turn in the provider session history. */
  rewindSession: (appSessionId: string, agentKind: AgentKind, target?: AgentUserMessageLocator): Promise<void> =>
    invokeLogged('rewind_agent_session', { appSessionId, agentKind, target }),
  getSessionInfo: (appSessionId: string, agentKind: AgentKind): Promise<{ agentSessionId: string | null; messagePath: string | null }> =>
    invokeLogged('get_agent_session_info', { appSessionId, agentKind }),
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
  setCompactAiOutput: (enabled: boolean): Promise<void> =>
    invokeLogged('set_compact_ai_output', { enabled }),
  setNotificationSettings: (settings: NotificationSettings): Promise<void> =>
    invokeLogged('set_notification_settings', { settings }),
  setDefaultOpenTarget: (target: OpenTarget): Promise<void> =>
    invokeLogged('set_default_open_target', { target }),
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
  openProjectPath: (path: string, target: OpenTarget): Promise<void> =>
    invokeLogged('open_project_path', { path, target }),
};

export const gitApi = {
  getChangedFiles: (projectPath: string, baselineTree: string): Promise<GitChangedFile[]> =>
    invokeLogged('get_git_changed_files', { projectPath, baselineTree }),
  getChangedFilesSinceHead: (projectPath: string): Promise<GitChangedFile[]> =>
    invokeLogged('get_git_changed_files_since_head', { projectPath }),
  getRepositoryState: (projectPath: string): Promise<GitRepositoryState> =>
    invokeLogged('get_git_repository_state', { projectPath }),
  createBranch: (projectPath: string, branchName: string, checkout: boolean): Promise<void> =>
    invokeLogged('create_git_branch', { projectPath, branchName, checkout }),
  checkoutBranch: (projectPath: string, branchName: string): Promise<void> =>
    invokeLogged('checkout_git_branch', { projectPath, branchName }),
  getStatusChanges: (projectPath: string, area: GitStatusArea): Promise<GitStatusChange[]> =>
    invokeLogged('get_git_status_changes', { projectPath, area }),
  getStatusChangeDetail: (projectPath: string, area: GitStatusArea, filePath: string): Promise<GitStatusChange> =>
    invokeLogged('get_git_status_change_detail', { projectPath, area, filePath }),
  stageStatusChanges: (projectPath: string, filePath?: string): Promise<void> =>
    invokeLogged('stage_git_status_changes', { projectPath, filePath: filePath ?? null }),
  unstageStatusChanges: (projectPath: string, filePath?: string): Promise<void> =>
    invokeLogged('unstage_git_status_changes', { projectPath, filePath: filePath ?? null }),
  revertStatusChanges: (projectPath: string, area: GitStatusArea, filePath?: string): Promise<void> =>
    invokeLogged('revert_git_status_changes', { projectPath, area, filePath: filePath ?? null }),
  commitChanges: (projectPath: string, message: string): Promise<string> =>
    invokeLogged('commit_git_changes', { projectPath, message }),
  pushBranch: (projectPath: string): Promise<void> =>
    invokeLogged('push_git_branch', { projectPath }),
  generateCommitMessage: (projectPath: string): Promise<GitCommitMessageSuggestion> =>
    invokeLogged('generate_git_commit_message', { projectPath }),
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
  listImportable: (): Promise<ImportableSkill[]> => invokeLogged('list_importable_skills'),
  uninstall: (id: string): Promise<boolean> => invokeLogged('uninstall_skill', { id }),
  toggleApp: (skillId: string, app: string, enabled: boolean): Promise<void> =>
    invokeLogged('toggle_skill_app', { skillId, app, enabled }),
  getContent: (id: string): Promise<string> => invokeLogged('get_skill_content', { id }),
  syncBuiltins: (): Promise<Skill[]> => invokeLogged('scan_disk_skills'),
  registerFromDisk: (name: string): Promise<Skill> =>
    invokeLogged('register_skill_from_disk', { name }),
  importFromApps: (selected?: string[] | null): Promise<{ total: number }> =>
    invokeLogged('import_skills_from_apps', { selected: selected ?? null }),
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
  showMainWindow: (): Promise<void> => invokeLogged('show_main_window_command'),
  sendAgentNotification: (payload: { title: string; body: string; sessionId: string }): Promise<void> =>
    invokeLogged('send_agent_notification_command', payload),
};
