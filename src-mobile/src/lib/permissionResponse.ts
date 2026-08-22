export type MobilePermissionDecision = 'once' | 'always' | 'reject';

export type MobilePermissionResponse = MobilePermissionDecision | { approved: boolean };

/**
 * Builds the payload for POST /api/permissions/respond. Claude and Codex
 * accept the native decision strings (the Codex app-server bridge maps
 * once/always/reject onto accept/acceptForSession/decline); OpenCode expects
 * a server-side approval object.
 */
export function buildMobilePermissionResponse(
  agentKind: string,
  decision: MobilePermissionDecision,
): MobilePermissionResponse {
  if (agentKind === 'opencode') {
    return { approved: decision !== 'reject' };
  }
  return decision;
}
