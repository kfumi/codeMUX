import { invoke, Channel } from '@tauri-apps/api/core';
import type { AgentKind, ReasoningEffort, Session, SessionMode } from '../types/session';
import type { ImportCandidate, ImportSessionsRequest, ImportSessionsResult } from '../types/historyImport';
import type { AgentUserMessageLocator } from '../types/agent';
import type { AgentInputPayload, AgentInputAttachment, EnrichmentBlockResult, UserAttachmentPreview } from '../types/agentInput';
import type {
  AgentConfigUpdateMap,
  ImageRecognitionConfig,
  AppConfig,
  BuiltinProviderTemplate,
  GitSettings,
  ModelProvider,
  NotificationSettings,
  Provider,
  Theme,
} from '../types/provider';
import type { OpenTarget } from './openTargets';
import type { AgentPermissionConfig, AgentPlanMode } from './agentPermissions';
import type { Project } from '../types/project';
import type { McpServer } from '../types/mcp';
import type { ImportableSkill, ProjectSkill, Skill } from '../types/skill';
import type { UsageStatsResponse, TokenBreakdownResponse } from '../types/usage';
import type { CompanionStatus } from '../types/companion';
import type { ScheduledTask, ScheduledTaskInput, TaskRun } from '../types/scheduledTask';
import { createLogger, serializeError } from './logger';
import { usePerfStore } from '../stores/perfStore';

const logger = createLogger('tauri');
const agentChannels = new Map<string, Channel<string>>();
const agentEventListeners = new Map<string, (event: string) => void>();
const terminalLifecycleQueues = new Map<string, Promise<void>>();
const terminalAttachmentStates = new Map<string, boolean>();

function queueTerminalLifecycle(terminalId: string, operation: () => Promise<void>): Promise<void> {
  const previous = terminalLifecycleQueues.get(terminalId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      if (terminalLifecycleQueues.get(terminalId) === next) {
        terminalLifecycleQueues.delete(terminalId);
      }
    });
  terminalLifecycleQueues.set(terminalId, next);
  return next;
}

function queueTerminalIo(terminalId: string, operation: () => Promise<void>): Promise<void> {
  if (terminalAttachmentStates.get(terminalId) !== true) {
    return Promise.resolve();
  }

  return queueTerminalLifecycle(terminalId, () => {
    if (terminalAttachmentStates.get(terminalId) !== true) {
      return Promise.resolve();
    }
    return operation();
  });
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
  upstreamBranch: string | null;
  upstreamRef: string | null;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface GitCommitMessageSuggestion {
  message: string;
}

export interface GitPullRequestSuggestion {
  title: string;
  body: string;
  base: string;
}

export type ForgePlatform = 'github' | 'gitlab' | 'gitee';

export interface CreatePullRequestRequest {
  projectPath: string;
  title: string;
  body: string;
  base: string;
}

export interface CreatePullRequestResult {
  platform: ForgePlatform;
  url: string;
  number: number;
  head: string;
  base: string;
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
  if (typeof args.reasoningEffort === 'string') summary.reasoningEffort = args.reasoningEffort;
  if (typeof args.theme === 'string') summary.theme = args.theme;
  if (typeof args.mode === 'string') summary.mode = args.mode;
  if (typeof args.planMode === 'string') summary.planMode = args.planMode;
  if (typeof args.name === 'string') summary.name = args.name;

  if (typeof args.prompt === 'string') summary.promptLength = args.prompt.length;
  if (typeof args.content === 'string') summary.contentLength = args.content.length;
  if (typeof args.eventsJson === 'string') summary.eventsLength = args.eventsJson.length;

  return Object.keys(summary).length > 0 ? summary : undefined;
}

async function invokeLogged<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const isAgentCommand = command.startsWith('agent_') || command.startsWith('ensure_agent') || command.startsWith('start_agent') || command.startsWith('send_agent') || command.startsWith('interrupt_agent') || command.startsWith('reset_agent') || command.startsWith('shutdown_agent') || command.startsWith('rewind_agent') || command.startsWith('fork_');

  if (isAgentCommand) {
    logger.debug('Tauri command invoked', {
      command,
      ...summarizeInvokeArgs(args),
    });
  }

  if (import.meta.env.DEV) {
    const start = performance.now();
    try {
      const result = await invoke<T>(command, args);
      const duration = performance.now() - start;
      usePerfStore.getState().recordIpc(command, duration, false);
      if (isAgentCommand) {
        logger.debug('Tauri command succeeded', {
          command,
          ...summarizeInvokeArgs(args),
          resultType: result !== undefined ? typeof result : 'void',
        });
      }
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      usePerfStore.getState().recordIpc(command, duration, true);
      logger.error(`Tauri command failed: ${serializeError(error)}`, {
        command,
        ...summarizeInvokeArgs(args),
      });
      throw error;
    }
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
    logger.error(`Tauri command failed: ${serializeError(error)}`, {
      command,
      ...summarizeInvokeArgs(args),
    });
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
    model?: string,
  ): Promise<Session> =>
    invokeLogged('create_session', {
      title,
      agentKind,
      mode,
      projectId: projectId ?? null,
      permissionConfig: permissionConfig ? JSON.stringify(permissionConfig) : null,
      planMode: planMode ?? null,
      model: model ?? null,
    }),
  getAll: (): Promise<Session[]> => invokeLogged('get_all_sessions'),
  getArchived: (): Promise<Session[]> => invokeLogged('get_archived_sessions'),
  delete: (sessionId: string): Promise<void> => invokeLogged('delete_session', { sessionId }),
  archive: (sessionId: string): Promise<void> => invokeLogged('archive_session', { sessionId }),
  unarchive: (sessionId: string): Promise<void> => invokeLogged('unarchive_session', { sessionId }),
  setPinned: (sessionId: string, pinned: boolean): Promise<void> => invokeLogged('set_session_pinned', { sessionId, pinned }),
  setReadOnly: (sessionId: string, readOnly: boolean): Promise<void> => invokeLogged('set_session_read_only', { sessionId, readOnly }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invokeLogged('update_session_title', { sessionId, title }),
  updateWorkingPath: (sessionId: string, workingPath: string): Promise<Session> =>
    invokeLogged('update_session_working_path', { sessionId, workingPath }),
  touch: (sessionId: string): Promise<void> => invokeLogged('touch_session', { sessionId }),
  updateProvider: (sessionId: string, providerId: string | null, model: string, reasoningEffort?: ReasoningEffort): Promise<void> =>
    invokeLogged('update_session_provider', { sessionId, providerId, model, reasoningEffort }),
  updateReasoningEffort: (sessionId: string, reasoningEffort: ReasoningEffort): Promise<void> =>
    invokeLogged('update_session_reasoning_effort', { sessionId, reasoningEffort }),
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
  forkClaude: (
    sessionId: string,
    forkEventId: string,
    forkProviderMessageId?: string,
    title?: string,
    forkUserMessageCount?: number,
  ): Promise<Session> =>
    invokeLogged('fork_claude_session', {
      sessionId,
      forkEventId,
      forkProviderMessageId: forkProviderMessageId ?? null,
      title: title ?? null,
      forkUserMessageCount: forkUserMessageCount ?? null,
    }),
  forkCodex: (
    sessionId: string,
    forkEventId: string,
    forkProviderMessageId?: string,
    forkProviderTurnId?: string,
    forkProviderTurnOrdinal?: number,
    title?: string,
    forkUserMessageCount?: number,
  ): Promise<Session> =>
    invokeLogged('fork_codex_session', {
      sessionId,
      forkEventId,
      forkProviderMessageId: forkProviderMessageId ?? null,
      forkProviderTurnId: forkProviderTurnId ?? null,
      forkProviderTurnOrdinal: forkProviderTurnOrdinal ?? null,
      title: title ?? null,
      forkUserMessageCount: forkUserMessageCount ?? null,
    }),
  forkOpenCode: (
    sessionId: string,
    forkEventId: string,
    forkProviderMessageId?: string,
    title?: string,
    forkUserMessageCount?: number,
  ): Promise<Session> =>
    invokeLogged('fork_opencode_session', {
      sessionId,
      forkEventId,
      forkProviderMessageId: forkProviderMessageId ?? null,
      title: title ?? null,
      forkUserMessageCount: forkUserMessageCount ?? null,
    }),
  saveMessageAttachments: (
    sessionId: string,
    userIndex: number,
    attachments: UserAttachmentPreview[],
  ): Promise<void> =>
    invokeLogged('save_session_message_attachments', { sessionId, userIndex, attachments }),
  getMessageAttachments: (sessionId: string): Promise<Record<number, UserAttachmentPreview[]>> =>
    invokeLogged('get_session_message_attachments', { sessionId }),
};

export const agentApi = {
  ensureSession: (
    sessionId: string,
    cwd: string,
    onEvent?: (event: string) => void,
    reasoningEffort?: ReasoningEffort,
  ): Promise<void> => {
    if (onEvent) {
      agentEventListeners.set(sessionId, onEvent);
    }
    const channel = getAgentChannel(sessionId);
    return invokeLogged('ensure_agent_session', { sessionId, cwd, channel, reasoningEffort });
  },
  sendInput: (
    sessionId: string,
    prompt: string,
    inputPayload?: AgentInputPayload,
    displayContent?: string,
  ): Promise<void> => invokeLogged('send_agent_input', { sessionId, prompt, inputPayload, displayContent }),
  enrichAttachments: (attachments: AgentInputAttachment[]): Promise<{ blocks: EnrichmentBlockResult[] }> =>
    invokeLogged('enrich_attachments', { attachments }),
  startSession: (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
    reasoningEffort?: ReasoningEffort,
    inputPayload?: AgentInputPayload,
    displayContent?: string,
  ): Promise<void> => {
    const channel = createAgentChannel(sessionId, onEvent);
    return invokeLogged('start_agent_session', { sessionId, prompt, cwd, channel, reasoningEffort, inputPayload, displayContent });
  },
  interrupt: (sessionId: string): Promise<void> => invokeLogged('interrupt_agent_session', { sessionId }),
  shutdown: (sessionId: string): Promise<void> => invokeLogged('shutdown_agent', { sessionId }),
  resetSession: (sessionId: string): Promise<void> => invokeLogged('reset_agent_session', { sessionId }),
  sendToolResponse: (sessionId: string, toolUseId: string, response: unknown): Promise<void> =>
    invokeLogged('send_tool_response', { sessionId, toolUseId, response }),

  respondToAgentPermission: (sessionId: string, requestId: string, response: 'once' | 'always' | 'reject'): Promise<void> =>
    invokeLogged('respond_to_agent_permission', { sessionId, requestId, response }),
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
  loadOpenCodeSessionEvents: (appSessionId: string): Promise<Record<string, unknown>[]> =>
    invokeLogged('load_opencode_session_events', { appSessionId }),
  loadSessionEvents: (appSessionId: string): Promise<Record<string, unknown>[]> =>
    invokeLogged('load_session_events', { appSessionId }),
  /** Replace the cached timeline with the latest CLI provider history file. */
  resyncSessionFromNative: (appSessionId: string): Promise<{ eventCount: number }> =>
    invokeLogged('resync_session_from_native', { appSessionId }),
  deleteOpenCodeSession: (appSessionId: string): Promise<void> =>
    invokeLogged('delete_opencode_session', { appSessionId }),
  /** Load latest token usage snapshot directly from the agent history file. */
  loadLatestTokenUsage: (
    appSessionId: string,
    agentKind: AgentKind,
    freshness: 'live_synced' | 'restored',
  ): Promise<Record<string, unknown> | null> =>
    invokeLogged('load_agent_latest_token_usage', { appSessionId, agentKind, freshness }),
  /** Rewind the conversation and/or files to a target user message in the provider session history. */
  rewindSession: (
    appSessionId: string,
    agentKind: AgentKind,
    target?: AgentUserMessageLocator,
    rewindUserIndex?: number,
    mode?: 'conversation' | 'files' | 'both',
  ): Promise<{ filesChanged?: number }> =>
    invokeLogged('rewind_agent_session', {
      appSessionId,
      agentKind,
      target,
      rewindUserIndex: rewindUserIndex ?? null,
      mode: mode ?? null,
    }),
  getSessionInfo: (appSessionId: string, agentKind: AgentKind): Promise<{ agentSessionId: string | null; messagePath: string | null }> =>
    invokeLogged('get_agent_session_info', { appSessionId, agentKind }),
  stopProxy: (): Promise<void> => invokeLogged('stop_codex_proxy'),
  getProxyPort: (): Promise<number | null> => invokeLogged('get_codex_proxy_port'),
};

export const historyImportApi = {
  discover: (agentKind?: AgentKind): Promise<ImportCandidate[]> =>
    invokeLogged('discover_importable_sessions', { agentKind: agentKind ?? null }),
  import: (request: ImportSessionsRequest): Promise<ImportSessionsResult> =>
    invokeLogged('import_sessions', { request }),
};

export const configApi = {
  get: (): Promise<AppConfig> => invokeLogged('get_config'),
  updateProvider: (provider: Provider): Promise<void> => invokeLogged('update_provider', { provider }),
  deleteProvider: (providerId: string): Promise<void> => invokeLogged('delete_provider', { providerId }),
  setActiveProvider: (providerId: string): Promise<void> =>
    invokeLogged('set_active_model_provider', { providerId }),
  listBuiltinProviderTemplates: (): Promise<BuiltinProviderTemplate[]> =>
    invokeLogged('list_builtin_provider_templates'),
  instantiateBuiltinProviderTemplate: (templateId: string): Promise<ModelProvider> =>
    invokeLogged('instantiate_builtin_provider_template', { templateId }),
  upsertModelProvider: (provider: ModelProvider): Promise<void> =>
    invokeLogged('upsert_model_provider', { provider }),
  deleteModelProvider: (providerId: string): Promise<void> =>
    invokeLogged('delete_model_provider', { providerId }),
  setModelProviderEnabled: (providerId: string, enabled: boolean): Promise<void> =>
    invokeLogged('set_model_provider_enabled', { providerId, enabled }),
  testModelProvider: (apiKey: string, baseUrl: string): Promise<string> =>
    invokeLogged('test_model_provider', { apiKey, baseUrl }),
  providerUsableForAgent: (providerId: string, agentKind: AgentKind): Promise<boolean> =>
    invokeLogged('provider_usable_for_agent', { providerId, agentKind }),
  setDefaultAgentKind: (agentKind: AgentKind): Promise<void> =>
    invokeLogged('set_default_agent_kind', { agentKind }),
  updateAgentConfig: <T extends keyof AgentConfigUpdateMap>(
    agentKind: T,
    config: AgentConfigUpdateMap[T],
  ): Promise<void> => invokeLogged('update_agent_config', { agentKind, config }),
  setTheme: (theme: Theme): Promise<void> => invokeLogged('set_theme', { theme: theme.toLowerCase() }),
  setCompactAiOutput: (enabled: boolean): Promise<void> =>
    invokeLogged('set_compact_ai_output', { enabled }),
  setAttachmentEnrichment: (enrichment: ImageRecognitionConfig): Promise<void> =>
    invokeLogged('set_attachment_enrichment', { enrichment }),
  setNotificationSettings: (settings: NotificationSettings): Promise<void> =>
    invokeLogged('set_notification_settings', { settings }),
  setGitSettings: (settings: GitSettings): Promise<void> =>
    invokeLogged('set_git_settings', { settings }),
  setDefaultOpenTarget: (target: OpenTarget): Promise<void> =>
    invokeLogged('set_default_open_target', { target }),
  testProvider: (apiKey: string, baseUrl: string): Promise<string> =>
    invokeLogged('test_model_provider', { apiKey, baseUrl }),
  fetchProviderModels: (
    apiKey: string,
    baseUrl: string,
  ): Promise<Array<{ id: string; owned_by: string; name?: string | null }>> =>
    invokeLogged('fetch_provider_models', { apiKey, baseUrl }),
  fetchOpenCodeFreeModels: (): Promise<Array<{ id: string; owned_by: string; name?: string | null }>> =>
    invokeLogged('fetch_opencode_free_models'),
};

export const fileApi = {
  readFile: (path: string, basePath?: string): Promise<string> => invokeLogged('read_file', { path, basePath }),
  writeFile: (path: string, content: string, basePath?: string): Promise<void> =>
    invokeLogged('write_file', { path, content, basePath }),
  deleteFile: (path: string, basePath?: string): Promise<void> =>
    invokeLogged('delete_file', { path, basePath }),
  listDirectory: (
    path: string,
    depth?: number,
    basePath?: string,
    includeHidden = false,
  ): Promise<FileTreeNode[]> =>
    invokeLogged('list_directory', { path, depth, basePath, includeHidden }),
  openProjectPath: (path: string, target: OpenTarget): Promise<void> =>
    invokeLogged('open_project_path', { path, target }),
  readHomeFile: (relativePath: string): Promise<string> =>
    invokeLogged('read_home_file', { relativePath }),
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
  listWorktrees: (projectPath: string): Promise<GitWorktree[]> =>
    invokeLogged('list_git_worktrees', { projectPath }),
  createWorktree: (
    projectPath: string,
    branchName: string,
    baseBranch?: string | null,
  ): Promise<GitWorktree> =>
    invokeLogged('create_git_worktree', {
      projectPath,
      branchName,
      baseBranch: baseBranch ?? null,
    }),
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
  generatePullRequestDescription: (projectPath: string): Promise<GitPullRequestSuggestion> =>
    invokeLogged('generate_pull_request_description', { projectPath }),
  createPullRequest: (request: CreatePullRequestRequest): Promise<CreatePullRequestResult> =>
    invokeLogged('create_pull_request', { request }),
  getGiteeCredentialStatus: (): Promise<boolean> => invokeLogged('get_gitee_credential_status'),
  setGiteeToken: (token: string): Promise<void> => invokeLogged('set_gitee_token', { token }),
  clearGiteeToken: (): Promise<void> => invokeLogged('clear_gitee_token'),
};

export const terminalApi = {
  createChannel: (onEvent: (event: TerminalEvent) => void): Channel<string> => {
    const channel = new Channel<string>();
    channel.onmessage = (event: string) => {
      try {
        onEvent(JSON.parse(event) as TerminalEvent);
      } catch {
        onEvent({ type: 'error', terminalId: '', error: event });
      }
    };
    return channel;
  },
  start: (
    projectPath: string,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<string> => {
    const channel = terminalApi.createChannel(onEvent);
    return invokeLogged<string>('start_terminal_session', { projectPath, cols, rows, channel }).then((terminalId) => {
      terminalAttachmentStates.set(terminalId, true);
      return terminalId;
    });
  },
  attach: (
    terminalId: string,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<void> => {
    const channel = terminalApi.createChannel(onEvent);
    terminalAttachmentStates.set(terminalId, true);
    return queueTerminalLifecycle(terminalId, async () => {
      try {
        await invokeLogged('attach_terminal_session', { terminalId, cols, rows, channel });
      } catch (error) {
        terminalAttachmentStates.set(terminalId, false);
        throw error;
      }
    });
  },
  detach: (terminalId: string): Promise<void> => {
    terminalAttachmentStates.set(terminalId, false);
    return queueTerminalLifecycle(terminalId, async () => {
      if (terminalAttachmentStates.get(terminalId) === true) return;
      await invokeLogged('detach_terminal_session', { terminalId });
      terminalAttachmentStates.delete(terminalId);
    });
  },
  write: (terminalId: string, data: string): Promise<void> =>
    queueTerminalIo(terminalId, () =>
      invokeLogged('write_terminal_session', { terminalId, data }),
    ),
  resize: (terminalId: string, cols: number, rows: number): Promise<void> =>
    queueTerminalIo(terminalId, () =>
      invokeLogged('resize_terminal_session', { terminalId, cols, rows }),
    ),
  close: (terminalId: string): Promise<void> => {
    terminalAttachmentStates.delete(terminalId);
    return queueTerminalLifecycle(terminalId, () =>
      invokeLogged('close_terminal_session', { terminalId }),
    );
  },
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

export const scheduledTaskApi = {
  list: (): Promise<ScheduledTask[]> => invokeLogged('list_scheduled_tasks'),
  get: (taskId: string): Promise<ScheduledTask | null> => invokeLogged('get_scheduled_task', { taskId }),
  create: (input: ScheduledTaskInput): Promise<ScheduledTask> =>
    invokeLogged('create_scheduled_task', { input }),
  update: (taskId: string, input: ScheduledTaskInput): Promise<ScheduledTask> =>
    invokeLogged('update_scheduled_task', { taskId, input }),
  delete: (taskId: string): Promise<void> => invokeLogged('delete_scheduled_task', { taskId }),
  setEnabled: (taskId: string, enabled: boolean): Promise<ScheduledTask> =>
    invokeLogged('set_scheduled_task_enabled', { taskId, enabled }),
  listRuns: (taskId: string): Promise<TaskRun[]> =>
    invokeLogged('list_scheduled_task_runs', { taskId }),
  getTimezone: (): Promise<string> => invokeLogged('get_scheduled_task_timezone'),
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
  listProject: (projectRoot: string, agentKind: AgentKind, force = false): Promise<ProjectSkill[]> =>
    invokeLogged('list_project_skills', { projectRoot, agentKind, force }),
};

export interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  modified: string;
}

export type EnvironmentCheckStatus = 'ok' | 'warning' | 'missing' | 'error';

export type EnvironmentToolName = 'node' | 'npm' | 'git';

export interface EnvironmentToolCheck {
  name: 'Node.js' | 'npm' | 'Git';
  command: EnvironmentToolName;
  status: EnvironmentCheckStatus;
  version: string | null;
  path: string | null;
  message: string;
}

export interface DevelopmentEnvironmentCheck {
  checkedAt: string;
  tools: EnvironmentToolCheck[];
}

export type AgentRuntimeStatus = 'ok' | 'outdated' | 'missing' | 'error';

export type InstallSource =
  | 'nvm' | 'homebrew' | 'volta' | 'fnm' | 'mise'
  | 'bun' | 'pnpm' | 'scoop' | 'system' | 'unknown';

export interface AgentInstallation {
  path: string;
  real: string;
  version: string | null;
  runnable: boolean;
  error: string | null;
  source: InstallSource;
  isPathDefault: boolean;
}

export interface AgentInstallationReport {
  agentKind: string;
  installs: AgentInstallation[];
  isConflict: boolean;
  needsConfirmation: boolean;
  anchored: boolean;
  command: string | null;
}

export interface AgentRuntimeCheck {
  agentKind: string;
  label: string;
  command: string;
  status: AgentRuntimeStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  executablePath: string | null;
  configPath: string | null;
  npmPackage: string;
  message: string;
  installedButBroken: boolean;
}

export interface AgentRuntimeCheckResult {
  checkedAt: string;
  runtimes: AgentRuntimeCheck[];
}

export type UpgradeOutcome =
  | 'success'
  | 'soft_version_unchanged'
  | 'soft_not_runnable'
  | 'hard_failure';

export interface AgentRuntimeUpgradeResult {
  agentKind: string;
  success: boolean;
  outcome: UpgradeOutcome;
  message: string;
  newVersion: string | null;
}

// ----------------------------------------------------------------------------
// CodeMUX 托管 SDK Runtime 契约（与 Rust `runtime` 模块对齐）。
// 描述由 CodeMUX 自己管理、可验证、可回滚且与用户全局 CLI 解耦的 SDK Runtime。
// ----------------------------------------------------------------------------

/** CodeMUX 托管的 Provider Runtime 种类。 */
export type RuntimeProvider = 'claude_code' | 'codex' | 'opencode';

/** 目标平台。 */
export type RuntimePlatform = 'windows' | 'macos' | 'linux';

/** CPU 架构。 */
export type RuntimeArch = 'x64' | 'arm64';

/**
 * CodeMUX 自有 Runtime 状态。
 * 不得由外部 CLI 缺失推导为不可用。
 */
export type ManagedRuntimeStatus =
  | 'missing'
  | 'installing'
  | 'ready'
  | 'outdated'
  | 'corrupted'
  | 'node_unavailable'
  | 'error';

/** 安装 / 升级 / 修复流程的阶段。 */
export type RuntimeInstallStage =
  | 'resolving'
  | 'downloading'
  | 'verifying_integrity'
  | 'switching'
  | 'cleaning'
  | 'done'
  | 'failed';

/** Runtime 操作错误种类。 */
export type RuntimeErrorKind =
  | 'manifest_failed'
  | 'download_failed'
  | 'integrity_failed'
  | 'compatibility_failed'
  | 'permission_failed'
  | 'node_unavailable'
  | 'rollback_failed'
  | 'busy'
  | 'cancelled'
  | 'io_failed'
  | 'unknown';

/** 结构化 Runtime 错误。 */
export interface RuntimeErrorInfo {
  kind: RuntimeErrorKind;
  provider?: RuntimeProvider;
  stage?: RuntimeInstallStage;
  message: string;
  recoverable: boolean;
}

/** 安装进度。 */
export interface RuntimeInstallProgress {
  stage: RuntimeInstallStage;
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  message?: string;
}

/** Runtime 完整性校验结果。 */
export interface RuntimeIntegrityResult {
  ok: boolean;
  missingFiles: string[];
  missingBinaries: string[];
  message: string;
}

/** 系统 Node.js 检测结果。 */
export interface NodeDetection {
  available: boolean;
  version: string | null;
  executablePath: string | null;
  satisfiesMinimum: boolean;
  error: string | null;
}

/** 单个 Provider 的 Runtime 检测结果。 */
export interface ManagedRuntimeInfo {
  provider: RuntimeProvider;
  label: string;
  status: ManagedRuntimeStatus;
  currentVersion: string | null;
  installedVersions: string[];
  availableVersions: string[];
  installPath: string | null;
  runtimeRoot: string;
  integrityOk: boolean;
  message: string;
}

/** Node.js 检测信息（与 Rust `NodeInfo` 对齐）。 */
export interface ManagedNodeInfo {
  available: boolean;
  satisfiesMinimum: boolean;
  version: string | null;
  executablePath: string | null;
  error: string | null;
  npm: ManagedNpmInfo;
}

export interface ManagedNpmInfo {
  available: boolean;
  version: string | null;
  executablePath: string | null;
  matchesNode: boolean;
  error: string | null;
}

/** 一次托管 Runtime 检测的聚合结果。 */
export interface ManagedRuntimeCheckResult {
  checkedAt: string;
  node: ManagedNodeInfo;
  runtimes: ManagedRuntimeInfo[];
}

/** 安装 / 升级 / 修复操作的结果。 */
export interface ManagedRuntimeOperationResult {
  provider: RuntimeProvider;
  label: string;
  previousVersion: string | null;
  installedVersion: string;
  installPath: string;
  switched: boolean;
}

/** Runtime 安装进度事件 payload。 */
export interface RuntimeInstallProgressEvent {
  provider: RuntimeProvider;
  progress: RuntimeInstallProgress;
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
  checkAgentRuntimes: (): Promise<AgentRuntimeCheckResult> =>
    invokeLogged('check_agent_runtimes'),
  upgradeAgentRuntime: (agentKind: string): Promise<AgentRuntimeUpgradeResult> =>
    invokeLogged('upgrade_agent_runtime', { agentKind }),
  probeAgentInstallations: (agentKind: string): Promise<AgentInstallationReport> =>
    invokeLogged('probe_agent_installations', { agentKind }),
  checkManagedRuntimes: (): Promise<ManagedRuntimeCheckResult> =>
    invokeLogged('check_managed_runtimes'),
  listManagedRuntimeVersions: (provider: RuntimeProvider): Promise<string[]> =>
    invokeLogged('list_managed_runtime_versions', { provider }),
  refreshManagedRuntime: (provider: RuntimeProvider): Promise<ManagedRuntimeInfo> =>
    invokeLogged('refresh_managed_runtime', { provider }),
  installManagedRuntime: (provider: RuntimeProvider, version?: string): Promise<ManagedRuntimeOperationResult> =>
    invokeLogged('install_managed_runtime', { provider, version: version ?? null }),
  upgradeManagedRuntime: (provider: RuntimeProvider): Promise<ManagedRuntimeOperationResult | null> =>
    invokeLogged('upgrade_managed_runtime', { provider }),
  repairManagedRuntime: (provider: RuntimeProvider): Promise<ManagedRuntimeOperationResult | null> =>
    invokeLogged('repair_managed_runtime', { provider }),
  removeManagedRuntime: (provider: RuntimeProvider): Promise<void> =>
    invokeLogged('remove_managed_runtime', { provider }),
};

export const companionApi = {
  getStatus: (): Promise<CompanionStatus> => invokeLogged('get_companion_status'),
  setEnabled: (enabled: boolean): Promise<CompanionStatus> =>
    invokeLogged('set_companion_enabled', { enabled }),
  refreshPairingCode: (): Promise<CompanionStatus> =>
    invokeLogged('refresh_companion_pairing_code'),
  setRelayEnabled: (enabled: boolean): Promise<CompanionStatus> =>
    invokeLogged('set_companion_relay_enabled', { enabled }),
  setRelayConfig: (endpoint: string, useTls: boolean): Promise<CompanionStatus> =>
    invokeLogged('set_companion_relay_config', { endpoint, useTls }),
};

export const usageApi = {
  getStats: (agentKind?: string, days?: number): Promise<UsageStatsResponse> =>
    invokeLogged('get_usage_stats', { agentKind: agentKind ?? null, days: days ?? null }),
  getTokenBreakdown: (agentKind?: string, days?: number): Promise<TokenBreakdownResponse> =>
    invokeLogged('get_usage_token_breakdown', { agentKind: agentKind ?? null, days: days ?? null }),
};
