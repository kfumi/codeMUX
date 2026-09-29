import { stripDateSnapshot, stripBedrockDottedVendorPrefix } from './normalize';
import { catalogDisplayName } from '../modelCatalog';

/** Tokens that must stay upper-cased when a raw id is prettified. */
const MODEL_NAME_ACRONYMS: Record<string, string> = {
  api: 'API',
  asr: 'ASR',
  glm: 'GLM',
  gpt: 'GPT',
  hd: 'HD',
  llm: 'LLM',
  mt: 'MT',
  ocr: 'OCR',
  tts: 'TTS',
  vl: 'VL',
};

export type ResolvedRegistryModel = {
  apiModelId: string;
  /**
   * The id the display name came from — set only when the models.dev catalog
   * had an entry for `(provider template, model id)`. `enrichFetchedModels`
   * reads it to decide whether an upstream name may be kept.
   */
  presetModelId: string | null;
  name: string;
  /** The catalog's own display name, or `null` when it had no entry. */
  curatedName: string | null;
};

function titleCaseIdToken(token: string): string {
  const acronym = MODEL_NAME_ACRONYMS[token.toLowerCase()];
  if (acronym) return acronym;
  if (/^[a-z]/.test(token)) return token.charAt(0).toUpperCase() + token.slice(1);
  return token;
}

function trailingRemainder(id: string, stem: string): string {
  return id.length > stem.length ? id.slice(stem.length).replace(/^[-:@._]+/, '') : '';
}

function prettifyIdSegment(segment: string): string {
  const stem = stripDateSnapshot(segment);
  const date = trailingRemainder(segment, stem);
  const pretty = stem.split('-').filter(Boolean).map(titleCaseIdToken).join(' ');
  return date ? `${pretty} (${date})` : pretty;
}

/**
 * Display name for a model id the catalog has no entry for.
 *
 * Three layers, in order: the last path segment, the dotted Bedrock vendor
 * prefix that normalization folds away (restored as decoration), and the
 * date snapshot that `stripDateSnapshot` removed.
 */
export function deriveResolvedModelName(rawId: string): string {
  const slashIdx = rawId.lastIndexOf('/');
  const afterSlash = slashIdx >= 0 ? rawId.slice(slashIdx + 1) : rawId;
  const tail = afterSlash.slice(
    afterSlash.length - stripBedrockDottedVendorPrefix(afterSlash.toLowerCase()).length,
  );

  const name = prettifyIdSegment(tail);
  const namespaces = [
    ...(slashIdx >= 0 ? rawId.slice(0, slashIdx).split('/').map(titleCaseIdToken) : []),
    ...(tail.length < afterSlash.length
      ? [afterSlash.slice(0, afterSlash.length - tail.length - 1)]
      : []),
  ];
  return namespaces.length > 0 ? `${namespaces.join(': ')}: ${name}` : name;
}

/**
 * Resolve one raw api model id to a display name.
 *
 * The catalog is keyed by `(provider template, model id)` — the same two-level
 * key the hand-written override table used, which models.dev publishes natively
 * and better (it already decorates dated snapshots, e.g. `GPT-4o-mini
 * (2024-07-18)`). Ids it does not carry — a relay's own naming, a retired
 * model, or any of the providers it doesn't list — are prettified instead.
 */
export function resolveModelFromRegistry(
  providerId: string | null | undefined,
  rawId: string,
): ResolvedRegistryModel {
  const apiModelId = rawId.trim();
  if (!apiModelId) {
    return { apiModelId: '', presetModelId: null, name: '', curatedName: null };
  }

  const curatedName = catalogDisplayName(providerId, apiModelId);
  if (curatedName) {
    return { apiModelId, presetModelId: apiModelId, curatedName, name: curatedName };
  }

  return {
    apiModelId,
    presetModelId: null,
    curatedName: null,
    name: deriveResolvedModelName(apiModelId),
  };
}

export type FetchedModelNameInput = {
  id: string;
  name?: string | null;
};

/**
 * Name rules for a fetched `/models` list:
 * - catalog entry → the catalog's name
 * - no entry but upstream returns a name that differs from the id → keep it
 * - otherwise → prettify the id
 */
export function enrichFetchedModels(
  providerId: string | null | undefined,
  fetched: readonly FetchedModelNameInput[],
): Array<{ id: string; name: string }> {
  return fetched
    .map((item) => {
      const id = item.id.trim();
      if (!id) return null;

      const upstreamName = item.name?.trim() ?? '';
      const resolved = resolveModelFromRegistry(providerId, id);
      const keepFetchedName =
        !resolved.presetModelId && !!upstreamName && upstreamName !== id;

      return { id, name: keepFetchedName ? upstreamName : resolved.name };
    })
    .filter((item): item is { id: string; name: string } => item != null);
}

/**
 * Resolve a stored/fetched model display name with optional provider context.
 */
export function resolveModelDisplayName(model: {
  id: string;
  name?: string | null;
  providerTemplateId?: string | null;
}): string {
  const id = model.id.trim();
  if (!id) return '';

  const enriched = enrichFetchedModels(model.providerTemplateId, [{ id, name: model.name }]);
  return enriched[0]?.name || id;
}

// Re-export stripDateSnapshot for callers/tests that imported it from resolve before.
export { stripDateSnapshot } from './normalize';
