import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}));

describe('loadSystemFonts', () => {
  beforeEach(async () => {
    invoke.mockReset();
    const { clearSystemFontsCache } = await import('./systemFonts');
    clearSystemFontsCache();
  });

  it('normalizes and caches fonts from tauri', async () => {
    invoke.mockResolvedValue(['"Segoe UI"', ' Microsoft YaHei UI ']);
    const { loadSystemFonts } = await import('./systemFonts');

    await expect(loadSystemFonts()).resolves.toEqual(['Segoe UI', 'Microsoft YaHei UI']);
    await expect(loadSystemFonts()).resolves.toEqual(['Segoe UI', 'Microsoft YaHei UI']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('get_system_fonts');
  });

  it('returns an empty list when invoke fails', async () => {
    invoke.mockRejectedValue(new Error('unavailable'));
    const { loadSystemFonts } = await import('./systemFonts');

    await expect(loadSystemFonts()).resolves.toEqual([]);
  });
});
