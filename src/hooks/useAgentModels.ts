import { useState, useEffect } from 'react';
import { fileApi } from '../lib/tauri';
import { getProviderModelList } from '../lib/providerModels';
import { profileToSelectorProvider } from '../lib/agentProfileSelector';
import type { AgentKind } from '../types/session';
import type { AgentProviderProfile, CodexCatalogModel, OpenCodeModel } from '../types/provider';

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  efforts?: boolean;
  source?: 'profile' | 'catalog' | 'config' | 'builtin';
}

const CLAUDE_CODE_BUILTINS: ModelOption[] = [
  { id: 'sonnet', name: 'Sonnet 5', efforts: true },
  { id: 'opus', name: 'Opus 4.8', efforts: true },
  { id: 'fable', name: 'Fable 5', efforts: true },
  { id: 'haiku', name: 'Haiku 4.5', efforts: true },
];

const OPENCODE_FREE_MODELS: ModelOption[] = [
  { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra', efforts: true },
  { id: 'opencode/north-mini-code-free', name: 'North Mini Code', efforts: true },
  { id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash', efforts: true },
  { id: 'opencode/mimo-v2.5-free', name: 'Mimo V2.5', efforts: true },
  { id: 'opencode/big-pickle', name: 'Big Pickle', efforts: true },
];

function dedupById(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

function getActiveProfileFingerprint(activeProfile: AgentProviderProfile | null): string {
  if (!activeProfile) return 'none';

  return JSON.stringify({
    id: activeProfile.id,
    agent_kind: activeProfile.agent_kind,
    default_model: activeProfile.default_model,
    models: activeProfile.models.map(({ id, name }) => ({ id, name })),
    provider_key: activeProfile.native_config.type === 'opencode'
      ? activeProfile.native_config.provider_key
      : undefined,
  });
}

async function loadClaudeCodeModels(
  activeProfile: AgentProviderProfile | null,
): Promise<ModelOption[]> {
  const builtins = [...CLAUDE_CODE_BUILTINS];
  if (!activeProfile) return builtins;

  try {
    const selectorProvider = profileToSelectorProvider(activeProfile);
    const providerModels = getProviderModelList(selectorProvider);
    const profileModels: ModelOption[] = providerModels.map((id) => ({
      id,
      name: id,
      efforts: true,
      source: 'profile',
    }));
    return dedupById([...builtins, ...profileModels]);
  } catch {
    return builtins;
  }
}

async function loadCodexModels(
  activeProfile: AgentProviderProfile | null,
): Promise<ModelOption[]> {
  if (!activeProfile) {
    try {
      const raw = await fileApi.readHomeFile('.codex/models_cache.json');
      const catalog = JSON.parse(raw) as CodexCatalogModel[];
      return catalog.map((m) => ({
        id: m.model,
        name: m.displayName ?? m.model,
        efforts: true,
        source: 'catalog',
      }));
    } catch {
      return [];
    }
  }

  const profileModels: ModelOption[] = activeProfile.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    efforts: true,
    source: 'profile',
  }));

  try {
    const raw = await fileApi.readHomeFile('.codex/codemux-model-catalog.json');
    const catalog = JSON.parse(raw) as CodexCatalogModel[];
      const catalogModels: ModelOption[] = catalog.map((m) => ({
        id: m.model,
        name: m.displayName ?? m.model,
        efforts: true,
        source: 'catalog',
      }));
    return dedupById([...profileModels, ...catalogModels]);
  } catch {
    return profileModels;
  }
}

async function loadOpenCodeModels(
  activeProfile: AgentProviderProfile | null,
): Promise<ModelOption[]> {
  let fileModels: ModelOption[] = [];
  try {
    const raw = await fileApi.readHomeFile('.config/opencode/opencode.json');
    const config = JSON.parse(raw) as { provider?: Record<string, { models?: Record<string, OpenCodeModel> }> };
    const providerKey = activeProfile?.native_config.type === 'opencode'
      ? activeProfile.native_config.provider_key
      : undefined;
    const providerConfig = config.provider?.[providerKey || 'codemux-openai'];
    if (providerConfig?.models) {
      for (const [modelId, modelDef] of Object.entries(providerConfig.models)) {
        fileModels.push({
          id: modelId,
          name: modelDef.name ?? modelId,
          efforts: true,
          source: 'config',
        });
      }
    }
  } catch {
    console.warn('Failed to load OpenCode config models');
  }

  const base = dedupById([...OPENCODE_FREE_MODELS, ...fileModels]);
  if (!activeProfile) return base;

  const profileModels: ModelOption[] = activeProfile.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    efforts: true,
    source: 'profile',
  }));

  return dedupById([...base, ...profileModels]);
}

export function useAgentModels(
  agentKind: AgentKind,
  activeProfile: AgentProviderProfile | null,
  activeProfileId: string | null,
): { models: ModelOption[]; isLoading: boolean } {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const activeProfileFingerprint = getActiveProfileFingerprint(activeProfile);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    async function load() {
      let result: ModelOption[];
      switch (agentKind) {
        case 'claude_code':
          result = await loadClaudeCodeModels(activeProfile);
          break;
        case 'codex':
          result = await loadCodexModels(activeProfile);
          break;
        case 'opencode':
          result = await loadOpenCodeModels(activeProfile);
          break;
        default:
          result = [];
      }
      if (!cancelled) {
        setModels(result);
        setIsLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [agentKind, activeProfileId, activeProfileFingerprint]);

  return { models, isLoading };
}
