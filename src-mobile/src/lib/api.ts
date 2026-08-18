import {
  buildReachabilityMap,
  buildRestUrl,
  companionHttpRequest,
  isRelayConnection,
  isHttpUrlBlockedBySecurePage,
  normalizeStoredConnection,
  resolveActiveConnection,
  resolveProfileWsUrl,
  type CompanionConnectionProfile,
  type CompanionOfferV1,
  type ConnectionReachability,
} from '@shared/lib/companion-connection';

import type { CompanionConnection } from './storage';
import type { MobilePermissionResponse } from './permissionResponse';

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
  permission_config?: string | null;
  plan_mode?: string | null;
  project_id?: string | null;
  origin?: string;
  is_read_only?: boolean;
  is_archived?: boolean;
  is_pinned?: boolean;
  updated_at: string;
}

export type MobileAgentKind = 'claude_code' | 'codex' | 'opencode';

export interface MobileInputAttachment {
  type: 'image';
  name: string;
  mediaType: string;
  dataUrl: string;
  size?: number;
}

export interface MobileInputPayload {
  text: string;
  images?: Array<Omit<MobileInputAttachment, 'type'>>;
  attachments?: MobileInputAttachment[];
}

export interface MobileComposerFile {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

export interface MobileComposerCommand {
  name: string;
  description: string;
  category: 'session' | 'builtin' | 'skill';
  handler: 'local' | 'prompt';
  prompt?: string | null;
  filePath?: string | null;
  scope?: 'project' | 'global' | null;
}

export interface MobileComposerContext {
  files: MobileComposerFile[];
  commands: MobileComposerCommand[];
}

export interface MobileSessionSettingsPatch {
  agentKind: MobileAgentKind;
  providerId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  permissionConfig: Record<string, unknown>;
  planMode: 'on' | 'off';
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

function asProfile(connection: CompanionConnection): CompanionConnectionProfile {
  return normalizeStoredConnection(connection);
}

let cachedReachability: ConnectionReachability | null = null;
let reachabilityProfileKey: string | null = null;

function profileCacheKey(profile: CompanionConnectionProfile): string {
  return `${profile.desktopId}:${profile.token}:${profile.connections.map((item) => item.id).join(',')}`;
}

async function getReachability(profile: CompanionConnectionProfile): Promise<ConnectionReachability> {
  const key = profileCacheKey(profile);
  if (cachedReachability && reachabilityProfileKey === key) {
    return cachedReachability;
  }
  const next = await buildReachabilityMap(profile);
  cachedReachability = next;
  reachabilityProfileKey = key;
  return next;
}

export function invalidateReachabilityCache(): void {
  cachedReachability = null;
  reachabilityProfileKey = null;
}

async function requestJson<T>(
  profile: CompanionConnectionProfile,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const reachability = await getReachability(profile);
  const response = await companionHttpRequest(profile, path, init, reachability);
  if (response.status < 200 || response.status >= 300) {
    let message = `Request failed (${response.status})`;
    try {
      const body = JSON.parse(response.body) as { error?: string };
      if (typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // ignore
    }
    throw new ApiRequestError(response.status, message);
  }
  if (!response.body.trim()) {
    return undefined as T;
  }
  return JSON.parse(response.body) as T;
}

async function requestVoid(
  profile: CompanionConnectionProfile,
  path: string,
  init?: RequestInit,
): Promise<void> {
  await requestJson(profile, path, init);
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function relayProfileFromOffer(offer: CompanionOfferV1): CompanionConnectionProfile {
  return {
    desktopId: offer.desktopId,
    deviceId: '',
    token: '',
    connections: [{
      id: `relay:${offer.desktopId}`,
      type: 'relay',
      endpoint: offer.relay!.endpoint,
      useTls: offer.relay!.useTls ?? false,
      desktopPublicKeyB64: offer.desktopPublicKeyB64!,
    }],
  };
}

export function shouldAttemptDirectPairing(baseUrl: string, pageProtocol?: string): boolean {
  return Boolean(baseUrl.trim()) && !isHttpUrlBlockedBySecurePage(baseUrl, pageProtocol);
}

export async function claimPairing(
  baseUrl: string,
  code: string,
  name?: string,
): Promise<{ token: string; deviceId: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/pair/claim`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name }),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      const message = typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
      throw new ApiRequestError(response.status, message);
    }
    return response.json() as Promise<{ token: string; deviceId: string }>;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('连接超时，桌面端无响应');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function claimPairingResolved(
  input: {
    baseUrl: string;
    pairingCode: string;
    offer?: CompanionOfferV1;
  },
  name?: string,
): Promise<{ token: string; deviceId: string; usedRelay: boolean }> {
  const offer = input.offer;
  if (offer?.relay && offer.desktopPublicKeyB64) {
    try {
      if (shouldAttemptDirectPairing(input.baseUrl)) {
        const result = await claimPairing(input.baseUrl, input.pairingCode, name);
        return { ...result, usedRelay: false };
      }
    } catch {
      // fall through to relay
    }
    const profile = relayProfileFromOffer(offer);
    const result = await requestJson<{ token: string; deviceId: string }>(profile, '/api/pair/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: input.pairingCode, name }),
    });
    return { ...result, usedRelay: true };
  }
  const result = await claimPairing(input.baseUrl, input.pairingCode, name);
  return { ...result, usedRelay: false };
}

export async function fetchBootstrap(connection: CompanionConnection): Promise<MobileBootstrap> {
  const profile = asProfile(connection);
  return requestJson<MobileBootstrap>(profile, '/api/bootstrap', {
    headers: authHeaders(profile.token),
  });
}

export async function pingDesktopHealth(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Health check failed (${response.status})`);
  }
}

export async function checkDesktopReachability(connection: CompanionConnection): Promise<void> {
  invalidateReachabilityCache();
  const profile = asProfile(connection);
  const reachability = await getReachability(profile);
  const active = resolveActiveConnection(profile, reachability);
  if (isRelayConnection(active)) {
    await fetchBootstrap(connection);
    return;
  }
  await pingDesktopHealth(buildRestUrl(active, ''));
  await fetchBootstrap(connection);
}

export async function listSessions(connection: CompanionConnection): Promise<MobileSession[]> {
  const profile = asProfile(connection);
  return requestJson<MobileSession[]>(profile, '/api/sessions', {
    headers: authHeaders(profile.token),
  });
}

export async function listProjects(connection: CompanionConnection): Promise<MobileProject[]> {
  const profile = asProfile(connection);
  return requestJson<MobileProject[]>(profile, '/api/projects', {
    headers: authHeaders(profile.token),
  });
}

export async function fetchSessionEvents(
  connection: CompanionConnection,
  sessionId: string,
  after = -1,
): Promise<unknown[]> {
  const profile = asProfile(connection);
  const query = after >= 0 ? `?after=${after}` : '';
  return requestJson<unknown[]>(profile, `/api/sessions/${sessionId}/events${query}`, {
    headers: authHeaders(profile.token),
  });
}

export async function fetchComposerContext(
  connection: CompanionConnection,
  sessionId: string,
): Promise<MobileComposerContext> {
  const profile = asProfile(connection);
  return requestJson<MobileComposerContext>(profile, `/api/sessions/${sessionId}/composer-context`, {
    headers: authHeaders(profile.token),
  });
}

export async function sendSessionMessage(
  connection: CompanionConnection,
  sessionId: string,
  prompt: string,
  inputPayload?: MobileInputPayload,
): Promise<void> {
  const profile = asProfile(connection);
  await requestVoid(profile, `/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: authHeaders(profile.token),
    body: JSON.stringify({ prompt, inputPayload }),
  });
}

export async function updateSessionSettings(
  connection: CompanionConnection,
  sessionId: string,
  settings: MobileSessionSettingsPatch,
): Promise<MobileSession> {
  const profile = asProfile(connection);
  return requestJson<MobileSession>(profile, `/api/sessions/${sessionId}/settings`, {
    method: 'PATCH',
    headers: authHeaders(profile.token),
    body: JSON.stringify(settings),
  });
}

export async function interruptSession(
  connection: CompanionConnection,
  sessionId: string,
): Promise<void> {
  const profile = asProfile(connection);
  await requestVoid(profile, `/api/sessions/${sessionId}/interrupt`, {
    method: 'POST',
    headers: authHeaders(profile.token),
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
  const profile = asProfile(connection);
  return requestJson<MobileSession>(profile, '/api/sessions', {
    method: 'POST',
    headers: authHeaders(profile.token),
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
  response: MobilePermissionResponse,
): Promise<void> {
  const profile = asProfile(connection);
  await requestVoid(profile, '/api/permissions/respond', {
    method: 'POST',
    headers: authHeaders(profile.token),
    body: JSON.stringify({ sessionId, requestId, response }),
  });
}

export async function respondUserInput(
  connection: CompanionConnection,
  sessionId: string,
  toolUseId: string,
  response: unknown,
): Promise<void> {
  const profile = asProfile(connection);
  await requestVoid(profile, '/api/interactive/user-input', {
    method: 'POST',
    headers: authHeaders(profile.token),
    body: JSON.stringify({ sessionId, toolUseId, response }),
  });
}

export function buildWsUrl(connection: CompanionConnection, sessionId: string): string {
  const profile = asProfile(connection);
  const active = resolveActiveConnection(profile);
  if (active.type === 'relay') {
    throw new Error('WebSocket is not available over relay; use polling fallback');
  }
  return resolveProfileWsUrl(profile, sessionId);
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
    || message.includes('连接超时')
    || message.includes('relay');
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
