import type { AgentKind } from '../../types/session';
import type { ModelProvider } from '../../types/provider';

export const LARGE_CONTEXT_SUFFIX = '[1m]';

/** Strip Claude Code `[1m]` markers from a model id (case-insensitive). */
export function stripContext1mSuffix(model: string): string {
  return model.replace(/\[1m\]/gi, '').trim();
}

/** Ensure a bare model id carries the Claude Code `[1m]` suffix. */
export function withContext1mSuffix(model: string): string {
  const base = stripContext1mSuffix(model);
  if (!base) return base;
  return `${base}${LARGE_CONTEXT_SUFFIX}`;
}

/** Whether the provider model entry enables Claude Code 1M context via `[1m]`. */
export function checkProfileModelSupports1m(
  provider: ModelProvider | null,
  modelId: string,
): boolean {
  if (!provider) return false;
  const baseId = stripContext1mSuffix(modelId);
  if (!baseId) return false;
  const entry = provider.models.find((model) => stripContext1mSuffix(model.id) === baseId);
  return entry?.context_1m === true;
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
