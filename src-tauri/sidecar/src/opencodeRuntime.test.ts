import { describe, expect, it, vi } from 'vitest';
import type { AgentInputPayload } from './agentInputPayload.js';
import type { OpenCodeSessionConfig, OpenCodeSessionMapping } from './types.js';
import { OpenCodeRuntime } from './opencodeRuntime.js';
import {
  officialOpenCodeSdkPort,
  type OpenCodeSdkPort,
  type OpenCodeSdkStartFailure,
} from './opencodeSdk.js';

const sdkMocks = vi.hoisted(() => {
  const prompt = vi.fn().mockResolvedValue({ data: { info: {}, parts: [] } });
  const session = {
    create: vi.fn().mockResolvedValue({ data: { id: 'mock-session' } }),
    get: vi.fn().mockResolvedValue({ data: { id: 'mock-session' } }),
    prompt,
    abort: vi.fn().mockResolvedValue({ data: true }),
  };
  const client = { session };
  const createClient = vi.fn().mockReturnValue(client);
  const createServer = vi.fn().mockResolvedValue({
    url: 'http://127.0.0.1:4097',
    close: vi.fn().mockResolvedValue(undefined),
  });
  return { prompt, createClient, createServer, client };
});

vi.mock('@opencode-ai/sdk/client', () => ({
  createOpencodeClient: sdkMocks.createClient,
}));
vi.mock('@opencode-ai/sdk/server', () => ({
  createOpencodeServer: sdkMocks.createServer,
}));

function createConfig(agentSessionId?: string): OpenCodeSessionConfig {
  return {
    cwd: 'D:/workspace/demo',
    sessionId: 'codemux-session-1',
    ...(agentSessionId ? { agentSessionId } : {}),
    provider: 'openai',
    model: 'gpt-5',
    credentialSource: 'codemux',
  };
}

function createPort() {
  const server = { close: vi.fn() };
  const client = {
    createSession: vi.fn().mockResolvedValue({ id: 'opencode-new' }),
    restoreSession: vi.fn().mockResolvedValue({ id: 'opencode-existing' }),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
  };
  const port: OpenCodeSdkPort = {
    start: vi.fn().mockResolvedValue({ server, client }),
  };
  return { port, server, client };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('OpenCodeRuntime', () => {
  it('starts an isolated server before creating a new session and returns the mapping', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);

    const mapping = await runtime.start();

    expect(port.start).toHaveBeenCalledWith({ cwd: 'D:/workspace/demo' });
    expect(client.createSession).toHaveBeenCalledWith({ cwd: 'D:/workspace/demo' });
    expect(mapping).toEqual<OpenCodeSessionMapping>({
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-new',
    });
  });

  it('reuses one start promise for concurrent start calls', async () => {
    const { port, server, client } = createPort();
    const startResources = deferred<{ server: typeof server; client: typeof client }>();
    port.start.mockReturnValueOnce(startResources.promise);
    const runtime = new OpenCodeRuntime(createConfig(), port);

    const firstStart = runtime.start();
    const secondStart = runtime.start();
    expect(secondStart).toBe(firstStart);
    expect(port.start).toHaveBeenCalledTimes(0);

    startResources.resolve({ server, client });
    await expect(firstStart).resolves.toEqual({
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-new',
    });
    expect(port.start).toHaveBeenCalledTimes(1);
  });

  it('serializes shutdown after an in-flight start without reviving the runtime', async () => {
    const { port, server, client } = createPort();
    const startResources = deferred<{ server: typeof server; client: typeof client }>();
    port.start.mockReturnValueOnce(startResources.promise);
    const runtime = new OpenCodeRuntime(createConfig(), port);

    const startPromise = runtime.start();
    const shutdownPromise = runtime.shutdown();
    startResources.resolve({ server, client });

    await expect(startPromise).resolves.toBeDefined();
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).rejects.toThrow('OpenCode runtime cannot start in state disposed');
    expect(port.start).toHaveBeenCalledTimes(1);
  });

  it('restores an existing session and never creates a replacement when restoration fails', async () => {
    const { port, client } = createPort();
    client.restoreSession.mockRejectedValue(new Error('session not found'));
    const runtime = new OpenCodeRuntime(createConfig('opencode-missing'), port);

    await expect(runtime.start()).rejects.toThrow(
      'Failed to restore OpenCode session "opencode-missing": session not found',
    );
    expect(client.createSession).not.toHaveBeenCalled();
    await expect(runtime.start()).rejects.toThrow('Failed to restore OpenCode session "opencode-missing": session not found');
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('normalizes conflicting prompt and payload text using payload text as the source of truth', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();
    const inputPayload: AgentInputPayload = { text: 'payload text', images: [] };

    await runtime.sendInput('prompt text', inputPayload);

    expect(client.prompt).toHaveBeenCalledWith({
      sessionId: 'opencode-new',
      prompt: 'payload text',
      inputPayload,
      images: [],
      provider: 'openai',
      model: 'gpt-5',
    });
  });

  it('sends text and image payloads to the adapter without exposing SDK objects', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();
    const inputPayload: AgentInputPayload = {
      text: 'hello',
      images: [{ name: 'diagram.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    };

    await expect(runtime.sendInput('hello', inputPayload)).resolves.toBeUndefined();
    expect(client.prompt).toHaveBeenCalledWith({
      sessionId: 'opencode-new',
      prompt: 'hello',
      inputPayload,
      images: inputPayload.images,
      provider: 'openai',
      model: 'gpt-5',
    });
  });

  it('maps the official adapter prompt body and images to OpenCode SDK parts', async () => {
    sdkMocks.prompt.mockClear();
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo' });

    await resources.client.prompt({
      sessionId: 'opencode-new',
      prompt: 'fallback text',
      inputPayload: { text: 'payload text', images: [] },
      images: [{ name: 'diagram.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
      provider: 'openai',
      model: 'gpt-5',
    });

    expect(sdkMocks.prompt).toHaveBeenCalledWith({
      path: { id: 'opencode-new' },
      query: { directory: 'D:/workspace/demo' },
      body: {
        model: { providerID: 'openai', modelID: 'gpt-5' },
        parts: [
          { type: 'text', text: 'payload text' },
          { type: 'file', mime: 'image/png', filename: 'diagram.png', url: 'data:image/png;base64,abc' },
        ],
      },
    });
  });

  it('formats structured SDK errors without falling back to object stringification', async () => {
    sdkMocks.client.session.create.mockResolvedValueOnce({
      error: { code: 404, message: 'session unavailable' },
    });
    const resources = await officialOpenCodeSdkPort.start({ cwd: 'D:/workspace/demo' });

    await expect(resources.client.createSession({ cwd: 'D:/workspace/demo' })).rejects.toThrow(
      'OpenCode session creation failed: {"code":404,"message":"session unavailable"}',
    );
  });
  it('interrupts an active task and treats abort rejection as an expected interruption', async () => {
    const { port, client } = createPort();
    let rejectPrompt!: (reason: unknown) => void;
    client.prompt.mockReturnValueOnce(new Promise<void>((_, reject) => { rejectPrompt = reject; }));
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    const sendPromise = runtime.sendInput('long task');
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());
    await expect(runtime.interrupt()).resolves.toBeUndefined();
    rejectPrompt(new DOMException('The operation was aborted', 'AbortError'));
    await expect(sendPromise).resolves.toBeUndefined();
    expect(client.abort).toHaveBeenCalledWith('opencode-new');
  });

  it('continues cleanup after interrupt and active task failures, then aggregates errors', async () => {
    const { port, server, client } = createPort();
    let rejectPrompt!: (reason: unknown) => void;
    client.prompt.mockReturnValueOnce(new Promise<void>((_, reject) => { rejectPrompt = reject; }));
    client.abort.mockRejectedValueOnce(new Error('interrupt failed'));
    server.close.mockRejectedValueOnce(new Error('server close failed'));
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    void runtime.sendInput('long task').catch(() => undefined);
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());
    rejectPrompt(new Error('active task failed'));

    const cleanupError = await runtime.shutdown().catch((error: unknown) => error);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect(String(cleanupError)).toContain('OpenCode runtime cleanup failed');
    expect(server.close).toHaveBeenCalledTimes(1);

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(2);
  });

  it('bounds cleanup when the active task never settles and abort fails', async () => {
    const { port, server, client } = createPort();
    client.prompt.mockReturnValueOnce(new Promise<void>(() => undefined));
    client.abort.mockRejectedValueOnce(new Error('abort failed'));
    const runtime = new OpenCodeRuntime(createConfig(), port, {
      activeTaskTimeoutMs: 10,
    });
    await runtime.start();
    void runtime.sendInput('never ending task');
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());

    const startedAt = Date.now();
    const cleanupError = await runtime.shutdown().catch((error: unknown) => error);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    const cleanupMessages = (cleanupError as AggregateError).errors.map((error) => String(error)).join('\n');
    expect(cleanupMessages).toContain('OpenCode active task cleanup timed out after 10ms');
    expect(cleanupMessages).toContain('abort failed');
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging server close, retains it, and retries cleanup', async () => {
    const { port, server } = createPort();
    server.close
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockResolvedValueOnce(undefined);
    const runtime = new OpenCodeRuntime(createConfig(), port, {
      serverCloseTimeoutMs: 10,
    });
    await runtime.start();

    const cleanupError = await runtime.shutdown().catch((error: unknown) => error);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors.map(String).join('\n')).toContain(
      'OpenCode server close timed out after 10ms',
    );
    expect(server.close).toHaveBeenCalledTimes(1);

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(2);
  });

  it('does not start a new server after dispose and remains idempotent', async () => {
    const { port, server, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    await runtime.shutdown();
    await runtime.dispose();
    await runtime.shutdown();

    expect(client.abort).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(port.start).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).rejects.toThrow('OpenCode runtime cannot start in state disposed');
    await expect(runtime.sendInput('after dispose')).rejects.toThrow('OpenCode runtime is not started');
  });

  it('recovers to a retryable state when sdk.start fails after creating partial resources', async () => {
    const { port, server, client } = createPort();
    const startFailure = Object.assign(new Error('client creation failed'), {
      resources: { server, client },
    }) as OpenCodeSdkStartFailure;
    port.start
      .mockRejectedValueOnce(startFailure)
      .mockResolvedValueOnce({ server, client });
    const runtime = new OpenCodeRuntime(createConfig(), port);

    await expect(runtime.start()).rejects.toThrow('client creation failed');
    expect(server.close).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).resolves.toEqual({
      sessionId: 'codemux-session-1',
      agentSessionId: 'opencode-new',
    });
    expect(port.start).toHaveBeenCalledTimes(2);
  });

  it('retains a server when session startup and its close both fail, then shuts it down on retry', async () => {
    const { port, server, client } = createPort();
    client.createSession.mockRejectedValueOnce(new Error('session creation failed'));
    server.close
      .mockRejectedValueOnce(new Error('server close failed'))
      .mockResolvedValue(undefined);
    const runtime = new OpenCodeRuntime(createConfig(), port);

    await expect(runtime.start()).rejects.toThrow('OpenCode start failed and cleanup failed');
    expect(port.start).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).rejects.toThrow('OpenCode runtime cannot start in state cleanup_failed');

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(2);
    expect(port.start).toHaveBeenCalledTimes(1);
  });

  it('resetSession clears the current session and allows a new one on the next start', async () => {
    const { port, client } = createPort();
    const runtime = new OpenCodeRuntime(createConfig(), port);
    await runtime.start();

    await runtime.resetSession();
    await runtime.start();

    expect(client.createSession).toHaveBeenCalledTimes(2);
  });
});
