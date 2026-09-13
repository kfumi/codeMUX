import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  awaitLocalPairingApproval,
  LocalPairingError,
  requestLocalPairing,
} from './local-pairing';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('requestLocalPairing', () => {
  it('posts to the loopback pairing endpoint and returns the confirm code', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      requestId: 'req-1',
      code: '123456',
      name: 'Chrome · Windows',
      desktopId: 'cmx_desktop_abc',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const started = await requestLocalPairing('http://127.0.0.1:9240', 'Chrome · Windows');
    expect(started.code).toBe('123456');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9240/api/pair/local/request',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces daemon error messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'loopback only' })));
    await expect(requestLocalPairing('http://192.168.1.10:9240')).rejects.toThrow('loopback only');
  });
});

describe('awaitLocalPairingApproval', () => {
  it('polls until the desktop confirms and then yields the pairing token', async () => {
    const responses = [
      { status: 'pending', token: null, deviceId: null },
      { status: 'pending', token: null, deviceId: null },
      { status: 'approved', token: 'cmx_new', deviceId: 'device-9' },
    ];
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return jsonResponse(200, {
        requestId: 'req-1',
        desktopId: 'cmx_desktop_abc',
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        ...next,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const approved = await awaitLocalPairingApproval('http://127.0.0.1:9240', 'req-1', {
      pollIntervalMs: 1,
    });
    expect(approved).toEqual({
      token: 'cmx_new',
      deviceId: 'device-9',
      desktopId: 'cmx_desktop_abc',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports a denial to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      requestId: 'req-1',
      status: 'denied',
      desktopId: 'cmx_desktop_abc',
      token: null,
      deviceId: null,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    })));

    await expect(awaitLocalPairingApproval('http://127.0.0.1:9240', 'req-1', {
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ reason: 'denied' });
  });

  it('gives up when the request window has passed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      requestId: 'req-1',
      status: 'expired',
      desktopId: 'cmx_desktop_abc',
      token: null,
      deviceId: null,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })));

    const rejection = await awaitLocalPairingApproval('http://127.0.0.1:9240', 'req-1', {
      pollIntervalMs: 1,
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(LocalPairingError);
    expect((rejection as LocalPairingError).reason).toBe('expired');
  });
});
