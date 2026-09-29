import type { InputModality, ProviderModel } from '../types/provider';

export const INPUT_MODALITY_OPTIONS = [
  { id: 'image' as const, label: '视觉' },
  { id: 'audio' as const, label: '音频' },
  { id: 'video' as const, label: '视频' },
] as const;

export type OptionalInputModality = (typeof INPUT_MODALITY_OPTIONS)[number]['id'];

export function normalizeInputModalities(modalities?: InputModality[] | null): InputModality[] {
  const result = new Set<InputModality>(['text']);
  for (const modality of modalities ?? []) {
    if (modality !== 'text') {
      result.add(modality);
    }
  }
  return Array.from(result);
}

export function toggleOptionalInputModality(
  current: InputModality[] | null | undefined,
  modality: OptionalInputModality,
): InputModality[] {
  const normalized = normalizeInputModalities(current);
  if (normalized.includes(modality)) {
    return normalized.filter((entry) => entry !== modality);
  }
  return [...normalized, modality];
}

export function hasInputModality(
  modalities: InputModality[] | null | undefined,
  modality: InputModality,
): boolean {
  return normalizeInputModalities(modalities).includes(modality);
}

export function modelSupportsVision(model?: ProviderModel | null): boolean | null | undefined {
  if (model?.input_modalities?.length) {
    return hasInputModality(model.input_modalities, 'image');
  }
  return model?.supports_vision;
}

/**
 * Input modalities to record for a model being added, from what is actually
 * known: an explicit declaration (a builtin template's curated value, or the
 * models.dev catalog joined onto the picker row) wins; anything else falls
 * back to the text-only default.
 *
 * Deliberately no substring guessing any more. Family rules go stale — glm-5.x
 * and DeepSeek grew vision — and a wrong guess written into config reads as a
 * user declaration that the catalog suggestion must never override (ADR 0015),
 * so the error was permanent. A catalog miss now stays at the plain default,
 * which the user can correct in the edit dialog.
 */
export function inferDefaultInputModalities(
  declaredModalities?: InputModality[] | null,
  catalogModalities?: readonly string[] | null,
): InputModality[] {
  if (declaredModalities?.length) {
    return normalizeInputModalities(declaredModalities);
  }

  const fromCatalog = normalizeInputModalities(
    catalogModalities?.filter((modality): modality is InputModality =>
      modality === 'image' || modality === 'audio' || modality === 'video',
    ),
  );
  if (catalogModalities?.length) {
    return fromCatalog;
  }

  return ['text'];
}
