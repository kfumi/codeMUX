import type { ImageRecognitionConfig, ModelProvider, ProviderModel } from '../types/provider';
import { modelSupportsVision } from './inputModalities';

const EXPLICIT_VISION_UNSUPPORTED_MODELS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'mimo-v2.5-pro',
]);

/**
 * Models a runtime has rejected an image payload for, keyed by
 * `provider::model` and expiring on a TTL.
 *
 * The fact learned is "this provider's model rejects images" — never "this
 * model id". Keying it by id alone collapsed the two together, so one
 * endpoint that rejects images silently disabled them for the same id behind
 * every other provider, in every session, for the rest of the process's life:
 * a `Set` that only ever grows and is never invalidated, even after the user
 * changes the endpoint's API key or the model's declared modalities.
 *
 * Entries are scoped by provider and expire, so a config change takes effect
 * on its own. The cap keeps a long-lived window from accumulating one entry
 * per id ever tried; `Map` preserves insertion order, so the oldest goes first.
 */
const VISION_UNSUPPORTED_TTL_MS = 30 * 60 * 1000;
const VISION_UNSUPPORTED_MAX_ENTRIES = 200;

const runtimeUnsupportedVisionModels = new Map<string, number>();

function normalizeModelName(model: string | null | undefined): string {
  // Claude Code 的 1M 上下文会话在模型 ID 后追加 `[1m]`，能力判断与
  // 运行时缓存键都必须剥掉它，否则查不到元数据、缓存也分裂成两份。
  return (model ?? '').trim().toLowerCase().replace(/\s*\[1m\]\s*$/i, '').replace(/\s+/g, '-');
}

/**
 * Cache key for one learned rejection. Without a provider we cannot scope it,
 * so it falls back to the bare id — still expiring, but no longer a permanent
 * cross-provider verdict.
 */
function visionCacheKey(
  provider: string | null | undefined,
  model: string | null | undefined,
): string {
  const normalized = normalizeModelName(model);
  if (!normalized) return '';
  const scope = (provider ?? '').trim().toLowerCase();
  return scope ? `${scope}::${normalized}` : normalized;
}

function isCachedUnsupported(key: string, now: number): boolean {
  if (!key) return false;
  const learnedAt = runtimeUnsupportedVisionModels.get(key);
  if (learnedAt === undefined) return false;
  if (now - learnedAt < VISION_UNSUPPORTED_TTL_MS) return true;
  runtimeUnsupportedVisionModels.delete(key);
  return false;
}

/** Test seam: drop everything the runtime taught us. */
export function __resetVisionCacheForTests(): void {
  runtimeUnsupportedVisionModels.clear();
}

export function getCachedVisionSupport(
  model: string | null | undefined,
  provider?: string | null,
): boolean | undefined {
  return isCachedUnsupported(visionCacheKey(provider, model), Date.now()) ? false : undefined;
}

export function markModelVisionUnsupported(
  model: string | null | undefined,
  provider?: string | null,
): void {
  const key = visionCacheKey(provider, model);
  if (!key) return;
  // Re-insert so the key moves to the end of the insertion order and the
  // eviction below drops a genuinely older entry rather than this one.
  runtimeUnsupportedVisionModels.delete(key);
  runtimeUnsupportedVisionModels.set(key, Date.now());
  while (runtimeUnsupportedVisionModels.size > VISION_UNSUPPORTED_MAX_ENTRIES) {
    const oldest = runtimeUnsupportedVisionModels.keys().next();
    if (oldest.done) break;
    runtimeUnsupportedVisionModels.delete(oldest.value);
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
 * Resolve the model metadata for a session: the session provider's own entry
 * wins, because the same model id can exist under several providers with
 * different modality settings; only fall back to the global first match when
 * the session provider does not list the model at all.
 */
export function findSessionModelMetadata(
  model: string | null | undefined,
  providers: ModelProvider[],
  providerId: string | null | undefined,
): ProviderModel | undefined {
  const normalized = normalizeModelName(model);
  if (!normalized) return undefined;
  const sessionProvider = providerId
    ? providers.find((provider) => provider.id === providerId)
    : undefined;
  const scoped = sessionProvider?.models.find((entry) => normalizeModelName(entry.id) === normalized);
  if (scoped) return scoped;
  for (const provider of providers) {
    const match = provider.models.find((entry) => normalizeModelName(entry.id) === normalized);
    if (match) return match;
  }
  return undefined;
}

/**
 * Resolve whether the session model supports native image input.
 * Priority: runtime learned → input modalities / supports_vision → legacy denylist → unknown default.
 *
 * `providerId` scopes the runtime-learned memo; pass the provider the session
 * is actually bound to so a rejection behind one endpoint cannot disable
 * images for the same model id behind another.
 */
export function resolveVisionCapability(
  model: string | null | undefined,
  modelMetadata: ProviderModel | undefined,
  enrichmentEnabled: boolean,
  providerId?: string | null,
): boolean {
  const normalized = normalizeModelName(model);
  if (isCachedUnsupported(visionCacheKey(providerId, model), Date.now())) {
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
