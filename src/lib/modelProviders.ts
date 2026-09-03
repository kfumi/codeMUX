import type { AgentKind } from '@/types/session';
import type { ModelProvider, Protocol, ProtocolEndpoint } from '@/types/provider';

export function requiredProtocol(agentKind: AgentKind): Protocol | null {
  switch (agentKind) {
    case 'claude_code':
      return 'anthropic';
    case 'codex':
    case 'opencode':
      return 'openai_compatible';
    // pi 双协议可用：Anthropic 优先、OpenAI 兼容兜底（与 Rust 侧一致）。
    case 'pi':
      return 'anthropic';
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

/** Codex 优先直连原生 Responses 端点，未配置时回退 OpenAI 兼容端点。 */
export function codexEndpoint(provider: ModelProvider): ProtocolEndpoint | null {
  return (
    selectEndpoint(provider, 'openai_responses') ?? selectEndpoint(provider, 'openai_compatible')
  );
}

/** pi 优先 Anthropic 端点（ANTHROPIC_* 凭据注入），回退 OpenAI 兼容端点。 */
export function piEndpoint(provider: ModelProvider): ProtocolEndpoint | null {
  return selectEndpoint(provider, 'anthropic') ?? selectEndpoint(provider, 'openai_compatible');
}

export function agentEndpoint(
  provider: ModelProvider,
  agentKind: AgentKind,
): ProtocolEndpoint | null {
  if (agentKind === 'codex') return codexEndpoint(provider);
  if (agentKind === 'pi') return piEndpoint(provider);
  const protocol = requiredProtocol(agentKind);
  return protocol ? selectEndpoint(provider, protocol) : null;
}

export function effectiveApiKey(provider: ModelProvider, endpoint: ProtocolEndpoint): string {
  const override = endpoint.api_key_override?.trim();
  if (override) return override;
  return provider.api_key.trim();
}

export function isProviderUsable(provider: ModelProvider, agentKind: AgentKind): boolean {
  if (!provider.enabled) return false;
  const endpoint = agentEndpoint(provider, agentKind);
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
  if (!requiredProtocol(agentKind)) return '当前智能体不支持模型供应商';
  const endpoint = agentEndpoint(provider, agentKind);
  if (!endpoint) {
    if (agentKind === 'claude_code') return '缺少 Anthropic 端点';
    if (agentKind === 'opencode') return '缺少 OpenAI 兼容端点';
    if (agentKind === 'pi') return '缺少 Anthropic 或 OpenAI 兼容端点';
    return '缺少 OpenAI Responses 或 OpenAI 兼容端点';
  }
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
