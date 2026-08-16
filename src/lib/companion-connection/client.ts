import { getRelayTunnelClient } from './relay';
import { resolveActiveConnection } from './transport';
import type {
  CompanionConnectionEntry,
  CompanionConnectionProfile,
  ConnectionReachability,
} from './types';
import { buildRestUrl } from './transport';

export interface CompanionHttpResponse {
  status: number;
  body: string;
}

export async function companionHttpRequest(
  profile: CompanionConnectionProfile,
  path: string,
  init: RequestInit = {},
  reachability: ConnectionReachability = {},
): Promise<CompanionHttpResponse> {
  const connection = resolveActiveConnection(profile, reachability);
  if (connection.type === 'relay') {
    const client = getRelayTunnelClient(profile, connection, profile.desktopId);
    return client.request(path, init);
  }
  const url = buildRestUrl(connection, path);
  const response = await fetch(url, { ...init, cache: 'no-store' });
  const body = await response.text();
  return { status: response.status, body };
}

export function isRelayConnection(
  connection: CompanionConnectionEntry,
): connection is Extract<CompanionConnectionEntry, { type: 'relay' }> {
  return connection.type === 'relay';
}
