import {
  MODEL_CATALOG,
  PROVIDER_MODEL_OVERRIDES,
  type CatalogModel,
  type ProviderModelOverride,
} from './catalog';
import {
  colonVariantTagToHyphen,
  normalizeModelId,
  stripBedrockDottedVendorPrefix,
  stripBedrockRevision,
  stripDateSnapshot,
  stripHostReprefix,
  stripVariantQuantDateSuffixes,
} from './normalize';

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
  /** Set when a catalog / override entry matched. */
  presetModelId: string | null;
  name: string;
  curatedName: string | null;
  canonicalApiId: string | null;
};

type CatalogHit = {
  presetModelId: string;
  curatedName: string;
  canonicalApiId: string;
};

type RegistryIndexes = {
  catalogById: Map<string, CatalogModel>;
  catalogByNormId: Map<string, CatalogModel>;
  catalogBySizedNorm: Map<string, CatalogModel>;
  overrideByApiKey: Map<string, ProviderModelOverride>;
  overrideByNormApiKey: Map<string, ProviderModelOverride>;
  overrideByModelKey: Map<string, ProviderModelOverride>;
  overrideByNormModelKey: Map<string, ProviderModelOverride>;
};

let indexes: RegistryIndexes | null = null;

function buildIndexes(): RegistryIndexes {
  const catalogById = new Map<string, CatalogModel>();
  const catalogByNormId = new Map<string, CatalogModel>();
  const catalogBySizedNorm = new Map<string, CatalogModel>();

  for (const entry of MODEL_CATALOG) {
    catalogById.set(entry.id, entry);
    const norm = normalizeModelId(entry.id);
    if (!catalogByNormId.has(norm)) catalogByNormId.set(norm, entry);
    const sized = normalizeModelId(entry.id, { keepParameterSize: true });
    if (!catalogBySizedNorm.has(sized)) catalogBySizedNorm.set(sized, entry);
  }

  const overrideByApiKey = new Map<string, ProviderModelOverride>();
  const overrideByNormApiKey = new Map<string, ProviderModelOverride>();
  const overrideByModelKey = new Map<string, ProviderModelOverride>();
  const overrideByNormModelKey = new Map<string, ProviderModelOverride>();

  for (const entry of PROVIDER_MODEL_OVERRIDES) {
    const modelKey = `${entry.providerId}::${entry.modelId}`;
    const apiId = entry.apiModelId ?? entry.modelId;
    const apiKey = `${entry.providerId}::${apiId}`;
    if (!overrideByModelKey.has(modelKey)) overrideByModelKey.set(modelKey, entry);
    if (!overrideByApiKey.has(apiKey)) overrideByApiKey.set(apiKey, entry);

    const normModelKey = `${entry.providerId}::${normalizeModelId(entry.modelId)}`;
    const normApiKey = `${entry.providerId}::${normalizeModelId(apiId)}`;
    if (!overrideByNormModelKey.has(normModelKey)) overrideByNormModelKey.set(normModelKey, entry);
    if (!overrideByNormApiKey.has(normApiKey)) overrideByNormApiKey.set(normApiKey, entry);
  }

  return {
    catalogById,
    catalogByNormId,
    catalogBySizedNorm,
    overrideByApiKey,
    overrideByNormApiKey,
    overrideByModelKey,
    overrideByNormModelKey,
  };
}

function getIndexes(): RegistryIndexes {
  if (!indexes) indexes = buildIndexes();
  return indexes;
}

/** Test helper — rebuild indexes after catalog mutations. */
export function resetModelRegistryIndexesForTests(): void {
  indexes = null;
}

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
 * Cherry `deriveResolvedModelName`: curated exact match stays verbatim;
 * fuzzy siblings get distinguishing suffix/prefix; unmatched ids are prettified.
 */
export function deriveResolvedModelName(
  rawId: string,
  curatedName: string | null,
  canonicalApiId: string | null,
): string {
  if (curatedName && canonicalApiId && rawId === canonicalApiId) return curatedName;

  const slashIdx = rawId.lastIndexOf('/');
  const afterSlash = slashIdx >= 0 ? rawId.slice(slashIdx + 1) : rawId;
  // Normalization folds the dotted vendor prefix away; restore it as decoration.
  const tail = afterSlash.slice(
    afterSlash.length - stripBedrockDottedVendorPrefix(afterSlash.toLowerCase()).length,
  );

  let name: string;
  if (curatedName) {
    const suffix = trailingRemainder(tail, stripBedrockRevision(stripVariantQuantDateSuffixes(tail)));
    name = suffix ? `${curatedName} (${suffix})` : curatedName;
  } else {
    name = prettifyIdSegment(tail);
  }

  const namespaces = [
    ...(slashIdx >= 0 ? rawId.slice(0, slashIdx).split('/').map(titleCaseIdToken) : []),
    ...(tail.length < afterSlash.length
      ? [afterSlash.slice(0, afterSlash.length - tail.length - 1)]
      : []),
  ];
  return namespaces.length > 0 ? `${namespaces.join(': ')}: ${name}` : name;
}

function findCatalogModel(modelId: string): CatalogModel | undefined {
  const { catalogById, catalogByNormId, catalogBySizedNorm } = getIndexes();
  const exact = catalogById.get(modelId);
  if (exact) return exact;

  // Size-preserving colon tags (`gpt-oss:20b`) must not collapse onto a sibling size.
  if (colonVariantTagToHyphen(modelId) !== modelId) {
    return catalogBySizedNorm.get(normalizeModelId(modelId, { keepParameterSize: true }));
  }

  const byNorm = catalogByNormId.get(normalizeModelId(modelId));
  if (byNorm) return byNorm;

  // Host re-prefix: `databricks-gemini-…` → known catalog stem.
  const strippedHost = stripHostReprefix(normalizeModelId(modelId), (id) => catalogByNormId.has(id));
  if (strippedHost !== normalizeModelId(modelId)) {
    return catalogByNormId.get(strippedHost);
  }

  return undefined;
}

function findProviderOverride(
  providerId: string | null | undefined,
  apiModelId: string,
): ProviderModelOverride | undefined {
  if (!providerId) return undefined;
  const {
    overrideByApiKey,
    overrideByNormApiKey,
    overrideByModelKey,
    overrideByNormModelKey,
  } = getIndexes();

  const key = `${providerId}::${apiModelId}`;
  const normKey = `${providerId}::${normalizeModelId(apiModelId)}`;

  // Exact before normalized (Cherry registry-loader order).
  return (
    overrideByModelKey.get(key) ??
    overrideByApiKey.get(key) ??
    overrideByNormModelKey.get(normKey) ??
    overrideByNormApiKey.get(normKey)
  );
}

function lookupCatalogHit(
  providerId: string | null | undefined,
  rawId: string,
): CatalogHit | null {
  const override = findProviderOverride(providerId, rawId);
  if (override) {
    const preset = findCatalogModel(override.modelId) ?? findCatalogModel(rawId);
    const curatedName = override.name?.trim() || preset?.name || override.modelId;
    return {
      presetModelId: override.modelId,
      curatedName,
      canonicalApiId: override.apiModelId ?? override.modelId,
    };
  }

  const preset = findCatalogModel(rawId);
  if (preset) {
    return {
      presetModelId: preset.id,
      curatedName: preset.name,
      canonicalApiId: preset.id,
    };
  }

  return null;
}

/** Resolve one raw api model id against the lightweight registry. */
export function resolveModelFromRegistry(
  providerId: string | null | undefined,
  rawId: string,
): ResolvedRegistryModel {
  const apiModelId = rawId.trim();
  if (!apiModelId) {
    return {
      apiModelId: '',
      presetModelId: null,
      name: '',
      curatedName: null,
      canonicalApiId: null,
    };
  }

  const hit = lookupCatalogHit(providerId, apiModelId);
  if (hit) {
    return {
      apiModelId,
      presetModelId: hit.presetModelId,
      curatedName: hit.curatedName,
      canonicalApiId: hit.canonicalApiId,
      name: deriveResolvedModelName(apiModelId, hit.curatedName, hit.canonicalApiId),
    };
  }

  return {
    apiModelId,
    presetModelId: null,
    curatedName: null,
    canonicalApiId: null,
    name: deriveResolvedModelName(apiModelId, null, null),
  };
}

export type FetchedModelNameInput = {
  id: string;
  name?: string | null;
};

/**
 * Cherry `enrichFetchedModels` name rules:
 * - catalog hit (`presetModelId`) → registry curated/derived name
 * - no hit + upstream name ≠ id → keep upstream display name
 * - else → prettified id
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

      return {
        id,
        name: keepFetchedName ? upstreamName : resolved.name,
      };
    })
    .filter((item): item is { id: string; name: string } => item != null);
}

/**
 * Resolve a stored/fetched model display name with optional provider registry context.
 */
export function resolveModelDisplayName(model: {
  id: string;
  name?: string | null;
  providerTemplateId?: string | null;
}): string {
  const id = model.id.trim();
  if (!id) return '';

  const enriched = enrichFetchedModels(model.providerTemplateId, [
    { id, name: model.name },
  ]);
  return enriched[0]?.name || id;
}

// Re-export stripDateSnapshot for callers/tests that imported it from resolve before.
export { stripDateSnapshot } from './normalize';
