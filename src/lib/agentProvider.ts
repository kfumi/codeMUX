import type { AppConfig, Provider } from '../types/provider';
import type { AgentKind } from '../types/session';
import { getPrimaryProviderModel } from './providerModels';
import { normalizeOpenAIBaseUrl } from './providerUrls';

export type OpenCodeCredentialSource = 'codemux' | 'environment' | 'opencode' | 'none';

export const OPENCODE_OPENAI_PROVIDER = 'codemux-openai';
export const OPENCODE_ANTHROPIC_PROVIDER = 'codemux-anthropic';

export interface AgentProviderConfig {
  provider: Provider | null;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  runtimeModel: string | undefined;
  providerName: string | undefined;
  credentialSource: OpenCodeCredentialSource | undefined;
  configurationError: string | undefined;
  codexNeedsProxy: boolean | undefined;
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

function inferCodexNeedsProxy(baseUrl: string | undefined): boolean | undefined {
  if (!baseUrl) {
    return undefined;
  }

  try {
    return new URL(baseUrl).host.toLowerCase() !== 'api.openai.com';
  } catch {
    return true;
  }
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
  const baseUrl = agentKind === 'codex'
    ? (provider?.openai_base_url ? normalizeOpenAIBaseUrl(provider.openai_base_url) : undefined)
    : agentKind === 'opencode'
      ? provider?.openai_base_url || provider?.anthropic_base_url || undefined
      : provider?.anthropic_base_url || undefined;
  const apiKey = provider?.api_key || undefined;
  const providerName = agentKind === 'opencode'
    ? provider?.openai_base_url
      ? OPENCODE_OPENAI_PROVIDER
      : provider?.anthropic_base_url
        ? OPENCODE_ANTHROPIC_PROVIDER
        : undefined
    : undefined;
  const credentialSource = agentKind === 'opencode'
    ? apiKey
      ? 'codemux'
      : baseUrl
        ? 'environment'
        : 'none'
    : undefined;
  const configurationError = agentKind === 'opencode'
    ? !provider
      ? 'OpenCode 需要先选择一个 CodeMUX Provider。'
      : !model
        ? 'OpenCode 需要先在当前 Provider 中配置模型。'
        : !baseUrl
          ? 'OpenCode 需要当前 Provider 配置 base URL。'
          : undefined
    : undefined;

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    runtimeModel: resolveRuntimeModel(model, provider, agentKind),
    providerName,
    credentialSource,
    configurationError,
    codexNeedsProxy:
      agentKind === 'codex'
        ? inferCodexNeedsProxy(baseUrl) && (provider?.codex_needs_proxy ?? true)
        : undefined,
  };
}
