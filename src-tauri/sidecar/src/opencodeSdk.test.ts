import { describe, expect, it, vi } from 'vitest';
import { buildOpenCodeServerConfig, normalizeOpenCodeModelReference, officialOpenCodeSdkPort } from './opencodeSdk.js';


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
vi.mock('./opencodeExecutable.js', () => ({
  prepareOpenCodeExecutable: vi.fn(),
}));

vi.mock('@opencode-ai/sdk/server', () => ({
  createOpencodeServer: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:4097', close: vi.fn() }),
}));

describe('official OpenCode SDK adapter', () => {
  it('splits the default free model reference into provider and model id', () => {
    expect(normalizeOpenCodeModelReference('opencode/north-mini-code-free')).toEqual({
      provider: 'opencode',
      model: 'north-mini-code-free',
    });
  });

  it('does not shadow the built-in OpenCode provider for free models', () => {
    const config = buildOpenCodeServerConfig({
      provider: 'opencode',
      model: 'north-mini-code-free',
      credentialSource: 'opencode',
    });

    expect(config.model).toBe('opencode/north-mini-code-free');
    expect(config.provider?.opencode).toBeUndefined();
  });

  it('builds provider config with credentials using the official server config', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'provider-1',
      model: 'model-1',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-key',
      credentialSource: 'codemux',
    })).toEqual({
      provider: {
        'provider-1': {
          options: {
            apiKey: 'secret-key',
            baseURL: 'https://provider.example/v1',
          },
          models: {
            'model-1': { id: 'model-1', name: 'model-1' },
          },
        },
      },
    });
  });

  it('uses the OpenAI-compatible AI SDK adapter for a custom OpenAI endpoint', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'glm-4.7-flash',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-key',
      credentialSource: 'codemux',
    })).toMatchObject({
      provider: {
        'codemux-openai': {
          npm: '@ai-sdk/openai-compatible',
          name: 'CodeMUX OpenAI-compatible',
          options: { baseURL: 'https://provider.example/v1', apiKey: 'secret-key' },
        },
      },
    });
  });

  it('strips a full chat completions endpoint before passing baseURL to OpenCode', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'glm-4.7-flash',
      baseUrl: 'https://provider.example/v1/chat/completions',
      credentialSource: 'none',
    })).toMatchObject({
      provider: {
        'codemux-openai': {
          options: { baseURL: 'https://provider.example/v1' },
        },
      },
    });
  });

  it('does not inject an API key when credentials come from the environment', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'provider-1',
      model: 'model-1',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-key',
      credentialSource: 'environment',
    })).toEqual({
      provider: {
        'provider-1': {
          options: { baseURL: 'https://provider.example/v1' },
          models: {
            'model-1': { id: 'model-1', name: 'model-1' },
          },
        },
      },
    });
  });
  it('registers the selected CodeMUX model in the OpenCode provider config', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'glm-4.7-flash',
      credentialSource: 'codemux',
      apiKey: 'secret-key',
      baseUrl: 'https://provider.example/v1',
    })).toMatchObject({
      provider: {
        'codemux-openai': {
          models: {
            'glm-4.7-flash': { id: 'glm-4.7-flash' },
          },
        },
      },
    });
  });

  it('preserves the native OpenCode config while selecting the built-in free model', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'opencode',
      model: 'north-mini-code-free',
      credentialSource: 'opencode',
      existingConfig: {
        provider: {
          opencode: {
            npm: '@opencode-ai/provider',
            options: { apiKey: 'native-secret' },
            models: { 'north-mini-code-free': { name: 'North Mini Code Free' } },
          },
        },
      },
    })).toMatchObject({
      model: 'opencode/north-mini-code-free',
      provider: {
        opencode: {
          npm: '@opencode-ai/provider',
          options: { apiKey: 'native-secret' },
        },
      },
    });
  });

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
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo', provider: 'codemux-openai', model: 'model-1', credentialSource: 'none' });
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
