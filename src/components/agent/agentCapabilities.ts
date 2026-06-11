import { getAgentDefinition } from '../../types/agentRegistry';
import type { AgentKind } from '../../types/session';

export function supportsCapability(agentKind: AgentKind, capability: string): boolean {
  return getAgentDefinition(agentKind)?.capabilities.includes(capability as never) ?? false;
}
