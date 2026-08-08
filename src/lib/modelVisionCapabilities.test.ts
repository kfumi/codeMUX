import { describe, expect, it } from 'vitest';

import {
  getCachedVisionSupport,
  inferModelSupportsVision,
  markModelVisionUnsupported,
  resolveVisionCapability,
} from './modelVisionCapabilities';

describe('modelVisionCapabilities', () => {
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
    markModelVisionUnsupported('Future Model 7');

    expect(getCachedVisionSupport('future-model-7')).toBe(false);
    expect(inferModelSupportsVision('future-model-7')).toBe(false);
  });

  it('uses conservative enrichment default for unknown models when enrichment is enabled', () => {
    expect(resolveVisionCapability('future-model-8', undefined, true)).toBe(false);
    expect(resolveVisionCapability('future-model-8', undefined, false)).toBe(true);
  });

  it('prefers explicit input modalities over enrichment default', () => {
    expect(resolveVisionCapability('gpt-4.1', { id: 'gpt-4.1', input_modalities: ['text', 'image'] }, true)).toBe(true);
    expect(resolveVisionCapability('deepseek-v4-flash', { id: 'deepseek-v4-flash', input_modalities: ['text'] }, false)).toBe(false);
  });
});
