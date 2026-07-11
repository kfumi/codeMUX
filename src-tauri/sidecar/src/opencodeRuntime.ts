import type { AgentInputPayload } from './agentInputPayload.js';
import type { OpenCodeSessionConfig, OpenCodeSessionMapping } from './types.js';
import {
  mapOpenCodeImages,
  officialOpenCodeSdkPort,
  type OpenCodeClientPort,
  type OpenCodeSdkPort,
  type OpenCodeSdkReadyResources,
  type OpenCodeSdkStartFailure,
  type OpenCodeSdkStartResources,
  type OpenCodeServerHandle,
} from './opencodeSdk.js';

type RuntimeState = 'idle' | 'starting' | 'started' | 'disposing' | 'cleanup_failed' | 'disposed';

export const DEFAULT_ACTIVE_TASK_TIMEOUT_MS = 30_000;

export interface OpenCodeRuntimeOptions {
  activeTaskTimeoutMs?: number;
}

export class OpenCodeRuntime {
  private readonly config: OpenCodeSessionConfig;
  private readonly sdk: OpenCodeSdkPort;
  private readonly activeTaskTimeoutMs: number;
  private server: OpenCodeServerHandle | undefined;
  private client: OpenCodeClientPort | undefined;
  private agentSessionId: string | undefined;
  private activeTask: Promise<void> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private state: RuntimeState = 'idle';

  constructor(
    config: OpenCodeSessionConfig,
    sdk: OpenCodeSdkPort = officialOpenCodeSdkPort,
    options: OpenCodeRuntimeOptions = {},
  ) {
    this.config = config;
    this.sdk = sdk;
    this.activeTaskTimeoutMs = options.activeTaskTimeoutMs ?? DEFAULT_ACTIVE_TASK_TIMEOUT_MS;
    if (!Number.isFinite(this.activeTaskTimeoutMs) || this.activeTaskTimeoutMs <= 0) {
      throw new RangeError('OpenCode active task timeout must be a positive finite number');
    }
    this.agentSessionId = config.agentSessionId;
  }

  async start(): Promise<OpenCodeSessionMapping> {
    if (this.state === 'disposed' || this.state === 'disposing' || this.state === 'cleanup_failed') {
      throw new Error(`OpenCode runtime cannot start in state ${this.state}`);
    }
    if (this.state === 'started' && this.agentSessionId && this.client) {
      return this.mapping();
    }

    this.state = 'starting';
    if (!this.client) {
      let resources: OpenCodeSdkReadyResources;
      try {
        resources = await this.sdk.start({ cwd: this.config.cwd });
      } catch (error) {
        this.retainStartResources(getStartFailureResources(error));
        const cleanupError = await this.closeServerAfterStartFailure();
        this.state = cleanupError ? 'cleanup_failed' : 'idle';
        if (cleanupError) {
          throw aggregateErrors('OpenCode SDK start and cleanup failed', [error, cleanupError]);
        }
        throw error;
      }
      this.server = resources.server;
      this.client = resources.client;
    }

    const client = this.client;
    if (!client) {
      this.state = 'idle';
      throw new Error('OpenCode client is unavailable after server startup');
    }

    try {
      const session = this.agentSessionId
        ? await client.restoreSession({ cwd: this.config.cwd, sessionId: this.agentSessionId })
        : await client.createSession({ cwd: this.config.cwd });
      this.agentSessionId = session.id;
      this.state = 'started';
      return this.mapping();
    } catch (error) {
      const requestedSessionId = this.config.agentSessionId;
      const cleanupError = await this.closeServerAfterStartFailure();
      this.state = cleanupError ? 'cleanup_failed' : 'idle';
      const startError = requestedSessionId
        ? new Error(`Failed to restore OpenCode session "${requestedSessionId}": ${String(errorMessage(error))}`)
        : error;
      if (cleanupError) {
        throw aggregateErrors('OpenCode start failed and cleanup failed', [startError, cleanupError]);
      }
      throw startError;
    }
  }

  async sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void> {
    const client = this.client;
    const sessionId = this.agentSessionId;
    if (this.state !== 'started' || !client || !sessionId) {
      throw new Error('OpenCode runtime is not started');
    }
    if (this.activeTask) {
      throw new Error('OpenCode runtime already has an active task');
    }

    const task = client.prompt({
      sessionId,
      prompt,
      inputPayload,
      images: mapOpenCodeImages(inputPayload),
      provider: this.config.provider,
      model: this.config.model,
    });
    const handledTask = task.catch((error) => {
      if (isAbortError(error)) {
        return;
      }
      throw error;
    });
    this.activeTask = handledTask;
    try {
      await handledTask;
    } finally {
      if (this.activeTask === handledTask) {
        this.activeTask = undefined;
      }
    }
  }

  async interrupt(): Promise<void> {
    const client = this.client;
    const sessionId = this.agentSessionId;
    if (!client || !sessionId || !this.activeTask) {
      return;
    }

    try {
      await client.abort(sessionId);
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
    }
  }

  async resetSession(): Promise<void> {
    await this.interrupt();
    await this.activeTask;
    this.agentSessionId = undefined;
  }

  async shutdown(): Promise<void> {
    if (this.state === 'disposed') {
      return;
    }
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    this.state = 'disposing';
    const cleanupPromise = this.disposeResources();
    this.cleanupPromise = cleanupPromise;
    try {
      await cleanupPromise;
    } catch (error) {
      this.state = 'cleanup_failed';
      throw error;
    } finally {
      if (this.cleanupPromise === cleanupPromise) {
        this.cleanupPromise = undefined;
      }
    }
  }

  async dispose(): Promise<void> {
    await this.shutdown();
  }

  private mapping(): OpenCodeSessionMapping {
    if (!this.agentSessionId) {
      throw new Error('OpenCode session mapping is unavailable');
    }
    return {
      sessionId: this.config.sessionId,
      agentSessionId: this.agentSessionId,
    };
  }

  private retainStartResources(resources: OpenCodeSdkStartResources | undefined): void {
    if (resources?.server) {
      this.server = resources.server;
    }
    if (resources?.client) {
      this.client = resources.client;
    }
  }

  private async disposeResources(): Promise<void> {
    const errors: unknown[] = [];
    try {
      try {
        await this.interrupt();
      } catch (error) {
        errors.push(error);
      }

      const activeTask = this.activeTask;
      if (activeTask) {
        try {
          await this.waitForActiveTask(activeTask);
        } catch (error) {
          errors.push(error);
        }
      }
      this.activeTask = undefined;

      this.agentSessionId = undefined;
      this.client = undefined;

      const server = this.server;
      if (server) {
        try {
          await server.close();
          this.server = undefined;
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length > 0) {
        throw aggregateErrors('OpenCode runtime cleanup failed', errors);
      }
      this.state = 'disposed';
    } catch (error) {
      this.state = 'cleanup_failed';
      throw error;
    }
  }

  private async waitForActiveTask(activeTask: Promise<void>): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`OpenCode active task cleanup timed out after ${this.activeTaskTimeoutMs}ms`));
      }, this.activeTaskTimeoutMs);
    });

    try {
      await Promise.race([activeTask, timeout]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
  private async closeServerAfterStartFailure(): Promise<unknown | undefined> {
    this.client = undefined;
    const server = this.server;
    if (!server) {
      return undefined;
    }
    try {
      await server.close();
      this.server = undefined;
      return undefined;
    } catch (error) {
      return error;
    }
  }
}

function getStartFailureResources(error: unknown): OpenCodeSdkStartResources | undefined {
  if (!isOpenCodeSdkStartFailure(error)) {
    return undefined;
  }
  return error.resources;
}

function isOpenCodeSdkStartFailure(error: unknown): error is OpenCodeSdkStartFailure {
  return typeof error === 'object' && error !== null && 'resources' in error;
}

function aggregateErrors(message: string, errors: unknown[]): Error {
  return new AggregateError(errors, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('aborterror') ||
    message.includes('operation was aborted') ||
    message.includes('aborted') ||
    message.includes('cancelled') ||
    message.includes('canceled')
  );
}
