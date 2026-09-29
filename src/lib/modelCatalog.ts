/**
 * Public model capability catalog (models.dev).
 *
 * Advisory only (ADR 0015): `provider.models` stays the user's configuration
 * and the sole authority. A lookup that finds nothing returns `found: false`
 * rather than a guess — relay and proxy endpoints carry model ids no public
 * catalog will ever list, and an invented answer is worse than none.
 *
 * `mergeCatalogIntoModel` is the TS mirror of `suggestion_for` in
 * `crates/daemon/src/services/model_catalog.rs`; both only fill what the user
 * has not set.
 */

import type { InputModality, ProviderModel } from '../types/provider';
import { daemonFacade } from './facades/daemon-facade';
import { normalizeInputModalities } from './inputModalities';
import { normalizeThinkingLevels } from './reasoningEffort';
import type { ReasoningEffort } from '../types/session';

/** One model's published capabilities, as the daemon reports them. */
export interface CatalogEntry {
  provider: string;
  model_id: string;
  name?: string;
  /** Whether the catalog published reasoning support at all. */
  reasoning: boolean;
  reasoning_published: boolean;
  /** Thinking levels in CodeMUX's vocabulary, already normalized daemon-side. */
  thinking_levels: string[];
  context_window?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_modalities: string[];
}

export interface ModelCatalogLookup {
  found: boolean;
  entry?: CatalogEntry;
  /** `remote` = freshly fetched, `bundled` = the snapshot shipped with the app. */
  source: 'remote' | 'bundled';
}

/**
 * Apply a catalog entry to the model being edited.
 *
 * Never overwrites a value the user set. A `thinking_levels` of `[]` counts as
 * a decision ("this model does not reason") and is left alone; only an absent
 * declaration is filled.
 */
export function mergeCatalogIntoModel(
  model: ProviderModel,
  entry: CatalogEntry,
): ProviderModel {
  const merged: ProviderModel = { ...model };

  if (!merged.name?.trim() && entry.name) {
    merged.name = entry.name;
  }
  if (merged.thinking_levels === undefined || merged.thinking_levels === null) {
    const levels = normalizeThinkingLevels(entry.thinking_levels);
    if (levels.length > 0) merged.thinking_levels = levels;
  }
  if (merged.context_window == null && entry.context_window) {
    merged.context_window = entry.context_window;
  }
  if (merged.max_input_tokens == null && entry.max_input_tokens) {
    merged.max_input_tokens = entry.max_input_tokens;
  }
  if (merged.max_output_tokens == null && entry.max_output_tokens) {
    merged.max_output_tokens = entry.max_output_tokens;
  }
  // An existing `["text"]` is a declaration too ("text only"), so only an absent
  // one gets filled. `normalizeInputModalities` seeds `text`, which every entry
  // must carry — dropping it would make pi drop the prompt entirely.
  if (merged.input_modalities == null && entry.input_modalities.length > 0) {
    merged.input_modalities = normalizeInputModalities(
      entry.input_modalities.filter((modality): modality is InputModality =>
        modality === 'image' || modality === 'audio' || modality === 'video',
      ),
    );
  }
  return merged;
}

/**
 * `mergeCatalogIntoModel` plus the "would it change anything?" check the UI
 * needs: the merged model when the catalog has something to add, else `null`.
 * Both the suggestion card and the one-shot auto-fill in ProviderConfig run
 * on this, so they can never disagree about what the catalog offers.
 */
export function catalogSuggestionFor(
  model: ProviderModel,
  entry: CatalogEntry,
): ProviderModel | null {
  const merged = mergeCatalogIntoModel(model, entry);
  const changed = (Object.keys(merged) as (keyof ProviderModel)[]).some(
    (key) => merged[key] !== model[key],
  );
  return changed ? merged : null;
}

/** Thinking levels the catalog suggests, or `null` when it has no opinion. */
export function catalogThinkingLevels(
  entry: CatalogEntry | undefined,
): ReasoningEffort[] | null {
  if (!entry) return null;
  const levels = normalizeThinkingLevels(entry.thinking_levels);
  return levels.length > 0 ? levels : null;
}

/**
 * Display names from the catalog, keyed `"<templateId>::<modelId>"`.
 *
 * This replaces a hand-maintained 829-row table (410 catalog names + 419
 * provider-scoped wire-id overrides). models.dev is already indexed by
 * `(provider, wire id)`, so the wire-id layer it replaces is a two-level key we
 * were maintaining by hand.
 */
export interface ModelDisplayNameIndex {
  names: Record<string, string>;
  source: 'remote' | 'bundled';
}

let displayNameIndex: ModelDisplayNameIndex | null = null;
let displayNameIndexLoad: Promise<void> | null = null;
const displayNameListeners = new Set<() => void>();

function notifyDisplayNameListeners(): void {
  for (const listener of displayNameListeners) listener();
}

/** Subscribe to the index arriving; returns an unsubscribe function. */
export function onModelDisplayNamesChanged(listener: () => void): () => void {
  displayNameListeners.add(listener);
  return () => displayNameListeners.delete(listener);
}

/** Load the index once per app session. Safe to call from anywhere, repeatedly. */
export async function loadModelDisplayNames(): Promise<void> {
  if (displayNameIndexLoad) return displayNameIndexLoad;
  displayNameIndexLoad = (async () => {
    try {
      const result = await daemonFacade.fetchModelCatalogNames();
      displayNameIndex = result;
    } catch {
      // The catalog is optional; without it every name falls back to
      // prettifying the id, which is what happened before we had a catalog.
      displayNameIndex = null;
    }
    notifyDisplayNameListeners();
  })();
  return displayNameIndexLoad;
}

/** Test seam: swap or clear the in-memory index. */
export function __setModelDisplayNameIndexForTests(
  index: ModelDisplayNameIndex | null,
): void {
  displayNameIndex = index;
  displayNameIndexLoad = null;
}

/**
 * The catalog's display name for a model, or `null` when it has no opinion.
 *
 * `providerTemplateId` is the provider's builtin template id. A custom or relay
 * provider has none, and its ids are the user's own — those fall back to
 * prettifying.
 */
export function catalogDisplayName(
  providerTemplateId: string | null | undefined,
  modelId: string,
): string | null {
  if (!displayNameIndex || !providerTemplateId) return null;
  const name = displayNameIndex.names[`${providerTemplateId}::${modelId.trim()}`];
  return name?.trim() || null;
}

/** Whether the name index has been populated yet. */
export function hasModelDisplayNames(): boolean {
  return displayNameIndex !== null;
}
