import type { CompanionConnection } from './storage';

export interface MobileSession {
  id: string;
  title: string;
  agent_kind: string;
  provider_id?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  project_id?: string | null;
  updated_at: string;
}

export interface MobileProject {
  id: string;
  name: string;
  path: string;
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function claimPairing(
  baseUrl: string,
  code: string,
  name?: string,
): Promise<{ token: string; deviceId: string }> {
  const result = await requestJson<{ token: string; deviceId: string }>(`${baseUrl}/api/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  return result;
}

export async function listSessions(connection: CompanionConnection): Promise<MobileSession[]> {
  return requestJson<MobileSession[]>(`${connection.baseUrl}/api/sessions`, {
    headers: authHeaders(connection.token),
  });
}

export async function listProjects(connection: CompanionConnection): Promise<MobileProject[]> {
  return requestJson<MobileProject[]>(`${connection.baseUrl}/api/projects`, {
    headers: authHeaders(connection.token),
  });
}

export async function fetchSessionEvents(
  connection: CompanionConnection,
  sessionId: string,
  after = -1,
): Promise<unknown[]> {
  const query = after >= 0 ? `?after=${after}` : '';
  return requestJson<unknown[]>(`${connection.baseUrl}/api/sessions/${sessionId}/events${query}`, {
    headers: authHeaders(connection.token),
  });
}

export async function sendSessionMessage(
  connection: CompanionConnection,
  sessionId: string,
  prompt: string,
): Promise<void> {
  await requestJson(`${connection.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: authHeaders(connection.token),
    body: JSON.stringify({ prompt }),
  });
}

export async function createSession(
  connection: CompanionConnection,
  payload: {
    title: string;
    agentKind?: string;
    projectId?: string;
    model?: string;
    permissionConfig?: string;
    planMode?: string;
  },
): Promise<MobileSession> {
  return requestJson<MobileSession>(`${connection.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: authHeaders(connection.token),
    body: JSON.stringify({
      title: payload.title,
      agentKind: payload.agentKind,
      projectId: payload.projectId,
      model: payload.model,
      permissionConfig: payload.permissionConfig,
      planMode: payload.planMode,
    }),
  });
}

export async function respondPermission(
  connection: CompanionConnection,
  sessionId: string,
  requestId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await fetch(`${connection.baseUrl}/api/permissions/respond`, {
    method: 'POST',
    headers: authHeaders(connection.token),
    body: JSON.stringify({ sessionId, requestId, response }),
  });
}

export function buildWsUrl(connection: CompanionConnection, sessionId: string): string {
  const url = new URL('/api/ws', connection.baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', connection.token);
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}
