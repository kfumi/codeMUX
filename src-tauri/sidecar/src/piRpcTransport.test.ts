import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PiRpcConnection,
  PiRpcProcess,
  PiRpcRequestError,
  type PiRpcConnectionOptions,
} from './piRpcTransport.js';

type WireMessage = Record<string, unknown>;

const FAKE_PI_PATH = fileURLToPath(new URL('./__fixtures__/fake-pi.mjs', import.meta.url));

const pendingCleanups: Array<() => void> = [];

afterEach(() => {
  while (pendingCleanups.length > 0) {
    pendingCleanups.pop()?.();
  }
});

function createConnectionPair(options: PiRpcConnectionOptions = {}): {
  connection: PiRpcConnection;
  piToClient: PassThrough;
  clientToPi: PassThrough;
} {
  const piToClient = new PassThrough();
  const clientToPi = new PassThrough();
  const connection = new PiRpcConnection(piToClient, clientToPi, options);
  return { connection, piToClient, clientToPi };
}

function readClientLines(stream: PassThrough, count: number, timeoutMs = 2_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = '';
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        lines.push(line);
        if (lines.length >= count) {
          clearTimeout(timer);
          stream.off('data', onData);
          resolve(lines);
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      stream.off('data', onData);
      reject(new Error(`Timed out waiting for ${count} line(s); received ${lines.length}`));
    }, timeoutMs);
    stream.on('data', onData);
  });
}

function writeLine(stream: PassThrough, message: WireMessage): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

describe('PiRpcConnection', () => {
  it('resolves a request when pi answers with a success response', async () => {
    const { connection, piToClient, clientToPi } = createConnectionPair();
    const promise = connection.request({ type: 'get_state' });
    const [line] = await readClientLines(clientToPi, 1);
    const sent = JSON.parse(line) as WireMessage;
    expect(sent.type).toBe('get_state');
    expect(typeof sent.id).toBe('string');

    writeLine(piToClient, {
      type: 'response',
      command: 'get_state',
      id: sent.id,
      success: true,
      data: { sessionId: 's1' },
    });
    await expect(promise).resolves.toEqual({ sessionId: 's1' });
  });

  it('maps concurrent requests to their own responses by id', async () => {
    const { connection, piToClient, clientToPi } = createConnectionPair();
    const first = connection.request({ type: 'get_state' });
    const second = connection.request({ type: 'get_available_models' });
    const lines = await readClientLines(clientToPi, 2);
    const ids = lines.map((line) => (JSON.parse(line) as WireMessage).id);

    // Respond out of order to verify the pending request map.
    writeLine(piToClient, {
      type: 'response',
      command: 'get_available_models',
      id: ids[1],
      success: true,
      data: { models: [] },
    });
    writeLine(piToClient, {
      type: 'response',
      command: 'get_state',
      id: ids[0],
      success: true,
      data: { sessionId: 's1' },
    });
    await expect(first).resolves.toEqual({ sessionId: 's1' });
    await expect(second).resolves.toEqual({ models: [] });
  });

  it('rejects with PiRpcRequestError when pi answers success:false', async () => {
    const { connection, piToClient, clientToPi } = createConnectionPair();
    const promise = connection.request({ type: 'set_model', provider: 'x', modelId: 'bad' });
    const [line] = await readClientLines(clientToPi, 1);
    const sent = JSON.parse(line) as WireMessage;

    writeLine(piToClient, {
      type: 'response',
      command: 'set_model',
      id: sent.id,
      success: false,
      error: 'Model not found: x/bad',
    });

    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PiRpcRequestError);
    const rpcError = error as PiRpcRequestError;
    expect(rpcError.command).toBe('set_model');
    expect(rpcError.error).toBe('Model not found: x/bad');
    expect(rpcError.message).toContain('set_model');
    expect(rpcError.message).toContain('Model not found');
  });

  it('rejects a request after the control-plane timeout', async () => {
    const { connection } = createConnectionPair();
    const promise = connection.request({ type: 'get_state' }, { timeoutMs: 20 });
    await expect(promise).rejects.toThrow(/timed out after 20ms/);
  });

  it('waits indefinitely when timeoutMs is null (long-running compact)', async () => {
    const { connection, piToClient, clientToPi } = createConnectionPair();
    const promise = connection.request({ type: 'compact' }, { timeoutMs: null });
    const [line] = await readClientLines(clientToPi, 1);
    const sent = JSON.parse(line) as WireMessage;
    setTimeout(() => {
      writeLine(piToClient, {
        type: 'response',
        command: 'compact',
        id: sent.id,
        success: true,
        data: {},
      });
    }, 30);
    await expect(promise).resolves.toEqual({});
  });

  it('rejects pending requests and stops when the pi stream ends', async () => {
    const { connection, piToClient } = createConnectionPair();
    const promise = connection.request({ type: 'get_state' });
    piToClient.end();
    await expect(promise).rejects.toThrow(/connection closed/);
    expect(connection.isDisposed).toBe(true);
  });

  it('routes non-response lines to the message handler', async () => {
    const events: WireMessage[] = [];
    const { connection, piToClient } = createConnectionPair({
      onMessage: (message) => events.push(message),
    });
    writeLine(piToClient, { type: 'agent_start' });
    writeLine(piToClient, { type: 'response', command: 'prompt', success: true, data: {} });
    await vi_waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.type).toBe('agent_start');
  });

  it('does not split a line on U+2028 inside a JSON string', async () => {
    const events: WireMessage[] = [];
    const { connection, piToClient } = createConnectionPair({
      onMessage: (message) => events.push(message),
    });
    const text = `before\u2028after`;
    piToClient.write(`${JSON.stringify({ type: 'message_update', text })}\n`);
    await vi_waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ type: 'message_update', text });
    expect(connection.isDisposed).toBe(false);
  });

  it('strips a trailing carriage return from CRLF frames', async () => {
    const events: WireMessage[] = [];
    const { connection, piToClient } = createConnectionPair({
      onMessage: (message) => events.push(message),
    });
    piToClient.write(`${JSON.stringify({ type: 'agent_start' })}\r\n`);
    await vi_waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ type: 'agent_start' });
  });

  it('buffers partial frames until the newline arrives', async () => {
    const events: WireMessage[] = [];
    const { connection, piToClient } = createConnectionPair({
      onMessage: (message) => events.push(message),
    });
    const full = JSON.stringify({ type: 'turn_start', turnId: 't1' });
    piToClient.write(full.slice(0, 5));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toHaveLength(0);
    piToClient.write(`${full.slice(5)}\n`);
    await vi_waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ type: 'turn_start', turnId: 't1' });
  });

  it('rejects in-flight requests when disposed', async () => {
    const { connection } = createConnectionPair();
    const promise = connection.request({ type: 'get_state' });
    connection.dispose(new Error('disposed by test'));
    await expect(promise).rejects.toThrow(/disposed by test/);
  });

  it('rejects new requests after disposal', async () => {
    const { connection, piToClient } = createConnectionPair();
    piToClient.end();
    await vi_waitFor(() => expect(connection.isDisposed).toBe(true));
    await expect(connection.request({ type: 'get_state' })).rejects.toThrow(/connection is closed/);
  });
});

describe('PiRpcProcess', () => {
  function writeScenario(scenario: WireMessage): { envValue: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fake-scenario-'));
    const file = path.join(dir, 'scenario.json');
    fs.writeFileSync(file, JSON.stringify(scenario), 'utf8');
    return {
      envValue: file,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  function startFakePi(scenario: WireMessage): PiRpcProcess {
    const { envValue, cleanup } = writeScenario(scenario);
    pendingCleanups.push(cleanup);
    return PiRpcProcess.start({
      command: process.execPath,
      args: [FAKE_PI_PATH],
      env: { PI_FAKE_SCENARIO: envValue },
      requestTimeoutMs: 2_000,
    });
  }

  it('completes a request against the fake pi process', async () => {
    const pi = startFakePi({
      responses: { get_state: { data: { sessionId: 'fake-1', sessionFile: 'fake.jsonl' } } },
    });
    try {
      await expect(pi.request({ type: 'get_state' })).resolves.toEqual({
        sessionId: 'fake-1',
        sessionFile: 'fake.jsonl',
      });
    } finally {
      await pi.close();
    }
  });

  it('streams pi events to the message handler before the response', async () => {
    const pi = startFakePi({
      responses: {
        prompt: {
          data: {},
          thenEvents: [
            { delayMs: 0, event: { type: 'agent_start' } },
            { delayMs: 5, event: { type: 'message_update', text: 'hello' } },
            { delayMs: 5, event: { type: 'agent_end' } },
          ],
        },
      },
    });
    const events: WireMessage[] = [];
    pi.onMessage((message) => events.push(message));
    try {
      await expect(pi.request({ type: 'prompt', message: 'hi' })).resolves.toEqual({});
      await vi_waitFor(() => expect(events.map((event) => event.type)).toEqual([
        'agent_start',
        'message_update',
        'agent_end',
      ]));
    } finally {
      await pi.close();
    }
  });

  it('rejects with PiRpcRequestError when the fake pi reports failure', async () => {
    const pi = startFakePi({
      responses: { set_model: { success: false, error: 'Model not found: x/bad' } },
    });
    try {
      await expect(pi.request({ type: 'set_model', provider: 'x', modelId: 'bad' })).rejects.toThrow(
        PiRpcRequestError,
      );
    } finally {
      await pi.close();
    }
  });

  it('rejects a hanging request after the control-plane timeout', async () => {
    const pi = startFakePi({ hang: ['compact'] });
    try {
      await expect(
        pi.request({ type: 'compact' }, { timeoutMs: 30 }),
      ).rejects.toThrow(/timed out after 30ms/);
    } finally {
      await pi.close();
    }
  });

  it('propagates process exit to pending requests and the exit listener', async () => {
    const pi = startFakePi({ hang: ['get_state'], exitAfterMs: 30 });
    const exit = pi.waitForExit();
    const promise = pi.request({ type: 'get_state' });
    await expect(promise).rejects.toThrow(/process exited|connection closed/);
    await expect(exit).resolves.toEqual({ code: 1, signal: null });
  });

  it('captures stderr lines in a bounded buffer', async () => {
    const pi = startFakePi({ stderrLines: ['warn-one', 'warn-two'] });
    try {
      await pi.request({ type: 'get_state' });
      await vi_waitFor(() => expect(pi.getRecentStderr()).toContain('warn-two'));
      expect(pi.getRecentStderr()).toContain('warn-one');
    } finally {
      await pi.close();
    }
  });

  it('closes gracefully: pending requests reject and the process exits', async () => {
    const pi = startFakePi({});
    const pending = pi.request({ type: 'compact' }, { timeoutMs: null });
    const pendingAssertion = expect(pending).rejects.toThrow(/session closed/);
    const exit = pi.waitForExit();
    await pi.close(new Error('session closed'));
    await pendingAssertion;
    await exit;
  });

  it('rejects requests issued after close', async () => {
    const pi = startFakePi({});
    await pi.close();
    await expect(pi.request({ type: 'get_state' })).rejects.toThrow(/closed/);
  });
});

async function vi_waitFor(condition: () => void, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      condition();
      return;
    } catch {
      if (Date.now() - started > timeoutMs) {
        throw new Error('vi_waitFor timed out');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
