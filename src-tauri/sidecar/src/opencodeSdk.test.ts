import { describe, expect, it, vi } from 'vitest';
import { officialOpenCodeSdkPort } from './opencodeSdk.js';

const sdkMocks = vi.hoisted(() => {
  const eventSubscribe = vi.fn();
  const client = {
    event: { subscribe: eventSubscribe },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'opencode-session' } }),
      get: vi.fn().mockResolvedValue({ data: { id: 'opencode-session' } }),
      prompt: vi.fn().mockResolvedValue({ data: { info: {}, parts: [] } }),
      abort: vi.fn().mockResolvedValue({ data: true }),
    },
  };
  return { client, eventSubscribe };
});

vi.mock('@opencode-ai/sdk/client', () => ({
  createOpencodeClient: vi.fn().mockReturnValue(sdkMocks.client),
}));
vi.mock('@opencode-ai/sdk/server', () => ({
  createOpencodeServer: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:4097', close: vi.fn() }),
}));

describe('official OpenCode SDK adapter', () => {
  it('reports official onSseError as retry and only reports disconnect after stream end', async () => {
    let resolveStream!: () => void;
    const stream = (async function* () {
      await new Promise<void>((resolve) => { resolveStream = resolve; });
      yield { type: 'server.connected', properties: {} };
    })();
    sdkMocks.eventSubscribe.mockResolvedValueOnce({ stream });
    const disconnects: unknown[] = [];
    const retries: unknown[] = [];
    const received: unknown[] = [];
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo' });
    expect(resources.client.respondToTool).toBeUndefined();
    const subscription = await resources.client.subscribe!({ cwd: 'D:/workspace/demo', onEvent: (event) => received.push(event), onError: vi.fn(), onRetry: (error) => retries.push(error), onDisconnect: (error) => disconnects.push(error) });

    expect(sdkMocks.eventSubscribe).toHaveBeenCalledTimes(1);
    const options = sdkMocks.eventSubscribe.mock.calls[0][0] as { onSseError?: (error: unknown) => void; onSseEvent?: (event: { id?: string }) => void };
    expect(typeof options.onSseError).toBe('function');
    options.onSseError!(new Error('socket lost'));
    expect(retries).toHaveLength(1);
    expect(disconnects).toHaveLength(0);
    options.onSseEvent?.({ id: 'sse-event-1' });
    resolveStream();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ type: 'server.connected', eventId: 'sse-event-1' });
    await vi.waitFor(() => expect(disconnects).toHaveLength(1));
    expect(disconnects[0]).toMatchObject({ message: 'OpenCode SSE stream ended' });
    await subscription.close();
    options.onSseError!(new Error('late retry'));
    expect(retries).toHaveLength(1);
  });
});
