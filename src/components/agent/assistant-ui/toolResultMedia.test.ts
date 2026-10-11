import { describe, expect, it } from 'vitest';

import { extractToolResultMedia } from './toolResultMedia';

describe('extractToolResultMedia', () => {
  it('reads MCP image data and adjacent result text from serialized tool output', () => {
    const media = extractToolResultMedia(JSON.stringify({
      content: [
        { type: 'image', data: 'UE5H', mimeType: 'image/png' },
        { type: 'text', text: '截图已保存' },
      ],
    }));

    expect(media.images).toEqual([{ src: 'data:image/png;base64,UE5H' }]);
    expect(media.text).toBe('截图已保存');
  });

  it('reads Anthropic image source blocks and deduplicates repeated images', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/2Q==' } };
    const media = extractToolResultMedia([image, image, { type: 'text', text: 'Image read successfully' }]);

    expect(media.images).toEqual([{ src: 'data:image/jpeg;base64,/9j/2Q==' }]);
    expect(media.text).toBe('Image read successfully');
  });

  it('supports data URLs, OpenAI image URLs, and OpenCode file blocks', () => {
    expect(extractToolResultMedia('data:image/webp;base64,UklGRg==').images).toEqual([
      { src: 'data:image/webp;base64,UklGRg==' },
    ]);
    expect(extractToolResultMedia({ type: 'input_image', image_url: { url: 'data:image/png;base64,UE5H' } }).images).toEqual([
      { src: 'data:image/png;base64,UE5H' },
    ]);
    expect(extractToolResultMedia({ type: 'file', mime: 'image/png', url: 'data:image/png;base64,UE5H' }).images).toEqual([
      { src: 'data:image/png;base64,UE5H' },
    ]);
  });

  it('ignores non-image data and caps pathological image result lists', () => {
    expect(extractToolResultMedia({ type: 'image', data: 'hello', mimeType: 'text/plain' }).images).toEqual([]);
    const media = extractToolResultMedia(Array.from({ length: 12 }, (_, index) => ({
      type: 'image', data: `IMG${index}`, mimeType: 'image/png',
    })));
    expect(media.images).toHaveLength(8);
  });
});
