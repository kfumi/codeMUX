import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createCodexCompatProxyServerMock = vi.fn();

vi.mock('./codexCompatProxy.js', () => ({
  createCodexCompatProxyServer: createCodexCompatProxyServerMock,
}));

describe('proxyManager', () => {
  beforeEach(() => {
    vi.resetModules();
    createCodexCompatProxyServerMock.mockReset();
  });

  afterEach(async () => {
    const { proxyManager } = await import('./proxyManager.js');
    await proxyManager.stop();
  });

  it('reuses an existing compat proxy already listening on 15722', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { proxyManager } = await import('./proxyManager.js');
    const result = await proxyManager.start('proxy-key', 'https://openrouter.ai/api/v1');

    expect(result).toEqual({ port: 15722 });
    expect(createCodexCompatProxyServerMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:15722/__codemux_proxy_health', expect.any(Object));
    expect(proxyManager.getBaseUrl()).toBe('http://127.0.0.1:15722');

    vi.unstubAllGlobals();
  });

  it('reuses an existing compat proxy even when upstream model listing is unavailable', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/__codemux_proxy_health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      }

      throw new Error(`unexpected fetch ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { proxyManager } = await import('./proxyManager.js');
    const result = await proxyManager.start('proxy-key', 'https://token-plan-cn.xiaomimimo.com/v1');

    expect(result).toEqual({ port: 15722 });
    expect(createCodexCompatProxyServerMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('falls back to starting a fresh proxy when the existing listener is not reusable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);
    createCodexCompatProxyServerMock.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:15722',
      close: vi.fn(async () => {}),
    });

    const { proxyManager } = await import('./proxyManager.js');
    const result = await proxyManager.start('proxy-key', 'https://openrouter.ai/api/v1');

    expect(result).toEqual({ port: 15722 });
    expect(createCodexCompatProxyServerMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
