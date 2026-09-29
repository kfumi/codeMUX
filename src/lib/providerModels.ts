import type { Provider } from '../types/provider';
import {
  deriveResolvedModelName,
  enrichFetchedModels,
  resolveModelDisplayName as resolveWithRegistry,
} from './modelRegistry';

/**
 * Model display-name helpers. Names come from the models.dev catalog when it has
 * an entry for `(provider template, model id)`; everything else is prettified
 * from the raw id. See docs/adr/0016-model-display-names-from-catalog.md
 */

/** Format a raw model id the catalog has no entry for (prettify). */
export function formatModelDisplayName(modelId: string): string {
  return deriveResolvedModelName(modelId.trim());
}

/**
 * Resolve display name for a fetched or stored model.
 * Optional `providerTemplateId` scopes the catalog lookup to that provider.
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
