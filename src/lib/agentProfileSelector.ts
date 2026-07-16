import type { AgentProviderProfile, Provider } from '../types/provider';

function claudeEnvValue(profile: AgentProviderProfile, key: string): string {
  if (profile.native_config.type !== 'claude_code') return '';
  const env = profile.native_config.settings?.env;
  return env && typeof env === 'object' && typeof (env as Record<string, unknown>)[key] === 'string'
    ? (env as Record<string, string>)[key]
    : '';
}

/** 将脱敏档案投影为既有模型选择器所需的展示结构；不得用于运行时连接。 */
export function getProfilePrimaryModel(profile: AgentProviderProfile | null | undefined): string {
  return profile?.models.find((model) => model.id.trim())?.id.trim() ?? '';
}

export function profileToSelectorProvider(profile: AgentProviderProfile): Provider {
  const native = profile.native_config;
  return {
    id: profile.id,
    name: profile.name,
    api_key: '',
    anthropic_base_url: claudeEnvValue(profile, 'ANTHROPIC_BASE_URL'),
    openai_base_url: native.type === 'claude_code' ? '' : native.openai_base_url,
    default_model: getProfilePrimaryModel(profile),
    models: profile.models.map((model) => model.id),
    context_1m: false,
    codex_needs_proxy: native.type === 'codex' ? Boolean(native.codex_needs_proxy) : false,
  };
}
