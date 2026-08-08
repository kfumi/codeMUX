import { describe, expect, it } from 'vitest';

import { resolveChatCompletionsUrls } from './imageProcessor.js';

describe('resolveChatCompletionsUrls', () => {
  it('uses /chat/completions for Zhipu /v4 base without /v1 fallback', () => {
    expect(resolveChatCompletionsUrls('https://open.bigmodel.cn/api/paas/v4')).toEqual([
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    ]);
  });

  it('appends /chat/completions to /v1 base', () => {
    expect(resolveChatCompletionsUrls('https://example.com/v1')).toEqual([
      'https://example.com/v1/chat/completions',
    ]);
  });

  it('tries /v1 first for generic OpenAI-compatible bases', () => {
    expect(resolveChatCompletionsUrls('https://api.example.com')).toEqual([
      'https://api.example.com/v1/chat/completions',
      'https://api.example.com/chat/completions',
    ]);
  });
});
