import { useEffect, useMemo, useState } from 'react';
import type { AgentKind } from '../types/session';
import type { ModelProvider } from '../types/provider';
import { isProviderUsable } from '../lib/modelProviders';

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  efforts?: boolean;
  source?: 'provider' | 'catalog' | 'config' | 'builtin';
}

function providerFingerprint(provider: ModelProvider | null): string {
  if (!provider) return 'none';
  return JSON.stringify({
    id: provider.id,
    default_model: provider.default_model,
    models: provider.models.map((model) => model.id),
  });
}

export function useAgentModels(
  agentKind: AgentKind,
  activeProvider: ModelProvider | null,
  _activeProviderId: string | null = null,
): { models: ModelOption[]; isLoading: boolean } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick((value) => value + 1);
  }, [agentKind, providerFingerprint(activeProvider)]);

  const models = useMemo(() => {
    void tick;
    if (!activeProvider || !isProviderUsable(activeProvider, agentKind)) {
      return [] as ModelOption[];
    }
    return activeProvider.models
      .filter((model) => model.id.trim())
      .map((model) => ({
        id: model.id.trim(),
        name: (model.name ?? model.id).trim() || model.id.trim(),
        efforts: true,
        source: 'provider' as const,
      }));
  }, [activeProvider, agentKind, tick]);

  return { models, isLoading: false };
}

/** @deprecated Free catalog is no longer a default send path (ADR 0005). */
export function initializeOpenCodeFreeModels(_forceRefresh = false): Promise<void> {
  return Promise.resolve();
}
