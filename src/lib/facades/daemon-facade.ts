import type { AgentKind, Session, SessionMode } from '../../types/session';
import type { AgentPermissionConfig, AgentPlanMode } from '../agentPermissions';
import type { CompanionStatus } from '../../types/companion';

import {
  agentApi,
  companionApi,
  configApi,
  fileApi,
  gitApi,
  historyImportApi,
  mcpApi,
  sessionApi,
  usageApi,
} from './invoke-backend';
import type { Project } from '../../types/project';
import type { McpServer } from '../../types/mcp';
import type { ImportableSkill, ProjectSkill, Skill } from '../../types/skill';
import type { ScheduledTask, ScheduledTaskInput, TaskRun } from '../../types/scheduledTask';
import type { FileTreeNode } from '../tauri';
import type { DaemonClient, DaemonConnectionConfig } from '../daemon-client/client';
import { createDaemonClient, resolveDesktopDaemonConfig } from '../daemon-client/client';
import { desktopBridge, isElectronDesktop } from '../desktop-bridge';

let activeClient: DaemonClient | null = null;
let clientInitPromise: Promise<DaemonClient> | null = null;
let clientInitError: string | null = null;

export function getDaemonClientInitError(): string | null {
  return clientInitError;
}

async function resolveElectronDaemonConfig(): Promise<DaemonConnectionConfig> {
  // Electron 壳(工单 05):token 读 app-data-dir/local-daemon-token,
  // 端口来自 main 侧 supervisor(run-state / spawn 结果)。
  const bridge = desktopBridge;
  if (!bridge) {
    throw new Error('codemuxDesktop 桥不可用(Electron preload 未注入)');
  }
  const [token, info] = await Promise.all([bridge.getLocalDaemonToken(), bridge.getDaemonInfo()]);
  if (!info.port) {
    throw new Error('本机 Daemon 未就绪，请稍后重试或重启应用。');
  }
  return { baseUrl: `http://127.0.0.1:${info.port}`, token };
}

export async function ensureDaemonClient(): Promise<DaemonClient> {
  if (activeClient) return activeClient;
  if (!clientInitPromise) {
    clientInitPromise = (async () => {
      const config = isElectronDesktop()
        ? await resolveElectronDaemonConfig()
        : await resolveDesktopDaemonConfig(
          () => invokeLocalDaemonToken(),
          () => companionApi.getStatus(),
        );
      const health = await fetch(`${config.baseUrl}/api/health`);
      if (!health.ok) {
        throw new Error('本机 Daemon 未就绪，请稍后重试或重启应用。');
      }
      activeClient = createDaemonClient(config);
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

async function invokeLocalDaemonToken(): Promise<string> {
  if (isElectronDesktop() && desktopBridge) {
    // Electron 壳(工单 05):读 app-data-dir/local-daemon-token(preload 桥)。
    return desktopBridge.getLocalDaemonToken();
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('get_local_daemon_token');
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
  upsert: async (server: Parameters<typeof mcpApi.upsert>[0]) => {
    await (await ensureDaemonClient()).mcpUpsert(server);
  },
  delete: async (id: string) => {
    await (await ensureDaemonClient()).mcpDelete(id);
  },
  toggleApp: async (serverId: string, app: string, enabled: boolean) => {
    await (await ensureDaemonClient()).mcpToggleApp(serverId, app, enabled);
  },
  probe: async (id: string) => (await ensureDaemonClient()).mcpProbe(id),
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

export const gitViaDaemon = {
  getChangedFiles: async (projectPath: string, baselineTree: string) =>
    (await ensureDaemonClient()).gitChangedFiles(projectPath, baselineTree),
  getChangedFilesSinceHead: async (projectPath: string) =>
    (await ensureDaemonClient()).gitChangedFilesSinceHead(projectPath),
  getRepositoryState: async (projectPath: string) =>
    (await ensureDaemonClient()).gitRepositoryState(projectPath),
  getStatusChanges: async (
    projectPath: string,
    area: Parameters<typeof gitApi.getStatusChanges>[1],
  ) => (await ensureDaemonClient()).gitStatusChanges(projectPath, area),
  getStatusChangeDetail: async (
    projectPath: string,
    area: Parameters<typeof gitApi.getStatusChangeDetail>[1],
    filePath: string,
  ) => (await ensureDaemonClient()).gitStatusChangeDetail(projectPath, area, filePath),
  stageStatusChanges: async (projectPath: string, filePath?: string) => {
    await (await ensureDaemonClient()).gitStage(projectPath, filePath);
  },
  unstageStatusChanges: async (projectPath: string, filePath?: string) => {
    await (await ensureDaemonClient()).gitUnstage(projectPath, filePath);
  },
  revertStatusChanges: async (
    projectPath: string,
    area: Parameters<typeof gitApi.revertStatusChanges>[1],
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
    (await ensureDaemonClient()).gitListWorktrees(projectPath),
  createWorktree: async (
    projectPath: string,
    branchName: string,
    baseBranch?: string | null,
  ) => (await ensureDaemonClient()).gitCreateWorktree(projectPath, branchName, baseBranch),
  commitChanges: async (projectPath: string, message: string) => {
    const result = await (await ensureDaemonClient()).gitCommit(projectPath, message);
    return result.commit;
  },
  pushBranch: async (projectPath: string) => {
    await (await ensureDaemonClient()).gitPush(projectPath);
  },
  generateCommitMessage: async (projectPath: string) =>
    (await ensureDaemonClient()).gitGenerateCommitMessage(projectPath),
  generatePullRequestDescription: async (projectPath: string) =>
    (await ensureDaemonClient()).gitGeneratePullRequestDescription(projectPath),
  createPullRequest: async (request: Parameters<typeof gitApi.createPullRequest>[0]) =>
    (await ensureDaemonClient()).gitCreatePullRequest(request),
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
} as typeof gitApi;

export const providersViaDaemon = {
  listBuiltinProviderTemplates: async () => (await ensureDaemonClient()).providersTemplates(),
  instantiateBuiltinProviderTemplate: async (templateId: string) =>
    (await ensureDaemonClient()).providersInstantiateTemplate(templateId),
  upsertModelProvider: async (provider: Parameters<typeof configApi.upsertModelProvider>[0]) => {
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
};

export type { TerminalEvent } from '../daemon-client/terminal';

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
    }) as Session,
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
  updateWorkingPath: async (sessionId: string, workingPath: string) => {
    await (await ensureDaemonClient()).patchSession(sessionId, { workingPath });
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
  enrichAttachments: async (attachments: Parameters<typeof agentApi.enrichAttachments>[0]) => {
    const response = await (await ensureDaemonClient()).enrichAttachments(attachments);
    return response as Awaited<ReturnType<typeof agentApi.enrichAttachments>>;
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
    response: Parameters<typeof agentApi.respondToAgentPermission>[2],
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
    return payload as Awaited<ReturnType<typeof agentApi.loadSessionSubagents>>;
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

  getConfig: async () => (await ensureDaemonClient()).getAppConfig() as Awaited<ReturnType<typeof configApi.get>>,
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
  setDefaultOpenTarget: async (target: import('../openTargets').OpenTarget) => {
    await (await ensureDaemonClient()).patchAppConfig({ defaultOpenTarget: target });
  },
  setBrowserControl: async (settings: import('../../types/provider').BrowserControlSettings) => {
    await (await ensureDaemonClient()).patchAppConfig({ browser: settings });
  },
  fetchProviderModels: async (apiKey: string, baseUrl: string) =>
    providersViaDaemon.fetchProviderModels(apiKey, baseUrl),
  fetchOpenCodeFreeModels: () => providersViaDaemon.fetchOpenCodeFreeModels(),

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
  skills: skillsViaDaemon,
  scheduledTasks: scheduledTasksViaDaemon,
  historyImport: {
    discover: async (agentKind?: AgentKind) => {
      const client = await ensureDaemonClient();
      return client.discoverHistoryImportCandidates(agentKind) as ReturnType<
        typeof historyImportApi.discover
      >;
    },
    import: async (request: Parameters<typeof historyImportApi.import>[0]) => {
      const client = await ensureDaemonClient();
      return client.importHistorySessions(request) as ReturnType<typeof historyImportApi.import>;
    },
  },
  usage: {
    getStats: async (agentKind?: string, days?: number) =>
      (await ensureDaemonClient()).usageGetStats(agentKind, days) as Awaited<
        ReturnType<typeof usageApi.getStats>
      >,
    getTokenBreakdown: async (agentKind?: string, days?: number) =>
      (await ensureDaemonClient()).usageGetTokenBreakdown(agentKind, days) as Awaited<
        ReturnType<typeof usageApi.getTokenBreakdown>
      >,
  },

  checkManagedRuntimes: async () => (await ensureDaemonClient()).checkManagedRuntimes(),

  managedRuntime: {
    listVersions: async (provider: string) =>
      (await ensureDaemonClient()).managedRuntimeListVersions(provider),
    refresh: async (provider: string) =>
      (await ensureDaemonClient()).managedRuntimeRefresh(provider),
    install: async (provider: string, version?: string) =>
      (await ensureDaemonClient()).managedRuntimeInstall(provider, version),
    upgrade: async (provider: string) =>
      (await ensureDaemonClient()).managedRuntimeUpgrade(provider),
    repair: async (provider: string) =>
      (await ensureDaemonClient()).managedRuntimeRepair(provider),
    remove: async (provider: string) => {
      await (await ensureDaemonClient()).managedRuntimeRemove(provider);
    },
  },

  getCompanionStatus: (): Promise<CompanionStatus> => companionApi.getStatus(),
  setCompanionEnabled: (...args: Parameters<typeof companionApi.setEnabled>) =>
    companionApi.setEnabled(...args),
  refreshCompanionPairingCode: (...args: Parameters<typeof companionApi.refreshPairingCode>) =>
    companionApi.refreshPairingCode(...args),
  setCompanionRelayEnabled: (...args: Parameters<typeof companionApi.setRelayEnabled>) =>
    companionApi.setRelayEnabled(...args),
  setCompanionRelayConfig: (...args: Parameters<typeof companionApi.setRelayConfig>) =>
    companionApi.setRelayConfig(...args),
};

export type DaemonFacade = typeof daemonFacade;
