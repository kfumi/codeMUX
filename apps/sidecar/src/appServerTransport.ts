import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** JSON-RPC error payload returned by the app-server. */
export type AppServerRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

/** Error thrown when the app-server answers a client request with an RPC error. */
export class AppServerRpcRequestError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(method: string, rpcError: AppServerRpcError) {
    super(`App-server request "${method}" failed: ${rpcError.message}`);
    this.name = 'AppServerRpcRequestError';
    this.method = method;
    this.code = rpcError.code;
    this.data = rpcError.data;
  }
}

export type AppServerNotificationHandler = (
  method: string,
  params: Record<string, unknown>,
) => void;

/** Responder passed to server-initiated request handlers. */
export type AppServerRequestResponder = (
  response: { result?: unknown; error?: AppServerRpcError },
) => void;

export type AppServerRequestHandler = (
  params: Record<string, unknown>,
  respond: AppServerRequestResponder,
) => void | Promise<void>;

export type AppServerErrorListener = (error: Error) => void;

export type AppServerConnectionOptions = {
  /** Default timeout applied to each request unless overridden per call. 0 disables. */
  requestTimeoutMs?: number;
  onNotification?: AppServerNotificationHandler;
  onError?: AppServerErrorListener;
  /** Fired once when the underlying stream closes or errors. */
  onDisconnect?: (reason: Error) => void;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON-RPC 2.0 connection over newline-delimited JSON streams, matching the
 * Codex app-server wire format (the `jsonrpc` header is omitted on the wire).
 *
 * Supports client→server requests/notifications, server→client notifications,
 * and server-initiated requests with bidirectional responses.
 */
export class AppServerConnection {
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Set<AppServerNotificationHandler>();
  private readonly requestHandlers = new Map<string, AppServerRequestHandler>();
  private buffer = '';
  private disposed = false;
  private disconnectReason: Error | null = null;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: AppServerConnectionOptions = {},
  ) {
    if (options.onNotification) {
      this.notificationHandlers.add(options.onNotification);
    }
    this.input.setEncoding?.('utf8');
    this.input.on('data', (chunk: string | Buffer) => this.handleData(chunk));
    this.input.on('end', () => this.handleDisconnect(new Error('App-server stdout stream ended')));
    this.input.on('error', (error: Error) => this.handleDisconnect(error));
    this.input.on('close', () => this.handleDisconnect(new Error('App-server stdout stream closed')));
    this.output.on('error', (error: Error) => this.handleDisconnect(error));
  }

  /** True once the underlying stream has ended, errored, or been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Registers a listener for server-initiated notifications. */
  onNotification(handler: AppServerNotificationHandler): void {
    this.notificationHandlers.add(handler);
  }

  /** Registers a handler for a server-initiated request method. */
  handleRequest(method: string, handler: AppServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Sends a request to the app-server and awaits its response. */
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.disposed) {
      throw new Error(
        `App-server request "${method}" failed: connection is closed (${this.disconnectReason?.message ?? 'disposed'})`,
      );
    }

    const id = `c${this.nextRequestId++}`;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          timer = null;
          reject(new Error(`App-server request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }

      this.pendingRequests.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.writeMessage({ method, id, params });
    });
  }

  /** Sends a notification (no response expected) to the app-server. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.disposed) {
      throw new Error(
        `App-server notification "${method}" failed: connection is closed (${this.disconnectReason?.message ?? 'disposed'})`,
      );
    }
    this.writeMessage({ method, params });
  }

  /**
   * Client-initiated teardown. Rejects pending requests so callers do not
   * wait on a connection that will never produce more responses.
   */
  dispose(reason = new Error('Connection disposed')): void {
    this.handleDisconnect(reason);
  }

  private handleData(chunk: string | Buffer): void {
    if (this.disposed) {
      return;
    }
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      this.reportError(new Error(`App-server sent a non-JSON line: ${line.slice(0, 200)}`));
      return;
    }

    const method = typeof message.method === 'string' ? message.method : undefined;
    const hasId = message.id !== undefined && message.id !== null;

    if (method !== undefined && hasId) {
      // Server-initiated request — the client must respond.
      void this.dispatchServerRequest(String(message.id), method, isRecord(message.params) ? message.params : {});
      return;
    }
    if (method !== undefined) {
      // Server notification.
      this.dispatchNotification(method, isRecord(message.params) ? message.params : {});
      return;
    }
    if (hasId) {
      // Response to a pending client request.
      this.resolvePendingRequest(String(message.id), message);
      return;
    }
    this.reportError(new Error(`App-server sent a message without method or id: ${line.slice(0, 200)}`));
  }

  private dispatchNotification(method: string, params: Record<string, unknown>): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(method, params);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async dispatchServerRequest(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.writeMessage({
        id,
        error: { code: -32601, message: `No handler registered for app-server request "${method}"` },
      });
      return;
    }

    const respond: AppServerRequestResponder = (response) => {
      if (this.disposed) return;
      this.writeMessage({ id, ...response });
    };

    try {
      await handler(params, respond);
    } catch (error) {
      if (this.disposed) return;
      this.writeMessage({
        id,
        error: {
          code: -32603,
          message: `Handler for "${method}" failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  private resolvePendingRequest(id: string, message: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }

    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : -32000;
      const text = typeof message.error.message === 'string' ? message.error.message : 'unknown app-server error';
      pending.reject(new AppServerRpcRequestError(pending.method, {
        code,
        message: text,
        ...(message.error.data !== undefined ? { data: message.error.data } : {}),
      }));
      return;
    }

    pending.resolve(message.result);
  }

  private writeMessage(message: Record<string, unknown>): void {
    try {
      this.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.handleDisconnect(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleDisconnect(reason: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnectReason = reason;

    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      pending.reject(
        new Error(
          `App-server request "${pending.method}" failed: connection closed (${reason.message})`,
        ),
      );
    }
    this.pendingRequests.clear();

    try {
      this.options.onDisconnect?.(reason);
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Observer errors must not break the connection loop.
    }
  }
}

export type AppServerClientInfo = {
  name: string;
  title?: string;
  version: string;
};

export type AppServerTransportOptions = {
  /** Executable to spawn (the Codex CLI binary or a test double). */
  executable: string;
  /** Arguments for the executable. Defaults to the app-server stdio invocation. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  clientInfo?: AppServerClientInfo;
  /** Opt into experimental app-server APIs during initialize. */
  experimentalApi?: boolean;
  /**
   * Declare the MCP elicitation capability during initialize. Must be enabled
   * whenever an `mcpServer/elicitation/request` handler is registered —
   * servers only forward elicitations to clients that declared the capability.
   */
  mcpServerElicitation?: boolean;
  /** Timeout for the initialize handshake. */
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  onNotification?: AppServerNotificationHandler;
  onError?: AppServerErrorListener;
  /** Fired when the app-server process exits. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Receives app-server stderr lines for diagnostics. */
  onStderrLine?: (line: string) => void;
};

export const CODEX_APP_SERVER_DEFAULT_ARGS = ['app-server', '--stdio'];

const DEFAULT_CLIENT_INFO: AppServerClientInfo = {
  name: 'codemux',
  title: 'CodeMUX',
  version: '0.1.0',
};

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

/**
 * Windows npm shims (.cmd/.bat) require the shell; real executables and POSIX
 * binaries spawn directly, which also keeps space-containing paths safe.
 */
function needsShell(executable: string): boolean {
  if (process.platform !== 'win32') return false;
  const lower = executable.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/**
 * Long-lived `codex app-server --stdio` transport: spawns the child process,
 * performs the initialize/initialized handshake, and exposes bidirectional
 * JSON-RPC on a single connection.
 */
export class AppServerTransport {
  private child: ChildProcess | null = null;
  private connection: AppServerConnection | null = null;
  private startError: Error | null = null;
  private stopping = false;
  private exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();

  private constructor(private readonly options: AppServerTransportOptions) {}

  static async connect(options: AppServerTransportOptions): Promise<AppServerTransport> {
    const transport = new AppServerTransport(options);
    try {
      await transport.start();
    } catch (error) {
      await transport.stop().catch(() => undefined);
      throw error;
    }
    return transport;
  }

  get isConnected(): boolean {
    return this.connection !== null && !this.connection.isDisposed;
  }

  /** Registers a handler for a server-initiated request (e.g. approvals). */
  handleRequest(method: string, handler: AppServerRequestHandler): void {
    if (!this.connection) {
      throw new Error('App-server transport has not started yet');
    }
    this.connection.handleRequest(method, handler);
  }

  /** Registers a listener for server-initiated notifications. */
  onNotification(handler: AppServerNotificationHandler): void {
    if (!this.connection) {
      throw new Error('App-server transport has not started yet');
    }
    this.connection.onNotification(handler);
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.connection) {
      return Promise.reject(new Error('App-server transport has not started yet'));
    }
    return this.connection.request<T>(method, params, options);
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.connection) {
      throw new Error('App-server transport has not started yet');
    }
    this.connection.notify(method, params);
  }

  /** Resolves once the app-server process exits (already-exited resolves immediately). */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => {
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
        const code = this.child?.exitCode ?? null;
        const signal = this.child?.signalCode ?? null;
        resolve({ code, signal });
        return;
      }
      const listener = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.exitListeners.delete(listener);
        resolve({ code, signal });
      };
      this.exitListeners.add(listener);
    });
  }

  /** Kills the child process and disposes the connection. */
  async stop(): Promise<void> {
    const child = this.child;
    const connection = this.connection;
    this.connection = null;
    this.stopping = true;

    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await this.waitForExit();
    }
    connection?.dispose(new Error('App-server transport stopped'));
  }

  private async start(): Promise<void> {
    if (this.connection) {
      throw new Error('App-server transport has already started');
    }

    const args = this.options.args ?? CODEX_APP_SERVER_DEFAULT_ARGS;
    let child: ChildProcess;
    try {
      child = spawn(this.options.executable, args, {
        cwd: this.options.cwd,
        env: this.buildEnv(),
        shell: needsShell(this.options.executable),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(
        `Failed to spawn app-server (${this.options.executable}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.child = child;

    const stdin = child.stdin;
    const stdout = child.stdout;
    if (!stdin || !stdout) {
      throw new Error('App-server process was spawned without piped stdio');
    }

    child.stderr?.setEncoding?.('utf8');
    let stderrBuffer = '';
    child.stderr?.on('data', (chunk: string) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.options.onStderrLine?.(line);
      }
    });

    // Both spawn errors (ENOENT etc.) and early exits must fail the pending
    // handshake and reject in-flight requests with an observable error.
    child.on('error', (error) => {
      this.startError = error;
      this.connection?.dispose(error);
      this.options.onError?.(error);
    });
    child.on('exit', (code, signal) => {
      const reason = new Error(
        `App-server process exited (code=${code ?? 'null'} signal=${signal ?? 'null'})${this.startError ? `: ${this.startError.message}` : ''}`,
      );
      this.connection?.dispose(reason);
      // Abnormal exits (crash / signal) are surfaced as observable errors;
      // intentional stop() and clean exits only report via onExit.
      if (!this.stopping && (code === null || code !== 0)) {
        this.options.onError?.(reason);
      }
      this.options.onExit?.(code, signal);
      for (const listener of [...this.exitListeners]) {
        listener(code, signal);
      }
      this.exitListeners.clear();
    });

    this.connection = new AppServerConnection(stdout, stdin, {
      requestTimeoutMs: this.options.requestTimeoutMs,
      onNotification: this.options.onNotification,
      onError: this.options.onError,
    });

    await this.performHandshake();
  }

  private async performHandshake(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      throw new Error('App-server connection was not established');
    }

    const clientInfo = this.options.clientInfo ?? DEFAULT_CLIENT_INFO;
    const experimentalApi = this.options.experimentalApi ?? true;
    const mcpServerElicitation = this.options.mcpServerElicitation ?? false;

    await connection.request(
      'initialize',
      {
        clientInfo: {
          name: clientInfo.name,
          ...(clientInfo.title ? { title: clientInfo.title } : {}),
          version: clientInfo.version,
        },
        capabilities: {
          experimentalApi,
          ...(mcpServerElicitation ? { mcpServerOpenaiFormElicitation: true } : {}),
        },
      },
      { timeoutMs: this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS },
    );
    connection.notify('initialized');
  }

  private buildEnv(): Record<string, string | undefined> {
    if (this.options.env) {
      return { ...this.options.env };
    }
    return { ...process.env };
  }
}

/**
 * Spawns the Codex app-server process without performing the JSON-RPC
 * handshake. Useful for one-shot control operations.
 */
export function spawnAppServerProcess(options: {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}): ChildProcess {
  return spawn(options.executable, options.args ?? CODEX_APP_SERVER_DEFAULT_ARGS, {
    cwd: options.cwd,
    env: options.env ?? { ...process.env },
    shell: needsShell(options.executable),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
