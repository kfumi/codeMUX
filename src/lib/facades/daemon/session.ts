import type { AgentKind, Session } from '../../../types/session';
import type { AgentPermissionConfig, AgentPlanMode } from '../../agentKind';
import type { AgentInputAttachment, EnrichmentBlockResult } from '../../../types/agentInput';
import { ensureDaemonClient } from './lifecycle';

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

/** 会话生命周期、消息与审批:只讲域动作,不暴露传输路由。 */
export const session = {
  list: async (): Promise<Session[]> => {
    const client = await ensureDaemonClient();
    return client.listSessions() as Promise<Session[]>;
  },
  listArchived: async (): Promise<Session[]> => {
    const client = await ensureDaemonClient();
    return client.listArchivedSessions() as Promise<Session[]>;
  },
  isTurnActive: async (sessionId: string) => {
    const state = await (await ensureDaemonClient()).getSessionRuntimeState(sessionId);
    return state.running;
  },
  create: async (body: Record<string, unknown>) =>
    (await ensureDaemonClient()).createSession(body),
  delete: async (sessionId: string) => {
    await (await ensureDaemonClient()).deleteSession(sessionId);
  },
  sendMessage: async (
    sessionId: string,
    prompt: string,
    inputPayload?: unknown,
    options?: { delivery?: 'steer'; requestId?: string },
  ) => (await ensureDaemonClient()).sendMessage(sessionId, prompt, inputPayload, options),
  interrupt: async (sessionId: string) =>
    (await ensureDaemonClient()).interruptSession(sessionId),
  respondToPermission: async (sessionId: string, requestId: string, response: unknown) =>
    (await ensureDaemonClient()).respondToPermission(sessionId, requestId, response),
  respondToInteractive: async (sessionId: string, toolUseId: string, response: unknown) =>
    (await ensureDaemonClient()).respondToInteractive(sessionId, toolUseId, response),
  updateSettings: async (sessionId: string, settings: Record<string, unknown>) =>
    (await ensureDaemonClient()).updateSessionSettings(sessionId, settings),
  archive: async (sessionId: string) =>
    (await ensureDaemonClient()).archiveSession(sessionId),
  unarchive: async (sessionId: string) =>
    (await ensureDaemonClient()).unarchiveSession(sessionId),
  patch: async (sessionId: string, patch: Record<string, unknown>) =>
    (await ensureDaemonClient()).patchSession(sessionId, patch),
  fork: forkSessionViaDaemon,
  // 工作路径变化时守护进程顺带采样「启动分支」，返回整条会话供调用方回填。
  updateWorkingPath: async (sessionId: string, workingPath: string): Promise<Session | null> => {
    const updated = await (await ensureDaemonClient()).patchSession(sessionId, { workingPath });
    return (updated as Session | null) ?? null;
  },
  touch: async (sessionId: string) => {
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
  ensureAgent: async (
    sessionId: string,
    cwd: string,
    _onEvent?: (event: string) => void,
    reasoningEffort?: string | null,
  ) => {
    await (await ensureDaemonClient()).ensureAgentSession(sessionId, cwd, reasoningEffort);
  },
  enrichAttachments: async (
    attachments: AgentInputAttachment[],
  ): Promise<{ blocks: EnrichmentBlockResult[] }> => {
    const response = await (await ensureDaemonClient()).enrichAttachments(attachments);
    return response as { blocks: EnrichmentBlockResult[] };
  },
  resetAgent: async (sessionId: string) => {
    await (await ensureDaemonClient()).resetAgentSession(sessionId);
  },
  deleteNativeFiles: async (sessionId: string, agentKind: AgentKind) => {
    const result = await (await ensureDaemonClient()).deleteSessionNativeFiles(sessionId, agentKind);
    return result.deleted;
  },
  loadSubagents: async (sessionId: string) => {
    const payload = await (await ensureDaemonClient()).loadSessionSubagents(sessionId);
    return payload as {
      subagents: Array<Record<string, unknown>>;
      timelines: Record<string, Array<Record<string, unknown>>>;
    };
  },
  resyncFromNative: async (sessionId: string) =>
    (await ensureDaemonClient()).resyncSessionFromNative(sessionId),
  loadLatestTokenUsage: async (
    sessionId: string,
    agentKind: string,
    freshness?: string,
  ) => (await ensureDaemonClient()).loadLatestTokenUsage(sessionId, agentKind, freshness),
  getInfo: async (sessionId: string, agentKind: string) => {
    const info = await (await ensureDaemonClient()).getAgentSessionInfo(sessionId, agentKind);
    return {
      agentSessionId: info.agentSessionId ?? null,
      messagePath: info.messagePath ?? null,
    };
  },
  rewind: async (
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
};

export type SessionDomain = typeof session;
