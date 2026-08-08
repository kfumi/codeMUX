import type { Provider } from '../types/provider';
import {
  deriveResolvedModelName,
  enrichFetchedModels,
  resolveModelDisplayName as resolveWithRegistry,
} from './modelRegistry';

/**
 * Model display-name helpers aligned with Cherry Studio + CodeMUX lightweight registry.
 * See docs/research/cherry-studio-model-display-name-rules.md
 */

/** Format a raw model id (unmatched registry path / prettify). */
export function formatModelDisplayName(modelId: string): string {
  return deriveResolvedModelName(modelId.trim(), null, null);
}

/**
 * Resolve display name for a fetched or stored model.
 * Optional `providerTemplateId` enables catalog / provider-override curated names.
 */
export function resolveModelDisplayName(model: {
  id: string;
  name?: string | null;
  providerTemplateId?: string | null;
}): string {
  return resolveWithRegistry(model);
}

/** Enrich a fetched `/models` list with registry names (Cherry enrichFetchedModels). */
export { enrichFetchedModels };

export function modelsFromText(value: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];

  for (const line of value.split(/\r?\n/)) {
    const model = line.trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    models.push(model);
  }

  return models;
}

export function modelsToText(models: readonly string[] | null | undefined): string {
  return [...(models ?? [])].map((model) => model.trim()).filter(Boolean).join('\n');
}

export function getProviderModelList(provider: Provider | null | undefined): string[] {
  if (!provider) {
    return [];
  }

  const models = Array.isArray(provider.models) ? provider.models : [];
  const normalized = modelsFromText(models.join('\n'));

  if (normalized.length > 0) {
    return normalized;
  }

  const fallback = provider.default_model?.trim();
  return fallback ? [fallback] : [];
}

export function getPrimaryProviderModel(provider: Provider | null | undefined): string {
  return getProviderModelList(provider)[0] ?? '';
}

export function normalizeProviderModels(provider: Provider): Provider {
  const models = getProviderModelList(provider);
  return {
    ...provider,
    models,
    default_model: models[0] ?? '',
  };
}
