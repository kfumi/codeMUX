import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
} from '@openai/codex-sdk';

import type { SidecarCommand } from './types.js';
import {
  buildAssistantEvent,
  buildCodexResultEvent,
  buildCodexToolResultContent,
  buildCodexToolUseContent,
  buildToolResultEvent,
} from './runtimeEvents.js';
import { shouldUseCodexChatCompatProxy } from './sessionRuntimeHelpers.js';
import { proxyManager } from './proxyManager.js';

type EnsureSessionCommand = Extract<SidecarCommand, { type: 'ensure_session' }>;

type CodexSessionBootstrap = {
  sessionId?: string;
  agentSessionId?: string;
  cwd: string;
  apiKey?: string;
  upstreamBaseUrl?: string;
  runtimeBaseUrl?: string;
  model?: string;
};

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

export class CodexSessionRuntime {
  private config: CodexSessionBootstrap | null = null;
  private configFingerprint: string | null = null;
  private abortController: AbortController | null = null;
  private client: Codex | null = null;
  private thread: Thread | null = null;

  async ensure(cmd: EnsureSessionCommand): Promise<void> {
    const cwd = cmd.cwd === '.'
      ? (process.env.USERPROFILE || process.env.HOME || cmd.cwd)
      : cmd.cwd;
    const requestedConfig = {
      sessionId: cmd.sessionId,
      agentSessionId: cmd.agentSessionId,
      cwd,
      apiKey: cmd.apiKey,
      upstreamBaseUrl: cmd.baseUrl,
      model: cmd.model,
    };
    const nextFingerprint = JSON.stringify(requestedConfig);

    if (this.configFingerprint === nextFingerprint && this.config && this.thread) {
      process.stderr.write(
        `[codex] Session ensured via SDK: session_id=${cmd.sessionId || 'none'} cwd=${cwd} thread=${requestedConfig.agentSessionId || 'new'}\n`,
      );
      emit({
        type: 'mcp_status_update',
        servers: {},
        status: 'ready',
      });
      emit({ type: 'proxy_status', ...proxyManager.getStatus() });
      return;
    }

    await this.teardownClient();
    this.configFingerprint = nextFingerprint;

    let runtimeBaseUrl = requestedConfig.upstreamBaseUrl;
    if (
      requestedConfig.apiKey &&
      requestedConfig.upstreamBaseUrl &&
      shouldUseCodexChatCompatProxy(requestedConfig.upstreamBaseUrl)
    ) {
      const result = await proxyManager.start(requestedConfig.apiKey, requestedConfig.upstreamBaseUrl);
      if (result) {
        runtimeBaseUrl = proxyManager.getBaseUrl() ?? runtimeBaseUrl;
        process.stderr.write(
          `[codex] Using chat-compat proxy upstream=${requestedConfig.upstreamBaseUrl} local=${runtimeBaseUrl}\n`,
        );
      }
    }

    this.config = {
      ...requestedConfig,
      runtimeBaseUrl,
    };

    const codexEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        codexEnv[key] = value;
      }
    }
    if (requestedConfig.apiKey) {
      codexEnv.OPENAI_API_KEY = requestedConfig.apiKey;
      codexEnv.CODEX_API_KEY = requestedConfig.apiKey;
    }
    if (runtimeBaseUrl) {
      codexEnv.OPENAI_BASE_URL = runtimeBaseUrl;
    }

    this.client = new Codex({
      env: codexEnv,
      apiKey: requestedConfig.apiKey,
      baseUrl: runtimeBaseUrl,
      config: runtimeBaseUrl
        ? {
            model_provider: 'codemux_proxy',
            model_providers: {
              codemux_proxy: {
                name: 'CodeMUX Proxy',
                base_url: runtimeBaseUrl,
                env_key: 'OPENAI_API_KEY',
              },
            },
            openai_base_url: runtimeBaseUrl,
          }
        : undefined,
    });
    process.stderr.write(
      `[codex] SDK client configured with baseUrl=${runtimeBaseUrl || 'default'} env.OPENAI_BASE_URL=${codexEnv.OPENAI_BASE_URL || 'unset'} model_provider=codemux_proxy\n`,
    );
    this.thread = requestedConfig.agentSessionId
      ? this.client.resumeThread(requestedConfig.agentSessionId, this.threadOptions())
      : this.client.startThread(this.threadOptions());

    process.stderr.write(
      `[codex] Session ensured via SDK: session_id=${cmd.sessionId || 'none'} cwd=${cwd} thread=${requestedConfig.agentSessionId || 'new'}\n`,
    );

    emit({
      type: 'mcp_status_update',
      servers: {},
      status: 'ready',
    });
    emit({ type: 'proxy_status', ...proxyManager.getStatus() });
  }

  async sendInput(prompt: string): Promise<void> {
    if (!this.config || !this.thread) {
      throw new Error('Codex session not initialized. Call ensure_session first.');
    }

    const sessionId = this.config.sessionId || '';
    const model = this.config.model || 'o4-mini';
    const startedAt = Date.now();
    let usage: Usage = emptyUsage();
    let usageSeen = false;
    let turnCompleted = false;
    let turnFailed = false;
    let failureEmitted = false;
    let pendingStreamError: string | null = null;

    this.abortController = new AbortController();

    process.stderr.write(`[codex] Processing input via SDK: ${prompt.slice(0, 80)}...\n`);

    emit({
      type: 'system',
      subtype: 'init',
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      model,
      cwd: this.config.cwd,
      tools: [],
      permissionMode: 'bypassPermissions',
    });

    const emitFailure = (message: string): void => {
      turnFailed = true;
      if (failureEmitted) {
        return;
      }
      failureEmitted = true;
      emit({ type: 'sidecar_error', error: message });
    };

    const noteStreamError = (message: string): void => {
      pendingStreamError = message;
      process.stderr.write(`[codex] SDK stream warning: ${message}\n`);
    };

    try {
      const { events } = await this.thread.runStreamed(prompt, {
        signal: this.abortController.signal,
      });

      for await (const event of events) {
        const eventDetail =
          event.type === 'error'
            ? ` message=${event.message}`
            : event.type === 'turn.failed'
              ? ` message=${event.error.message}`
              : 'item' in event
                ? ` item=${event.item.type}`
                : '';
        process.stderr.write(`[codex] SDK event: ${event.type}${eventDetail}\n`);

        if (event.type === 'turn.completed') {
          usage = event.usage;
          usageSeen = true;
          turnCompleted = true;
        }

        await this.handleSdkEvent(sessionId, event, emitFailure, noteStreamError);
      }
    } catch (error) {
      if (!this.abortController?.signal.aborted) {
        const message = error instanceof Error
          ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
          : String(error);
        process.stderr.write(`[codex] SDK turn failed before completion: ${message}\n`);
        emitFailure(message);
      } else {
        process.stderr.write('[codex] SDK turn aborted\n');
      }
    } finally {
      if (!this.abortController?.signal.aborted && !turnCompleted && !turnFailed && pendingStreamError) {
        emitFailure(pendingStreamError);
      }

      const finalUsage = usageSeen ? usage : emptyUsage();
      if (!this.abortController?.signal.aborted && turnCompleted && !turnFailed) {
        emit(buildCodexResultEvent({
          sessionId,
          usage: finalUsage,
          durationMs: Date.now() - startedAt,
        }));
      } else if (!this.abortController?.signal.aborted) {
        process.stderr.write(
          `[codex] Skipping success result: completed=${turnCompleted} failed=${turnFailed}\n`,
        );
      }

      this.abortController = null;
      this.finishTurn();
    }
  }

  async interrupt(): Promise<void> {
    process.stderr.write('[codex] Interrupt requested\n');
    this.abortController?.abort();
  }

  async resetSession(sessionId: string): Promise<void> {
    process.stderr.write(`[codex] Reset session: ${sessionId}\n`);
    this.abortController?.abort();
    this.abortController = null;
    await this.teardownClient();
    this.config = null;
    this.configFingerprint = null;
  }

  async shutdown(): Promise<void> {
    process.stderr.write('[codex] Shutdown\n');
    this.abortController?.abort();
    this.abortController = null;
    await this.teardownClient();
    this.config = null;
    this.configFingerprint = null;
  }

  private threadOptions() {
    if (!this.config) {
      throw new Error('Missing Codex config');
    }

    return {
      model: this.config.model,
      workingDirectory: this.config.cwd,
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access' as const,
      approvalPolicy: 'never' as const,
      networkAccessEnabled: true,
    };
  }

  private async handleSdkEvent(
    sessionId: string,
    event: ThreadEvent,
    emitFailure: (message: string) => void,
    noteStreamError: (message: string) => void,
  ): Promise<void> {
    switch (event.type) {
      case 'thread.started': {
        if (this.config && this.config.agentSessionId !== event.thread_id) {
          this.config = {
            ...this.config,
            agentSessionId: event.thread_id,
          };
          this.configFingerprint = JSON.stringify(this.config);
        }

        process.stderr.write(
          `[codex] Captured SDK thread ID: ${event.thread_id} for app session: ${sessionId}\n`,
        );
        emit({
          type: 'agent_session_mapping',
          app_session_id: sessionId,
          agent_kind: 'codex',
          agent_session_id: event.thread_id,
        });
        return;
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.emitItemEvent(sessionId, event.type, event.item, emitFailure);
        return;
      case 'turn.failed':
        process.stderr.write(`[codex] SDK turn failed: ${event.error.message}\n`);
        emitFailure(event.error.message);
        return;
      case 'error':
        noteStreamError(event.message);
        return;
      case 'turn.started':
      case 'turn.completed':
        return;
    }
  }

  private emitItemEvent(
    sessionId: string,
    eventType: 'item.started' | 'item.updated' | 'item.completed',
    item: ThreadItem,
    emitFailure: (message: string) => void,
  ): void {
    if (item.type === 'error' && eventType === 'item.completed') {
      process.stderr.write(`[codex] SDK item error: ${item.message}\n`);
      emitFailure(item.message);
      return;
    }

    if (item.type === 'agent_message' && eventType === 'item.completed') {
      if (item.text.trim()) {
        emit(buildAssistantEvent({
          sessionId,
          content: [{ type: 'text', text: item.text }],
        }));
      }
      return;
    }

    if (item.type === 'reasoning' && eventType === 'item.completed') {
      if (item.text.trim()) {
        emit(buildAssistantEvent({
          sessionId,
          content: [{ type: 'thinking', thinking: item.text }],
        }));
      }
      return;
    }

    const toolUse = buildCodexToolUseContent(item);
    if (toolUse && eventType === 'item.started') {
      emit(buildAssistantEvent({
        sessionId,
        content: [toolUse],
      }));
    }

    if (
      eventType === 'item.completed'
      && (item.type === 'command_execution'
        || item.type === 'mcp_tool_call'
        || item.type === 'todo_list'
        || item.type === 'web_search')
    ) {
      const result = buildCodexToolResultContent(item);
      if (result) {
        emit(buildToolResultEvent({
          sessionId,
          toolUseId: item.id,
          content: result,
        }));
      }
    }
  }

  private finishTurn(): void {
    emit({ type: 'sidecar_query_done' });
  }

  private async teardownClient(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.client = null;
  }
}
