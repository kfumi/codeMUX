import { afterEach, describe, expect, it, vi } from 'vitest';

import { enrichAttachments } from './index.js';
import type { AgentInputAttachment } from '../agentInputPayload.js';
import type { EnrichmentRuntimeConfig } from './types.js';

const attachment: AgentInputAttachment = {
  type: 'image',
  name: 'screen.png',
  mediaType: 'image/png',
  dataUrl: 'data:image/png;base64,ZmFrZQ==',
};

const config: EnrichmentRuntimeConfig = {
  protocol: 'openai_compatible',
  apiKey: 'test-key',
  baseUrl: 'https://example.com/v1',
  model: 'vision-model',
};

describe('attachmentEnrichment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns markdown blocks for successful vision calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Terminal shows ECONNREFUSED on port 3000.' } }],
      }),
    }));

    const blocks = await enrichAttachments([attachment], config);

    expect(blocks).toEqual([
      {
        attachment_name: 'screen.png',
        markdown: 'Terminal shows ECONNREFUSED on port 3000.',
        ok: true,
      },
    ]);
  });

  it('returns failed blocks without throwing for partial enrichment failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => 'upstream unavailable',
    }));

    const blocks = await enrichAttachments([attachment], config);

    expect(blocks).toEqual([
      expect.objectContaining({
        attachment_name: 'screen.png',
        ok: false,
        error: expect.stringContaining('503'),
      }),
    ]);
  });
});
