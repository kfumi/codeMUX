import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { createDaemonClient, type DaemonConnectionConfig } from './client';

describe('daemon client', () => {
  const config: DaemonConnectionConfig = {
    baseUrl: 'http://127.0.0.1:9240',
    token: 'test-token',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists sessions with bearer token', async () => {
    const sessions = [{ id: 's1', title: 'Test' }];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(sessions), { status: 200 }),
    );

    const client = createDaemonClient(config);
    const result = await client.listSessions();
    expect(result).toEqual(sessions);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9240/api/sessions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  it('sends messages to companion route', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 202 }));

    const client = createDaemonClient(config);
    await client.sendMessage('s1', 'hello');

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9240/api/sessions/s1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
