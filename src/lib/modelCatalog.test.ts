import { describe, expect, it } from 'vitest';

import {
  REASONING_EFFORT_OPTIONS,
  effortOptionsForModel,
  normalizeThinkingLevels,
  resolveThinkingLevels,
} from './reasoningEffort';
import { catalogSuggestionFor, catalogThinkingLevels, mergeCatalogIntoModel, type CatalogEntry } from './modelCatalog';
import { inferDefaultInputModalities } from './inputModalities';
import type { ProviderModel } from '../types/provider';

const allIds = REASONING_EFFORT_OPTIONS.map((option) => option.id);

describe('normalizeThinkingLevels', () => {
  it('drops unknown entries, de-duplicates and returns canonical order', () => {
    expect(normalizeThinkingLevels(['high', 'high', 'bogus', '', 'low'])).toEqual(['low', 'high']);
  });

  it('folds pi and session synonyms onto the canonical vocabulary', () => {
    expect(normalizeThinkingLevels(['off', 'disabled', 'minimal', 'HIGH'])).toEqual([
      'none',
      'low',
      'high',
    ]);
  });
});

describe('resolveThinkingLevels', () => {
  it('distinguishes undeclared from declared-as-unsupported', () => {
    expect(resolveThinkingLevels(null)).toBeNull();
    expect(resolveThinkingLevels({})).toBeNull();
    expect(resolveThinkingLevels({ thinking_levels: null })).toBeNull();
    expect(resolveThinkingLevels({ thinking_levels: [] })).toEqual([]);
    expect(resolveThinkingLevels({ thinking_levels: ['xhigh', 'none'] })).toEqual(['none', 'xhigh']);
  });
});

describe('effortOptionsForModel', () => {
  it('offers every level when nothing is declared', () => {
    // Existing sessions must keep working, so an unconfigured model still gets
    // the full vocabulary.
    expect(effortOptionsForModel({}).map((option) => option.id)).toEqual(allIds);
  });

  it('offers only "off" when the model is declared as not reasoning', () => {
    expect(effortOptionsForModel({ thinking_levels: [] }).map((option) => option.id)).toEqual([
      'none',
    ]);
  });

  it('offers exactly the declared levels, in canonical order', () => {
    const options = effortOptionsForModel({ thinking_levels: ['xhigh', 'off', 'low'] });
    expect(options.map((option) => option.id)).toEqual(['none', 'low', 'xhigh']);
  });
});

describe('mergeCatalogIntoModel', () => {
  const entry: CatalogEntry = {
    provider: 'anthropic',
    model_id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    reasoning: true,
    reasoning_published: true,
    thinking_levels: ['low', 'high', 'minimal'],
    context_window: 200_000,
    max_input_tokens: undefined,
    max_output_tokens: 64_000,
    input_modalities: ['text', 'image', 'pdf'],
  };

  it('fills only what the user has not set', () => {
    const merged = mergeCatalogIntoModel({ id: 'claude-sonnet-4-5' }, entry);
    expect(merged.name).toBe('Claude Sonnet 4.5');
    expect(merged.thinking_levels).toEqual(['low', 'high']);
    expect(merged.context_window).toBe(200_000);
    expect(merged.max_output_tokens).toBe(64_000);
    // `pdf` is not one of our tracked modalities.
    expect(merged.input_modalities).toEqual(['text', 'image']);
  });

  it('never overwrites a user decision', () => {
    const configured: ProviderModel = {
      id: 'claude-sonnet-4-5',
      name: 'Mine',
      thinking_levels: ['medium'],
      context_window: 32_000,
      input_modalities: ['text'],
    };
    const merged = mergeCatalogIntoModel(configured, entry);
    expect(merged.name).toBe('Mine');
    expect(merged.thinking_levels).toEqual(['medium']);
    expect(merged.context_window).toBe(32_000);
    expect(merged.input_modalities).toEqual(['text']);
  });

  it('does not overturn a model the user declared as non-reasoning', () => {
    const declined: ProviderModel = { id: 'm', thinking_levels: [] };
    expect(mergeCatalogIntoModel(declined, entry).thinking_levels).toEqual([]);
  });

  it('leaves thinking levels unset when the catalog publishes none', () => {
    const plain: CatalogEntry = { ...entry, reasoning: false, reasoning_options_unused: undefined } as CatalogEntry;
    plain.thinking_levels = [];
    const merged = mergeCatalogIntoModel({ id: 'm' }, plain);
    expect(merged.thinking_levels).toBeUndefined();
  });
});

describe('catalogSuggestionFor', () => {
  const entry: CatalogEntry = {
    provider: 'anthropic',
    model_id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    reasoning: true,
    reasoning_published: true,
    thinking_levels: ['low', 'high'],
    context_window: 200_000,
    max_input_tokens: undefined,
    max_output_tokens: 64_000,
    input_modalities: ['text', 'image'],
  };

  it('returns the merge when the catalog would add something', () => {
    const suggestion = catalogSuggestionFor({ id: 'claude-sonnet-4-5' }, entry);
    expect(suggestion?.context_window).toBe(200_000);
    expect(suggestion?.name).toBe('Claude Sonnet 4.5');
  });

  it('returns null when there is nothing left to fill', () => {
    const configured: ProviderModel = {
      id: 'claude-sonnet-4-5',
      name: 'Mine',
      thinking_levels: ['medium'],
      context_window: 32_000,
      max_output_tokens: 64_000,
      input_modalities: ['text'],
    };
    expect(catalogSuggestionFor(configured, entry)).toBeNull();
  });
});

describe('catalogThinkingLevels', () => {
  it('returns null when the catalog has no opinion', () => {
    expect(catalogThinkingLevels(undefined)).toBeNull();
    expect(
      catalogThinkingLevels({
        provider: 'p',
        model_id: 'm',
        reasoning: false,
        reasoning_published: false,
        thinking_levels: [],
        input_modalities: ['text'],
      }),
    ).toBeNull();
  });
});

describe('inferDefaultInputModalities', () => {
  it('prefers an explicit declared value over the catalog', () => {
    expect(inferDefaultInputModalities(['audio'], ['text', 'image'])).toEqual([
      'text',
      'audio',
    ]);
  });

  it('uses the catalog before the default', () => {
    // A vision model behind a relay used to be recorded as text-only here by a
    // substring guess, and its images were silently dropped.
    expect(inferDefaultInputModalities(null, ['text', 'image'])).toEqual(['text', 'image']);
    // Family rules are gone: the catalog is the only opinion above the default.
    expect(inferDefaultInputModalities(null, ['text', 'image', 'pdf'])).toEqual(['text', 'image']);
  });

  it('falls back to the text-only default when nothing is known', () => {
    // No guessing: an unknown id stays at the default, which the user can
    // correct in the edit dialog instead of fighting a wrong declaration.
    expect(inferDefaultInputModalities(null, null)).toEqual(['text']);
    expect(inferDefaultInputModalities(null, [])).toEqual(['text']);
  });
});
