import { describe, expect, it } from 'vitest';

import {
  inferDefaultInputModalities,
  modelSupportsVision,
  normalizeInputModalities,
  toggleOptionalInputModality,
} from './inputModalities';

describe('inputModalities', () => {
  it('always keeps text in normalized modalities', () => {
    expect(normalizeInputModalities(['image'])).toEqual(['text', 'image']);
  });

  it('toggles optional modalities', () => {
    expect(toggleOptionalInputModality(['text'], 'image')).toEqual(['text', 'image']);
    expect(toggleOptionalInputModality(['text', 'image'], 'image')).toEqual(['text']);
  });

  it('derives vision support from input modalities', () => {
    expect(modelSupportsVision({ id: 'gpt-4.1', input_modalities: ['text', 'image'] })).toBe(true);
    expect(modelSupportsVision({ id: 'deepseek-v4-flash', input_modalities: ['text'] })).toBe(false);
  });

  it('infers default modalities from what is declared, never from the id', () => {
    // A declared value wins as-is.
    expect(inferDefaultInputModalities(['text'])).toEqual(['text']);
    expect(inferDefaultInputModalities(['text', 'image'])).toEqual(['text', 'image']);
    // No id-based guessing: an unknown model stays at the text-only default.
    expect(inferDefaultInputModalities()).toEqual(['text']);
  });
});
