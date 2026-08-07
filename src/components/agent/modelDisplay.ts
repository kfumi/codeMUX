import type { AgentKind } from '../../types/session';
import type { ModelProvider } from '../../types/provider';

const LARGE_CONTEXT_SUFFIX = '[1m]';

/** 1M context detection for Claude role models is retired with native settings blobs. */
export function checkProfileModelSupports1m(
  _provider: ModelProvider | null,
  _modelId: string,
): boolean {
  return false;
}

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
