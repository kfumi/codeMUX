import type { ImageRecognitionConfig, ProviderModel } from '../types/provider';
import { modelSupportsVision } from './inputModalities';

const EXPLICIT_VISION_UNSUPPORTED_MODELS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'mimo-v2.5-pro',
]);

const runtimeUnsupportedVisionModels = new Set<string>();

function normalizeModelName(model: string | null | undefined): string {
  return (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

export function getCachedVisionSupport(model: string | null | undefined): boolean | undefined {
  const normalized = normalizeModelName(model);
  if (!normalized) return undefined;
  return runtimeUnsupportedVisionModels.has(normalized) ? false : undefined;
}

export function markModelVisionUnsupported(model: string | null | undefined): void {
  const normalized = normalizeModelName(model);
  if (normalized) {
    runtimeUnsupportedVisionModels.add(normalized);
  }
}

export function findProviderModelMetadata(
  model: string | null | undefined,
  providerModels: ProviderModel[],
): ProviderModel | undefined {
  const normalized = normalizeModelName(model);
  if (!normalized) return undefined;
  return providerModels.find((entry) => normalizeModelName(entry.id) === normalized);
}

/**
 * Resolve whether the session model supports native image input.
 * Priority: runtime learned → input modalities / supports_vision → legacy denylist → unknown default.
 */
export function resolveVisionCapability(
  model: string | null | undefined,
  modelMetadata: ProviderModel | undefined,
  enrichmentEnabled: boolean,
): boolean {
  const normalized = normalizeModelName(model);
  if (normalized && runtimeUnsupportedVisionModels.has(normalized)) {
    return false;
  }

  const explicitVision = modelSupportsVision(modelMetadata);
  if (explicitVision === true) {
    return true;
  }
  if (explicitVision === false) {
    return false;
  }

  if (normalized && EXPLICIT_VISION_UNSUPPORTED_MODELS.has(normalized)) {
    return false;
  }
  return enrichmentEnabled ? false : true;
}

/** Backward-compatible helper: unknown models default to optimistic send. */
export function inferModelSupportsVision(model: string | null | undefined): boolean {
  return resolveVisionCapability(model, undefined, false);
}

export function isImageRecognitionConfigured(
  config: ImageRecognitionConfig | undefined,
): boolean {
  return Boolean(
    config?.enabled
    && config.base_url.trim()
    && config.model.trim()
    && (config.api_key.trim() || config.api_key_configured),
  );
}

/** @deprecated */
export const isAttachmentEnrichmentConfigured = isImageRecognitionConfigured;
