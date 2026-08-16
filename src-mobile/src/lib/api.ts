import {
  normalizeStoredConnection,
  resolveProfileRestUrl,
  resolveProfileWsUrl,
} from '@shared/lib/companion-connection';

import type { CompanionConnection } from './storage';

export interface MobileBootstrap {
  defaultAgentKind: string;
  activeProviderId?: string | null;
  compactAiOutput?: boolean;
  providers: MobileProvider[];
  agentDefaults: {
    claude_code: MobileAgentKindDefaults;
    codex: MobileAgentKindDefaults;
    opencode: MobileAgentKindDefaults;
  };
  reasoningEfforts: string[];
  permissionPresets: {
    claude_code: Record<string, unknown>;
    codex: Record<string, unknown>;
    opencode: Record<string, unknown>;
  };
}

export interface MobileProvider {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  defaultModel: string;
  models: Array<{ id: string; name?: string | null }>;
  protocols: string[];
}

export interface MobileAgentKindDefaults {
  providerId?: string | null;
  model?: string | null;
}

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

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

export function formatPairingClaimError(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 400) {
    return '配对码无效或已过期，请让桌面刷新二维码';
  }
  return String(error);
}

function profileFor(connection: CompanionConnection) {
  return normalizeStoredConnection(connection);
}

function apiUrl(connection: CompanionConnection, path: string): string {
  return resolveProfileRestUrl(profileFor(connection), path);
}

export function isAuthError(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    return error.status === 401;
  }
  const message = String(error);
  return message.includes('Invalid token')
    || message.includes('Missing token')
    || message.includes('Request failed (401)');
}

export function isConnectivityError(error: unknown): boolean {
  if (isAuthError(error)) {
    return false;
  }
  if (error instanceof ApiRequestError) {
    return error.status === 0 || error.status >= 502;
  }
  const message = String(error).toLowerCase();
  return message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network request failed')
    || message.includes('load failed')
    || message.includes('connection refused')
    || message.includes('econnrefused')
    || message.includes('fetch failed')
    || message.includes('连接超时');
}

const REQUEST_TIMEOUT_MS = 3000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('连接超时，桌面端无响应');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    const message = typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
    throw new ApiRequestError(response.status, message);
  }
  const text = await response.text();
  if (!text.trim()) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

async function requestVoid(url: string, init?: RequestInit): Promise<void> {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    const message = typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
    throw new ApiRequestError(response.status, message);
  }
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

export async function revokePairing(connection: CompanionConnection): Promise<void> {
  await requestVoid(apiUrl(connection, '/api/pair/device'), {
    method: 'DELETE',
    headers: authHeaders(connection.token),
  });
}

export async function fetchBootstrap(connection: CompanionConnection): Promise<MobileBootstrap> {
  return requestJson<MobileBootstrap>(apiUrl(connection, '/api/bootstrap'), {
    headers: authHeaders(connection.token),
  });
}

export async function pingDesktopHealth(baseUrl: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`${baseUrl.replace(/\/$/, '')}/api/health`);
}

export async function checkDesktopReachability(connection: CompanionConnection): Promise<void> {
  await pingDesktopHealth(connection.baseUrl);
  await fetchBootstrap(connection);
}

export async function listSessions(connection: CompanionConnection): Promise<MobileSession[]> {
  return requestJson<MobileSession[]>(apiUrl(connection, '/api/sessions'), {
    headers: authHeaders(connection.token),
  });
}

export async function listProjects(connection: CompanionConnection): Promise<MobileProject[]> {
  return requestJson<MobileProject[]>(apiUrl(connection, '/api/projects'), {
    headers: authHeaders(connection.token),
  });
}

export async function fetchSessionEvents(
  connection: CompanionConnection,
  sessionId: string,
  after = -1,
): Promise<unknown[]> {
  const query = after >= 0 ? `?after=${after}` : '';
  return requestJson<unknown[]>(`${apiUrl(connection, `/api/sessions/${sessionId}/events`)}${query}`, {
    headers: authHeaders(connection.token),
  });
}

export async function sendSessionMessage(
  connection: CompanionConnection,
  sessionId: string,
  prompt: string,
): Promise<void> {
  await requestVoid(apiUrl(connection, `/api/sessions/${sessionId}/messages`), {
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
    providerId?: string;
    model?: string;
    reasoningEffort?: string;
    permissionConfig?: string;
    planMode?: string;
    mode?: string;
  },
): Promise<MobileSession> {
  return requestJson<MobileSession>(apiUrl(connection, '/api/sessions'), {
    method: 'POST',
    headers: authHeaders(connection.token),
    body: JSON.stringify({
      title: payload.title,
      agentKind: payload.agentKind,
      projectId: payload.projectId,
      providerId: payload.providerId,
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
      permissionConfig: payload.permissionConfig,
      planMode: payload.planMode,
      mode: payload.mode ?? 'agent',
    }),
  });
}

export async function respondPermission(
  connection: CompanionConnection,
  sessionId: string,
  requestId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await requestVoid(apiUrl(connection, '/api/permissions/respond'), {
    method: 'POST',
    headers: authHeaders(connection.token),
    body: JSON.stringify({ sessionId, requestId, response }),
  });
}

export async function respondUserInput(
  connection: CompanionConnection,
  sessionId: string,
  toolUseId: string,
  response: unknown,
): Promise<void> {
  await requestVoid(apiUrl(connection, '/api/interactive/user-input'), {
    method: 'POST',
    headers: authHeaders(connection.token),
    body: JSON.stringify({ sessionId, toolUseId, response }),
  });
}

export function buildWsUrl(connection: CompanionConnection, sessionId: string): string {
  return resolveProfileWsUrl(profileFor(connection), sessionId);
}

export function providerSupportsAgent(provider: MobileProvider, agentKind: string): boolean {
  const required = agentKind === 'claude_code' ? 'anthropic' : 'openai_compatible';
  return provider.enabled && provider.configured && provider.protocols.includes(required);
}

export function resolveDefaultProvider(
  bootstrap: MobileBootstrap,
  agentKind: 'claude_code' | 'codex' | 'opencode',
): MobileProvider | null {
  const defaults = bootstrap.agentDefaults[agentKind];
  const candidates = bootstrap.providers.filter((provider) => providerSupportsAgent(provider, agentKind));
  if (defaults.providerId) {
    const preferred = candidates.find((provider) => provider.id === defaults.providerId);
    if (preferred) return preferred;
  }
  if (bootstrap.activeProviderId) {
    const active = candidates.find((provider) => provider.id === bootstrap.activeProviderId);
    if (active) return active;
  }
  return candidates[0] ?? null;
}
