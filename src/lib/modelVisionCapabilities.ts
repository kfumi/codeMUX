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

export function inferModelSupportsVision(model: string | null | undefined): boolean {
  const normalized = normalizeModelName(model);
  if (!normalized) return true;
  if (runtimeUnsupportedVisionModels.has(normalized)) return false;
  if (EXPLICIT_VISION_UNSUPPORTED_MODELS.has(normalized)) return false;
  return true;
}
