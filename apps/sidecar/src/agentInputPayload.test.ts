import { describe, expect, it } from 'vitest';

import {
  buildClaudeUserMessageContent,
  buildCodexInputEntries,
  isImageUnsupportedError,
  normalizeAgentInputPayload,
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

  it('sends the command prompt even when inputPayload.text is a shorter display follow-up', () => {
    const payload = normalizeAgentInputPayload(
      '[CodeMUX runtime switch]\nUser: 你好\n\n---\nUser follow-up:\n刚才我问了你哪些问题？',
      { text: '刚才我问了你哪些问题？' },
    );

    expect(payload.text).toContain('[CodeMUX runtime switch]');
    expect(payload.text).toContain('刚才我问了你哪些问题？');
  });

  it('recognizes common provider image-unsupported errors', () => {
    expect(isImageUnsupportedError('This model does not support image input')).toBe(true);
    expect(isImageUnsupportedError('Unsupported content type: image_url')).toBe(true);
    expect(isImageUnsupportedError('unknown feature key in config: view_image_tool\nShell snapshot not supported yet for PowerShell')).toBe(false);
    expect(isImageUnsupportedError('ordinary rate limit error')).toBe(false);
  });
});
