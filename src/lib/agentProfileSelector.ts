import type { AgentProviderProfile, Provider } from '../types/provider';

/** 将脱敏档案投影为既有模型选择器所需的展示结构；不得用于运行时连接。 */
export function profileToSelectorProvider(profile: AgentProviderProfile): Provider {
  const native = profile.native_config;
  return {
    id: profile.id,
    name: profile.name,
    api_key: '',
    anthropic_base_url: native.type === 'claude_code' ? native.anthropic_base_url : '',
    openai_base_url: native.type === 'claude_code' ? '' : native.openai_base_url,
    default_model: profile.default_model,
    models: profile.models.map((model) => model.id),
    context_1m: native.type === 'claude_code' ? Boolean(native.context_1m) : false,
    codex_needs_proxy: native.type === 'codex' ? Boolean(native.codex_needs_proxy) : false,
  };
}
