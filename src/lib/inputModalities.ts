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

export function inferDefaultInputModalities(modelId: string, templateModalities?: InputModality[] | null): InputModality[] {
  if (templateModalities?.length) {
    return normalizeInputModalities(templateModalities);
  }

  const normalized = modelId.trim().toLowerCase();
  if (
    normalized.includes('claude')
    || normalized.includes('gpt-4o')
    || normalized.includes('gpt-5')
    || normalized.includes('gpt-4.1')
    || normalized.includes('4v')
    || normalized.includes('vision')
  ) {
    return ['text', 'image'];
  }
  if (normalized.includes('deepseek') || normalized.includes('glm-4.7') || normalized.includes('glm-5')) {
    return ['text'];
  }
  return ['text'];
}
