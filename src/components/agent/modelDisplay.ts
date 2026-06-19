import type { AgentKind } from '../../types/session';

const LARGE_CONTEXT_SUFFIX = '[1m]';

export function formatModelDisplayName({
  model,
  agentKind,
  usesLargeContext,
}: {
  model: string;
  agentKind: AgentKind;
  usesLargeContext?: boolean;
}): string {
  if (agentKind === 'claude_code' && usesLargeContext && !model.endsWith(LARGE_CONTEXT_SUFFIX)) {
    return `${model}${LARGE_CONTEXT_SUFFIX}`;
  }

  return model;
}
