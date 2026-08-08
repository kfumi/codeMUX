import { useEffect, useMemo, useState } from 'react';

import { providerDisplayName } from '@/components/settings/ProviderBrandIcon';
import { isProviderUsable } from '../lib/modelProviders';
import type { ModelProvider } from '../types/provider';
import type { AgentKind } from '../types/session';

export interface ModelOption {
  /** Unique selector value: `${providerId}::${modelId}` */
  id: string;
  modelId: string;
  providerId: string;
  providerTemplateId: string | null;
  name: string;
  group: string;
  description?: string;
  efforts?: boolean;
  source?: 'provider' | 'catalog' | 'config' | 'builtin';
}

function providersFingerprint(providers: ModelProvider[]): string {
  return JSON.stringify(
    providers.map((provider) => ({
      id: provider.id,
      enabled: provider.enabled,
      name: provider.name,
      default_model: provider.default_model,
      models: provider.models.map((model) => [model.id, model.name]),
      endpoints: provider.endpoints.map((endpoint) => [
        endpoint.protocol,
        endpoint.base_url,
        Boolean(endpoint.api_key_override?.trim()),
      ]),
      api_key: Boolean(provider.api_key.trim()),
    })),
  );
}

export function encodeModelSelectorValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function decodeModelSelectorValue(
  value: string,
): { providerId: string; modelId: string } | null {
  const separator = value.indexOf('::');
  if (separator <= 0) return null;
  const providerId = value.slice(0, separator);
  const modelId = value.slice(separator + 2);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/** Collect usable provider models for an agent, grouped by provider. */
export function useAgentModels(
  agentKind: AgentKind,
  providers: ModelProvider[] | ModelProvider | null,
  _activeProviderId: string | null = null,
): { models: ModelOption[]; isLoading: boolean } {
  const providerList = useMemo(() => {
    if (!providers) return [] as ModelProvider[];
    return Array.isArray(providers) ? providers : [providers];
  }, [providers]);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick((value) => value + 1);
  }, [agentKind, providersFingerprint(providerList)]);

  const models = useMemo(() => {
    void tick;
    const usable = providerList.filter((provider) => isProviderUsable(provider, agentKind));
    // Keep enabled + configured order: enabled already required by usable; preserve list order.
    return usable.flatMap((provider) => {
      const group = providerDisplayName(provider.name, provider.builtin_template_id);
      return provider.models
        .filter((model) => model.id.trim())
        .map((model) => {
          const modelId = model.id.trim();
          return {
            id: encodeModelSelectorValue(provider.id, modelId),
            modelId,
            providerId: provider.id,
            providerTemplateId: provider.builtin_template_id ?? null,
            name: (model.name ?? modelId).trim() || modelId,
            group,
            efforts: true,
            source: 'provider' as const,
          };
        });
    });
  }, [agentKind, providerList, tick]);

  return { models, isLoading: false };
}

/** @deprecated Free catalog is no longer a default send path (ADR 0005). */
export function initializeOpenCodeFreeModels(_forceRefresh = false): Promise<void> {
  return Promise.resolve();
}
