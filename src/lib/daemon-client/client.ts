import { createControlPlaneMethods, type ControlPlaneMethods } from './control-plane';
import { createTerminalMethods, type TerminalMethods } from './terminal';
import { usePerfStore } from '../../stores/perfStore';

export interface DaemonConnectionConfig {
  baseUrl: string;
  token: string;
  /**
   * 传输层覆盖(工单 02):浏览器形态在直连不可用时经既有中继/E2EE 通道
   * 发请求(见 lib/companion-connection)。缺省走 fetch 直连。
   */
  transport?: DaemonTransport;
  /** true = 用轮询代替 WebSocket(中继通道无法升级 WS 时的回退)。 */
  polling?: boolean;
}

export interface DaemonTransport {
  request(path: string, init?: RequestInit): Promise<{ status: number; body: string }>;
}

const POLLING_INTERVAL_MS = 2500;

export interface DaemonStatus {
  loopbackReady: boolean;
  lanExposed: boolean;
  activeSessionCount: number;
}

interface DaemonClientCore {
  readonly config: DaemonConnectionConfig;

  health(): Promise<{ ok: boolean; loopback: boolean; lanExposed: boolean }>;
  getDaemonStatus(): Promise<DaemonStatus>;
  listSessions(): Promise<unknown[]>;
  listArchivedSessions(): Promise<unknown[]>;
  listProjects(): Promise<unknown[]>;
  createProject(name: string, path: string): Promise<unknown>;
  deleteProject(projectId: string): Promise<void>;
  renameProject(projectId: string, name: string): Promise<void>;
  getBootstrap(): Promise<unknown>;
  getTimeline(
    sessionId: string,
    query?: { direction?: 'tail' | 'after' | 'before'; cursor?: number; limit?: number },
  ): Promise<{
    events: unknown[];
    seqStart?: number | null;
    seqEnd?: number | null;
    hasOlder: boolean;
    hasNewer: boolean;
    historyComplete: boolean;
  }>;
  createSession(body: Record<string, unknown>): Promise<unknown>;
  sendMessage(sessionId: string, prompt: string, inputPayload?: unknown, options?: { delivery?: 'steer'; requestId?: string }): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  respondToPermission(sessionId: string, requestId: string, response: unknown): Promise<void>;
  respondToInteractive(sessionId: string, toolUseId: string, response: unknown): Promise<void>;
  updateSessionSettings(sessionId: string, settings: Record<string, unknown>): Promise<unknown>;
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
  patchSession(sessionId: string, patch: Record<string, unknown>): Promise<unknown>;
  forkSession(
    sessionId: string,
    body: {
      agentKind?: string;
      forkEventId: string;
      forkProviderMessageId?: string;
      forkProviderTurnId?: string;
      forkProviderTurnOrdinal?: number;
      title?: string;
    },
  ): Promise<unknown>;
  deleteSession(sessionId: string): Promise<void>;
  resyncSessionFromNative(sessionId: string): Promise<{ eventCount: number }>;
  discoverHistoryImportCandidates(agentKind?: string): Promise<unknown[]>;
  importHistorySessions(body: Record<string, unknown>): Promise<unknown>;
  resetAgentSession(sessionId: string): Promise<void>;
  shutdownAgent(sessionId: string): Promise<void>;
  getAppConfig(): Promise<unknown>;
  patchAppConfig(body: Record<string, unknown>): Promise<void>;
  getSessionRuntimeState(sessionId: string): Promise<{ running: boolean }>;
  /** 回环浏览器配对确认(工单 02):壳/CLI 用,需已鉴权。 */
  decideLocalPairing(requestId: string, approve: boolean): Promise<void>;
  subscribeSession(
    sessionId: string,
    handlers: {
      onEvent: (event: unknown) => void;
      onState?: (running: boolean) => void;
      onReconnect?: () => void;
      getInitialSequence?: () => number;
    },
  ): () => void;
}

export type DaemonClient = DaemonClientCore & ControlPlaneMethods & TerminalMethods;

async function daemonFetch<T>(
  config: DaemonConnectionConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (config.transport) {
    const result = await config.transport.request(path, init);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(result.body.trim() || `Daemon request failed: ${result.status}`);
    }
    if (!result.body.trim()) {
      return undefined as T;
    }
    return JSON.parse(result.body) as T;
  }
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Daemon request failed: ${response.status}`);
  }
  if (response.status === 204 || response.status === 202) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

type SessionHandlers = {
  onEvent: (event: unknown) => void;
  onState?: (running: boolean) => void;
  onReconnect?: () => void;
  getInitialSequence?: () => number;
};

/**
 * 轮询回退(工单 02/03):中继通道没有可升级的 WebSocket,改用
 * `/api/sessions/:id/state` + 增量 timeline 拉取,语义与 WS 订阅一致:
 * 先补 `after` 游标之后的事件,再回调最新运行态;拉取恢复时触发一次
 * `onReconnect` 让上层重放时间线,避免断档。
 */
export function subscribeSessionByPolling(
  config: DaemonConnectionConfig,
  sessionId: string,
  handlers: SessionHandlers,
): () => void {
  let closed = false;
  let lastSequence = handlers.getInitialSequence?.() ?? -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hadError = false;

  const schedule = () => {
    if (closed) return;
    timer = setTimeout(() => {
      void tick();
    }, POLLING_INTERVAL_MS);
  };

  const tick = async () => {
    if (closed) return;
    try {
      lastSequence = handlers.getInitialSequence?.() ?? lastSequence;
      const query = lastSequence >= 0
        ? `?direction=after&cursor=${lastSequence}&limit=200`
        : '';
      const page = await daemonFetch<{
        events: Array<{ sequence?: number }>;
      }>(config, `/api/sessions/${sessionId}/timeline${query}`);
      for (const event of page.events ?? []) {
        const sequence = typeof event?.sequence === 'number' ? event.sequence : undefined;
        if (sequence != null) {
          if (sequence <= lastSequence) continue;
          lastSequence = sequence;
        }
        handlers.onEvent(event);
      }
      const state = await daemonFetch<{ running: boolean }>(
        config,
        `/api/sessions/${sessionId}/state`,
      );
      handlers.onState?.(Boolean(state?.running));
      if (hadError) {
        hadError = false;
        handlers.onReconnect?.();
      }
    } catch {
      hadError = true;
    }
    schedule();
  };

  void tick();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
  };
}

export function createDaemonClient(config: DaemonConnectionConfig): DaemonClient {
  return {
    config,

    health: () => daemonFetch(config, '/api/health'),
    getDaemonStatus: () => daemonFetch(config, '/api/daemon/status'),
    listSessions: () => daemonFetch(config, '/api/sessions'),
    listArchivedSessions: () => daemonFetch(config, '/api/sessions/archived'),
    listProjects: () => daemonFetch(config, '/api/projects'),
    createProject: (name, path) =>
      daemonFetch(config, '/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, path }),
      }),
    deleteProject: async (projectId) => {
      await daemonFetch(config, `/api/projects/${projectId}`, { method: 'DELETE' });
    },
    renameProject: async (projectId, name) => {
      await daemonFetch(config, `/api/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
    },
    getBootstrap: () => daemonFetch(config, '/api/bootstrap'),
    getTimeline: (sessionId, query = {}) => {
      const params = new URLSearchParams();
      if (query.direction) params.set('direction', query.direction);
      if (query.cursor != null) params.set('cursor', String(query.cursor));
      if (query.limit != null) params.set('limit', String(query.limit));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return daemonFetch(config, `/api/sessions/${sessionId}/timeline${suffix}`);
    },
    createSession: (body) =>
      daemonFetch(config, '/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
    sendMessage: async (sessionId, prompt, inputPayload, options) => {
      await daemonFetch(config, `/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          inputPayload,
          delivery: options?.delivery,
          requestId: options?.requestId,
        }),
      });
    },
    interruptSession: async (sessionId) => {
      await daemonFetch(config, `/api/sessions/${sessionId}/interrupt`, { method: 'POST' });
    },
    respondToPermission: async (sessionId, requestId, response) => {
      await daemonFetch(config, '/api/permissions/respond', {
        method: 'POST',
        body: JSON.stringify({ sessionId, requestId, response }),
      });
    },
    respondToInteractive: async (sessionId, toolUseId, response) => {
      await daemonFetch(config, '/api/interactive/user-input', {
        method: 'POST',
        body: JSON.stringify({ sessionId, toolUseId, response }),
      });
    },
    updateSessionSettings: (sessionId, settings) =>
      daemonFetch(config, `/api/sessions/${sessionId}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(settings),
      }),
    archiveSession: async (sessionId) => {
      await daemonFetch(config, `/api/sessions/${sessionId}/archive`, { method: 'POST' });
    },
    unarchiveSession: async (sessionId) => {
      await daemonFetch(config, `/api/sessions/${sessionId}/unarchive`, { method: 'POST' });
    },
    patchSession: (sessionId, patch) =>
      daemonFetch(config, `/api/sessions/${sessionId}/maintenance`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    forkSession: (sessionId, body) =>
      daemonFetch(config, `/api/sessions/${sessionId}/fork`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    deleteSession: async (sessionId) => {
      await daemonFetch(config, `/api/sessions/${sessionId}`, { method: 'DELETE' });
    },
    resyncSessionFromNative: (sessionId) =>
      daemonFetch<{ eventCount: number }>(config, `/api/sessions/${sessionId}/resync`, {
        method: 'POST',
        body: '{}',
      }),
    discoverHistoryImportCandidates: (agentKind) => {
      const params = new URLSearchParams();
      if (agentKind) params.set('agentKind', agentKind);
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return daemonFetch(config, `/api/sessions/import/candidates${suffix}`);
    },
    importHistorySessions: (body) =>
      daemonFetch(config, '/api/sessions/import', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    resetAgentSession: async (sessionId) => {
      await daemonFetch(config, `/api/sessions/${sessionId}/reset-agent`, { method: 'POST' });
    },
    shutdownAgent: async (sessionId) => {
      await daemonFetch(config, `/api/sessions/${sessionId}/shutdown-agent`, { method: 'POST' });
    },
    getAppConfig: () => daemonFetch(config, '/api/config'),
    patchAppConfig: async (body) => {
      await daemonFetch(config, '/api/config', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
    getSessionRuntimeState: (sessionId) =>
      daemonFetch(config, `/api/sessions/${sessionId}/state`),
    decideLocalPairing: async (requestId, approve) => {
      await daemonFetch(config, '/api/pair/local/decision', {
        method: 'POST',
        body: JSON.stringify({ requestId, approve }),
      });
    },
    subscribeSession(sessionId, handlers) {
      if (config.polling) {
        return subscribeSessionByPolling(config, sessionId, handlers);
      }
      const wsUrl = new URL('/api/ws', config.baseUrl.replace(/^http/, 'ws'));
      wsUrl.searchParams.set('token', config.token);
      wsUrl.searchParams.set('sessionId', sessionId);

      let socket: WebSocket | null = null;
      let closed = false;
      let lastSequence = handlers.getInitialSequence?.() ?? -1;

      const connect = () => {
        if (closed) return;
        lastSequence = handlers.getInitialSequence?.() ?? lastSequence;
        socket = new WebSocket(wsUrl.toString());
        socket.onmessage = (message) => {
          const startedAt = import.meta.env.DEV ? performance.now() : 0;
          try {
            const payload = JSON.parse(message.data as string) as {
              type: string;
              event?: { sequence?: number };
              running?: boolean;
            };
            if (payload.type === 'event' && payload.event) {
              const sequence = payload.event.sequence;
              if (typeof sequence === 'number') {
                if (sequence <= lastSequence) return;
                lastSequence = sequence;
              }
              handlers.onEvent(payload.event);
            } else if (payload.type === 'state' && handlers.onState) {
              handlers.onState(Boolean(payload.running));
            }
          } catch {
            // ignore malformed frames
          } finally {
            // DEV-only: feeds the perf overlay so that "IPC/秒" reports the real
            // inbound WS frame rate and "慢 IPC Top-5" surfaces frames whose
            // parse + handler work crossed the threshold. Nothing called
            // recordIpc before, so those rows always read zero — which hid the
            // frame rate, the single most useful number for judging the event
            // pipeline during streaming.
            if (import.meta.env.DEV) {
              usePerfStore.getState().recordIpc('ws:frame', performance.now() - startedAt, false);
            }
          }
        };
        socket.onclose = () => {
          if (closed) return;
          handlers.onReconnect?.();
          window.setTimeout(connect, 1200);
        };
      };

      connect();
      return () => {
        closed = true;
        socket?.close();
      };
    },

    ...createControlPlaneMethods(config, (c, path, init) => daemonFetch(c, `/api${path}`, init)),
    ...createTerminalMethods(
      config,
      (c, path, init) => daemonFetch(c, `/api${path}`, init),
      async () => config,
    ),
  };
}
