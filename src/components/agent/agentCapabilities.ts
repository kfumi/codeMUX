import { supports } from '../../lib/agentKind';
import type { AgentKind } from '../../types/session';

export function supportsCapability(agentKind: AgentKind, capability: string): boolean {
  return supports(agentKind, capability as never);
}
