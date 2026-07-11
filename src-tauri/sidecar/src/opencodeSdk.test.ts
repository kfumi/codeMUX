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
  it('bridges the official onSseError callback into the adapter disconnect signal', async () => {
    let resolveStream!: () => void;
    const stream = (async function* () {
      await new Promise<void>((resolve) => { resolveStream = resolve; });
    })();
    sdkMocks.eventSubscribe.mockResolvedValueOnce({ stream });
    const disconnects: unknown[] = [];
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo' });
    const subscription = await resources.client.subscribe!({ cwd: 'D:/workspace/demo', onEvent: vi.fn(), onError: vi.fn(), onDisconnect: (error) => disconnects.push(error) });

    expect(sdkMocks.eventSubscribe).toHaveBeenCalledTimes(1);
    const options = sdkMocks.eventSubscribe.mock.calls[0][0] as { onSseError?: (error: unknown) => void };
    expect(typeof options.onSseError).toBe('function');
    options.onSseError!(new Error('socket lost'));
    expect(disconnects).toHaveLength(1);
    await vi.waitFor(() => expect(disconnects).toHaveLength(1));
    expect(disconnects[0]).toMatchObject({ message: 'socket lost' });
    resolveStream();
    await subscription.close();
  });
});
