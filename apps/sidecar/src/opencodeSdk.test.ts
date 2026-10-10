import { describe, expect, it, vi } from 'vitest';
import { buildOpenCodeServerConfig, DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS, normalizeOpenCodeModelReference, officialOpenCodeSdkPort } from './opencodeSdk.js';


const sdkMocks = vi.hoisted(() => {
  const eventSubscribe = vi.fn();
  const client = {
    event: { subscribe: eventSubscribe },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'opencode-session' } }),
      get: vi.fn().mockResolvedValue({ data: { id: 'opencode-session' } }),
      messages: vi.fn().mockResolvedValue({
        data: [
          { info: { id: 'user-message-1' }, parts: [] },
          { info: { id: 'assistant-message-1' }, parts: [] },
          { info: { id: 'user-message-2' }, parts: [] },
        ],
      }),
      fork: vi.fn().mockResolvedValue({ data: { id: 'opencode-forked-session' } }),
      delete: vi.fn().mockResolvedValue({ data: true }),
      summarize: vi.fn().mockResolvedValue({ data: true }),
      prompt: vi.fn().mockResolvedValue({ data: { info: {}, parts: [] } }),
      abort: vi.fn().mockResolvedValue({ data: true }),
    },
  };
  const createOpencodeClient = vi.fn().mockReturnValue(client);
  const createOpencodeServer = vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:4097', close: vi.fn() });
  const runtimeRef = {
    provider: 'opencode',
    runtimeRoot: 'D:/runtimes',
    runtimePath: 'D:/runtimes/opencode/1.18.3',
    runtimeVersion: '1.18.3',
  };
  const runtimeLoaded = {
    ref: runtimeRef,
    nodeModulesPath: 'D:/runtimes/opencode/1.18.3/node_modules',
    runtimeRequire: vi.fn((packageName: string) => {
      if (packageName === '@opencode-ai/sdk/client') return { createOpencodeClient };
      if (packageName === '@opencode-ai/sdk/server') return { createOpencodeServer };
      throw new Error(`unexpected runtime package: ${packageName}`);
    }),
  };
  return { client, eventSubscribe, createOpencodeClient, createOpencodeServer, runtimeRef, runtimeLoaded };
});

vi.mock('@opencode-ai/sdk/client', () => ({
  createOpencodeClient: vi.fn().mockReturnValue(sdkMocks.client),
}));
vi.mock('./opencodeExecutable.js', () => ({
  prepareOpenCodeExecutable: vi.fn(),
}));

vi.mock('./runtimeLoader.js', () => ({
  loadProviderRuntime: vi.fn().mockReturnValue(sdkMocks.runtimeLoaded),
  isRuntimeError: vi.fn().mockReturnValue(false),
}));

vi.mock('@opencode-ai/sdk/server', () => ({
  createOpencodeServer: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:4097', close: vi.fn() }),
}));

describe('official OpenCode SDK adapter', () => {
  it('starts the server with the relaxed startup timeout instead of the 5s SDK default', async () => {
    sdkMocks.createOpencodeServer.mockClear();

    await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo', provider: 'opencode', model: 'default', credentialSource: 'opencode', runtimeRef: sdkMocks.runtimeRef });

    expect(sdkMocks.createOpencodeServer).toHaveBeenCalledWith(expect.objectContaining({
      timeout: DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS,
    }));
    expect(DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS).toBeGreaterThan(5000);
  });

  it('forks a session at the requested provider message', async () => {
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo', provider: 'opencode', model: 'default', credentialSource: 'opencode', runtimeRef: sdkMocks.runtimeRef });

    await expect(resources.client.forkSession({
      cwd: 'D:/workspace/demo',
      sessionId: 'opencode-session',
      messageId: 'assistant-message-1',
    })).resolves.toEqual({ id: 'opencode-forked-session' });

    expect(sdkMocks.client.session.fork).toHaveBeenCalledWith({
      path: { id: 'opencode-session' },
      query: { directory: 'D:/workspace/demo' },
      body: { messageID: 'user-message-2' },
    });
    expect(sdkMocks.client.session.messages).toHaveBeenCalledWith({
      path: { id: 'opencode-session' },
      query: { directory: 'D:/workspace/demo' },
    });
  });

  it('deletes a session through the official session.delete endpoint', async () => {
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo', provider: 'opencode', model: 'default', credentialSource: 'opencode', runtimeRef: sdkMocks.runtimeRef });

    await resources.client.deleteSession({ cwd: 'D:/workspace/demo', sessionId: 'opencode-session' });

    expect(sdkMocks.client.session.delete).toHaveBeenCalledWith({
      path: { id: 'opencode-session' },
      query: { directory: 'D:/workspace/demo' },
    });
  });

  it('triggers native session compaction through the official summarize endpoint', async () => {
    const resources = await officialOpenCodeSdkPort.start({
      cwd: 'D:/workspace/demo',
      provider: 'codemux-openai',
      model: 'gpt-5',
      credentialSource: 'none',
      runtimeRef: sdkMocks.runtimeRef,
    });

    await expect(resources.client.compactSession?.({
      cwd: 'D:/workspace/demo',
      sessionId: 'opencode-session',
      provider: 'codemux-openai',
      model: 'gpt-5',
    })).resolves.toBeUndefined();

    expect(sdkMocks.client.session.summarize).toHaveBeenCalledWith({
      path: { id: 'opencode-session' },
      query: { directory: 'D:/workspace/demo' },
      body: { providerID: 'codemux-openai', modelID: 'gpt-5', auto: false },
    });
  });

  it('prefers the V2 native session.compact endpoint when the SDK exposes it', async () => {
    const compact = vi.fn().mockResolvedValue({
      data: { id: 'pending-compaction', sessionID: 'opencode-session', type: 'compaction' },
    });
    sdkMocks.client.session.summarize.mockClear();
    Object.assign(sdkMocks.client.session, { compact });
    try {
      const resources = await officialOpenCodeSdkPort.start({
        cwd: 'D:/workspace/demo',
        provider: 'codemux-openai',
        model: 'gpt-5',
        credentialSource: 'none',
        runtimeRef: sdkMocks.runtimeRef,
      });

      await expect(resources.client.compactSession?.({
        cwd: 'D:/workspace/demo',
        sessionId: 'opencode-session',
        provider: 'codemux-openai',
        model: 'gpt-5',
      })).resolves.toBeUndefined();

      expect(compact).toHaveBeenCalledWith({
        path: { id: 'opencode-session' },
        query: { directory: 'D:/workspace/demo' },
        body: {},
      });
      expect(sdkMocks.client.session.summarize).not.toHaveBeenCalled();
    } finally {
      delete (sdkMocks.client.session as { compact?: unknown }).compact;
    }
  });

  it('treats a native 404 as an idempotent delete', async () => {
    sdkMocks.client.session.delete.mockResolvedValueOnce({ data: undefined, error: { status: 404 }, response: { status: 404 } });
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo', provider: 'opencode', model: 'default', credentialSource: 'opencode', runtimeRef: sdkMocks.runtimeRef });

    await expect(resources.client.deleteSession({ sessionId: 'already-deleted' })).resolves.toBeUndefined();
  });

  it('propagates non-404 deletion failures', async () => {
    sdkMocks.client.session.delete.mockResolvedValueOnce({ data: undefined, error: { status: 500, message: 'database unavailable' }, response: { status: 500 } });
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo', provider: 'opencode', model: 'default', credentialSource: 'opencode', runtimeRef: sdkMocks.runtimeRef });

    await expect(resources.client.deleteSession({ sessionId: 'session-with-error' })).rejects.toThrow('database unavailable');
  });

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

  it('writes OpenCode model limit metadata when provided', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'provider-1',
      model: 'model-1',
      credentialSource: 'codemux',
      modelLimits: {
        contextWindow: 200000,
        maxInputTokens: 180000,
        maxOutputTokens: 65536,
      },
    })).toMatchObject({
      provider: {
        'provider-1': {
          models: {
            'model-1': {
              id: 'model-1',
              name: 'model-1',
              limit: {
                context: 200000,
                input: 180000,
                output: 65536,
              },
            },
          },
        },
      },
    });
  });

  it('maps session mcpServers into the mcp config section (local stdio)', () => {
    const config = buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'model-1',
      credentialSource: 'codemux',
      mcpServers: {
        'codemux-control': {
          command: 'D:/bin/codemux-daemon.exe',
          args: ['mcp-control', '--app-data-dir', 'D:/data'],
          env: { A: '1' },
        },
        bad: { url: 'https://x' },
      },
    });
    expect(config.mcp).toEqual({
      'codemux-control': {
        type: 'local',
        command: ['D:/bin/codemux-daemon.exe', 'mcp-control', '--app-data-dir', 'D:/data'],
        environment: { A: '1' },
        enabled: true,
      },
    });
    // 用户既有 mcp 配置保留,会话条目覆盖同名键。
    const merged = buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'model-1',
      credentialSource: 'codemux',
      existingConfig: { mcp: { mine: { type: 'local', command: ['x'], enabled: true } } },
      mcpServers: { 'codemux-control': { command: 'daemon' } },
    });
    expect(Object.keys(merged.mcp)).toEqual(['mine', 'codemux-control']);
  });

  it('includes a default output limit when only the context window is configured', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'deepseek-v4-flash-free',
      credentialSource: 'codemux',
      modelLimits: {
        contextWindow: 1_000_000,
      },
    })).toMatchObject({
      provider: {
        'codemux-openai': {
          models: {
            'deepseek-v4-flash-free': {
              limit: {
                context: 1_000_000,
                output: 65_536,
              },
            },
          },
        },
      },
    });
  });

  it('declares input modalities on the model entry for vision-capable models', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'glm-4.7-flash',
      credentialSource: 'codemux',
      modelLimits: {
        inputModalities: ['text', 'image'],
      },
    })).toMatchObject({
      provider: {
        'codemux-openai': {
          models: {
            'glm-4.7-flash': {
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        },
      },
    });
  });

  it('normalizes input modalities and always keeps text first', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'glm-4.7-flash',
      credentialSource: 'codemux',
      modelLimits: {
        inputModalities: ['IMAGE', 'weird', '  ', 'image'],
      },
    })).toMatchObject({
      provider: {
        'codemux-openai': {
          models: {
            'glm-4.7-flash': {
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        },
      },
    });
  });

  it('omits modalities when the model declares none', () => {
    const config = buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'glm-4.7-flash',
      credentialSource: 'codemux',
    });
    expect(config.provider?.['codemux-openai']?.models?.['glm-4.7-flash']).toEqual({
      id: 'glm-4.7-flash',
      name: 'glm-4.7-flash',
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

  it('adds the OpenAI-compatible v1 path when a provider gives only its API root', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'deepseek-v4-flash-free',
      baseUrl: 'https://opencode.ai/zen',
      credentialSource: 'codemux',
    })).toMatchObject({
      provider: {
        'codemux-openai': {
          options: { baseURL: 'https://opencode.ai/zen/v1' },
        },
      },
    });
  });

  it('preserves an existing versioned OpenAI-compatible path', () => {
    expect(buildOpenCodeServerConfig({
      provider: 'codemux-openai',
      model: 'glm-4.7-flash',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      credentialSource: 'none',
    })).toMatchObject({
      provider: {
        'codemux-openai': {
          options: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
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

  it('excludes non-opencode custom providers when selecting the built-in free model', () => {
    const config = buildOpenCodeServerConfig({
      provider: 'opencode',
      model: 'deepseek-v4-flash-free',
      credentialSource: 'opencode',
      existingConfig: {
        provider: {
          glm: {
            npm: '@ai-sdk/openai-compatible',
            options: { apiKey: 'custom-key', baseURL: 'http://localhost:3002/v1' },
            models: { 'glm-5.1': { name: 'GLM 5.1' } },
          },
        },
      },
    });

    expect(config.model).toBe('opencode/deepseek-v4-flash-free');
    expect(config.provider?.glm).toBeUndefined();
    expect(config.provider?.opencode).toBeUndefined();
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
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo', provider: 'codemux-openai', model: 'model-1', credentialSource: 'none', runtimeRef: sdkMocks.runtimeRef });
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
