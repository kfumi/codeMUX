import { describe, expect, it } from 'vitest';

import {
  deriveResolvedModelName,
  enrichFetchedModels,
  resolveModelDisplayName,
  resolveModelFromRegistry,
} from './resolve';

describe('modelRegistry resolve', () => {
  it('uses curated catalog name on exact id match', () => {
    const resolved = resolveModelFromRegistry('openai', 'gpt-4o');
    expect(resolved.presetModelId).toBe('gpt-4o');
    expect(resolved.name).toBe('GPT-4o');
  });

  it('uses Cherry silicon override + catalog name for namespaced wire ids', () => {
    const resolved = resolveModelFromRegistry('siliconflow', 'deepseek-ai/DeepSeek-V3');
    expect(resolved.presetModelId).toBe('deepseek-v3');
    expect(resolved.name).toBe('DeepSeek V3 0324');
  });

  it('decorates fuzzy date-snapshot siblings of a catalog entry', () => {
    const resolved = resolveModelFromRegistry('anthropic', 'claude-sonnet-4-20250929');
    expect(resolved.presetModelId).toBe('claude-sonnet-4');
    expect(resolved.name).toBe('Claude Sonnet 4 (20250929)');
  });

  it('decorates builtin dated anthropic ids that are not exact catalog rows', () => {
    const resolved = resolveModelFromRegistry('anthropic', 'claude-sonnet-4-20250514');
    expect(resolved.presetModelId).toBe('claude-sonnet-4');
    expect(resolved.name).toBe('Claude Sonnet 4 (20250514)');
  });

  it('resolves openrouter and opencode-go wire ids to Cherry curated names', () => {
    expect(resolveModelFromRegistry('openrouter', 'anthropic/claude-sonnet-4').name).toBe(
      'Claude Sonnet 4',
    );
    expect(resolveModelFromRegistry('opencode-go', 'kimi-k2.6').name).toBe('Kimi K2.6');
    expect(resolveModelFromRegistry('opencode-go', 'glm-5.1').name).toBe('GLM-5.1');
    expect(resolveModelFromRegistry('deepseek', 'deepseek-v4-flash').name).toBe(
      'DeepSeek V4 Flash',
    );
    expect(resolveModelFromRegistry('zhipu', 'glm-5.2').name).toBe('GLM-5.2');
  });

  it('matches dotted wire ids to hyphenated Cherry catalog ids', () => {
    expect(resolveModelFromRegistry('zhipu', 'glm-4.7').name).toBe('GLM-4.7');
    expect(resolveModelFromRegistry('openai', 'gpt-4.1').name).toBe('GPT-4.1');
  });

  it('decorates colon / hyphen variants while preserving aggregator clean curated names', () => {
    expect(resolveModelFromRegistry('openai', 'gpt-4o:free').name).toBe('GPT-4o (free)');
    expect(resolveModelFromRegistry('openai', 'gpt-4o-free').name).toBe('GPT-4o (free)');
    expect(resolveModelFromRegistry('openai', 'aihubmix-gpt-4o').name).toBe('GPT-4o');
    expect(resolveModelFromRegistry('openai', 'gpt-4o-fp8').name).toBe('GPT-4o (fp8)');
  });

  it('decorates slash / dotted vendor namespaces and Bedrock revisions', () => {
    expect(resolveModelFromRegistry(null, 'MiniMax/MiniMax-M2.1').name).toMatch(/^MiniMax:/);
    expect(resolveModelFromRegistry('openrouter', 'qwen-plus-2025-12-01').name).toBe(
      'Qwen Plus (2025-12-01)',
    );
    expect(
      deriveResolvedModelName('us.anthropic.claude-sonnet-4-5-v1:0', 'Claude Sonnet 4.5', 'claude-sonnet-4-5'),
    ).toBe('us.anthropic: Claude Sonnet 4.5 (v1:0)');
  });

  it('prettifies unmatched ids', () => {
    expect(resolveModelFromRegistry(null, 'custom-model').name).toBe('Custom Model');
    expect(deriveResolvedModelName('openai/gpt-5-preview', null, null)).toBe(
      'Openai: GPT 5 Preview',
    );
  });

  it('enrich keeps upstream display name only when registry misses', () => {
    expect(
      enrichFetchedModels('custom', [
        { id: 'custom-model', name: 'Provider Display Name' },
        { id: 'gpt-4o', name: 'Upstream GPT' },
        { id: 'mystery-model', name: 'mystery-model' },
      ]),
    ).toEqual([
      { id: 'custom-model', name: 'Provider Display Name' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'mystery-model', name: 'Mystery Model' },
    ]);
  });

  it('resolveModelDisplayName uses provider template context', () => {
    expect(
      resolveModelDisplayName({
        id: 'anthropic/claude-sonnet-4',
        providerTemplateId: 'openrouter',
      }),
    ).toBe('Claude Sonnet 4');
  });
});
