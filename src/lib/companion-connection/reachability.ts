import type {
  CompanionConnectionEntry,
  CompanionConnectionProfile,
  ConnectionReachability,
} from './types';
import { buildRestUrl, isHttpUrlBlockedBySecurePage } from './transport';

const HEALTH_TIMEOUT_MS = 3000;

async function probeHealth(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function probeConnectionReachability(
  connection: CompanionConnectionEntry,
): Promise<boolean> {
  if (connection.type === 'relay') {
    return true;
  }
  const healthUrl = buildRestUrl(connection, '/api/health');
  if (isHttpUrlBlockedBySecurePage(healthUrl)) {
    return false;
  }
  return probeHealth(healthUrl);
}

export async function buildReachabilityMap(
  profile: CompanionConnectionProfile,
): Promise<ConnectionReachability> {
  const entries = await Promise.all(
    profile.connections.map(async (connection) => [
      connection.id,
      await probeConnectionReachability(connection),
    ] as const),
  );
  return Object.fromEntries(entries);
}

export function summarizeActiveConnection(
  profile: CompanionConnectionProfile,
  reachability: ConnectionReachability,
): string {
  const direct = profile.connections.find((connection) => connection.type === 'direct');
  const lan = profile.connections.find((connection) => connection.type === 'lan');
  const relay = profile.connections.find((connection) => connection.type === 'relay');

  if (direct && reachability[direct.id] !== false) {
    const protocol = direct.useTls ? 'https' : 'http';
    return `${protocol}://${direct.host}:${direct.port}`;
  }
  if (lan && reachability[lan.id] !== false) {
    return lan.baseUrl;
  }
  if (relay) {
    return `中继 · ${relay.endpoint}`;
  }
  return profile.label ?? profile.desktopId;
}
