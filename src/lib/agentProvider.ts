import type { AppConfig, Provider } from '../types/provider';
import type { AgentKind } from '../types/session';
import { normalizeOpenAIBaseUrl } from './providerUrls';

export interface AgentProviderConfig {
  provider: Provider | null;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
}

function getProviderById(config: AppConfig | null | undefined, providerId?: string | null): Provider | null {
  if (!config || !providerId) {
    return null;
  }

  return config.providers.find((provider) => provider.id === providerId) ?? null;
}

function resolveModel(provider: Provider | null, agentKind: AgentKind): string | undefined {
  const model = provider?.default_model || undefined;
  if (!model) {
    return undefined;
  }

  if (agentKind === 'claude_code' && provider?.context_1m && !model.includes('[1m]')) {
    return `${model}[1m]`;
  }

  return model;
}

export function resolveAgentProviderConfig({
  agentKind,
  config,
  sessionProviderId,
}: {
  agentKind: AgentKind;
  config: AppConfig | null | undefined;
  sessionProviderId?: string | null;
}): AgentProviderConfig {
  const sessionProvider = getProviderById(config, sessionProviderId);
  const activeProvider = getProviderById(config, config?.active_provider_id);
  const provider = sessionProvider ?? activeProvider;

  return {
    provider,
    apiKey: provider?.api_key || undefined,
    baseUrl:
      agentKind === 'codex'
        ? (provider?.openai_base_url ? normalizeOpenAIBaseUrl(provider.openai_base_url) : undefined)
        : provider?.anthropic_base_url || undefined,
    model: resolveModel(provider, agentKind),
  };
}
