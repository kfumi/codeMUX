import type { AgentKind } from '@/types/session';
import type { ModelProvider, Protocol, ProtocolEndpoint } from '@/types/provider';

export function requiredProtocol(agentKind: AgentKind): Protocol | null {
  switch (agentKind) {
    case 'claude_code':
      return 'anthropic';
    case 'codex':
    case 'opencode':
      return 'openai_compatible';
    default:
      return null;
  }
}

export function selectEndpoint(
  provider: ModelProvider,
  protocol: Protocol,
): ProtocolEndpoint | null {
  return (
    provider.endpoints.find(
      (endpoint) => endpoint.protocol === protocol && endpoint.base_url.trim().length > 0,
    ) ?? null
  );
}

export function effectiveApiKey(provider: ModelProvider, endpoint: ProtocolEndpoint): string {
  const override = endpoint.api_key_override?.trim();
  if (override) return override;
  return provider.api_key.trim();
}

export function isProviderUsable(provider: ModelProvider, agentKind: AgentKind): boolean {
  if (!provider.enabled) return false;
  const protocol = requiredProtocol(agentKind);
  if (!protocol) return false;
  const endpoint = selectEndpoint(provider, protocol);
  if (!endpoint) return false;
  if (!effectiveApiKey(provider, endpoint)) return false;
  const defaultModel = provider.default_model.trim();
  if (!defaultModel) return false;
  return provider.models.some((model) => model.id.trim() === defaultModel);
}

export function providerUnusableReason(
  provider: ModelProvider,
  agentKind: AgentKind,
): string | null {
  if (!provider.enabled) return '已禁用';
  const protocol = requiredProtocol(agentKind);
  if (!protocol) return '当前智能体不支持模型供应商';
  if (!selectEndpoint(provider, protocol)) {
    return protocol === 'anthropic' ? '缺少 Anthropic 端点' : '缺少 OpenAI 兼容端点';
  }
  const endpoint = selectEndpoint(provider, protocol)!;
  if (!effectiveApiKey(provider, endpoint)) return '未配置 API Key';
  if (!provider.default_model.trim()) return '未设置默认模型';
  if (!provider.models.some((model) => model.id.trim() === provider.default_model.trim())) {
    return '默认模型不在列表中';
  }
  return null;
}

export function getActiveModelProvider(
  providers: ModelProvider[] | undefined,
  activeId: string | null | undefined,
): ModelProvider | null {
  if (!providers?.length || !activeId) return null;
  return providers.find((provider) => provider.id === activeId) ?? null;
}
