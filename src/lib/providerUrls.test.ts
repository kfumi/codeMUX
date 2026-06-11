import { describe, expect, it } from 'vitest';

import {
  getOpenAIBaseUrlHint,
  humanizeCodexError,
  normalizeOpenAIBaseUrl,
} from './providerUrls';

describe('normalizeOpenAIBaseUrl', () => {
  it('strips chat completions endpoints down to the API root', () => {
    expect(normalizeOpenAIBaseUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(
      'https://openrouter.ai/api',
    );
    expect(normalizeOpenAIBaseUrl('https://example.com/v1/chat/completions/')).toBe(
      'https://example.com',
    );
  });

  it('strips responses endpoints used by Codex-compatible providers', () => {
    expect(normalizeOpenAIBaseUrl('https://gateway.example.com/codex/responses')).toBe(
      'https://gateway.example.com',
    );
    expect(normalizeOpenAIBaseUrl('https://gateway.example.com/v1/responses')).toBe(
      'https://gateway.example.com',
    );
  });
});

describe('getOpenAIBaseUrlHint', () => {
  it('warns when a full endpoint URL is provided instead of a base URL', () => {
    expect(getOpenAIBaseUrlHint('https://openrouter.ai/api/v1/chat/completions')).toContain(
      'base URL',
    );
  });

  it('does not warn for a normalized API root', () => {
    expect(getOpenAIBaseUrlHint('https://openrouter.ai/api')).toBeNull();
  });
});

describe('humanizeCodexError', () => {
  it('explains Codex subscription errors in plainer language', () => {
    expect(
      humanizeCodexError(
        'unexpected status 403 Forbidden: you do not have an available Codex subscription',
      ),
    ).toContain('does not grant Codex access');
  });
});
