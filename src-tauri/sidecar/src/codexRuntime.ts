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
  isCodexToolResultError,
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

export function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Current active session ID — shared with the proxy for event routing. */
export let activeSessionId = '';
export function setActiveSessionId(id: string): void {
  activeSessionId = id;
}

/**
 * Abort controller for the currently active Codex turn.
 * Set by CodexSessionRuntime.sendInput() and cleared in its finally block.
 * Exposed so the command dispatcher can interrupt immediately without waiting
 * for the stdin command loop to unblock.
 */
let activeAbortController: AbortController | null = null;

/** Abort the active Codex turn immediately. Returns true if an active turn was aborted. */
export function interruptActiveTurn(): boolean {
  if (activeAbortController && !activeAbortController.signal.aborted) {
    process.stderr.write('[codex] Aborting active turn via interruptActiveTurn\n');
    activeAbortController.abort();
    return true;
  }
  return false;
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
  private streamingItemState = new Map<string, { kind: 'text' | 'thinking'; text: string }>();

  async ensure(cmd: EnsureSessionCommand): Promise<void> {
    if (cmd.sessionId) setActiveSessionId(cmd.sessionId);
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
    if (cmd.proxyBaseUrl) {
      // Proxy already running externally (e.g. started from settings) — use it directly
      runtimeBaseUrl = cmd.proxyBaseUrl;
      process.stderr.write(
        `[codex] Using existing proxy at ${runtimeBaseUrl}\n`,
      );
    } else if (
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

    // Build Codex CLI config overrides (values must be CodexConfigValue-compatible)
    const codexConfig: Record<string, string | number | boolean | Record<string, unknown> | Record<string, unknown>[]> = {};
    if (runtimeBaseUrl) {
      codexConfig.model_provider = 'codemux_proxy';
      codexConfig.model_providers = {
        codemux_proxy: {
          name: 'CodeMUX Proxy',
          base_url: runtimeBaseUrl,
          env_key: 'OPENAI_API_KEY',
        },
      };
      codexConfig.openai_base_url = runtimeBaseUrl;
    }

    this.client = new Codex({
      env: codexEnv,
      apiKey: requestedConfig.apiKey,
      baseUrl: runtimeBaseUrl,
      config: Object.keys(codexConfig).length > 0 ? codexConfig as any : undefined,
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
    activeAbortController = this.abortController;

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

      // Safety: if abort fires but the SDK iterator doesn't close within 5s, force-break.
      let forceBreak = false;
      const onAbort = () => {
        setTimeout(() => { forceBreak = true; }, 5_000);
      };
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });

      try {
        for await (const event of events) {
          if (this.abortController?.signal.aborted || forceBreak) break;

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

          if (this.abortController?.signal.aborted || forceBreak) break;
          await this.handleSdkEvent(sessionId, event, emitFailure, noteStreamError);
        }
      } finally {
        this.abortController?.signal.removeEventListener('abort', onAbort);
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

      activeAbortController = null;
      this.abortController = null;
      this.finishTurn();
    }
  }

  async interrupt(): Promise<void> {
    process.stderr.write('[codex] Interrupt requested — tearing down client to stop agentic loop\n');
    // Abort the signal first for immediate effect on in-flight requests.
    this.abortController?.abort();
    // Emit done so the frontend clears isRunning.
    this.finishTurn();
    // Destroy the SDK client and thread to stop the agentic loop.
    // The session will be re-established on the next ensure_session call.
    await this.teardownClient();
  }

  async resetSession(sessionId: string): Promise<void> {
    process.stderr.write(`[codex] Reset session: ${sessionId}\n`);
    this.abortController?.abort();
    this.abortController = null;
    this.streamingItemState.clear();
    await this.teardownClient();
    this.config = null;
    this.configFingerprint = null;
  }

  async shutdown(): Promise<void> {
    process.stderr.write('[codex] Shutdown\n');
    this.abortController?.abort();
    this.abortController = null;
    this.streamingItemState.clear();
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
      process.stderr.write(`[codex] agent_message completed: text_length=${item.text?.length ?? 0} preview=${JSON.stringify((item.text ?? '').slice(0, 100))}\n`);
      this.completeStreamingText(sessionId, item.id);
      if (item.text.trim()) {
        emit(buildAssistantEvent({
          sessionId,
          content: [{ type: 'text', text: item.text }],
        }));
      }
      return;
    }

    if (item.type === 'agent_message' && eventType === 'item.updated') {
      this.emitStreamingTextDelta(sessionId, item.id, 'text', item.text);
      return;
    }

    if (item.type === 'reasoning' && eventType === 'item.completed') {
      this.completeStreamingText(sessionId, item.id);
      if (item.text.trim()) {
        emit(buildAssistantEvent({
          sessionId,
          content: [{ type: 'thinking', thinking: item.text }],
        }));
      }
      return;
    }

    if (item.type === 'reasoning' && eventType === 'item.updated') {
      this.emitStreamingTextDelta(sessionId, item.id, 'thinking', item.text);
      return;
    }

    const toolUse = buildCodexToolUseContent(item);
    if (eventType === 'item.started') {
      if (toolUse) {
        emit(buildAssistantEvent({
          sessionId,
          content: [toolUse],
        }));
      } else {
        process.stderr.write(`[codex] item.started with no tool_use mapping: type=${item.type} id=${item.id}\n`);
      }
    }

    if (eventType === 'item.completed') {
      if (item.type === 'command_execution'
        || item.type === 'mcp_tool_call'
        || item.type === 'todo_list'
        || item.type === 'web_search') {
        const result = buildCodexToolResultContent(item);
        if (result) {
          const isError = isCodexToolResultError(item);
          emit(buildToolResultEvent({
            sessionId,
            toolUseId: item.id,
            content: result,
            isError,
          }));
        }
      } else if (item.type !== 'agent_message' && item.type !== 'reasoning' && item.type !== 'error') {
        process.stderr.write(`[codex] item.completed with unhandled type: ${item.type} id=${item.id}\n`);
      }
    }
  }

  private finishTurn(): void {
    this.streamingItemState.clear();
    emit({ type: 'sidecar_query_done' });
  }

  private async teardownClient(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.streamingItemState.clear();
    this.thread = null;
    this.client = null;
  }

  private emitStreamingTextDelta(
    sessionId: string,
    itemId: string,
    kind: 'text' | 'thinking',
    nextText: string,
  ): void {
    const previous = this.streamingItemState.get(itemId);
    const previousText = previous?.text ?? '';
    const delta = nextText.startsWith(previousText)
      ? nextText.slice(previousText.length)
      : nextText;

    if (!previous) {
      emit({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: kind === 'thinking' ? 'thinking' : 'text',
            [kind === 'thinking' ? 'thinking' : 'text']: '',
          },
        },
      });
    }

    this.streamingItemState.set(itemId, { kind, text: nextText });

    if (!delta) {
      return;
    }

    emit({
      type: 'stream_event',
      session_id: sessionId,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: kind === 'thinking'
          ? {
              type: 'thinking_delta',
              thinking: delta,
            }
          : {
              type: 'text_delta',
              text: delta,
            },
      },
    });
  }

  private completeStreamingText(sessionId: string, itemId: string): void {
    const state = this.streamingItemState.get(itemId);
    if (!state) {
      return;
    }

    emit({
      type: 'stream_event',
      session_id: sessionId,
      event: {
        type: 'content_block_stop',
        index: 0,
      },
    });
    this.streamingItemState.delete(itemId);
  }
}
