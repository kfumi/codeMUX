import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

type CodexAppServerRequest = {
  method: string;
  id: number;
  params: Record<string, unknown>;
};

type CodexAppServerResponse = {
  id?: number;
  result?: {
    thread?: {
      id?: string;
      sessionId?: string;
      turns?: Array<{ id?: string }>;
    };
    data?: Array<{ id?: string }>;
  };
  error?: {
    message?: string;
    data?: unknown;
  };
};

export type CodexForkOptions = {
  runtimePath: string;
  cwd: string;
  sourceThreadId: string;
  lastTurnId?: string;
  turnOrdinal?: number;
  apiKey?: string;
  baseUrl?: string;
};

const APP_SERVER_TIMEOUT_MS = 30_000;

/**
 * Uses the official Codex app-server only for the thread/fork control operation.
 * Normal turns continue to run through @openai/codex-sdk.
 */
export async function forkCodexThread(options: CodexForkOptions): Promise<string> {
  const executable = resolveCodexExecutable(options.runtimePath);
  const child = spawnCodexAppServer(executable, options);
  const timeout = setTimeout(() => {
    child.kill();
  }, APP_SERVER_TIMEOUT_MS);

  try {
    const initializeResponse = await sendRequest(child, {
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'codemux',
          title: 'CodeMUX',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    });
    assertResponse(initializeResponse, 'Codex app-server initialization failed');
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);

    const params: Record<string, unknown> = {
      threadId: options.sourceThreadId,
    };
    const lastTurnId = options.turnOrdinal !== undefined
      ? await resolveTurnId(child, options.sourceThreadId, options.turnOrdinal)
      : options.lastTurnId;
    if (lastTurnId) {
      params.lastTurnId = lastTurnId;
    }

    const forkResponse = await sendRequest(child, {
      method: 'thread/fork',
      id: 2,
      params,
    });
    assertResponse(forkResponse, 'Codex app-server thread fork failed');

    const childThreadId =
      forkResponse.result?.thread?.id
      ?? forkResponse.result?.thread?.sessionId;
    if (!childThreadId) {
      throw new Error('Codex app-server fork response did not include a thread ID');
    }
    return childThreadId;
  } finally {
    clearTimeout(timeout);
    child.kill();
    await waitForExit(child);
  }
}

async function resolveTurnId(
  child: ChildProcessWithoutNullStreams,
  threadId: string,
  turnOrdinal: number,
): Promise<string> {
  const response = await sendRequest(child, {
    method: 'thread/turns/list',
    id: 3,
    params: {
      threadId,
      limit: 200,
      sortDirection: 'asc',
      itemsView: 'summary',
    },
  });
  assertResponse(response, 'Codex app-server turn list failed');

  const turns = response.result?.data ?? response.result?.thread?.turns ?? [];
  const turn = turns[turnOrdinal];
  if (!turn?.id) {
    throw new Error(`Codex provider turn ${turnOrdinal} was not found`);
  }
  return turn.id;
}

function resolveCodexExecutable(runtimePath: string): string {
  const binDirectory = path.join(runtimePath, 'node_modules', '.bin');
  const candidates = process.platform === 'win32'
    ? ['codex.cmd', 'codex.exe', 'codex']
    : ['codex'];

  const executable = candidates
    .map((name) => path.join(binDirectory, name))
    .find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error(`Codex CLI executable was not found in ${binDirectory}`);
  }
  return executable;
}

function spawnCodexAppServer(
  executable: string,
  options: CodexForkOptions,
): ChildProcessWithoutNullStreams {
  const env = { ...process.env };
  if (options.apiKey) {
    env.OPENAI_API_KEY = options.apiKey;
    env.CODEX_API_KEY = options.apiKey;
  }
  if (options.baseUrl) {
    env.OPENAI_BASE_URL = options.baseUrl;
  }
  const runtimeBin = path.join(options.runtimePath, 'node_modules', '.bin');
  const currentPath = env.PATH ?? env.Path ?? '';
  const pathKey = env.PATH !== undefined ? 'PATH' : 'Path';
  env[pathKey] = [runtimeBin, currentPath].filter(Boolean).join(path.delimiter);

  return spawn(executable, ['app-server', '--stdio'], {
    cwd: options.cwd,
    env,
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function sendRequest(
  child: ChildProcessWithoutNullStreams,
  request: CodexAppServerRequest,
): Promise<CodexAppServerResponse> {
  return new Promise<CodexAppServerResponse>((resolve, reject) => {
    let buffered = '';
    const cleanup = (): void => {
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onData = (chunk: Buffer | string): void => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let response: CodexAppServerResponse;
        try {
          response = JSON.parse(line) as CodexAppServerResponse;
        } catch {
          continue;
        }
        if (response.id === request.id) {
          cleanup();
          resolve(response);
          return;
        }
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error('Codex app-server exited before returning a response'));
    };

    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function assertResponse(response: CodexAppServerResponse, prefix: string): void {
  if (response.error) {
    const details = response.error.message
      ?? (response.error.data ? JSON.stringify(response.error.data) : 'unknown error');
    throw new Error(`${prefix}: ${details}`);
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
}
