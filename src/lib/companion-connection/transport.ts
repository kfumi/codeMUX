import type {
  CompanionConnectionEntry,
  CompanionConnectionProfile,
  ConnectionReachability,
} from './types';
import { CompanionConnectionError } from './types';

const TRANSPORT_PRIORITY: CompanionConnectionEntry['type'][] = ['direct', 'lan', 'relay'];

function directBaseUrl(connection: Extract<CompanionConnectionEntry, { type: 'direct' }>): string {
  const protocol = connection.useTls ? 'https' : 'http';
  return `${protocol}://${connection.host}:${connection.port}`;
}

export function resolveActiveConnection(
  profile: CompanionConnectionProfile,
  reachability: ConnectionReachability = {},
): CompanionConnectionEntry {
  const preferred = profile.preferredConnectionId
    ? profile.connections.find((connection) => connection.id === profile.preferredConnectionId)
    : undefined;
  if (preferred && reachability[preferred.id] !== false) {
    return preferred;
  }

  for (const type of TRANSPORT_PRIORITY) {
    const candidate = profile.connections.find((connection) => connection.type === type);
    if (!candidate) continue;
    if (reachability[candidate.id] === false) continue;
    return candidate;
  }

  const fallback = profile.connections[0];
  if (!fallback) {
    throw new CompanionConnectionError('No companion connections configured');
  }
  return fallback;
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl.replace(/\/$/, '')}${normalizedPath}`;
}

export function connectionBaseUrl(connection: CompanionConnectionEntry): string {
  switch (connection.type) {
    case 'lan':
      return connection.baseUrl.replace(/\/$/, '');
    case 'direct':
      return directBaseUrl(connection);
    case 'relay':
      return `relay://${connection.endpoint}`;
    default: {
      const exhaustive: never = connection;
      return exhaustive;
    }
  }
}

export function buildRestUrl(connection: CompanionConnectionEntry, path: string): string {
  return joinUrl(connectionBaseUrl(connection), path);
}

export function buildWsUrl(
  connection: CompanionConnectionEntry,
  token: string,
  sessionId: string,
): string {
  const restBase = connectionBaseUrl(connection);
  const url = new URL('/api/ws', restBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}

export function resolveProfileRestUrl(profile: CompanionConnectionProfile, path: string): string {
  return buildRestUrl(resolveActiveConnection(profile), path);
}

export function resolveProfileWsUrl(
  profile: CompanionConnectionProfile,
  sessionId: string,
): string {
  const active = resolveActiveConnection(profile);
  return buildWsUrl(active, profile.token, sessionId);
}
