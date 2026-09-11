import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSystemFonts = vi.fn();

vi.mock('./desktop-bridge', () => ({
  desktopBridge: {
    listSystemFonts,
  },
}));

describe('loadSystemFonts', () => {
  beforeEach(async () => {
    listSystemFonts.mockReset();
    const { clearSystemFontsCache } = await import('./systemFonts');
    clearSystemFontsCache();
  });

  it('normalizes and caches fonts from the desktop bridge', async () => {
    listSystemFonts.mockResolvedValue(['"Segoe UI"', ' Microsoft YaHei UI ']);
    const { loadSystemFonts } = await import('./systemFonts');

    await expect(loadSystemFonts()).resolves.toEqual(['Segoe UI', 'Microsoft YaHei UI']);
    await expect(loadSystemFonts()).resolves.toEqual(['Segoe UI', 'Microsoft YaHei UI']);
    expect(listSystemFonts).toHaveBeenCalledTimes(1);
    expect(listSystemFonts).toHaveBeenCalledWith();
  });

  it('returns an empty list when the bridge call fails', async () => {
    listSystemFonts.mockRejectedValue(new Error('unavailable'));
    const { loadSystemFonts } = await import('./systemFonts');

    await expect(loadSystemFonts()).resolves.toEqual([]);
  });

  it('returns an empty list when the desktop bridge is unavailable', async () => {
    vi.resetModules();
    vi.doMock('./desktop-bridge', () => ({
      desktopBridge: undefined,
    }));
    const { clearSystemFontsCache, loadSystemFonts } = await import('./systemFonts');
    clearSystemFontsCache();

    await expect(loadSystemFonts()).resolves.toEqual([]);
    vi.doUnmock('./desktop-bridge');
  });
});
