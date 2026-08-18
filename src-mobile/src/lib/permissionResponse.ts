export type MobilePermissionResponse = 'once' | 'reject' | { approved: boolean };

export function buildMobilePermissionResponse(
  agentKind: string,
  allow: boolean,
): MobilePermissionResponse {
  if (agentKind === 'opencode') {
    return { approved: allow };
  }
  return allow ? 'once' : 'reject';
}
