import type { CompanionStatus } from '../../types/companion';

export interface DaemonConnectionConfig {
  baseUrl: string;
  token: string;
}

export interface DaemonStatus {
  loopbackReady: boolean;
  lanExposed: boolean;
  activeSessionCount: number;
}

export interface DaemonClient {
  readonly config: DaemonConnectionConfig;

  health(): Promise<{ ok: boolean; loopback: boolean; lanExposed: boolean }>;
  getDaemonStatus(): Promise<DaemonStatus>;
  listSessions(): Promise<unknown[]>;
  listArchivedSessions(): Promise<unknown[]>;
  listProjects(): Promise<unknown[]>;
  getBootstrap(): Promise<unknown>;
  getTimeline(
    sessionId: string,
    query?: { direction?: 'tail' | 'after' | 'before'; cursor?: number; limit?: number },
  ): Promise<{ events: unknown[]; hasMore: boolean; nextCursor?: number | null }>;
  createSession(body: Record<string, unknown>): Promise<unknown>;
  sendMessage(sessionId: string, prompt: string, inputPayload?: unknown): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  respondToPermission(sessionId: string, requestId: string, response: unknown): Promise<void>;
  respondToInteractive(sessionId: string, toolUseId: string, response: unknown): Promise<void>;
  updateSessionSettings(sessionId: string, settings: Record<string, unknown>): Promise<unknown>;
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
  patchSession(sessionId: string, patch: Record<string, unknown>): Promise<unknown>;
  subscribeSession(
    sessionId: string,
    handlers: {
      onEvent: (event: unknown) => void;
      onState?: (running: boolean) => void;
      onReconnect?: () => void;
    },
  ): () => void;
}

async function daemonFetch<T>(
  config: DaemonConnectionConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
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

export function createDaemonClient(config: DaemonConnectionConfig): DaemonClient {
  return {
    config,

    health: () => daemonFetch(config, '/api/health'),
    getDaemonStatus: () => daemonFetch(config, '/api/daemon/status'),
    listSessions: () => daemonFetch(config, '/api/sessions'),
    listArchivedSessions: () => daemonFetch(config, '/api/sessions/archived'),
    listProjects: () => daemonFetch(config, '/api/projects'),
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
    sendMessage: async (sessionId, prompt, inputPayload) => {
      await daemonFetch(config, `/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ prompt, inputPayload }),
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
    subscribeSession(sessionId, handlers) {
      const wsUrl = new URL('/api/ws', config.baseUrl.replace(/^http/, 'ws'));
      wsUrl.searchParams.set('token', config.token);
      wsUrl.searchParams.set('sessionId', sessionId);

      let socket: WebSocket | null = null;
      let closed = false;
      let lastSequence = -1;

      const connect = () => {
        if (closed) return;
        socket = new WebSocket(wsUrl.toString());
        socket.onmessage = (message) => {
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
  };
}

export async function resolveDesktopDaemonConfig(
  getToken: () => Promise<string>,
  getCompanionStatus: () => Promise<CompanionStatus>,
): Promise<DaemonConnectionConfig> {
  const [token, status] = await Promise.all([getToken(), getCompanionStatus()]);
  const port = status.port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
  };
}
