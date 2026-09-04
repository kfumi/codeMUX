import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** Error thrown when pi answers a command with `success: false`. */
export class PiRpcRequestError extends Error {
  readonly command: string;
  readonly error: string;

  constructor(command: string, error: string) {
    super(`pi RPC command "${command}" failed: ${error}`);
    this.name = 'PiRpcRequestError';
    this.command = command;
    this.error = error;
  }
}

/** Handler for every pi line that is not a response to a pending request. */
export type PiRpcMessageHandler = (message: Record<string, unknown>) => void;

export type PiRpcErrorListener = (error: Error) => void;

export type PiRpcConnectionOptions = {
  /** Receives every pi line that is not a matched response (events, extension UI, …). */
  onMessage?: PiRpcMessageHandler;
  /** Protocol-level problems (unroutable responses, non-JSON lines, write failures). */
  onError?: PiRpcErrorListener;
  /** Fired once when the underlying stream closes or errors. */
  onDisconnect?: (reason: Error) => void;
};

/** Default control-plane timeout. Long-blocking commands (compact) pass null explicitly. */
export const PI_RPC_DEFAULT_TIMEOUT_MS = 30_000;

const STDERR_BUFFER_LIMIT = 8_192;

type PendingRequest = {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * pi RPC wire connection over newline-delimited JSON (pi `--mode rpc`).
 *
 * Unlike JSON-RPC, every pi frame carries a `type`; responses are the frames
 * with `type: "response"` whose `id` matches a pending request. All other
 * lines (events, extension UI requests, …) go to the message handler.
 *
 * Frames split strictly on `\n` with a trailing `\r` stripped: Node's
 * `readline` also splits on U+2028/U+2029, which corrupts pi payloads
 * containing those code points (see the pi RPC docs).
 */
export class PiRpcConnection {
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly messageHandlers = new Set<PiRpcMessageHandler>();
  private buffer = '';
  private disposed = false;
  private disconnectReason: Error | null = null;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: PiRpcConnectionOptions = {},
  ) {
    if (options.onMessage) {
      this.messageHandlers.add(options.onMessage);
    }
    this.input.setEncoding?.('utf8');
    this.input.on('data', (chunk: string | Buffer) => this.handleData(chunk));
    this.input.on('end', () => this.handleDisconnect(new Error('pi stdout stream ended')));
    this.input.on('error', (error: Error) => this.handleDisconnect(error));
    this.input.on('close', () => this.handleDisconnect(new Error('pi stdout stream closed')));
    this.output.on('error', (error: Error) => this.handleDisconnect(error));
  }

  /** True once the underlying stream has ended, errored, or been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  onMessage(handler: PiRpcMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  /**
   * Sends a command frame and awaits its response. `timeoutMs: null` waits
   * only for the response, process death, or dispose — for long-blocking
   * commands such as `compact`.
   */
  request<T = unknown>(
    command: Record<string, unknown> & { type: string },
    options: { timeoutMs?: number | null } = {},
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(
        new Error(
          `pi RPC command "${command.type}" failed: connection is closed (${this.disconnectReason?.message ?? 'disposed'})`,
        ),
      );
    }

    const id = `c${this.nextRequestId++}`;
    const timeoutMs =
      options.timeoutMs === null ? null : (options.timeoutMs ?? PI_RPC_DEFAULT_TIMEOUT_MS);

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          timer = null;
          reject(new Error(`pi RPC command "${command.type}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }

      this.pendingRequests.set(id, {
        command: command.type,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.writeLine({ ...command, id });
    });
  }

  /**
   * Sends a frame without registering a pending request — for replies to
   * pi-initiated requests such as `extension_ui_response`（pi 按 frame 里的
   * `id`（它自己发的 uuid）匹配挂起的 extension UI 请求）。
   */
  notify(frame: Record<string, unknown>): void {
    if (this.disposed) return;
    this.writeLine(frame);
  }

  /** Client-initiated teardown. Rejects pending requests with the given reason. */
  dispose(reason = new Error('pi RPC connection disposed')): void {
    this.handleDisconnect(reason);
  }

  private handleData(chunk: string | Buffer): void {
    if (this.disposed) {
      return;
    }
    this.buffer += chunk.toString();
    // Split on \n only; a lone \r is mid-line content (CRLF producers leave a
    // trailing \r that pi semantics treat as part of the separator).
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
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
      this.reportError(new Error(`pi sent a non-JSON line: ${line.slice(0, 200)}`));
      return;
    }

    if (message.type === 'response') {
      this.resolvePendingRequest(message);
      return;
    }
    this.dispatchMessage(message);
  }

  private resolvePendingRequest(message: Record<string, unknown>): void {
    const id = message.id === undefined || message.id === null ? null : String(message.id);
    const pending = id !== null ? this.pendingRequests.get(id) : undefined;
    if (!pending || id === null) {
      this.reportError(new Error(`pi response does not match a pending request: ${JSON.stringify(message).slice(0, 200)}`));
      return;
    }
    this.pendingRequests.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }

    if (message.success === false) {
      const errorText =
        typeof message.error === 'string' && message.error.trim()
          ? message.error
          : 'unknown pi error';
      pending.reject(new PiRpcRequestError(pending.command, errorText));
      return;
    }
    pending.resolve(message.data);
  }

  private dispatchMessage(message: Record<string, unknown>): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private writeLine(message: Record<string, unknown>): void {
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
          `pi RPC command "${pending.command}" failed: connection closed (${reason.message})`,
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

export type PiRpcProcessOptions = {
  /** Executable to spawn (the pi binary or a test double). */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Default request timeout; individual requests may override or disable (null). */
  requestTimeoutMs?: number;
  /** Test seam: spawn the process yourself instead of node's spawn. */
  spawnProcess?: (command: string, args: string[]) => ChildProcess;
  /** Receives pi stderr lines for diagnostics. */
  onStderrLine?: (line: string) => void;
  /** Protocol-level problems (unroutable responses, non-JSON lines). */
  onError?: PiRpcErrorListener;
  /** Fired when the pi process exits. */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
};

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

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
 * Long-lived `pi --mode rpc` process: spawns the child and exposes the JSONL
 * request/event surface plus a graceful-close ladder (stdin end → SIGTERM-equivalent
 * kill → force kill).
 */
export class PiRpcProcess {
  private child: ChildProcess | null = null;
  private connection: PiRpcConnection | null = null;
  private stderrTail = '';
  private stderrLineBuffer = '';
  private exitListeners = new Set<(info: { code: number | null; signal: NodeJS.Signals | null }) => void>();
  private stopping = false;

  private constructor(private readonly options: PiRpcProcessOptions) {}

  static start(options: PiRpcProcessOptions): PiRpcProcess {
    const process = new PiRpcProcess(options);
    process.start();
    return process;
  }

  get isConnected(): boolean {
    return this.connection !== null && !this.connection.isDisposed;
  }

  onMessage(handler: PiRpcMessageHandler): void {
    if (!this.connection) {
      throw new Error('pi RPC process has not started yet');
    }
    this.connection.onMessage(handler);
  }

  request<T = unknown>(
    command: Record<string, unknown> & { type: string },
    options: { timeoutMs?: number | null } = {},
  ): Promise<T> {
    if (!this.connection) {
      return Promise.reject(new Error('pi RPC process has not started yet'));
    }
    const effectiveOptions: { timeoutMs?: number | null } =
      options.timeoutMs !== undefined ? options : { timeoutMs: this.options.requestTimeoutMs };
    return this.connection.request<T>(command, effectiveOptions);
  }

  /** Sends a frame without awaiting a response (see {@link PiRpcConnection.notify}). */
  notify(frame: Record<string, unknown>): void {
    this.connection?.notify(frame);
  }

  /** Bounded tail of everything pi wrote to stderr, for diagnostics. */
  getRecentStderr(): string {
    return this.stderrTail;
  }

  /** Resolves once the pi process exits (already-exited resolves immediately). */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => {
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve({ code: this.child?.exitCode ?? null, signal: this.child?.signalCode ?? null });
        return;
      }
      const listener = (info: { code: number | null; signal: NodeJS.Signals | null }): void => {
        this.exitListeners.delete(listener);
        resolve(info);
      };
      this.exitListeners.add(listener);
    });
  }

  /**
   * Graceful close ladder: end stdin (pi exits on EOF), wait
   * GRACEFUL_SHUTDOWN_TIMEOUT_MS, kill, wait FORCE_SHUTDOWN_TIMEOUT_MS, force
   * kill. Pending requests reject with the close reason either way.
   */
  async close(reason = new Error('pi RPC session is closed')): Promise<void> {
    const child = this.child;
    const connection = this.connection;
    this.stopping = true;
    connection?.dispose(reason);

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.stdin?.end();
    const graceful = await this.waitForExitWithin(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    if (graceful) return;

    child.kill();
    const terminated = await this.waitForExitWithin(FORCE_SHUTDOWN_TIMEOUT_MS);
    if (!terminated) {
      child.kill('SIGKILL');
      await this.waitForExit();
    }
  }

  private start(): void {
    const args = this.options.args ?? [];
    let child: ChildProcess;
    const spawnFn = this.options.spawnProcess;
    try {
      child = spawnFn
        ? spawnFn(this.options.command, args)
        : spawn(this.options.command, args, {
            cwd: this.options.cwd,
            env: this.options.env ? { ...this.options.env } : { ...process.env },
            shell: needsShell(this.options.command),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
    } catch (error) {
      throw new Error(
        `Failed to spawn pi (${this.options.command}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.child = child;

    const stdin = child.stdin;
    const stdout = child.stdout;
    if (!stdin || !stdout) {
      throw new Error('pi process was spawned without piped stdio');
    }

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const text = chunk.toString();
      this.stderrTail = `${this.stderrTail}${text}`.slice(-STDERR_BUFFER_LIMIT);
      this.stderrLineBuffer += text;
      const parts = this.stderrLineBuffer.split(/\r?\n/);
      this.stderrLineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim()) this.options.onStderrLine?.(line);
      }
    });

    child.on('error', (error) => {
      this.connection?.dispose(error);
      this.options.onError?.(error);
    });
    child.on('exit', (code, signal) => {
      const reason = new Error(`pi process exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
      this.connection?.dispose(reason);
      if (!this.stopping && (code === null || code !== 0)) {
        this.options.onError?.(reason);
      }
      this.options.onExit?.({ code, signal });
      for (const listener of [...this.exitListeners]) {
        listener({ code, signal });
      }
      this.exitListeners.clear();
    });

    this.connection = new PiRpcConnection(stdout, stdin, {
      onError: this.options.onError,
    });
  }

  private waitForExitWithin(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.exitListeners.delete(listener);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const listener = (info: { code: number | null; signal: NodeJS.Signals | null }): void => {
        clearTimeout(timer);
        this.exitListeners.delete(listener);
        resolve(true);
        void info;
      };
      this.exitListeners.add(listener);
    });
  }
}
