import type { ModelProvider } from '../types/provider';

/** Primary model id for selector defaults. */
export function getProviderPrimaryModel(provider: ModelProvider | null | undefined): string {
  const defaultModel = provider?.default_model.trim();
  if (defaultModel) return defaultModel;
  return provider?.models.find((model) => model.id.trim())?.id.trim() ?? '';
}
