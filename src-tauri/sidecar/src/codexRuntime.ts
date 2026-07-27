import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
} from '@openai/codex-sdk';

import type { SidecarCommand } from './types.js';
import { readLatestCodexTotalTokenUsage } from './codexSessionUsage.js';
import { CodexSessionEventTailer, type CodexSessionTailEvent } from './codexSessionEventTailer.js';
import {
  buildAssistantEvent,
  buildCodexResultEvent,
  buildCodexTodoListEvent,
  buildCodexToolResultContent,
  buildCodexToolUseContent,
  buildToolResultEvent,
  isCodexToolResultError,
} from './runtimeEvents.js';
import { shouldUseCodexChatCompatProxy } from './sessionRuntimeHelpers.js';
import { proxyManager } from './proxyManager.js';
import { emit } from './streamEventBatcher.js';
import { ensureWorkingDirectory } from './defaultWorkingDirectory.js';
import {
  buildCodexInputEntries,
  cleanupTempImageFiles,
  isImageUnsupportedError,
  normalizeAgentInputPayload,
  writePayloadImagesToTempFiles,
  type AgentInputPayload,
} from './agentInputPayload.js';
import {
  buildCodexThreadPermissionOptions,
  describeCodexPermissionOptions,
  type AgentPlanMode,
  type SidecarPermissionConfig,
} from './agentPermissions.js';
import {
  resolveActiveCodexPlanMode,
  setActivePermissionState,
} from './activePermissionState.js';
import {
  applyCodexCollaborationPolicyToInput,
  buildPlanMutationBlockedEvent,
  resolveCodexCollaborationPolicy,
  setActiveCodexCollaborationPolicy,
  shouldBlockPlanModeItem,
  type CodexCollaborationPolicy,
} from './codexCollaborationPolicy.js';
import { setLogCtx, writeLog } from './writeLog.js';

export { emit } from './streamEventBatcher.js';

type EnsureSessionCommand = Extract<SidecarCommand, { type: 'ensure_session' }>;
type UpdatePermissionsCommand = Extract<SidecarCommand, { type: 'update_permissions' }>;
const DEFAULT_SHELL_COMMAND_TIMEOUT_MS = 10000;

// Gate per-event stderr logs for debugging. Enable with CODEMUX_CODEX_DEBUG=1.
const CODEX_DEBUG_LOGS = process.env.CODEMUX_CODEX_DEBUG === '1';

type CodexSessionBootstrap = {
  sessionId?: string;
  agentSessionId?: string;
  cwd: string;
  apiKey?: string;
  upstreamBaseUrl?: string;
  runtimeBaseUrl?: string;
  usesCompatProxy?: boolean;
  model?: string;
  reasoningEffort?: string;
  codexNeedsProxy?: boolean;
  permissionConfig?: SidecarPermissionConfig;
  planMode?: AgentPlanMode;
  collaborationPolicy?: CodexCollaborationPolicy;
};

type UsageBaseline = {
  threadId: string;
  usage: Usage;
};

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

function normalizeUsage(usage: Partial<Usage>): Usage {
  return {
    input_tokens: readUsageNumber(usage.input_tokens),
    cached_input_tokens: readUsageNumber(usage.cached_input_tokens),
    output_tokens: readUsageNumber(usage.output_tokens),
    reasoning_output_tokens: readUsageNumber(usage.reasoning_output_tokens),
  };
}

function subtractUsage(current: Usage, previous: Usage): Usage {
  return {
    input_tokens: subtractUsageNumber(current.input_tokens, previous.input_tokens),
    cached_input_tokens: subtractUsageNumber(current.cached_input_tokens, previous.cached_input_tokens),
    output_tokens: subtractUsageNumber(current.output_tokens, previous.output_tokens),
    reasoning_output_tokens: subtractUsageNumber(current.reasoning_output_tokens, previous.reasoning_output_tokens),
  };
}

function subtractUsageNumber(current: number, previous: number): number {
  return Math.max(0, readUsageNumber(current) - readUsageNumber(previous));
}

function readUsageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatUsageForDebug(usage: Partial<Usage> | null): string {
  if (!usage) {
    return 'null';
  }

  const normalized = normalizeUsage(usage);
  const totalTokens = normalized.input_tokens + normalized.output_tokens;
  return JSON.stringify({
    input_tokens: normalized.input_tokens,
    cached_input_tokens: normalized.cached_input_tokens,
    output_tokens: normalized.output_tokens,
    reasoning_output_tokens: normalized.reasoning_output_tokens,
    total_tokens: totalTokens,
  });
}

export class CodexSessionRuntime {
  private config: CodexSessionBootstrap | null = null;
  private configFingerprint: string | null = null;
  private abortController: AbortController | null = null;
  private client: Codex | null = null;
  private thread: Thread | null = null;
  private streamingItemState = new Map<string, { kind: 'text' | 'thinking'; text: string }>();
  private todoListState = new Map<string, string>();
  private emittedToolUseIds = new Set<string>();
  private emittedToolResultIds = new Set<string>();
  private nativeSessionEventTailer: CodexSessionEventTailer | null = null;
  private nativeSessionEventTailerTimer: ReturnType<typeof setInterval> | null = null;
  private nativeSessionEventTailerThreadId: string | null = null;
  private blockedPlanMutationItemIds = new Set<string>();
  private activeCompactItemIds = new Set<string>();
  private emittedCompactItemIds = new Set<string>();
  private previousTotalUsage: UsageBaseline | null = null;

  async ensure(cmd: EnsureSessionCommand): Promise<void> {
    if (cmd.sessionId) {
      setActiveSessionId(cmd.sessionId);
      setLogCtx({ sessionId: cmd.sessionId });
    }
    const cwd = ensureWorkingDirectory(cmd.cwd);
    const requestedConfig = {
      sessionId: cmd.sessionId,
      agentSessionId: cmd.agentSessionId,
      cwd,
      apiKey: cmd.apiKey,
      upstreamBaseUrl: cmd.baseUrl,
      model: cmd.model,
      reasoningEffort: normalizeCodexReasoningEffort(cmd.reasoningEffort),
      codexNeedsProxy: cmd.codexNeedsProxy,
      permissionConfig: cmd.permissionConfig,
      planMode: normalizeCodexPlanMode(cmd.planMode),
    };
    const collaborationPolicy = resolveCodexCollaborationPolicy({
      planMode: requestedConfig.planMode,
      permissionConfig: requestedConfig.permissionConfig,
      previousMode: this.config?.collaborationPolicy?.effectiveMode ?? null,
    });
    const nextFingerprint = JSON.stringify(requestedConfig);

    if (this.configFingerprint === nextFingerprint && this.config && this.thread) {
      this.applyActivePermissionState({
        sessionId: requestedConfig.sessionId,
        permissionConfig: requestedConfig.permissionConfig,
        planMode: requestedConfig.planMode,
        collaborationPolicy: this.config.collaborationPolicy ?? collaborationPolicy,
      });
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
    let usesCompatProxy = false;
    // Always go through proxyManager — it checks fingerprint and restarts
    // the proxy when the upstream config (apiKey/baseUrl) changes.
    if (
      requestedConfig.apiKey &&
      requestedConfig.upstreamBaseUrl &&
      shouldRouteCodexThroughCompatProxy(
        requestedConfig.upstreamBaseUrl,
        requestedConfig.codexNeedsProxy,
        collaborationPolicy,
      )
    ) {
      const result = await proxyManager.start(
        requestedConfig.apiKey,
        requestedConfig.upstreamBaseUrl,
        undefined,
        resolveCompatProxyOverride(requestedConfig.codexNeedsProxy, collaborationPolicy),
      );
      if (result) {
        runtimeBaseUrl = proxyManager.getBaseUrl() ?? runtimeBaseUrl;
        usesCompatProxy = true;
        process.stderr.write(
          `[codex] Using chat-compat proxy upstream=${requestedConfig.upstreamBaseUrl} local=${runtimeBaseUrl}\n`,
        );
      }
    }

    this.config = {
      ...requestedConfig,
      runtimeBaseUrl,
      usesCompatProxy,
      collaborationPolicy,
    };
    this.applyActivePermissionState({
      sessionId: requestedConfig.sessionId,
      permissionConfig: requestedConfig.permissionConfig,
      planMode: requestedConfig.planMode,
      collaborationPolicy,
    });

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
    applyCodexWindowsSandboxPathCompatibility(codexEnv);

    const codexConfig = buildCodexCliConfig(runtimeBaseUrl);

    this.client = new Codex({
      env: codexEnv,
      apiKey: requestedConfig.apiKey,
      baseUrl: runtimeBaseUrl,
      config: Object.keys(codexConfig).length > 0 ? codexConfig as any : undefined,
    });
    process.stderr.write(
      `[codex] SDK client configured with baseUrl=${runtimeBaseUrl || 'default'} env.OPENAI_BASE_URL=${codexEnv.OPENAI_BASE_URL || 'unset'}\n`,
    );
    this.thread = requestedConfig.agentSessionId
      ? this.client.resumeThread(requestedConfig.agentSessionId, this.threadOptions())
      : this.client.startThread(this.threadOptions());
    this.previousTotalUsage = requestedConfig.agentSessionId
      ? await this.readRestoredTotalUsageBaseline(requestedConfig.agentSessionId)
      : null;

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

  updatePermissions(cmd: UpdatePermissionsCommand): void {
    const planMode = normalizeCodexPlanMode(cmd.planMode) ?? this.config?.planMode ?? 'off';
    const collaborationPolicy = resolveCodexCollaborationPolicy({
      planMode,
      permissionConfig: cmd.permissionConfig,
      previousMode: this.config?.collaborationPolicy?.effectiveMode ?? null,
    });

    if (cmd.sessionId) {
      setActiveSessionId(cmd.sessionId);
    }

    if (this.config) {
      this.config = {
        ...this.config,
        sessionId: cmd.sessionId ?? this.config.sessionId,
        permissionConfig: cmd.permissionConfig,
        planMode,
        collaborationPolicy,
      };
    }

    this.applyActivePermissionState({
      sessionId: cmd.sessionId ?? this.config?.sessionId,
      permissionConfig: cmd.permissionConfig,
      planMode,
      collaborationPolicy,
    });
    process.stderr.write(
      `[codex] Runtime permissions updated: session_id=${cmd.sessionId || this.config?.sessionId || 'none'} plan_mode=${planMode} effective_mode=${collaborationPolicy.effectiveMode}\n`,
    );
  }

  async sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void> {
    try {
      await this.runInput(prompt, inputPayload, true);
    } catch (error) {
      if (!isImageUnsupportedError(error)) {
        throw error;
      }

      emit({
        type: 'vision_unsupported',
        model: this.config?.model || 'o4-mini',
        message: String(error),
      });
      process.stderr.write(`[codex] Vision payload unsupported; retrying text-only: ${String(error)}\n`);
      activeAbortController = null;
      this.abortController = null;
      await this.runInput(prompt, inputPayload, false);
    }
  }

  private async runInput(prompt: string, inputPayload: AgentInputPayload | undefined, includeImages: boolean): Promise<void> {
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
    let retryingWithoutImages = false;
    let completedAssistantMessageSeen = false;
    const completedTurnUsages: Usage[] = [];

    this.abortController = new AbortController();
    activeAbortController = this.abortController;

    if (this.config.agentSessionId && !this.config.usesCompatProxy) {
      await this.startNativeSessionEventTailer(sessionId, this.config.agentSessionId, true);
    }

    const collaborationPolicy = this.config.collaborationPolicy
      ?? resolveCodexCollaborationPolicy({
        planMode: this.config.planMode,
        permissionConfig: this.config.permissionConfig,
      });
    const payload = normalizeAgentInputPayload(prompt, inputPayload);
    const imagePaths = includeImages ? await writePayloadImagesToTempFiles(payload) : [];
    const permissionOptions = buildCodexThreadPermissionOptions(
      this.config.permissionConfig,
      agentPlanModeFromCollaborationPolicy(collaborationPolicy),
    );

    process.stderr.write(`[codex] Processing input via SDK: ${payload.text.slice(0, 80)}...\n`);
    writeLog('[codex-task]', `sendInput START model=${model} prompt_preview=${payload.text.slice(0, 120)} includeImages=${includeImages}`);

    emit({
      type: 'system',
      subtype: 'init',
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      model,
      cwd: this.config.cwd,
      tools: [],
      permissionMode: describeCodexPermissionOptions(permissionOptions),
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
      const codexInput = applyCodexCollaborationPolicyToInput(
        buildCodexInputEntries(payload, imagePaths, includeImages) as unknown[],
        collaborationPolicy,
      );
      const { events } = await this.thread.runStreamed(codexInput as any, {
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
          if (CODEX_DEBUG_LOGS) {
            const eventPreview = (() => { try { return JSON.stringify(event).slice(0, 2000) } catch { return String(event).slice(0, 2000) } })();
            process.stderr.write(`[codex-debug] handleSdkEvent type=${event.type} preview=${eventPreview}\n`);
          }
          if (this.abortController?.signal.aborted || forceBreak) break;

          if (event.type === 'turn.completed') {
            usage = event.usage;
            const normalizedUsage = normalizeUsage(event.usage);
            completedTurnUsages.push(normalizedUsage);
            process.stderr.write(
              `[codex][usage] turn.completed session=${sessionId || 'none'} thread=${this.thread.id ?? this.config.agentSessionId ?? 'unknown'} index=${completedTurnUsages.length} usage=${formatUsageForDebug(normalizedUsage)}\n`,
            );
            usageSeen = true;
            turnCompleted = true;
            continue;
          }

          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            completedAssistantMessageSeen = true;
          }

          if (this.abortController?.signal.aborted || forceBreak) break;
          await this.handleSdkEvent(sessionId, event, emitFailure, noteStreamError);
        }
        if (CODEX_DEBUG_LOGS) {
          process.stderr.write(`[codex-debug] event stream ended sessionId=${sessionId}\n`);
        }
      } finally {
        this.abortController?.signal.removeEventListener('abort', onAbort);
      }
    } catch (error) {
      if (includeImages && isImageUnsupportedError(error)) {
        retryingWithoutImages = true;
        throw error;
      }
      if (!this.abortController?.signal.aborted) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = error instanceof Error
          ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
          : rawMessage;
        if (completedAssistantMessageSeen && isMissingResponsesCompletionError(rawMessage)) {
          process.stderr.write(`[codex] SDK stream closed after completed assistant message; treating as completed: ${rawMessage}\n`);
          turnCompleted = true;
        } else {
          process.stderr.write(`[codex] SDK turn failed before completion: ${message}\n`);
          emitFailure(message);
        }
      } else {
        process.stderr.write('[codex] SDK turn aborted\n');
      }
    } finally {
      if (!retryingWithoutImages && !this.abortController?.signal.aborted && !turnCompleted && !turnFailed && pendingStreamError) {
        emitFailure(pendingStreamError);
      }

      const finalUsage = usageSeen ? usage : emptyUsage();
      if (!retryingWithoutImages && !this.abortController?.signal.aborted && turnCompleted && !turnFailed) {
        const threadId = this.thread.id ?? this.config.agentSessionId ?? sessionId;
        const lastTokenUsage = this.calculateLiveTurnUsage(threadId, completedTurnUsages, finalUsage);
        emit(buildCodexResultEvent({
          sessionId,
          usage: finalUsage,
          lastTokenUsage,
          durationMs: Date.now() - startedAt,
        }));
      } else if (!retryingWithoutImages && !this.abortController?.signal.aborted) {
        process.stderr.write(
          `[codex] Skipping success result: completed=${turnCompleted} failed=${turnFailed}\n`,
        );
      }

      // Lifecycle log — capture state before cleanup nulls abortController
      if (!retryingWithoutImages) {
        if (this.abortController?.signal.aborted) {
          writeLog('[codex-task]', 'sendInput ABORT');
        } else if (turnFailed) {
          writeLog('[codex-task]', 'sendInput FAILED');
        } else if (turnCompleted) {
          writeLog('[codex-task]', 'sendInput COMPLETE');
        } else {
          writeLog('[codex-task]', `sendInput ENDED completed=${turnCompleted} failed=${turnFailed}`);
        }
      }

      activeAbortController = null;
      this.abortController = null;
      await cleanupTempImageFiles(imagePaths);
      if (!retryingWithoutImages) {
        await this.finishTurn();
      }
    }
  }

  async interrupt(): Promise<void> {
    process.stderr.write('[codex] Interrupt requested — tearing down client to stop agentic loop\n');
    // Abort the signal first for immediate effect on in-flight requests.
    this.abortController?.abort();
    // Emit done so the frontend clears isRunning.
    await this.finishTurn();
    // Destroy the SDK client and thread to stop the agentic loop.
    // The session will be re-established on the next ensure_session call.
    await this.teardownClient();
  }

  async resetSession(sessionId: string): Promise<void> {
    process.stderr.write(`[codex] Reset session: ${sessionId}\n`);
    this.abortController?.abort();
    this.abortController = null;
    this.streamingItemState.clear();
    this.todoListState.clear();
    this.emittedToolUseIds.clear();
    this.blockedPlanMutationItemIds.clear();
    this.activeCompactItemIds.clear();
    this.emittedCompactItemIds.clear();
    await this.teardownClient();
    this.config = null;
    this.configFingerprint = null;
  }

  async shutdown(): Promise<void> {
    process.stderr.write('[codex] Shutdown\n');
    this.abortController?.abort();
    this.abortController = null;
    this.streamingItemState.clear();
    this.todoListState.clear();
    this.emittedToolUseIds.clear();
    this.blockedPlanMutationItemIds.clear();
    this.activeCompactItemIds.clear();
    this.emittedCompactItemIds.clear();
    await this.teardownClient();
    this.config = null;
    this.configFingerprint = null;
  }

  private threadOptions() {
    if (!this.config) {
      throw new Error('Missing Codex config');
    }

    const permissionOptions = buildCodexThreadPermissionOptions(
      this.config.permissionConfig,
      agentPlanModeFromCollaborationPolicy(
        this.config.collaborationPolicy ?? resolveCodexCollaborationPolicy({
          planMode: this.config.planMode,
          permissionConfig: this.config.permissionConfig,
        }),
      ),
    );

    return {
      model: this.config.model,
      workingDirectory: this.config.cwd,
      skipGitRepoCheck: true,
      sandboxMode: permissionOptions.sandboxMode,
      approvalPolicy: permissionOptions.approvalPolicy,
      networkAccessEnabled: permissionOptions.networkAccessEnabled,
      ...(this.config.reasoningEffort ? { modelReasoningEffort: this.config.reasoningEffort as any } : {}),
    };
  }

  private applyActivePermissionState(input: {
    sessionId?: string;
    permissionConfig?: SidecarPermissionConfig;
    planMode?: AgentPlanMode;
    collaborationPolicy: CodexCollaborationPolicy;
  }): void {
    setActivePermissionState({
      sessionId: input.sessionId,
      agentKind: 'codex',
      permissionConfig: input.permissionConfig,
      planMode: input.planMode,
    });
    setActiveCodexCollaborationPolicy(input.collaborationPolicy);
  }

  private async handleSdkEvent(
    sessionId: string,
    event: ThreadEvent,
    emitFailure: (message: string) => void,
    noteStreamError: (message: string) => void,
  ): Promise<void> {
    const eventItem = (event as { item?: { id?: unknown } }).item;
    const itemId = typeof eventItem?.id === 'string' ? eventItem.id : undefined;
    if (itemId) {
      setLogCtx({ sessionId, messageId: itemId });
    }
    if (this.handleLiveCodexCompactEvent(sessionId, event)) {
      return;
    }

    // Codex SDK 0.139.0 exposes tool execution items and sandbox/approval policy
    // options, but this codebase has not observed a stable interactive approval
    // event shape. Approval-like unknown event types are surfaced as diagnostics
    // instead of being auto-allowed.
    switch (event.type) {
      case 'thread.started': {
        if (this.config && this.config.agentSessionId !== event.thread_id) {
          this.config = {
            ...this.config,
            agentSessionId: event.thread_id,
          };
          this.configFingerprint = JSON.stringify(this.config);
          this.previousTotalUsage = null;
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
        await this.startNativeSessionEventTailer(sessionId, event.thread_id, false);
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
        // Forward stream errors (e.g. "Reconnecting...") as structured events
        // so the UI can display status instead of only logging to stderr.
        emit({
          type: 'sidecar_stream_status',
          message: event.message,
          is_reconnecting: event.message.includes('Reconnecting'),
        });
        return;
      case 'turn.started':
      case 'turn.completed':
        return;
      default: {
        const unknownEvent = event as { type?: string };
        if (typeof unknownEvent.type === 'string' && unknownEvent.type.toLowerCase().includes('approval')) {
          emit({
            type: 'sidecar_stream_status',
            message: `Codex emitted unsupported approval event type: ${unknownEvent.type}`,
            is_reconnecting: false,
          });
        }
        return;
      }
    }
  }

  private async readRestoredTotalUsageBaseline(threadId: string): Promise<UsageBaseline | null> {
    const usage = await readLatestCodexTotalTokenUsage(threadId).catch((error) => {
      process.stderr.write(`[codex] Failed to read restored session total_token_usage: ${String(error)}\n`);
      return null;
    });

    process.stderr.write(
      `[codex][usage] restored baseline thread=${threadId} usage=${formatUsageForDebug(usage)}\n`,
    );
    return usage ? { threadId, usage: normalizeUsage(usage) } : null;
  }

  private calculateLiveTurnUsage(
    threadId: string,
    completedTurnUsages: Usage[],
    fallbackUsage: Usage,
  ): Usage {
    const current = normalizeUsage(completedTurnUsages.at(-1) ?? fallbackUsage);
    const previousSource = completedTurnUsages.length >= 2
      ? 'stream_previous_turn_completed'
      : this.previousTotalUsage?.threadId === threadId
        ? 'stored_previous_total'
        : 'none';
    const previous = completedTurnUsages.length >= 2
      ? normalizeUsage(completedTurnUsages[completedTurnUsages.length - 2])
      : this.previousTotalUsage?.threadId === threadId
        ? this.previousTotalUsage.usage
        : null;
    const turnUsage = previous ? subtractUsage(current, previous) : current;
    process.stderr.write(
      `[codex][usage] live calculation thread=${threadId} completed_events=${completedTurnUsages.length} previous_source=${previousSource} current=${formatUsageForDebug(current)} previous=${formatUsageForDebug(previous)} delta=${formatUsageForDebug(turnUsage)}\n`,
    );
    this.previousTotalUsage = { threadId, usage: current };
    return turnUsage;
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

    const collaborationPolicy = this.config?.collaborationPolicy
      ?? resolveCodexCollaborationPolicy({
        planMode: this.config?.planMode,
        permissionConfig: this.config?.permissionConfig,
      });
    const activePlanMode = resolveActiveCodexPlanMode(sessionId);
    const effectiveCollaborationPolicy = activePlanMode
      ? resolveCodexCollaborationPolicy({
        planMode: activePlanMode,
        permissionConfig: this.config?.permissionConfig,
      })
      : collaborationPolicy;
    const blockedMethod = shouldBlockPlanModeItem(item, effectiveCollaborationPolicy);
    if (blockedMethod) {
      if (!this.blockedPlanMutationItemIds.has(item.id)) {
        this.blockedPlanMutationItemIds.add(item.id);
        emit(buildPlanMutationBlockedEvent(blockedMethod, item.id ?? null));
      }
      return;
    }

    if (item.type === 'agent_message' && eventType === 'item.completed') {
      process.stderr.write(`[codex] agent_message completed: text_length=${item.text?.length ?? 0} preview=${JSON.stringify((item.text ?? '').slice(0, 100))}\n`);
      this.completeStreamingText(sessionId, item.id);
      if (isCodexCompactSummaryText(item.text)) {
        process.stderr.write(`[codex][compact-summary-filtered] event=item.completed item_id=${item.id}\n`);
        return;
      }
      if (item.text.trim()) {
        emit(buildAssistantEvent({
          sessionId,
          content: [{ type: 'text', text: item.text }],
        }));
      }
      return;
    }

    if (item.type === 'agent_message' && eventType === 'item.updated') {
      if (isCodexCompactSummaryText(item.text)) {
        process.stderr.write(`[codex][compact-summary-filtered] event=item.updated item_id=${item.id}\n`);
        this.completeStreamingText(sessionId, item.id);
        return;
      }
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

    if (item.type === 'todo_list') {
      const todoEvent = buildCodexTodoListEvent({ sessionId, item });
      const nextState = JSON.stringify(todoEvent.todos);
      if (this.todoListState.get(item.id) !== nextState) {
        this.todoListState.set(item.id, nextState);
        emit(todoEvent);
      }
      return;
    }

    const toolUse = buildCodexToolUseContent(item, {
      workdir: this.config?.cwd,
      timeoutMs: item.type === 'command_execution' ? DEFAULT_SHELL_COMMAND_TIMEOUT_MS : undefined,
    });
    if (eventType === 'item.started') {
      if (toolUse) {
        if (this.emittedToolUseIds.has(item.id)) {
          return;
        }
        this.emittedToolUseIds.add(item.id);
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
        || item.type === 'file_change'
        || item.type === 'web_search') {
        if (item.type === 'file_change' && toolUse && !this.emittedToolUseIds.has(item.id)) {
          this.emittedToolUseIds.add(item.id);
          emit(buildAssistantEvent({
            sessionId,
            content: [toolUse],
          }));
        }
        const result = buildCodexToolResultContent(item);
        if (result) {
          const isError = isCodexToolResultError(item);
          if (this.emittedToolResultIds.has(item.id)) {
            return;
          }
          this.emittedToolResultIds.add(item.id);
          emit(buildToolResultEvent({
            sessionId,
            toolUseId: item.id,
            content: result,
            isError,
          }));
        }
      } else {
        const unhandledItem = item as { type: string; id?: string };
        if (unhandledItem.type !== 'agent_message' && unhandledItem.type !== 'reasoning' && unhandledItem.type !== 'error') {
          process.stderr.write(`[codex] item.completed with unhandled type: ${unhandledItem.type} id=${unhandledItem.id ?? 'unknown'}\n`);
        }
      }
    }
  }

  private async startNativeSessionEventTailer(
    sessionId: string,
    threadId: string,
    skipExisting: boolean,
  ): Promise<void> {
    if (this.config?.usesCompatProxy || this.nativeSessionEventTailerThreadId === threadId) {
      return;
    }

    this.stopNativeSessionEventTailer();
    const tailer = new CodexSessionEventTailer({
      threadId,
      skipExisting,
      onEvent: (event) => this.handleNativeSessionTailEvent(sessionId, event),
    });
    this.nativeSessionEventTailer = tailer;
    this.nativeSessionEventTailerThreadId = threadId;
    await tailer.start();
    this.nativeSessionEventTailerTimer = setInterval(() => {
      void tailer.pollOnce().catch((error) => {
        process.stderr.write(`[codex] Failed to tail native session events: ${String(error)}\n`);
      });
    }, 100);
    this.nativeSessionEventTailerTimer.unref?.();
  }

  private stopNativeSessionEventTailer(): void {
    if (this.nativeSessionEventTailerTimer) {
      clearInterval(this.nativeSessionEventTailerTimer);
    }
    this.nativeSessionEventTailer = null;
    this.nativeSessionEventTailerTimer = null;
    this.nativeSessionEventTailerThreadId = null;
  }

  private async flushAndStopNativeSessionEventTailer(): Promise<void> {
    const tailer = this.nativeSessionEventTailer;
    if (tailer) {
      try {
        await tailer.pollOnce();
      } catch (error) {
        process.stderr.write(`[codex] Failed to flush native session events: ${String(error)}\n`);
      }
    }
    this.stopNativeSessionEventTailer();
  }

  private handleNativeSessionTailEvent(sessionId: string, event: CodexSessionTailEvent): void {
    if (event.type === 'tool_use') {
      if (this.emittedToolUseIds.has(event.id)) {
        return;
      }
      this.emittedToolUseIds.add(event.id);
      emit(buildAssistantEvent({
        sessionId,
        content: [{ type: 'tool_use', id: event.id, name: event.name, input: event.input }],
      }));
      return;
    }

    if (this.emittedToolResultIds.has(event.toolUseId)) {
      return;
    }
    this.emittedToolResultIds.add(event.toolUseId);
    emit(buildToolResultEvent({
      sessionId,
      toolUseId: event.toolUseId,
      content: event.content,
      isError: event.isError,
    }));
  }
  private async finishTurn(): Promise<void> {
    await this.flushAndStopNativeSessionEventTailer();
    this.streamingItemState.clear();
    this.emittedToolUseIds.clear();
    this.emittedToolResultIds.clear();
    this.blockedPlanMutationItemIds.clear();
    this.activeCompactItemIds.clear();
    emit({ type: 'sidecar_query_done' });
  }

  private async teardownClient(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.streamingItemState.clear();
    this.todoListState.clear();
    this.emittedToolUseIds.clear();
    this.emittedToolResultIds.clear();
    await this.flushAndStopNativeSessionEventTailer();
    this.blockedPlanMutationItemIds.clear();
    this.activeCompactItemIds.clear();
    this.emittedCompactItemIds.clear();
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

  private handleLiveCodexCompactEvent(sessionId: string, event: ThreadEvent): boolean {
    const rawEvent = event as unknown as Record<string, unknown>;
    const compactEvent = parseLiveCodexCompactEvent(rawEvent);
    if (!compactEvent) {
      return false;
    }

    process.stderr.write(`[codex][compact-detected] phase=${compactEvent.phase} item_id=${compactEvent.itemId ?? 'none'}\n`);

    if (compactEvent.itemId && compactEvent.phase === 'started') {
      this.activeCompactItemIds.add(compactEvent.itemId);
      return true;
    }

    if (compactEvent.itemId) {
      if (this.emittedCompactItemIds.has(compactEvent.itemId)) {
        return true;
      }
      this.activeCompactItemIds.delete(compactEvent.itemId);
      this.emittedCompactItemIds.add(compactEvent.itemId);
    }

    emit(buildLiveCodexCompactBoundaryEvent(sessionId, compactEvent));
    return true;
  }
}

type LiveCodexCompactEvent = {
  phase: 'started' | 'completed';
  itemId?: string;
  timestamp?: unknown;
  payload: Record<string, unknown>;
};

function parseLiveCodexCompactEvent(rawEvent: Record<string, unknown>): LiveCodexCompactEvent | null {
  if (rawEvent.type === 'compacted') {
    return {
      phase: 'completed',
      timestamp: rawEvent.timestamp,
      payload: isRecord(rawEvent.payload) ? rawEvent.payload : {},
    };
  }

  const item = isRecord(rawEvent.item) ? rawEvent.item : undefined;
  if (
    (rawEvent.type === 'item.started' || rawEvent.type === 'item.completed')
    && item
    && isCodexCompactItemType(item.type)
  ) {
    return {
      phase: rawEvent.type === 'item.started' ? 'started' : 'completed',
      itemId: typeof item.id === 'string' ? item.id : undefined,
      timestamp: rawEvent.timestamp,
      payload: item,
    };
  }

  const payload = isRecord(rawEvent.payload) ? rawEvent.payload : undefined;
  if (rawEvent.type === 'event_msg' && payload && isCodexCompactItemType(payload.type)) {
    return {
      phase: 'completed',
      timestamp: rawEvent.timestamp,
      itemId: typeof payload.id === 'string' ? payload.id : undefined,
      payload,
    };
  }

  return null;
}

function buildLiveCodexCompactBoundaryEvent(sessionId: string, compactEvent: LiveCodexCompactEvent): Record<string, unknown> {
  const payload = compactEvent.payload;
  const trigger = payload.trigger === 'manual' ? 'manual' : 'auto';
  const preTokens = readFiniteNumber(payload.pre_tokens) ?? readFiniteNumber(payload.preTokens) ?? 0;
  const postTokens = readFiniteNumber(payload.post_tokens) ?? readFiniteNumber(payload.postTokens) ?? 0;

  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    ...(compactEvent.timestamp !== undefined ? { timestamp: compactEvent.timestamp } : {}),
    session_id: sessionId,
    compact_metadata: {
      trigger,
      pre_tokens: preTokens,
      post_tokens: postTokens,
    },
  };
}

function isCodexCompactItemType(value: unknown): boolean {
  return value === 'contextCompaction'
    || value === 'context_compaction'
    || value === 'context_compacted';
}

function isCodexCompactSummaryText(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const text = value.trimStart();
  return text.startsWith('Another language model started to solve this problem and produced a summary')
    || text.startsWith('This session is being continued from a previous conversation that ran out of context.');
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCodexReasoningEffort(value: unknown): 'low' | 'medium' | 'high' | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function normalizeCodexPlanMode(value: unknown): AgentPlanMode | undefined {
  if (value === 'on' || value === 'off') {
    return value;
  }
  return undefined;
}

function agentPlanModeFromCollaborationPolicy(policy: CodexCollaborationPolicy): AgentPlanMode {
  return policy.effectiveMode === 'plan' ? 'on' : 'off';
}

export function buildCodexCliConfig(
  runtimeBaseUrl: string | undefined,
): Record<string, string | Record<string, unknown>> {
  if (!runtimeBaseUrl) return {};

  const providerBaseUrl = normalizeCodexResponsesProviderBaseUrl(runtimeBaseUrl);
  return {
    model_provider: 'codemux_proxy',
    model_providers: {
      codemux_proxy: {
        name: 'CodeMUX Proxy',
        base_url: providerBaseUrl,
        env_key: 'OPENAI_API_KEY',
        wire_api: 'responses',
        requires_openai_auth: true,
      },
    },
    openai_base_url: runtimeBaseUrl,
  };
}

function normalizeCodexResponsesProviderBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function shouldRouteCodexThroughCompatProxy(
  baseUrl: string | undefined,
  explicitNeedsProxy: boolean | undefined,
  collaborationPolicy: CodexCollaborationPolicy,
): boolean {
  return shouldUseCodexChatCompatProxy(
    baseUrl,
    resolveCompatProxyOverride(explicitNeedsProxy, collaborationPolicy),
  );
}

function resolveCompatProxyOverride(
  explicitNeedsProxy: boolean | undefined,
  collaborationPolicy: CodexCollaborationPolicy,
): boolean | undefined {
  if (collaborationPolicy.effectiveMode === 'plan') {
    return true;
  }
  return explicitNeedsProxy;
}

export function applyCodexWindowsSandboxPathCompatibility(env: Record<string, string>): void {
  if (process.platform !== 'win32') {
    return;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  const pathValue = env[pathKey];
  if (!pathValue) {
    return;
  }

  const filtered = pathValue
    .split(';')
    .filter((entry) => entry.trim().length > 0)
    .filter((entry) => !entry.toLowerCase().includes('\\windowsapps'))
    .join(';');

  if (filtered) {
    env[pathKey] = filtered;
  }
}

function isMissingResponsesCompletionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('stream closed before response.completed')
    || normalized.includes('stream disconnected before completion');
}
