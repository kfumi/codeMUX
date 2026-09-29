import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveResolvedModelName,
  enrichFetchedModels,
  resolveModelDisplayName,
  resolveModelFromRegistry,
} from './resolve';
import { __setModelDisplayNameIndexForTests } from '../modelCatalog';

/**
 * A stand-in for the models.dev name index the daemon serves, using real
 * entries — models.dev is keyed by `(provider, wire id)`, which is exactly the
 * two-level key this module looks up.
 */
const CATALOG_NAMES: Record<string, string> = {
  'openai::gpt-4o': 'GPT-4o',
  'openai::gpt-4o-mini-2024-07-18': 'GPT-4o-mini (2024-07-18)',
  'openrouter::anthropic/claude-sonnet-4': 'Claude Sonnet 4',
  'openrouter::~anthropic/claude-sonnet-latest': 'Claude Sonnet Latest',
  'openrouter::qwen-plus-2025-12-01': 'Qwen Plus (2025-12-01)',
  'siliconflow::deepseek-ai/DeepSeek-V3': 'DeepSeek V3',
  'opencode-go::glm-5.1': 'GLM-5.1',
  'deepseek::deepseek-v4-flash': 'DeepSeek V4 Flash',
  'anthropic::claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
};

function withCatalog<T>(run: () => T): T {
  __setModelDisplayNameIndexForTests({ names: CATALOG_NAMES, source: 'bundled' });
  try {
    return run();
  } finally {
    __setModelDisplayNameIndexForTests(null);
  }
}

describe('modelRegistry resolve', () => {
  afterEach(() => {
    __setModelDisplayNameIndexForTests(null);
  });

  it('uses the catalog name on an exact (provider, model id) match', () => {
    withCatalog(() => {
      const resolved = resolveModelFromRegistry('openai', 'gpt-4o');
      expect(resolved.presetModelId).toBe('gpt-4o');
      expect(resolved.name).toBe('GPT-4o');
    });
  });

  it('scopes the lookup to the provider template', () => {
    withCatalog(() => {
      // Same id, different provider: only the matching template may supply a name.
      expect(resolveModelFromRegistry('openrouter', 'gpt-4o').presetModelId).toBeNull();
      expect(resolveModelFromRegistry(null, 'gpt-4o').presetModelId).toBeNull();
    });
  });

  it('resolves namespaced wire ids straight from the catalog', () => {
    withCatalog(() => {
      expect(resolveModelFromRegistry('openrouter', 'anthropic/claude-sonnet-4').name).toBe(
        'Claude Sonnet 4',
      );
      // The `~` OpenRouter fallback-router prefix is a real key upstream.
      expect(resolveModelFromRegistry('openrouter', '~anthropic/claude-sonnet-latest').name).toBe(
        'Claude Sonnet Latest',
      );
      expect(resolveModelFromRegistry('siliconflow', 'deepseek-ai/DeepSeek-V3').name).toBe(
        'DeepSeek V3',
      );
    });
  });

  it('keeps the catalog own decoration of dated snapshots', () => {
    withCatalog(() => {
      expect(resolveModelFromRegistry('openai', 'gpt-4o-mini-2024-07-18').name).toBe(
        'GPT-4o-mini (2024-07-18)',
      );
      expect(resolveModelFromRegistry('openrouter', 'qwen-plus-2025-12-01').name).toBe(
        'Qwen Plus (2025-12-01)',
      );
    });
  });

  it('prettifies anything the catalog does not carry', () => {
    withCatalog(() => {
      // Custom and relay ids, plus the providers models.dev does not list.
      expect(resolveModelFromRegistry('zhipu', 'glm-5.2').name).toBe('GLM 5.2');
      expect(resolveModelFromRegistry('moonshot', 'kimi-k2.6').name).toBe('Kimi K2.6');
      expect(resolveModelFromRegistry(null, 'custom-model').name).toBe('Custom Model');
      // A dated id the catalog has no entry for still gets its date back.
      expect(resolveModelFromRegistry('anthropic', 'claude-sonnet-4-20250514').name).toBe(
        'Claude Sonnet 4 (20250514)',
      );
    });
  });

  it('decorates slash / dotted vendor namespaces', () => {
    expect(deriveResolvedModelName('MiniMax/MiniMax-M2.1')).toMatch(/^MiniMax:/);
    expect(deriveResolvedModelName('openai/gpt-5-preview')).toBe('Openai: GPT 5 Preview');
  });

  it('falls back to prettifying when the catalog has not loaded', () => {
    // First paint, or a daemon that could not fetch it: every id is prettified.
    expect(resolveModelFromRegistry('openai', 'gpt-4o').name).toBe('GPT 4o');
    expect(resolveModelDisplayName({ id: 'gpt-4o', providerTemplateId: 'openai' })).toBe('GPT 4o');
  });

  it('enrich keeps upstream display name only when the catalog misses', () => {
    withCatalog(() => {
      expect(
        enrichFetchedModels('openai', [
          { id: 'gpt-4o', name: 'Upstream GPT' },
          { id: 'mystery-model', name: 'Provider Display Name' },
          { id: 'echoes-id', name: 'echoes-id' },
        ]),
      ).toEqual([
        // Catalog wins.
        { id: 'gpt-4o', name: 'GPT-4o' },
        // No entry: an upstream name that differs from the id is more useful.
        { id: 'mystery-model', name: 'Provider Display Name' },
        // No entry and upstream just echoes the id: prettify.
        { id: 'echoes-id', name: 'Echoes Id' },
      ]);
    });
  });

  it('resolveModelDisplayName uses provider template context', () => {
    withCatalog(() => {
      expect(
        resolveModelDisplayName({
          id: 'anthropic/claude-sonnet-4',
          providerTemplateId: 'openrouter',
        }),
      ).toBe('Claude Sonnet 4');
    });
  });

  it('takes the catalog name verbatim rather than re-decorating the id', () => {
    withCatalog(() => {
      // The catalog already applies the house style (vendor prefix, variant
      // suffix, snapshot dates), so the name is used as-is — re-running our own
      // decoration on top of it would double the namespace.
      const resolved = resolveModelFromRegistry('openai', 'gpt-4o-mini-2024-07-18');
      expect(resolved.curatedName).toBe('GPT-4o-mini (2024-07-18)');
      expect(resolved.name).toBe(resolved.curatedName);
      expect(resolved.name).not.toMatch('Openai:');
    });
  });
});
