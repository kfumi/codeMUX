import { describe, expect, it } from 'vitest';

import { mergeSessionMessageAttachments } from './sessionMessageAttachments';

describe('sessionMessageAttachments', () => {
  it('merges saved attachments into user events without existing previews', () => {
    const merged = mergeSessionMessageAttachments([
      { kind: 'user', data: { content: '这是谁' } },
    ], {
      0: [{ type: 'image', name: 'ggbond.jpg', mediaType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,abc' }],
    });

    expect(merged[0].data.attachments).toEqual([
      { type: 'image', name: 'ggbond.jpg', mediaType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,abc' },
    ]);
  });

  it('does not overwrite attachments already restored from provider history', () => {
    const merged = mergeSessionMessageAttachments([
      {
        kind: 'user',
        data: {
          content: 'hello',
          attachments: [{ type: 'image', name: 'live.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,live' }],
        },
      },
    ], {
      0: [{ type: 'image', name: 'saved.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,saved' }],
    });

    expect(merged[0].data.attachments?.[0]?.name).toBe('live.png');
  });
});
