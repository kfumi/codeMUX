import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelProvider } from '../types/provider';
import {
  __resetVisionCacheForTests,
  findProviderModelMetadata,
  findSessionModelMetadata,
  getCachedVisionSupport,
  inferModelSupportsVision,
  markModelVisionUnsupported,
  resolveVisionCapability,
} from './modelVisionCapabilities';

describe('modelVisionCapabilities', () => {
  // The learned-rejection memo is process-wide, so every test starts clean.
  beforeEach(() => __resetVisionCacheForTests());
  afterEach(() => {
    __resetVisionCacheForTests();
    vi.useRealTimers();
  });

  it('defaults unknown models to vision-capable', () => {
    expect(inferModelSupportsVision('future-model-7')).toBe(true);
  });

  it('keeps mimo-v2.5 base model vision-capable', () => {
    expect(inferModelSupportsVision('mimo-v2.5')).toBe(true);
  });

  it('treats explicit denylist models as not vision-capable', () => {
    expect(inferModelSupportsVision('deepseek-v4-flash')).toBe(false);
    expect(inferModelSupportsVision('deepseek-v4-pro')).toBe(false);
    expect(inferModelSupportsVision('mimo-v2.5-pro')).toBe(false);
  });

  it('caches runtime unsupported decisions by normalized model name', () => {
    markModelVisionUnsupported('Future Model 7', 'relay-a');

    expect(getCachedVisionSupport('future-model-7', 'relay-a')).toBe(false);
    expect(resolveVisionCapability('future-model-7', undefined, false, 'relay-a')).toBe(false);
  });

  it('does not let one provider rejection disable another provider', () => {
    // Same model id behind two endpoints: one rejects images, the other may well
    // accept them. Keying the memo by id alone silently disabled both.
    markModelVisionUnsupported('glm-5.3-flash', 'zhipu');

    expect(getCachedVisionSupport('glm-5.3-flash', 'zhipu')).toBe(false);
    expect(getCachedVisionSupport('glm-5.3-flash', 'opencode-go')).toBeUndefined();
    expect(resolveVisionCapability('glm-5.3-flash', undefined, false, 'opencode-go')).toBe(true);
  });

  it('stops consulting a learned rejection once it expires', () => {
    // A rejection is a statement about one endpoint at one moment. Changing the
    // API key or the declared modalities must be able to undo it.
    vi.useFakeTimers();
    markModelVisionUnsupported('glm-5.3-flash', 'zhipu');
    expect(getCachedVisionSupport('glm-5.3-flash', 'zhipu')).toBe(false);

    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(getCachedVisionSupport('glm-5.3-flash', 'zhipu')).toBeUndefined();
  });

  it('bounds how many rejections it retains', () => {
    for (let index = 0; index < 260; index += 1) {
      markModelVisionUnsupported(`model-${index}`, 'relay');
    }
    // The oldest entries are evicted; the newest is still remembered.
    expect(getCachedVisionSupport('model-259', 'relay')).toBe(false);
    expect(getCachedVisionSupport('model-0', 'relay')).toBeUndefined();
  });

  it('uses conservative enrichment default for unknown models when enrichment is enabled', () => {
    expect(resolveVisionCapability('future-model-8', undefined, true)).toBe(false);
    expect(resolveVisionCapability('future-model-8', undefined, false)).toBe(true);
  });

  it('prefers explicit input modalities over enrichment default', () => {
    expect(resolveVisionCapability('gpt-4.1', { id: 'gpt-4.1', input_modalities: ['text', 'image'] }, true)).toBe(true);
    expect(resolveVisionCapability('deepseek-v4-flash', { id: 'deepseek-v4-flash', input_modalities: ['text'] }, false)).toBe(false);
  });

  it('strips the Claude Code [1m] suffix when matching metadata and cache keys', () => {
    const metadata = { id: 'glm-5.3-flash', input_modalities: ['text', 'image'] as const };
    expect(resolveVisionCapability('glm-5.3-flash[1m]', metadata, false)).toBe(true);
    expect(findProviderModelMetadata('GLM-5.3-Flash [1m]', [metadata])).toBeDefined();

    markModelVisionUnsupported('glm-5.3-flash [1m]', 'zhipu');
    expect(getCachedVisionSupport('glm-5.3-flash', 'zhipu')).toBe(false);
  });
});

describe('findSessionModelMetadata', () => {
  const zhipu: ModelProvider = {
    id: 'zhipu',
    name: '智谱',
    enabled: true,
    api_key: '',
    endpoints: [],
    default_model: 'glm-4.7-flash',
    models: [
      { id: 'glm-4.7-flash', input_modalities: ['text'] },
      { id: 'glm-5.3-flash', input_modalities: ['text'] },
    ],
  };
  const opencodeGo: ModelProvider = {
    id: 'opencode-go',
    name: 'OpenCode Go',
    enabled: true,
    api_key: '',
    endpoints: [],
    default_model: 'deepseek-flash',
    models: [
      { id: 'deepseek-flash', input_modalities: ['text', 'image'] },
      { id: 'glm-5.3-flash', input_modalities: ['text', 'image'] },
    ],
  };
  const providers = [zhipu, opencodeGo];

  it('prefers the session provider entry over an earlier duplicate id', () => {
    expect(findSessionModelMetadata('glm-5.3-flash', providers, 'opencode-go'))
      .toBe(opencodeGo.models[1]);
  });

  it('uses the session provider entry even when it appears later in the list', () => {
    expect(findSessionModelMetadata('glm-5.3-flash', providers, 'zhipu'))
      .toBe(zhipu.models[1]);
  });

  it('falls back to the first global match when the session provider lacks the model', () => {
    expect(findSessionModelMetadata('glm-4.7-flash', providers, 'opencode-go'))
      .toBe(zhipu.models[0]);
  });

  it('matches with case, whitespace, and [1m] suffix normalized', () => {
    expect(findSessionModelMetadata('GLM-5.3-Flash [1m]', providers, 'opencode-go'))
      .toBe(opencodeGo.models[1]);
  });

  it('returns undefined for unknown models or providers', () => {
    expect(findSessionModelMetadata('gpt-4o', providers, 'opencode-go')).toBeUndefined();
    expect(findSessionModelMetadata('glm-5.3-flash', providers, 'missing-provider'))
      .toBe(zhipu.models[1]);
    expect(findSessionModelMetadata('', providers, 'opencode-go')).toBeUndefined();
  });
});
