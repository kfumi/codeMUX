import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppServerConnection,
  AppServerRpcRequestError,
  AppServerTransport,
  type AppServerConnectionOptions,
  type AppServerTransportOptions,
} from './appServerTransport.js';

type WireMessage = Record<string, unknown>;

type LogEntry = {
  direction: 'sent' | 'received' | 'response' | 'parse-error';
  message?: WireMessage;
  id?: string;
  method?: string | null;
  line?: string;
};

const FIXTURE_PATH = fileURLToPath(new URL('./__fixtures__/fake-app-server.mjs', import.meta.url));

const pendingCleanups: Array<() => void> = [];

afterEach(() => {
  while (pendingCleanups.length > 0) {
    pendingCleanups.pop()?.();
  }
});

function createConnectionPair(options: AppServerConnectionOptions = {}): {
  connection: AppServerConnection;
  serverToClient: PassThrough;
  clientToServer: PassThrough;
} {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const connection = new AppServerConnection(serverToClient, clientToServer, options);
  return { connection, serverToClient, clientToServer };
}

function readClientMessages(
  stream: PassThrough,
  count: number,
  timeoutMs = 2_000,
): Promise<WireMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WireMessage[] = [];
    let buffer = '';
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        messages.push(JSON.parse(line) as WireMessage);
        if (messages.length >= count) {
          clearTimeout(timer);
          stream.off('data', onData);
          resolve(messages);
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      stream.off('data', onData);
      reject(new Error(`Timed out waiting for ${count} message(s); received ${messages.length}`));
    }, timeoutMs);
    stream.on('data', onData);
  });
}

describe('AppServerConnection', () => {
  it('resolves a request with the server response result', async () => {
    const { connection, serverToClient } = createConnectionPair();
    const promise = connection.request<{ thread: { id: string } }>('thread/start', { model: 'gpt-5' });
    setTimeout(() => {
      serverToClient.write(`${JSON.stringify({ id: 'c1', result: { thread: { id: 'thread_1' } } })}\n`);
    }, 0);
    await expect(promise).resolves.toEqual({ thread: { id: 'thread_1' } });
  });

  it('maps concurrent requests to their own responses', async () => {
    const { connection, serverToClient } = createConnectionPair();
    const first = connection.request<{ thread: { id: string } }>('thread/start');
    const second = connection.request<{ thread: { id: string } }>('thread/resume');
    setTimeout(() => {
      // Respond out of order to verify the pending request map.
      serverToClient.write(`${JSON.stringify({ id: 'c2', result: { thread: { id: 'resumed' } } })}\n`);
      serverToClient.write(`${JSON.stringify({ id: 'c1', result: { thread: { id: 'started' } } })}\n`);
    }, 0);
    await expect(first).resolves.toEqual({ thread: { id: 'started' } });
    await expect(second).resolves.toEqual({ thread: { id: 'resumed' } });
  });

  it('rejects with AppServerRpcRequestError on an RPC error response', async () => {
    const { connection, serverToClient } = createConnectionPair();
    const promise = connection.request('turn/start');
    setTimeout(() => {
      serverToClient.write(
        `${JSON.stringify({ id: 'c1', error: { code: -32000, message: 'boom', data: { detail: 'x' } } })}\n`,
      );
    }, 0);

    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppServerRpcRequestError);
    const rpcError = error as AppServerRpcRequestError;
    expect(rpcError.code).toBe(-32000);
    expect(rpcError.message).toContain('turn/start');
    expect(rpcError.message).toContain('boom');
    expect(rpcError.data).toEqual({ detail: 'x' });
  });

  it('times out requests that never receive a response', async () => {
    const { connection } = createConnectionPair();
    await expect(
      connection.request('thread/compact/start', {}, { timeoutMs: 25 }),
    ).rejects.toThrow(/timed out after 25ms/);
  });

  it('rejects pending requests and reports disconnect when stdout ends', async () => {
    const onDisconnect = vi.fn();
    const { connection, serverToClient } = createConnectionPair({ onDisconnect });
    const promise = connection.request('thread/start');
    serverToClient.end();
    await expect(promise).rejects.toThrow(/connection closed/);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(connection.isDisposed).toBe(true);
  });

  it('rejects pending requests when stdout errors', async () => {
    const onDisconnect = vi.fn();
    const { connection, serverToClient } = createConnectionPair({ onDisconnect });
    const promise = connection.request('thread/start');
    serverToClient.destroy(new Error('stdout pipe broken'));
    await expect(promise).rejects.toThrow(/stdout pipe broken/);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('dispose rejects pending requests', async () => {
    const { connection } = createConnectionPair();
    const promise = connection.request('thread/start');
    connection.dispose();
    await expect(promise).rejects.toThrow(/Connection disposed/);
  });

  it('dispatches server notifications to registered handlers', async () => {
    const handler = vi.fn();
    const { connection, serverToClient } = createConnectionPair();
    connection.onNotification(handler);
    serverToClient.write(
      `${JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn_1' } } })}\n`,
    );
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith('turn/started', { turn: { id: 'turn_1' } });
    });
  });

  it('sends notifications without an id', async () => {
    const { connection, clientToServer } = createConnectionPair();
    connection.notify('turn/interrupt', { turnId: 't1' });
    const messages = await readClientMessages(clientToServer, 1);
    expect(messages[0]).toEqual({ method: 'turn/interrupt', params: { turnId: 't1' } });
  });

  it('routes server-initiated requests to handlers and writes responses', async () => {
    const { connection, serverToClient, clientToServer } = createConnectionPair();
    const handler = vi.fn((_params: Record<string, unknown>, respond) => {
      respond({ result: { decision: 'approved' } });
    });
    connection.handleRequest('tool/execCommand/requestApproval', handler);
    serverToClient.write(
      `${JSON.stringify({
        method: 'tool/execCommand/requestApproval',
        id: 's1',
        params: { callId: 'call_1' },
      })}\n`,
    );

    const messages = await readClientMessages(clientToServer, 1);
    expect(handler).toHaveBeenCalledWith({ callId: 'call_1' }, expect.any(Function));
    expect(messages[0]).toEqual({ id: 's1', result: { decision: 'approved' } });
  });

  it('supports async handlers that respond after awaiting work', async () => {
    const { connection, serverToClient, clientToServer } = createConnectionPair();
    connection.handleRequest('userInfo/questions', async (_params, respond) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      respond({ result: { answers: ['yes'] } });
    });
    serverToClient.write(
      `${JSON.stringify({ method: 'userInfo/questions', id: 's1', params: {} })}\n`,
    );

    const messages = await readClientMessages(clientToServer, 1);
    expect(messages[0]).toEqual({ id: 's1', result: { answers: ['yes'] } });
  });

  it('answers unregistered server-initiated requests with a method-not-found error', async () => {
    const { connection, serverToClient, clientToServer } = createConnectionPair();
    serverToClient.write(
      `${JSON.stringify({ method: 'unknown/approval', id: 's1', params: {} })}\n`,
    );
    const messages = await readClientMessages(clientToServer, 1);
    expect(messages[0]).toMatchObject({ id: 's1', error: { code: -32601 } });
  });

  it('reports handler exceptions as internal errors', async () => {
    const { connection, serverToClient, clientToServer } = createConnectionPair();
    connection.handleRequest('tool/execCommand/requestApproval', () => {
      throw new Error('handler exploded');
    });
    serverToClient.write(
      `${JSON.stringify({ method: 'tool/execCommand/requestApproval', id: 's1', params: {} })}\n`,
    );
    const messages = await readClientMessages(clientToServer, 1);
    expect(messages[0]).toMatchObject({
      id: 's1',
      error: { code: -32603, message: expect.stringContaining('handler exploded') },
    });
  });
});

async function connectFakeAppServer(
  scenario: Record<string, unknown>,
  options: Partial<AppServerTransportOptions> = {},
): Promise<{
  transport: AppServerTransport;
  readLog: () => LogEntry[];
  cleanup: () => void;
}> {
  const logPath = path.join(
    os.tmpdir(),
    `fake-app-server-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  fs.writeFileSync(logPath, '');
  pendingCleanups.push(() => {
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // Best-effort cleanup for temp files.
    }
  });

  const transport = await AppServerTransport.connect({
    executable: process.execPath,
    args: [FIXTURE_PATH],
    env: {
      ...process.env,
      FAKE_APP_SERVER_SCENARIO: JSON.stringify(scenario),
      FAKE_APP_SERVER_LOG: logPath,
    },
    requestTimeoutMs: 5_000,
    initializeTimeoutMs: 15_000,
    ...options,
  });

  const readLog = (): LogEntry[] =>
    fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LogEntry);

  return { transport, readLog, cleanup: () => undefined };
}

describe('AppServerTransport (fake app-server)', () => {
  it('performs the initialize/initialized handshake over a real child process', async () => {
    const { transport, readLog } = await connectFakeAppServer({});
    try {
      expect(transport.isConnected).toBe(true);
      const log = readLog();
      const initialize = log.find(
        (entry) => entry.direction === 'received' && entry.message?.method === 'initialize',
      );
      expect(initialize?.message?.params).toMatchObject({
        clientInfo: { name: 'codemux', title: 'CodeMUX', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
        const initialized = await vi.waitFor(() => {
          const entry = readLog().find(
            (candidate) => candidate.direction === 'received' && candidate.message?.method === 'initialized',
          );
          expect(entry).toBeDefined();
          return entry;
        });
        expect(initialized).toBeDefined();
    } finally {
      await transport.stop();
    }
  });

  it('round-trips requests through the child process stdio', async () => {
    const { transport } = await connectFakeAppServer({
      responses: {
        'thread/start': { result: { thread: { id: 'thread_fake_1' } } },
      },
    });
    try {
      const result = await transport.request<{ thread: { id: string } }>('thread/start', {
        model: 'gpt-5',
      });
      expect(result).toEqual({ thread: { id: 'thread_fake_1' } });
    } finally {
      await transport.stop();
    }
  });

  it('propagates RPC errors from the app-server process', async () => {
    const { transport } = await connectFakeAppServer({
      responses: {
        'turn/start': { error: { code: -32000, message: 'boom' } },
      },
    });
    try {
      const error = await transport.request('turn/start').then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AppServerRpcRequestError);
      expect(error).toMatchObject({ code: -32000 });
      expect((error as Error).message).toContain('boom');
    } finally {
      await transport.stop();
    }
  });

  it('completes a notification and approval request/response loop', async () => {
    const approvalParams = { callId: 'call_1', command: ['echo', 'hi'] };
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    let resolveTurnCompleted: () => void = () => undefined;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });

    const { transport, readLog } = await connectFakeAppServer(
      {
        // The script only starts when the client sends `test/trigger`, so the
        // test can register its approval handler first.
        trigger: 'test/trigger',
        afterInitialized: [
          {
            delayMs: 0,
            notification: { method: 'turn/started', params: { turn: { id: 'turn_1' } } },
          },
          {
            delayMs: 10,
            serverRequest: {
              method: 'tool/execCommand/requestApproval',
              params: approvalParams,
              thenNotify: { method: 'turn/completed', params: { turn: { id: 'turn_1' } } },
            },
          },
        ],
      },
      {
        onNotification: (method, params) => {
          notifications.push({ method, params });
          if (method === 'turn/completed') {
            resolveTurnCompleted();
          }
        },
      },
    );

    try {
      transport.handleRequest('tool/execCommand/requestApproval', (params, respond) => {
        expect(params).toEqual(approvalParams);
        respond({ result: { decision: 'approved' } });
      });

      transport.notify('test/trigger');
      await turnCompleted;

      const log = readLog();
      const approvalResponse = log.find((entry) => entry.direction === 'response');
      expect(approvalResponse?.method).toBe('tool/execCommand/requestApproval');
      expect(approvalResponse?.message?.result).toEqual({ decision: 'approved' });
      expect(notifications.map((entry) => entry.method)).toEqual(['turn/started', 'turn/completed']);
    } finally {
      await transport.stop();
    }
  });

  it('rejects pending requests and reports an observable error when the process crashes', async () => {
    const onError = vi.fn();
    const onExit = vi.fn();
    const { transport } = await connectFakeAppServer(
      {
        trigger: 'test/trigger',
        hang: ['thread/compact/start'],
        afterInitialized: [{ delayMs: 0, exit: { code: 1 } }],
      },
      { onError, onExit },
    );

    try {
      const pending = transport.request('thread/compact/start');
      transport.notify('test/trigger');

      // On Windows the stdout stream closes before the process exit event,
      // so the rejection reason may be either the stream end or the exit.
      await expect(pending).rejects.toThrow(/connection closed/);
      await vi.waitFor(() => {
        expect(onExit).toHaveBeenCalledWith(1, null);
      });
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0]?.[0] as Error).message).toContain('App-server process exited');
    } finally {
      await transport.stop();
    }
  });

  it('stop terminates the process cleanly without reporting an error', async () => {
    const onError = vi.fn();
    const { transport } = await connectFakeAppServer({}, { onError });

    await transport.stop();
    expect(transport.isConnected).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    const exit = await transport.waitForExit();
    // On Windows kill() surfaces as signal SIGTERM; elsewhere as an exit code.
    expect(exit.code !== null || exit.signal !== null).toBe(true);
  });

  it('rejects connect with an observable error when the executable cannot be spawned', async () => {
    const executable = path.join(os.tmpdir(), `definitely-missing-${Date.now()}.exe`);
    await expect(
      AppServerTransport.connect({
        executable,
        args: ['app-server', '--stdio'],
        initializeTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/app-server|ENOENT|spawn/i);
  });
});
