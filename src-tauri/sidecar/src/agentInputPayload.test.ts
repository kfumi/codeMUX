import { describe, expect, it } from 'vitest';

import {
  buildClaudeUserMessageContent,
  buildCodexInputEntries,
  isImageUnsupportedError,
} from './agentInputPayload.js';

const image = {
  name: 'screen.png',
  mediaType: 'image/png',
  dataUrl: 'data:image/png;base64,ZmFrZQ==',
  size: 4,
};

describe('agentInputPayload', () => {
  it('builds Claude content blocks from text and data-url images', () => {
    expect(buildClaudeUserMessageContent({ text: 'describe this', images: [image] })).toEqual([
      { type: 'text', text: 'describe this' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'ZmFrZQ==',
        },
      },
    ]);
  });

  it('builds Codex input entries with local images', () => {
    expect(buildCodexInputEntries({ text: 'describe this', images: [image] }, ['C:/tmp/screen.png'])).toEqual([
      { type: 'text', text: 'describe this' },
      { type: 'local_image', path: 'C:/tmp/screen.png' },
    ]);
  });

  it('recognizes common provider image-unsupported errors', () => {
    expect(isImageUnsupportedError('This model does not support image input')).toBe(true);
    expect(isImageUnsupportedError('Unsupported content type: image_url')).toBe(true);
    expect(isImageUnsupportedError('ordinary rate limit error')).toBe(false);
  });
});
