import type { AgentKind, Session, SessionMode } from '../../types/session';
import type { AgentPermissionConfig, AgentPlanMode } from '../agentPermissions';
import type { AgentInputAttachment, EnrichmentBlockResult } from '../../types/agentInput';
import type { AppConfig, Provider, ModelProvider } from '../../types/provider';
import type { CompanionStatus } from '../../types/companion';
import type { ImportCandidate, ImportSessionsRequest, ImportSessionsResult } from '../../types/historyImport';
import type { UsageStatsResponse, TokenBreakdownResponse } from '../../types/usage';
import type { Project } from '../../types/project';
import type { McpServer } from '../../types/mcp';
import type { ImportableSkill, ProjectSkill, Skill } from '../../types/skill';
import type { ScheduledTask, ScheduledTaskInput, TaskRun } from '../../types/scheduledTask';
import type {
  WorkTask,
  WorkTaskEvent,
  WorkTaskInput,
  WorkTaskPatch,
} from '../../types/workTask';
import type {
  GitChangedFile,
  GitStatusArea,
  GitStatusChange,
  GitRepositoryState,
  GitWorktree,
  GitCommitMessageSuggestion,
  GitPullRequestSuggestion,
  CreatePullRequestRequest,
  CreatePullRequestResult,
} from '../gitTypes';
import type { FileTreeNode } from '../workspaceTypes';
import type {
  ManagedRuntimeCheckResult,
  ManagedRuntimeInfo,
  ManagedRuntimeOperationResult,
} from '../runtimeTypes';
import type { DaemonClient, DaemonConnectionConfig } from '../daemon-client/client';
import { createDaemonClient } from '../daemon-client/client';
import { resolveDaemonConnectionConfig } from '../bootstrap';

let activeClient: DaemonClient | null = null;
let clientInitPromise: Promise<DaemonClient> | null = null;
let clientInitError: string | null = null;

export function getDaemonClientInitError(): string | null {
  return clientInitError;
}

export async function ensureDaemonClient(): Promise<DaemonClient> {
  if (activeClient) return activeClient;
  if (!clientInitPromise) {
    clientInitPromise = (async () => {
      // 工单 02:连接来源由宿主引导单入口决定(壳桥注入 / 浏览器配对档案)。
      const config: DaemonConnectionConfig = await resolveDaemonConnectionConfig();
      const client = createDaemonClient(config);
      await client.health().catch(() => {
        throw new Error('无法连接到 CodeMUX 后台服务，请稍后重试。');
      });
      activeClient = client;
      clientInitError = null;
      return activeClient;
    })().catch((error) => {
      clientInitError = String(error);
      clientInitPromise = null;
      throw error;
    });
  }
  return clientInitPromise;
}

export function resetDaemonClient(): void {
  activeClient = null;
  clientInitPromise = null;
}

/** Protocol-backed reads — issue 03+ */
export async function listSessionsViaDaemon(): Promise<Session[]> {
  const client = await ensureDaemonClient();
  return client.listSessions() as Promise<Session[]>;
}

export async function listArchivedSessionsViaDaemon(): Promise<Session[]> {
  const client = await ensureDaemonClient();
  return client.listArchivedSessions() as Promise<Session[]>;
}

export async function listProjectsViaDaemon(): Promise<Project[]> {
  const client = await ensureDaemonClient();
  return client.listProjects() as Promise<Project[]>;
}

export async function createProjectViaDaemon(name: string, path: string): Promise<Project> {
  const client = await ensureDaemonClient();
  return client.createProject(name, path) as Promise<Project>;
}

export async function deleteProjectViaDaemon(projectId: string): Promise<void> {
  const client = await ensureDaemonClient();
  await client.deleteProject(projectId);
}

export async function renameProjectViaDaemon(projectId: string, name: string): Promise<void> {
  const client = await ensureDaemonClient();
  await client.renameProject(projectId, name);
}

export async function forkClaudeViaDaemon(
  sessionId: string,
  forkEventId: string,
  forkProviderMessageId?: string,
  title?: string,
): Promise<Session> {
  const client = await ensureDaemonClient();
  return client.forkSession(sessionId, {
    agentKind: 'claude_code',
    forkEventId,
    forkProviderMessageId,
    title,
  }) as Promise<Session>;
}

async function forkSessionViaDaemon(
  sessionId: string,
  agentKind: AgentKind,
  forkEventId: string,
  forkProviderMessageId?: string,
  forkProviderTurnId?: string,
  forkProviderTurnOrdinal?: number,
): Promise<Session> {
  const client = await ensureDaemonClient();
  return client.forkSession(sessionId, {
    agentKind,
    forkEventId,
    forkProviderMessageId,
    forkProviderTurnId,
    forkProviderTurnOrdinal,
  }) as Promise<Session>;
}

export const mcpViaDaemon = {
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

export const skillsViaDaemon = {
  listInstalled: async () => (await ensureDaemonClient()).skillsList() as Promise<Skill[]>,
  listImportable: async () =>
    (await ensureDaemonClient()).skillsListImportable() as Promise<ImportableSkill[]>,
  uninstall: async (id: string) => (await ensureDaemonClient()).skillsUninstall(id),
  toggleApp: async (skillId: string, app: string, enabled: boolean) => {
    await (await ensureDaemonClient()).skillsToggleApp(skillId, app, enabled);
  },
  getContent: async (id: string) => (await ensureDaemonClient()).skillsGetContent(id),
  syncBuiltins: async () => (await ensureDaemonClient()).skillsSync() as Promise<Skill[]>,
  registerFromDisk: async (name: string) =>
    (await ensureDaemonClient()).skillsRegister(name) as Promise<Skill>,
  importFromApps: async (selected?: string[] | null) =>
    (await ensureDaemonClient()).skillsImport(selected),
  listProject: async (projectRoot: string, agentKind: AgentKind, force = false) =>
    (await ensureDaemonClient()).skillsListProject(projectRoot, agentKind, force) as Promise<
      ProjectSkill[]
    >,
};

export const scheduledTasksViaDaemon = {
  list: async () => (await ensureDaemonClient()).scheduledList() as Promise<ScheduledTask[]>,
  get: async (taskId: string) =>
    (await ensureDaemonClient()).scheduledGet(taskId) as Promise<ScheduledTask | null>,
  create: async (input: ScheduledTaskInput) =>
    (await ensureDaemonClient()).scheduledCreate(input) as Promise<ScheduledTask>,
  update: async (taskId: string, input: ScheduledTaskInput) =>
    (await ensureDaemonClient()).scheduledUpdate(taskId, input) as Promise<ScheduledTask>,
  delete: async (taskId: string) => {
    await (await ensureDaemonClient()).scheduledDelete(taskId);
  },
  setEnabled: async (taskId: string, enabled: boolean) =>
    (await ensureDaemonClient()).scheduledSetEnabled(taskId, enabled) as Promise<ScheduledTask>,
  listRuns: async (taskId: string) =>
    (await ensureDaemonClient()).scheduledListRuns(taskId) as Promise<TaskRun[]>,
  runNow: async (taskId: string) =>
    (await ensureDaemonClient()).scheduledRunNow(taskId) as Promise<TaskRun>,
  deleteRun: async (runId: string) => {
    await (await ensureDaemonClient()).scheduledDeleteRun(runId);
  },
  getTimezone: async () => (await ensureDaemonClient()).scheduledGetTimezone(),
};

export const workTasksViaDaemon = {
  list: async () => (await ensureDaemonClient()).workTaskList() as Promise<WorkTask[]>,
  get: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskGet(taskId) as Promise<WorkTask | null>,
  create: async (input: WorkTaskInput) =>
    (await ensureDaemonClient()).workTaskCreate(input) as Promise<WorkTask>,
  update: async (taskId: string, patch: WorkTaskPatch) =>
    (await ensureDaemonClient()).workTaskUpdate(taskId, patch) as Promise<WorkTask>,
  delete: async (taskId: string) => {
    await (await ensureDaemonClient()).workTaskDelete(taskId);
  },
  archive: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskArchive(taskId) as Promise<WorkTask>,
  unarchive: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskUnarchive(taskId) as Promise<WorkTask>,
  reorder: async (projectId: string, ids: string[]) => {
    await (await ensureDaemonClient()).workTaskReorder(projectId, ids);
  },
  start: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskStart(taskId) as Promise<WorkTask>,
  cancel: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskCancel(taskId) as Promise<WorkTask>,
  retry: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskRetry(taskId) as Promise<WorkTask>,
  restart: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskRestart(taskId) as Promise<WorkTask>,
  merge: async (taskId: string, message?: string) =>
    (await ensureDaemonClient()).workTaskMerge(taskId, message) as Promise<WorkTask>,
  complete: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskComplete(taskId) as Promise<WorkTask>,
  /** 任务时间线（GET /work-tasks/{id}/events）。 */
  listEvents: async (taskId: string) =>
    (await ensureDaemonClient()).workTaskListEvents(taskId) as Promise<WorkTaskEvent[]>,
};

export const gitViaDaemon = {
  getChangedFiles: async (projectPath: string, baselineTree: string) =>
    (await ensureDaemonClient()).gitChangedFiles(projectPath, baselineTree) as Promise<GitChangedFile[]>,
  getChangedFilesSinceHead: async (projectPath: string) =>
    (await ensureDaemonClient()).gitChangedFilesSinceHead(projectPath) as Promise<GitChangedFile[]>,
  getRepositoryState: async (projectPath: string) =>
    (await ensureDaemonClient()).gitRepositoryState(projectPath) as Promise<GitRepositoryState>,
  getStatusChanges: async (
    projectPath: string,
    area: GitStatusArea,
  ) => (await ensureDaemonClient()).gitStatusChanges(projectPath, area) as Promise<GitStatusChange[]>,
  getStatusChangeDetail: async (
    projectPath: string,
    area: GitStatusArea,
    filePath: string,
  ) =>
    (await ensureDaemonClient()).gitStatusChangeDetail(projectPath, area, filePath) as Promise<GitStatusChange>,
  stageStatusChanges: async (projectPath: string, filePath?: string) => {
    await (await ensureDaemonClient()).gitStage(projectPath, filePath);
  },
  unstageStatusChanges: async (projectPath: string, filePath?: string) => {
    await (await ensureDaemonClient()).gitUnstage(projectPath, filePath);
  },
  revertStatusChanges: async (
    projectPath: string,
    area: GitStatusArea,
    filePath?: string,
  ) => {
    await (await ensureDaemonClient()).gitRevert(projectPath, area, filePath);
  },
  createBranch: async (projectPath: string, branchName: string, checkout: boolean) => {
    await (await ensureDaemonClient()).gitCreateBranch(projectPath, branchName, checkout);
  },
  checkoutBranch: async (projectPath: string, branchName: string) => {
    await (await ensureDaemonClient()).gitCheckoutBranch(projectPath, branchName);
  },
  listWorktrees: async (projectPath: string) =>
    (await ensureDaemonClient()).gitListWorktrees(projectPath) as Promise<GitWorktree[]>,
  createWorktree: async (
    projectPath: string,
    branchName: string,
    baseBranch?: string | null,
  ) => (await ensureDaemonClient()).gitCreateWorktree(projectPath, branchName, baseBranch) as Promise<GitWorktree>,
  commitChanges: async (projectPath: string, message: string) => {
    const result = await (await ensureDaemonClient()).gitCommit(projectPath, message);
    return result.commit;
  },
  pushBranch: async (projectPath: string) => {
    await (await ensureDaemonClient()).gitPush(projectPath);
  },
  generateCommitMessage: async (projectPath: string) =>
    (await ensureDaemonClient()).gitGenerateCommitMessage(projectPath) as Promise<GitCommitMessageSuggestion>,
  generatePullRequestDescription: async (projectPath: string) =>
    (await ensureDaemonClient()).gitGeneratePullRequestDescription(projectPath) as Promise<GitPullRequestSuggestion>,
  createPullRequest: async (request: CreatePullRequestRequest) =>
    (await ensureDaemonClient()).gitCreatePullRequest(request) as Promise<CreatePullRequestResult>,
  getGiteeCredentialStatus: async () => {
    const result = await (await ensureDaemonClient()).gitGiteeCredentialStatus();
    return result.configured;
  },
  setGiteeToken: async (token: string) => {
    await (await ensureDaemonClient()).gitSetGiteeToken(token);
  },
  clearGiteeToken: async () => {
    await (await ensureDaemonClient()).gitClearGiteeToken();
  },
};

export const providersViaDaemon = {
  listBuiltinProviderTemplates: async () => (await ensureDaemonClient()).providersTemplates(),
  instantiateBuiltinProviderTemplate: async (templateId: string) =>
    (await ensureDaemonClient()).providersInstantiateTemplate(templateId),
  upsertModelProvider: async (provider: Provider | ModelProvider) => {
    await (await ensureDaemonClient()).providersUpsert(provider);
  },
  deleteModelProvider: async (providerId: string) => {
    await (await ensureDaemonClient()).providersDelete(providerId);
  },
  setActiveModelProvider: async (providerId: string) => {
    await (await ensureDaemonClient()).providersSetActive(providerId);
  },
  setModelProviderEnabled: async (providerId: string, enabled: boolean) => {
    await (await ensureDaemonClient()).providersSetEnabled(providerId, enabled);
  },
  testModelProvider: async (apiKey: string, baseUrl: string) => {
    const result = await (await ensureDaemonClient()).providersTest(apiKey, baseUrl);
    return result.message;
  },
  providerUsableForAgent: async (providerId: string, agentKind: AgentKind) => {
    const result = await (await ensureDaemonClient()).providersUsable(providerId, agentKind);
    return result.usable;
  },
  fetchProviderModels: async (apiKey: string, baseUrl: string) =>
    (await ensureDaemonClient()).providersFetchModels(apiKey, baseUrl),
  fetchOpenCodeFreeModels: async () =>
    (await ensureDaemonClient()).providersFetchOpenCodeFreeModels(),
  lookupModelCatalog: async (model: string, provider?: string | null) =>
    (await ensureDaemonClient()).providersLookupModelCatalog(model, provider),
  fetchModelCatalogNames: async () =>
    (await ensureDaemonClient()).providersFetchModelCatalogNames(),
};

export type { TerminalEvent } from '../daemon-client/terminal';

export const companionViaDaemon = {
  // Companion(移动伴侣配对):走 daemon client 的 /api/companion/* 管理面
  // (daemon 限回环来源 + Local Daemon Token)。
  getStatus: async (): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionGetStatus() as Promise<CompanionStatus>,
  setEnabled: async (enabled: boolean): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionSetEnabled(enabled) as Promise<CompanionStatus>,
  refreshPairingCode: async (): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionRefreshPairingCode() as Promise<CompanionStatus>,
  setRelayEnabled: async (enabled: boolean): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionSetRelayEnabled(enabled) as Promise<CompanionStatus>,
  setRelayConfig: async (endpoint: string, useTls: boolean): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionSetRelayConfig(endpoint, useTls) as Promise<CompanionStatus>,
};

export const terminalViaDaemon = {
  start: async (
    projectPath: string,
    cols: number,
    rows: number,
    onEvent: (event: import('../daemon-client/terminal').TerminalEvent) => void,
  ) => (await ensureDaemonClient()).terminalStart(projectPath, cols, rows, onEvent),
  attach: async (
    terminalId: string,
    cols: number,
    rows: number,
    onEvent: (event: import('../daemon-client/terminal').TerminalEvent) => void,
  ) => (await ensureDaemonClient()).terminalAttach(terminalId, cols, rows, onEvent),
  detach: async (terminalId: string) => (await ensureDaemonClient()).terminalDetach(terminalId),
  write: async (terminalId: string, data: string) =>
    (await ensureDaemonClient()).terminalWrite(terminalId, data),
  resize: async (terminalId: string, cols: number, rows: number) =>
    (await ensureDaemonClient()).terminalResize(terminalId, cols, rows),
  close: async (terminalId: string) => (await ensureDaemonClient()).terminalClose(terminalId),
};

export const daemonFacade = {
  // --- Protocol-backed (daemon client) ---
  ensureClient: ensureDaemonClient,
  resetClient: resetDaemonClient,
  /** 回环浏览器配对确认(工单 02):桌面壳弹一次确认后调用。 */
  decideLocalPairing: async (requestId: string, approve: boolean) => {
    await (await ensureDaemonClient()).decideLocalPairing(requestId, approve);
  },
  getInitError: getDaemonClientInitError,
  listSessions: listSessionsViaDaemon,
  listArchivedSessions: listArchivedSessionsViaDaemon,
  listProjects: listProjectsViaDaemon,
  createProject: createProjectViaDaemon,
  deleteProject: deleteProjectViaDaemon,
  renameProject: renameProjectViaDaemon,
  isSessionTurnActive: async (sessionId: string) => {
    const state = await (await ensureDaemonClient()).getSessionRuntimeState(sessionId);
    return state.running;
  },
  getBootstrap: async () => (await ensureDaemonClient()).getBootstrap(),
  getTimeline: async (
    sessionId: string,
    query?: { direction?: 'tail' | 'after' | 'before'; cursor?: number; limit?: number },
  ) => (await ensureDaemonClient()).getTimeline(sessionId, query),
  subscribeSession: async (
    sessionId: string,
    handlers: {
      onEvent: (event: unknown) => void;
      onState?: (running: boolean) => void;
      onReconnect?: () => void;
    },
  ) => (await ensureDaemonClient()).subscribeSession(sessionId, handlers),

  createSessionViaDaemon: async (body: Record<string, unknown>) =>
    (await ensureDaemonClient()).createSession(body),
  sendMessageViaDaemon: async (
    sessionId: string,
    prompt: string,
    inputPayload?: unknown,
    options?: { delivery?: 'steer'; requestId?: string },
  ) => (await ensureDaemonClient()).sendMessage(sessionId, prompt, inputPayload, options),
  interruptViaDaemon: async (sessionId: string) =>
    (await ensureDaemonClient()).interruptSession(sessionId),
  respondToPermissionViaDaemon: async (sessionId: string, requestId: string, response: unknown) =>
    (await ensureDaemonClient()).respondToPermission(sessionId, requestId, response),
  respondToInteractiveViaDaemon: async (sessionId: string, toolUseId: string, response: unknown) =>
    (await ensureDaemonClient()).respondToInteractive(sessionId, toolUseId, response),
  updateSessionSettingsViaDaemon: async (sessionId: string, settings: Record<string, unknown>) =>
    (await ensureDaemonClient()).updateSessionSettings(sessionId, settings),
  archiveViaDaemon: async (sessionId: string) =>
    (await ensureDaemonClient()).archiveSession(sessionId),
  unarchiveViaDaemon: async (sessionId: string) =>
    (await ensureDaemonClient()).unarchiveSession(sessionId),
  patchSessionViaDaemon: async (sessionId: string, patch: Record<string, unknown>) =>
    (await ensureDaemonClient()).patchSession(sessionId, patch),
  forkClaudeViaDaemon,

  // --- Invoke-backed (migrating in later issues) ---
  createSession: async (
    title: string,
    agentKind: AgentKind,
    mode?: SessionMode,
    projectId?: string,
    permissionConfig?: AgentPermissionConfig,
    planMode?: AgentPlanMode,
    model?: string,
  ) =>
    (await ensureDaemonClient()).createSession({
      title,
      agentKind,
      mode: mode ?? 'chat',
      projectId: projectId ?? null,
      permissionConfig: permissionConfig ? JSON.stringify(permissionConfig) : null,
      planMode: planMode ?? null,
      model: model ?? null,
    }) as unknown as Session,
  deleteSession: async (sessionId: string) => {
    await (await ensureDaemonClient()).deleteSession(sessionId);
  },
  forkClaude: forkClaudeViaDaemon,
  forkCodex: (
    sessionId: string,
    forkEventId: string,
    forkProviderMessageId?: string,
    forkProviderTurnId?: string,
    forkProviderTurnOrdinal?: number,
  ) =>
    forkSessionViaDaemon(
      sessionId,
      'codex',
      forkEventId,
      forkProviderMessageId,
      forkProviderTurnId,
      forkProviderTurnOrdinal,
    ),
  forkOpenCode: (sessionId: string, forkEventId: string, forkProviderMessageId?: string) =>
    forkSessionViaDaemon(sessionId, 'opencode', forkEventId, forkProviderMessageId),
  forkPi: (sessionId: string, forkEventId: string, forkProviderMessageId?: string) =>
    forkSessionViaDaemon(sessionId, 'pi', forkEventId, forkProviderMessageId),
  setPinned: async (sessionId: string, pinned: boolean) => {
    await (await ensureDaemonClient()).patchSession(sessionId, { pinned });
  },
  setReadOnly: async (sessionId: string, readOnly: boolean) => {
    await (await ensureDaemonClient()).patchSession(sessionId, { readOnly });
  },
  updateTitle: async (sessionId: string, title: string) => {
    await (await ensureDaemonClient()).patchSession(sessionId, { title });
  },
  // 工作路径变化时守护进程顺带采样「启动分支」，返回整条会话供调用方回填。
  updateWorkingPath: async (sessionId: string, workingPath: string): Promise<Session | null> => {
    const updated = await (await ensureDaemonClient()).patchSession(sessionId, { workingPath });
    return (updated as Session | null) ?? null;
  },
  touchSession: async (sessionId: string) => {
    await (await ensureDaemonClient()).patchSession(sessionId, { touch: true });
  },
  updateProvider: async (
    sessionId: string,
    providerId: string | null | undefined,
    model: string,
    reasoningEffort?: string | null,
  ) => {
    await (await ensureDaemonClient()).patchSession(sessionId, {
      providerId,
      model,
      reasoningEffort,
    });
  },
  updateReasoningEffort: async (sessionId: string, reasoningEffort: string) => {
    await (await ensureDaemonClient()).patchSession(sessionId, { reasoningEffort });
  },
  updatePermissions: async (
    sessionId: string,
    permissionConfig?: AgentPermissionConfig,
    planMode?: AgentPlanMode,
  ) => {
    await (await ensureDaemonClient()).patchSession(sessionId, {
      permissionConfig: permissionConfig ? JSON.stringify(permissionConfig) : null,
      planMode: planMode ?? null,
    });
  },

  ensureAgentSession: async (
    sessionId: string,
    cwd: string,
    _onEvent?: (event: string) => void,
    reasoningEffort?: string | null,
  ) => {
    await (await ensureDaemonClient()).ensureAgentSession(sessionId, cwd, reasoningEffort);
  },
  enrichAttachments: async (attachments: AgentInputAttachment[]): Promise<{ blocks: EnrichmentBlockResult[] }> => {
    const response = await (await ensureDaemonClient()).enrichAttachments(attachments);
    return response as { blocks: EnrichmentBlockResult[] };
  },
  interruptAgent: async (sessionId: string) => {
    await (await ensureDaemonClient()).interruptSession(sessionId);
  },
  shutdownAgent: async (sessionId: string) => {
    await (await ensureDaemonClient()).shutdownAgent(sessionId);
  },
  resetAgentSession: async (sessionId: string) => {
    await (await ensureDaemonClient()).resetAgentSession(sessionId);
  },
  sendToolResponse: async (sessionId: string, toolUseId: string, response: unknown) => {
    await (await ensureDaemonClient()).respondToInteractive(sessionId, toolUseId, response);
  },
  respondToAgentPermission: async (
    sessionId: string,
    requestId: string,
    response: 'once' | 'always' | 'reject',
  ) => {
    await (await ensureDaemonClient()).respondToPermission(sessionId, requestId, response);
  },
  deleteClaudeSessionFiles: async (sessionId: string) => {
    const result = await (await ensureDaemonClient()).deleteSessionNativeFiles(sessionId, 'claude_code');
    return result.deleted;
  },
  deleteCodexSessionFiles: async (sessionId: string) => {
    const result = await (await ensureDaemonClient()).deleteSessionNativeFiles(sessionId, 'codex');
    return result.deleted;
  },
  loadClaudeSessionEvents: async (sessionId: string) => {
    const page = await (await ensureDaemonClient()).getTimeline(sessionId);
    return page.events as Record<string, unknown>[];
  },
  loadCodexSessionEvents: async (sessionId: string) => {
    const page = await (await ensureDaemonClient()).getTimeline(sessionId);
    return page.events as Record<string, unknown>[];
  },
  loadOpenCodeSessionEvents: async (sessionId: string) => {
    const page = await (await ensureDaemonClient()).getTimeline(sessionId);
    return page.events as Record<string, unknown>[];
  },
  loadSessionEvents: async (sessionId: string) => {
    const page = await (await ensureDaemonClient()).getTimeline(sessionId);
    return page.events as Record<string, unknown>[];
  },
  loadSessionSubagents: async (sessionId: string) => {
    const payload = await (await ensureDaemonClient()).loadSessionSubagents(sessionId);
    return payload as {
      subagents: Array<Record<string, unknown>>;
      timelines: Record<string, Array<Record<string, unknown>>>;
    };
  },
  resyncSessionFromNative: async (sessionId: string) =>
    (await ensureDaemonClient()).resyncSessionFromNative(sessionId),
  deleteOpenCodeSession: async (sessionId: string) => {
    await (await ensureDaemonClient()).deleteSessionNativeFiles(sessionId, 'opencode');
  },
  loadLatestTokenUsage: async (
    sessionId: string,
    agentKind: string,
    freshness?: string,
  ) => (await ensureDaemonClient()).loadLatestTokenUsage(sessionId, agentKind, freshness),

  getSessionInfo: async (sessionId: string, agentKind: string) => {
    const info = await (await ensureDaemonClient()).getAgentSessionInfo(sessionId, agentKind);
    return {
      agentSessionId: info.agentSessionId ?? null,
      messagePath: info.messagePath ?? null,
    };
  },
  rewindSession: async (
    sessionId: string,
    agentKind: string,
    target?: unknown,
    mode?: string,
  ) =>
    (await ensureDaemonClient()).rewindSession(sessionId, {
      agentKind,
      target,
      mode,
    }),

  getConfig: async (): Promise<AppConfig> =>
    (await ensureDaemonClient()).getAppConfig() as Promise<AppConfig>,
  setActiveProvider: providersViaDaemon.setActiveModelProvider,
  listBuiltinProviderTemplates: providersViaDaemon.listBuiltinProviderTemplates,
  instantiateBuiltinProviderTemplate: providersViaDaemon.instantiateBuiltinProviderTemplate,
  upsertModelProvider: providersViaDaemon.upsertModelProvider,
  deleteModelProvider: providersViaDaemon.deleteModelProvider,
  setModelProviderEnabled: providersViaDaemon.setModelProviderEnabled,
  testModelProvider: providersViaDaemon.testModelProvider,
  providerUsableForAgent: providersViaDaemon.providerUsableForAgent,
  setDefaultAgentKind: async (agentKind: AgentKind) => {
    await (await ensureDaemonClient()).patchAppConfig({ defaultAgentKind: agentKind });
  },
  updateAgentConfig: async <T extends keyof import('../../types/provider').AgentConfigMap>(
    agentKind: T,
    config: import('../../types/provider').AgentConfigUpdateMap[T],
  ) => {
    await (await ensureDaemonClient()).patchAppConfig({ agentKind, agentConfig: config });
  },
  setTheme: async (theme: import('../../types/provider').Theme) => {
    await (await ensureDaemonClient()).patchAppConfig({ theme: theme.toLowerCase() });
  },
  setCompactAiOutput: async (enabled: boolean) => {
    await (await ensureDaemonClient()).patchAppConfig({ compactAiOutput: enabled });
  },
  setImmediateRunMode: async (mode: import('../../types/provider').ImmediateRunMode) => {
    await (await ensureDaemonClient()).patchAppConfig({ immediateRunMode: mode });
  },
  setAttachmentEnrichment: async (enrichment: import('../../types/provider').ImageRecognitionConfig) => {
    await (await ensureDaemonClient()).patchAppConfig({ attachmentEnrichment: enrichment });
  },
  setNotificationSettings: async (settings: import('../../types/provider').NotificationSettings) => {
    await (await ensureDaemonClient()).patchAppConfig({ notifications: settings });
  },
  setGitSettings: async (settings: import('../../types/provider').GitSettings) => {
    await (await ensureDaemonClient()).patchAppConfig({ git: settings });
  },
  setKeybindings: async (keybindings: import('../../types/provider').KeybindingsSettings) => {
    await (await ensureDaemonClient()).patchAppConfig({ keybindings });
  },
  setDefaultOpenTarget: async (target: import('../openTargets').OpenTarget) => {
    await (await ensureDaemonClient()).patchAppConfig({ defaultOpenTarget: target });
  },
  setBrowserControl: async (settings: import('../../types/provider').BrowserControlSettings) => {
    await (await ensureDaemonClient()).patchAppConfig({ browser: settings });
  },
  fetchProviderModels: async (apiKey: string, baseUrl: string) =>
    providersViaDaemon.fetchProviderModels(apiKey, baseUrl),
  fetchOpenCodeFreeModels: () => providersViaDaemon.fetchOpenCodeFreeModels(),
  lookupModelCatalog: (model: string, provider?: string | null) =>
    providersViaDaemon.lookupModelCatalog(model, provider),
  fetchModelCatalogNames: () => providersViaDaemon.fetchModelCatalogNames(),

  readFile: async (path: string, basePath?: string) =>
    (await ensureDaemonClient()).readWorkspaceFile(path, basePath),
  writeFile: async (path: string, content: string, basePath?: string) => {
    await (await ensureDaemonClient()).writeWorkspaceFile(path, content, basePath);
  },
  deleteFile: async (path: string, basePath?: string) => {
    await (await ensureDaemonClient()).deleteWorkspaceFile(path, basePath);
  },
  listDirectory: async (
    path: string,
    depth?: number,
    basePath?: string,
    includeHidden = false,
  ) =>
    (await ensureDaemonClient()).listWorkspaceDirectory(
      path,
      depth,
      basePath,
      includeHidden,
    ) as Promise<FileTreeNode[]>,
  openProjectPath: (path: string, target: import('../openTargets').OpenTarget) =>
    import('./shell-facade').then(({ shellFacade }) => shellFacade.openProjectPath(path, target)),
  readHomeFile: (fileName: string) =>
    import('./shell-facade').then(({ shellFacade }) => shellFacade.readHomeFile(fileName)),

  git: gitViaDaemon,
  terminal: terminalViaDaemon,
  mcp: mcpViaDaemon,
  workTasks: workTasksViaDaemon,
  skills: skillsViaDaemon,
  scheduledTasks: scheduledTasksViaDaemon,
  historyImport: {
    discover: async (agentKind?: AgentKind): Promise<ImportCandidate[]> => {
      const client = await ensureDaemonClient();
      return client.discoverHistoryImportCandidates(agentKind) as Promise<ImportCandidate[]>;
    },
    import: async (request: ImportSessionsRequest): Promise<ImportSessionsResult> => {
      const client = await ensureDaemonClient();
      // `ImportSessionsRequest` is an interface, so it has no implicit index
      // signature; spread it into a plain record for the transport layer.
      return client.importHistorySessions({ ...request }) as Promise<ImportSessionsResult>;
    },
  },
  usage: {
    getStats: async (agentKind?: string, days?: number): Promise<UsageStatsResponse> =>
      (await ensureDaemonClient()).usageGetStats(agentKind, days) as Promise<UsageStatsResponse>,
    getTokenBreakdown: async (agentKind?: string, days?: number): Promise<TokenBreakdownResponse> =>
      (await ensureDaemonClient()).usageGetTokenBreakdown(agentKind, days) as Promise<TokenBreakdownResponse>,
  },

  checkManagedRuntimes: async (): Promise<ManagedRuntimeCheckResult> =>
    (await ensureDaemonClient()).checkManagedRuntimes() as Promise<ManagedRuntimeCheckResult>,

  managedRuntime: {
    listVersions: async (provider: string): Promise<string[]> =>
      (await ensureDaemonClient()).managedRuntimeListVersions(provider) as Promise<string[]>,
    refresh: async (provider: string): Promise<ManagedRuntimeInfo> =>
      (await ensureDaemonClient()).managedRuntimeRefresh(provider) as Promise<ManagedRuntimeInfo>,
    install: async (provider: string, version?: string): Promise<ManagedRuntimeOperationResult> =>
      (await ensureDaemonClient()).managedRuntimeInstall(provider, version) as Promise<ManagedRuntimeOperationResult>,
    upgrade: async (provider: string): Promise<ManagedRuntimeOperationResult | null> =>
      (await ensureDaemonClient()).managedRuntimeUpgrade(provider) as Promise<ManagedRuntimeOperationResult | null>,
    repair: async (provider: string): Promise<ManagedRuntimeOperationResult | null> =>
      (await ensureDaemonClient()).managedRuntimeRepair(provider) as Promise<ManagedRuntimeOperationResult | null>,
    remove: async (provider: string) => {
      await (await ensureDaemonClient()).managedRuntimeRemove(provider);
    },
  },

  // Companion(移动伴侣配对):走 daemon client 的 /api/companion/* 面
  // (daemon 限回环来源 + Local Daemon Token)。
  getCompanionStatus: (): Promise<CompanionStatus> =>
    companionViaDaemon.getStatus(),
  setCompanionEnabled: (enabled: boolean): Promise<CompanionStatus> =>
    companionViaDaemon.setEnabled(enabled),
  refreshCompanionPairingCode: (): Promise<CompanionStatus> =>
    companionViaDaemon.refreshPairingCode(),
  setCompanionRelayEnabled: (enabled: boolean): Promise<CompanionStatus> =>
    companionViaDaemon.setRelayEnabled(enabled),
  setCompanionRelayConfig: (endpoint: string, useTls: boolean): Promise<CompanionStatus> =>
    companionViaDaemon.setRelayConfig(endpoint, useTls),
};

export type DaemonFacade = typeof daemonFacade;
