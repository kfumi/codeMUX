import type { AppConfig, Provider } from '../types/provider';
import type { AgentKind } from '../types/session';
import { getPrimaryProviderModel } from './providerModels';
import { normalizeOpenAIBaseUrl } from './providerUrls';

export interface AgentProviderConfig {
  provider: Provider | null;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  runtimeModel: string | undefined;
}

function getProviderById(config: AppConfig | null | undefined, providerId?: string | null): Provider | null {
  if (!config || !providerId) {
    return null;
  }

  return config.providers.find((provider) => provider.id === providerId) ?? null;
}

function stripContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/, '');
}

function resolveDisplayModel(provider: Provider | null, sessionModel?: string | null): string | undefined {
  const model = sessionModel?.trim() || getPrimaryProviderModel(provider) || undefined;
  if (!model) {
    return undefined;
  }

  return stripContextSuffix(model);
}

function resolveRuntimeModel(model: string | undefined, provider: Provider | null, agentKind: AgentKind): string | undefined {
  if (!model) {
    return undefined;
  }

  if (agentKind === 'claude_code' && provider?.context_1m) {
    return `${stripContextSuffix(model)}[1m]`;
  }

  return model;
}

export function resolveAgentProviderConfig({
  agentKind,
  config,
  sessionProviderId,
  sessionModel,
}: {
  agentKind: AgentKind;
  config: AppConfig | null | undefined;
  sessionProviderId?: string | null;
  sessionModel?: string | null;
}): AgentProviderConfig {
  const sessionProvider = getProviderById(config, sessionProviderId);
  const activeProvider = getProviderById(config, config?.active_provider_id);
  const provider = sessionProvider ?? activeProvider;
  const model = resolveDisplayModel(provider, sessionModel);

  return {
    provider,
    apiKey: provider?.api_key || undefined,
    baseUrl:
      agentKind === 'codex'
        ? (provider?.openai_base_url ? normalizeOpenAIBaseUrl(provider.openai_base_url) : undefined)
        : provider?.anthropic_base_url || undefined,
    model,
    runtimeModel: resolveRuntimeModel(model, provider, agentKind),
  };
}
