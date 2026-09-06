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
  scheduledTaskApi,
  sessionApi,
  skillApi,
  terminalApi,
  usageApi,
} from './invoke-backend';
import type { Project } from '../../types/project';
import type { DaemonClient } from '../daemon-client/client';
import { createDaemonClient, resolveDesktopDaemonConfig } from '../daemon-client/client';

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
      const config = await resolveDesktopDaemonConfig(
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

export const daemonFacade = {
  // --- Protocol-backed (daemon client) ---
  ensureClient: ensureDaemonClient,
  resetClient: resetDaemonClient,
  getInitError: getDaemonClientInitError,
  listSessions: listSessionsViaDaemon,
  listArchivedSessions: listArchivedSessionsViaDaemon,
  listProjects: listProjectsViaDaemon,
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
  sendMessageViaDaemon: async (sessionId: string, prompt: string, inputPayload?: unknown) =>
    (await ensureDaemonClient()).sendMessage(sessionId, prompt, inputPayload),
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

  // --- Invoke-backed (migrating in later issues) ---
  createSession: (
    title: string,
    agentKind: AgentKind,
    mode?: SessionMode,
    projectId?: string,
    permissionConfig?: AgentPermissionConfig,
    planMode?: AgentPlanMode,
    model?: string,
  ) => sessionApi.create(title, agentKind, mode, projectId, permissionConfig, planMode, model),
  deleteSession: sessionApi.delete,
  forkClaude: sessionApi.forkClaude,
  forkCodex: sessionApi.forkCodex,
  forkOpenCode: sessionApi.forkOpenCode,
  forkPi: sessionApi.forkPi,
  setPinned: sessionApi.setPinned,
  setReadOnly: sessionApi.setReadOnly,
  updateTitle: sessionApi.updateTitle,
  updateWorkingPath: sessionApi.updateWorkingPath,
  touchSession: sessionApi.touch,
  updateProvider: sessionApi.updateProvider,
  updateReasoningEffort: sessionApi.updateReasoningEffort,
  updatePermissions: sessionApi.updatePermissions,

  ensureAgentSession: agentApi.ensureSession,
  sendAgentInput: agentApi.sendInput,
  enrichAttachments: agentApi.enrichAttachments,
  startAgentSession: agentApi.startSession,
  interruptAgent: agentApi.interrupt,
  shutdownAgent: agentApi.shutdown,
  resetAgentSession: agentApi.resetSession,
  sendToolResponse: agentApi.sendToolResponse,
  respondToAgentPermission: agentApi.respondToAgentPermission,
  deleteClaudeSessionFiles: agentApi.deleteClaudeSessionFiles,
  deleteCodexSessionFiles: agentApi.deleteCodexSessionFiles,
  loadClaudeSessionEvents: agentApi.loadClaudeSessionEvents,
  loadCodexSessionEvents: agentApi.loadCodexSessionEvents,
  loadOpenCodeSessionEvents: agentApi.loadOpenCodeSessionEvents,
  loadSessionEvents: agentApi.loadSessionEvents,
  loadSessionSubagents: agentApi.loadSessionSubagents,
  resyncSessionFromNative: agentApi.resyncSessionFromNative,
  deleteOpenCodeSession: agentApi.deleteOpenCodeSession,
  loadLatestTokenUsage: agentApi.loadLatestTokenUsage,
  rewindSession: agentApi.rewindSession,
  getSessionInfo: agentApi.getSessionInfo,

  getConfig: configApi.get,
  updateProviderConfig: configApi.updateProvider,
  deleteProviderConfig: configApi.deleteProvider,
  setActiveProvider: configApi.setActiveProvider,
  listBuiltinProviderTemplates: configApi.listBuiltinProviderTemplates,
  instantiateBuiltinProviderTemplate: configApi.instantiateBuiltinProviderTemplate,
  upsertModelProvider: configApi.upsertModelProvider,
  deleteModelProvider: configApi.deleteModelProvider,
  setModelProviderEnabled: configApi.setModelProviderEnabled,
  testModelProvider: configApi.testModelProvider,
  providerUsableForAgent: configApi.providerUsableForAgent,
  setDefaultAgentKind: configApi.setDefaultAgentKind,
  updateAgentConfig: configApi.updateAgentConfig,
  setTheme: configApi.setTheme,
  setCompactAiOutput: configApi.setCompactAiOutput,
  setImmediateRunMode: configApi.setImmediateRunMode,
  setAttachmentEnrichment: configApi.setAttachmentEnrichment,
  setNotificationSettings: configApi.setNotificationSettings,
  setGitSettings: configApi.setGitSettings,
  setDefaultOpenTarget: configApi.setDefaultOpenTarget,
  fetchProviderModels: configApi.fetchProviderModels,
  fetchOpenCodeFreeModels: configApi.fetchOpenCodeFreeModels,

  readFile: fileApi.readFile,
  writeFile: fileApi.writeFile,
  deleteFile: fileApi.deleteFile,
  listDirectory: fileApi.listDirectory,
  openProjectPath: fileApi.openProjectPath,
  readHomeFile: fileApi.readHomeFile,

  git: gitApi,
  terminal: terminalApi,
  mcp: mcpApi,
  skills: skillApi,
  scheduledTasks: scheduledTaskApi,
  historyImport: historyImportApi,
  usage: usageApi,

  checkManagedRuntimes: async () => {
    const { appApi } = await import('./invoke-backend');
    return appApi.checkManagedRuntimes();
  },

  getCompanionStatus: (): Promise<CompanionStatus> => companionApi.getStatus(),
  isSessionTurnActive: companionApi.isSessionTurnActive,
  setCompanionEnabled: companionApi.setEnabled,
  refreshCompanionPairingCode: companionApi.refreshPairingCode,
  setCompanionRelayEnabled: companionApi.setRelayEnabled,
  setCompanionRelayConfig: companionApi.setRelayConfig,
};

export type DaemonFacade = typeof daemonFacade;
