import type { AgentKind } from '../../types/session';
import type { AgentProviderProfile } from '../../types/provider';

const LARGE_CONTEXT_SUFFIX = '[1m]';

const ROLE_ENV_KEYS: Record<string, string> = {
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

function envValue(settings: Record<string, unknown>, key: string): string | undefined {
  const env = settings.env;
  if (!env || typeof env !== 'object') return undefined;
  const value = (env as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function checkProfileModelSupports1m(
  profile: AgentProviderProfile | null,
  modelId: string,
): boolean {
  if (!profile || profile.native_config.type !== 'claude_code') return false;

  const settings = profile.native_config.settings;
  if (!settings || typeof settings !== 'object') return false;

  // Check role model mappings (sonnet, opus, fable)
  const envKey = ROLE_ENV_KEYS[modelId];
  if (envKey) {
    const value = envValue(settings, envKey);
    if (value && /\[1m\]|\[1M\]/i.test(value)) return true;
  }

  // Check custom models (requestModel field)
  const customModels = (settings as Record<string, unknown>).custom_models;
  if (Array.isArray(customModels)) {
    for (const cm of customModels) {
      if (typeof cm === 'object' && cm !== null) {
        const rec = cm as Record<string, unknown>;
        const requestModel = String(rec.requestModel ?? '');
        const displayName = String(rec.displayName ?? '');
        if (requestModel === modelId || displayName === modelId) {
          if (/\[1m\]|\[1M\]/i.test(requestModel)) return true;
        }
      }
    }
  }

  // Check fallback model (ANTHROPIC_MODEL)
  const fallback = envValue(settings, 'ANTHROPIC_MODEL');
  if (fallback && /\[1m\]|\[1M\]/i.test(fallback)) {
    const base = fallback.replace(/\[1m\]|\[1M\]/i, '');
    if (base === modelId) return true;
  }

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
