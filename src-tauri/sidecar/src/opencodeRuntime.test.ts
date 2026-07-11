import { describe, expect, it, vi } from 'vitest';
import type { AgentInputPayload } from './agentInputPayload.js';
import type { OpenCodeSessionConfig, OpenCodeSessionMapping } from './types.js';
import { OpenCodeRuntime } from './opencodeRuntime.js';
import type { OpenCodeSdkPort, OpenCodeSdkStartFailure } from './opencodeSdk.js';

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
