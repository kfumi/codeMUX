import { useState, useEffect } from 'react';
import { fileApi } from '../lib/tauri';
import type { AgentKind } from '../types/session';
import type { AgentProviderProfile, OpenCodeModel } from '../types/provider';

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

const CODEX_DEFAULT_MODELS: ModelOption[] = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', efforts: true },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: true },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: true },
  { id: 'gpt-5.5', name: 'GPT-5.5', efforts: true },
  { id: 'gpt-5.4', name: 'GPT-5.4', efforts: true },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', efforts: true },
  { id: 'gpt-5.2', name: 'GPT-5.2', efforts: true },
];

const OPENCODE_FREE_MODELS: ModelOption[] = [
  { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', efforts: true },
  { id: 'opencode/north-mini-code-free', name: 'North Mini Code Free', efforts: true },
  { id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', efforts: true },
  { id: 'opencode/mimo-v2.5-free', name: 'Mimo V2.5 Free', efforts: true },
  { id: 'opencode/big-pickle', name: 'Big Pickle Free', efforts: true },
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

  const profileModels: ModelOption[] = activeProfile.models
    .filter((m) => m.id.trim())
    .map((m) => ({
      id: m.id.trim(),
      name: m.name?.trim() || m.id.trim(),
      efforts: true,
      source: 'profile' as const,
    }));

  return dedupById([...profileModels, ...builtins]);
}

interface CodexCatalogEntry {
  model?: string;
  displayName?: string;
}

function normalizeCatalogModels(entries: CodexCatalogEntry[]): ModelOption[] {
  return entries
    .filter((m) => m.model)
    .map((m) => ({
      id: m.model!,
      name: m.displayName ?? m.model!,
      efforts: true,
      source: 'catalog' as const,
    }));
}

async function loadCodexModels(
  activeProfile: AgentProviderProfile | null,
): Promise<ModelOption[]> {
  if (!activeProfile) return [...CODEX_DEFAULT_MODELS];

  let models: ModelOption[] = [];

  if (activeProfile.native_config.type === 'codex' && activeProfile.native_config.model_catalog) {
    try {
      const raw = activeProfile.native_config.model_catalog;
      const entries: CodexCatalogEntry[] = typeof raw === 'string' ? JSON.parse(raw) : raw;
      models = normalizeCatalogModels(entries);
    } catch {
      // ignore parse errors
    }
  }

  const defaultModel = activeProfile.default_model.trim();
  if (defaultModel && !models.some((m) => m.id === defaultModel)) {
    models.unshift({ id: defaultModel, name: defaultModel, efforts: true, source: 'profile' });
  }

  return dedupById([...models, ...CODEX_DEFAULT_MODELS]);
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

  if (!activeProfile) return dedupById([...OPENCODE_FREE_MODELS, ...fileModels]);

  const profileModels: ModelOption[] = activeProfile.models
    .filter((m) => m.id.trim())
    .map((m) => ({
      id: m.id.trim(),
      name: m.name?.trim() || m.id.trim(),
      efforts: true,
      source: 'profile' as const,
    }));

  return dedupById([...profileModels, ...OPENCODE_FREE_MODELS, ...fileModels]);
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
