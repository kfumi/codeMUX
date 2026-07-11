import type { AgentInputPayload } from './agentInputPayload.js';
import type { OpenCodeSessionConfig, OpenCodeSessionMapping } from './types.js';
import {
  officialOpenCodeSdkPort,
  type OpenCodeClientPort,
  type OpenCodeSdkPort,
  type OpenCodeServerHandle,
} from './opencodeSdk.js';

export class OpenCodeRuntime {
  private readonly config: OpenCodeSessionConfig;
  private readonly sdk: OpenCodeSdkPort;
  private server: OpenCodeServerHandle | undefined;
  private client: OpenCodeClientPort | undefined;
  private agentSessionId: string | undefined;
  private activeTask: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;

  constructor(config: OpenCodeSessionConfig, sdk: OpenCodeSdkPort = officialOpenCodeSdkPort) {
    this.config = config;
    this.sdk = sdk;
    this.agentSessionId = config.agentSessionId;
  }

  async start(): Promise<OpenCodeSessionMapping> {
    if (this.agentSessionId && this.client) {
      return this.mapping();
    }

    if (!this.client) {
      const resources = await this.sdk.start({ cwd: this.config.cwd });
      this.server = resources.server;
      this.client = resources.client;
    }

    try {
      const session = this.agentSessionId
        ? await this.client.restoreSession({ cwd: this.config.cwd, sessionId: this.agentSessionId })
        : await this.client.createSession({ cwd: this.config.cwd });
      this.agentSessionId = session.id;
      return this.mapping();
    } catch (error) {
      const requestedSessionId = this.config.agentSessionId;
      await this.closeServerAfterStartFailure();
      if (requestedSessionId) {
        throw new Error(`Failed to restore OpenCode session "${requestedSessionId}": ${String(errorMessage(error))}`);
      }
      throw error;
    }
  }

  async sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void> {
    const client = this.client;
    const sessionId = this.agentSessionId;
    if (!client || !sessionId) {
      throw new Error('OpenCode runtime is not started');
    }
    if (this.activeTask) {
      throw new Error('OpenCode runtime already has an active task');
    }

    const task = client.prompt({
      sessionId,
      prompt,
      inputPayload,
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
    if (!this.disposePromise) {
      this.disposePromise = this.disposeResources();
    }
    await this.disposePromise;
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

  private async disposeResources(): Promise<void> {
    try {
      await this.interrupt();
      await this.activeTask;
      this.agentSessionId = undefined;
      this.client = undefined;
      const server = this.server;
      this.server = undefined;
      if (server) {
        await server.close();
      }
    } finally {
      this.activeTask = undefined;
    }
  }

  private async closeServerAfterStartFailure(): Promise<void> {
    this.client = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      await server.close();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return message.includes('abort') || message.includes('cancel');
}
