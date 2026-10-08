// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { base64PngToFile, screenshotFileName } from './desktopScreenshot';

describe('base64PngToFile', () => {
  it('decodes base64 into a png File', async () => {
    // "PNG" 三个字节的 base64。
    const file = base64PngToFile('UE5H', 'screen.png');
    expect(file.name).toBe('screen.png');
    expect(file.type).toBe('image/png');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0x50, 0x4e, 0x47]);
  });

  it('tolerates a data-url prefix from other capture paths', async () => {
    const file = base64PngToFile('data:image/png;base64,UE5H', 'screen.png');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0x50, 0x4e, 0x47]);
  });
});

describe('screenshotFileName', () => {
  it('stamps the capture time and keeps the png extension', () => {
    const name = screenshotFileName(new Date(2026, 9, 7, 21, 5, 9));
    expect(name).toBe('桌面截图-20261007-210509.png');
  });
});
