import { normalizeAgentInputPayload, type AgentInputPayload } from './agentInputPayload.js';
import { emit } from './streamEventBatcher.js';
import { OpenCodePermissionRegistry, type OpenCodePermissionResponse } from './opencodePermissions.js';
import { buildToolResultEvent } from './runtimeEvents.js';
import { extractOpenCodeUsageUpdate, mergeOpenCodeUsage, getOpenCodeEventIdentity, isOpenCodeSessionScopedEvent, getOpenCodeEventSessionId, getOpenCodePayloadKey, getOpenCodeToolId, getOpenCodeToolStatus, toCodeMuxEvent } from './opencodeEvents.js';
import type { OpenCodeEventSubscription, OpenCodePermissionUpdate } from './opencodeSdk.js';
import type { AgentPlanMode, SidecarPermissionConfig } from './agentPermissions.js';
import type { OpenCodeSessionConfig, OpenCodeSessionMapping } from './types.js';
import {
  closeOpenCodeServerWithTimeout,
  mapOpenCodeImages,
  officialOpenCodeSdkPort,
  type OpenCodeClientPort,
  type OpenCodeSdkPort,
  type OpenCodeSdkReadyResources,
  type OpenCodeSdkStartFailure,
  type OpenCodeSdkStartResources,
  type OpenCodeServerHandle,
} from './opencodeSdk.js';
import { setLogCtx, writeLog } from './writeLog.js';

type RuntimeState = 'idle' | 'starting' | 'started' | 'disposing' | 'cleanup_failed' | 'disposed';

export const DEFAULT_ACTIVE_TASK_TIMEOUT_MS = 30_000;
export const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;
export const DEFAULT_SERVER_CLOSE_TIMEOUT_MS = 10_000;
const MAX_SEEN_EVENT_IDS = 2_048;
const MAX_SEEN_PAYLOAD_KEYS = 2_048;
const MAX_SEEN_PAYLOAD_CACHE_BYTES = 512 * 1024;

export interface OpenCodeRuntimeOptions {
  activeTaskTimeoutMs?: number;
  promptTimeoutMs?: number;
  serverCloseTimeoutMs?: number;
  agentId?: string;
  emitEvent?: (event: unknown) => void;
  eventIdFactory?: () => string;
  permissionTimeoutMs?: number;
  nativeResponseTimeoutMs?: number;
}

export class OpenCodeRuntime {
  private readonly config: OpenCodeSessionConfig;
  private readonly sdk: OpenCodeSdkPort;
  private readonly activeTaskTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly serverCloseTimeoutMs: number;
  private readonly agentId: string;
  private readonly emitEvent: (event: unknown) => void;
  private readonly eventIdFactory: () => string;
  readonly permissions: OpenCodePermissionRegistry;
  private server: OpenCodeServerHandle | undefined;
  private client: OpenCodeClientPort | undefined;
  private agentSessionId: string | undefined;
  private activeTask: Promise<void> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private startPromise: Promise<OpenCodeSessionMapping> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private state: RuntimeState = 'idle';
  private eventSubscription: OpenCodeEventSubscription | undefined;
  private readonly seenEventIds = new Map<string, true>();
  private readonly seenPayloadKeys = new Map<string, true>();
  private seenPayloadKeyBytes = 0;
  private readonly terminalSessionIds = new Set<string>();
  private readonly terminalToolIds = new Set<string>();
  private readonly pendingQuestionIds = new Set<string>();
  private pendingTurnCompletion: { resolve: () => void; reject: (reason: unknown) => void; sessionId: string } | undefined;
  private readonly pendingTaskToolCallIds = new Set<string>();
  private readonly assistantMessageIds = new Set<string>();
  private readonly userMessageIds = new Set<string>();
  private readonly streamingParts = new Map<string, import('./opencodeEvents.js').StreamingPartState>();
  private readonly nextSection: { kind: import('./opencodeEvents.js').NextSectionKind } = { kind: 'idle' };
  private readonly idleStreamKind: { kind: 'thinking' | 'text' } = { kind: 'thinking' };
  private eventSequence = 0;
  private usage: import('./runtimeEvents.js').OpenCodeTokenUsage = { input_tokens: 0, output_tokens: 0 };
  private turnStartedAt = 0;
  private turnId = 0;
  private permissionCancellationEpoch = 0;
  private permissionClosing = false;
  private permissionConfig: SidecarPermissionConfig | undefined;
  private planMode: AgentPlanMode = 'off';

  constructor(
    config: OpenCodeSessionConfig,
    sdk: OpenCodeSdkPort = officialOpenCodeSdkPort,
    options: OpenCodeRuntimeOptions = {},
  ) {
    this.config = config;
    this.sdk = sdk;
    setLogCtx({ sessionId: config.sessionId });
    this.activeTaskTimeoutMs = options.activeTaskTimeoutMs ?? DEFAULT_ACTIVE_TASK_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.serverCloseTimeoutMs = options.serverCloseTimeoutMs ?? DEFAULT_SERVER_CLOSE_TIMEOUT_MS;
    this.agentId = options.agentId ?? config.sessionId;
    this.emitEvent = options.emitEvent ?? emit;
    this.eventIdFactory = options.eventIdFactory ?? (() => crypto.randomUUID());
    this.permissions = new OpenCodePermissionRegistry({ timeoutMs: options.permissionTimeoutMs, nativeResponseTimeoutMs: options.nativeResponseTimeoutMs });
    if (!Number.isFinite(this.activeTaskTimeoutMs) || this.activeTaskTimeoutMs <= 0) {
      throw new RangeError('OpenCode active task timeout must be a positive finite number');
    }
    if (!Number.isFinite(this.promptTimeoutMs) || this.promptTimeoutMs <= 0) {
      throw new RangeError('OpenCode prompt timeout must be a positive finite number');
    }
    if (!Number.isFinite(this.serverCloseTimeoutMs) || this.serverCloseTimeoutMs <= 0) {
      throw new RangeError('OpenCode server close timeout must be a positive finite number');
    }
    this.agentSessionId = config.agentSessionId;
  }

  start(): Promise<OpenCodeSessionMapping> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.shutdownPromise || this.state === 'disposed' || this.state === 'disposing' || this.state === 'cleanup_failed') {
      return Promise.reject(new Error(`OpenCode runtime cannot start in state ${this.state}`));
    }

    const startPromise = this.enqueueLifecycle(() => this.startInternal());
    this.startPromise = startPromise;
    void startPromise.then(
      () => this.clearStartPromise(startPromise),
      () => this.clearStartPromise(startPromise),
    );
    return startPromise;
  }

  async sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void> {
    const client = this.client;
    const sessionId = this.agentSessionId;
    if (this.shutdownPromise || this.state === 'disposing' || this.state === 'cleanup_failed') {
      throw new Error('OpenCode runtime is shutting down');
    }
    if (this.state !== 'started' || !client || !sessionId) {
      throw new Error('OpenCode runtime is not started');
    }
    if (this.activeTask) {
      throw new Error('OpenCode runtime already has an active task');
    }

    this.beginTurnEventState();
    const normalizedPayload = normalizeAgentInputPayload(prompt, inputPayload);
    const normalizedPrompt = normalizedPayload.text;
    setLogCtx({ sessionId: this.config.sessionId });
    writeLog('[opencode-task]', `sendInput START model=${this.config.provider}/${this.config.model} prompt_preview=${normalizedPrompt.slice(0, 120)}`);
    const task = (async () => {
      const turnCompletion = new Promise<void>((resolve, reject) => {
        this.pendingTurnCompletion = { resolve, reject, sessionId };
      });
      try {
        const agent = this.planMode === 'on' ? 'plan' : 'build';
        if (client.switchAgent) {
          await client.switchAgent({ sessionId, agent });
        }
        await client.prompt({
          sessionId,
          prompt: normalizedPrompt,
          inputPayload: normalizedPayload,
          images: mapOpenCodeImages(normalizedPayload),
          provider: this.config.provider,
          model: this.config.model,
          agent,
        });
      } catch (error) {
        this.pendingTurnCompletion = undefined;
        writeLog('[opencode-task]', `sendInput promptAsync FAILED error=${errorMessage(error)}`);
        throw error;
      }
      if (!this.eventSubscription) {
        if (this.pendingTurnCompletion?.sessionId === sessionId) {
          this.pendingTurnCompletion.resolve();
          this.pendingTurnCompletion = undefined;
        }
      }
      try {
        await turnCompletion;
      } catch {
        // turn completed externally (abort/timeout/error)
      }
    })();
    const handledTask = this.awaitPromptWithTimeout(task, sessionId).catch((error) => {
      if (isAbortError(error)) {
        writeLog('[opencode-task]', `sendInput ABORT_ERROR swallowed: ${errorMessage(error)}`);
        return;
      }
      writeLog('[opencode-task]', `sendInput ERROR propagating: ${errorMessage(error)}`);
      throw error;
    });
    this.activeTask = handledTask;
    try {
      await handledTask;
      writeLog('[opencode-task]', 'sendInput COMPLETE');
    } finally {
      if (this.pendingTurnCompletion?.sessionId === sessionId) {
        this.pendingTurnCompletion = undefined;
      }
      if (this.activeTask === handledTask) {
        this.activeTask = undefined;
      }
    }
  }

  interrupt(): Promise<void> {
    return this.enqueueLifecycle(() => this.interruptInternal());
  }

  /** Stores CodeMUX compatibility settings; OpenCode server remains authoritative for native permission decisions. */
  updatePermissions(input: OpenCodePermissionUpdate): void {
    if (input.permissionConfig !== undefined) {
      this.permissionConfig = input.permissionConfig;
    }
    if (input.planMode !== undefined) {
      this.planMode = input.planMode;
    }
  }

  respondToPermission(requestId: string, response: OpenCodePermissionResponse, codeMuxSessionId = this.config.sessionId): Promise<void> {
    return this.permissions.respond(requestId, codeMuxSessionId, response);
  }

  async respondToQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.pendingQuestionIds.delete(requestId);
    const client = this.client;
    if (client?.respondToQuestion) {
      await client.respondToQuestion({ requestId, answers, directory: this.config.cwd });
      this.emitEvent({
        ...buildToolResultEvent({ sessionId: this.config.sessionId, toolUseId: requestId, content: JSON.stringify({ answers }), eventIdFactory: this.eventIdFactory }),
        agent_id: this.agentId,
      });
    }
  }

  isPendingQuestion(requestId: string): boolean {
    return this.pendingQuestionIds.has(requestId);
  }

  resetSession(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const cancellation = this.beginPermissionCancellation();
      try {
        await this.interruptInternal();
        await this.waitForActiveTaskIfPresent();
        this.clearEventState();
        this.agentSessionId = undefined;
        await this.permissions.cancelAll(this.config.sessionId);
      } finally {
        this.finishPermissionCancellation(cancellation);
      }
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    if (this.state === 'disposed') {
      return Promise.resolve();
    }

    const shutdownPromise = this.enqueueLifecycle(() => this.disposeResources());
    this.shutdownPromise = shutdownPromise;
    void shutdownPromise.then(
      () => this.clearShutdownPromise(shutdownPromise),
      () => this.clearShutdownPromise(shutdownPromise),
    );
    return shutdownPromise;
  }

  dispose(): Promise<void> {
    return this.shutdown();
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private clearStartPromise(startPromise: Promise<OpenCodeSessionMapping>): void {
    if (this.startPromise === startPromise) {
      this.startPromise = undefined;
    }
  }

  private clearShutdownPromise(shutdownPromise: Promise<void>): void {
    if (this.shutdownPromise === shutdownPromise) {
      this.shutdownPromise = undefined;
    }
  }

  private async startInternal(): Promise<OpenCodeSessionMapping> {
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
        resources = await this.sdk.start({
          cwd: this.config.cwd,
          provider: this.config.provider,
          model: this.config.model,
          apiKey: this.config.apiKey,
          baseUrl: this.config.baseUrl,
          credentialSource: this.config.credentialSource,
          serverCloseTimeoutMs: this.serverCloseTimeoutMs,
        });
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
      await this.subscribeToEvents();
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

  private mapping(): OpenCodeSessionMapping {
    if (!this.agentSessionId) {
      throw new Error('OpenCode session mapping is unavailable');
    }
    return {
      sessionId: this.config.sessionId,
      agentSessionId: this.agentSessionId,
      runtimeGeneration: this.config.runtimeGeneration,
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

  private async subscribeToEvents(): Promise<void> {
    const client = this.client;
    if (!client?.subscribe || this.eventSubscription) {
      return;
    }
    process.stderr.write(`[opencode-debug] subscribeToEvents starting...\n`);
    try {
      this.eventSubscription = await client.subscribe({
        cwd: this.config.cwd,
        onEvent: (event) => this.handleSdkEvent(event),
        onError: (error) => this.handleSdkEvent({ type: 'server.error', properties: { error, sessionID: this.agentSessionId } }),
        onRetry: (error) => this.handleSdkEvent({ type: 'server.retry', properties: { error, sessionID: this.agentSessionId } }),
        onDisconnect: (error) => this.handleSdkEvent({ type: 'server.error', properties: { error, sessionID: this.agentSessionId } }),
      });
    } catch (error) {
      throw error;
    }
  }

  private handleSdkEvent(event: unknown): void {
    const eventSessionId = getOpenCodeEventSessionId(event);
    const activeSessionId = this.agentSessionId;
    const eventProperties = (event as { properties?: Record<string, unknown> })?.properties;
    const eventMessageId = typeof eventProperties?.messageID === 'string' ? eventProperties.messageID : undefined;
    if (eventMessageId) {
      setLogCtx({ sessionId: this.config.sessionId, messageId: eventMessageId });
    }
    const type = typeof (event as { type?: unknown })?.type === 'string' ? (event as { type: string }).type : '';
    const eventLower = type.toLowerCase();
    const eventJson = (() => { try { return JSON.stringify(event).slice(0, 2000) } catch { return String(event).slice(0, 2000) } })();
    process.stderr.write(`[opencode-debug] handleSdkEvent type=${type} sessionId=${eventSessionId ?? 'null'} activeSessionId=${activeSessionId ?? 'null'} event=${eventJson}\n`);
    if (eventLower.includes('cancel') || eventLower.includes('abort') || eventLower.includes('interrupt') || type === 'session.error') {
      writeLog('[opencode-task]', `handleSdkEvent type=${type} eventSessionId=${eventSessionId ?? 'null'} activeSessionId=${activeSessionId ?? 'null'} event=${JSON.stringify(event).slice(0, 500)}`);
    }
    if (type === 'permission.updated' && this.permissionClosing) {
      return;
    }
    const identity = getOpenCodeEventIdentity(event, this.turnId);
    const payloadKey = identity ? undefined : getOpenCodePayloadKey(event);
    if ((identity && this.seenEventIds.has(identity)) || (payloadKey && this.seenPayloadKeys.has(payloadKey))) {
      return;
    }
    if (isOpenCodeSessionScopedEvent(type) && !eventSessionId) {
      if (identity) {
        this.rememberSeenEventId(identity);
      } else if (payloadKey) {
        this.rememberSeenPayloadKey(payloadKey);
      }
      const diagnosticEvents = toCodeMuxEvent(event, {
        agentId: this.agentId,
        sessionId: this.config.sessionId,
        agentSessionId: this.agentSessionId,
        sequence: this.eventSequence,
        durationMs: this.turnStartedAt > 0 ? Date.now() - this.turnStartedAt : 0,
        usage: this.usage,
        terminalSessionIds: this.terminalSessionIds,
        terminalToolIds: this.terminalToolIds,
        assistantMessageIds: this.assistantMessageIds,
        userMessageIds: this.userMessageIds,
        turnId: this.turnId,
        eventIdFactory: this.eventIdFactory,
        streamingParts: this.streamingParts,
        nextSection: this.nextSection,
        idleStreamKind: this.idleStreamKind,
      });
      for (const diagnosticEvent of diagnosticEvents) {
        this.emitEvent(diagnosticEvent);
      }
      this.eventSequence += diagnosticEvents.length;
      return;
    }

    // Handle permission and question events from ANY session (including subagents)
    // These must be processed before the session filter below.
    if (type === 'permission.updated') {
      this.handlePermissionEvent(event, eventSessionId, identity, payloadKey);
      if (identity) {
        this.rememberSeenEventId(identity);
      } else if (payloadKey) {
        this.rememberSeenPayloadKey(payloadKey);
      }
      return;
    }
    if (type === 'question.asked') {
      this.handleQuestionEvent(event, eventSessionId, identity, payloadKey);
      if (identity) {
        this.rememberSeenEventId(identity);
      } else if (payloadKey) {
        this.rememberSeenPayloadKey(payloadKey);
      }
      return;
    }

    if (eventSessionId && eventSessionId !== activeSessionId) {
      return;
    }
    const terminalSessionId = eventSessionId ?? activeSessionId;
    if (terminalSessionId && this.terminalSessionIds.has(terminalSessionId) && isTerminalEventType(type)) {
      return;
    }
    if (type === 'message.updated') {
      const properties = asRecord(asRecord(event)?.properties);
      const info = asRecord(properties?.info);
      const messageId = readString(info?.id);
      if (messageId && readString(info?.role) === 'assistant') this.assistantMessageIds.add(messageId);
      if (messageId && readString(info?.role) === 'user') this.userMessageIds.add(messageId);
    }
    const toolId = getOpenCodeToolId(event);
    const toolStatus = getOpenCodeToolStatus(event);
    if (toolId && this.terminalToolIds.has(toolId)) {
      return;
    }

    if (identity) {
      this.rememberSeenEventId(identity);
    } else if (payloadKey) {
      this.rememberSeenPayloadKey(payloadKey);
    }
    const usageUpdate = extractOpenCodeUsageUpdate(event);
    if (usageUpdate) {
      this.usage = mergeOpenCodeUsage(this.usage, usageUpdate.usage, usageUpdate.mode);
    }
    const events = toCodeMuxEvent(event, {
      agentId: this.agentId,
      sessionId: this.config.sessionId,
      agentSessionId: this.agentSessionId,
      sequence: this.eventSequence,
      durationMs: this.turnStartedAt > 0 ? Date.now() - this.turnStartedAt : 0,
      usage: this.usage,
      terminalSessionIds: this.terminalSessionIds,
      terminalToolIds: this.terminalToolIds,
      assistantMessageIds: this.assistantMessageIds,
      userMessageIds: this.userMessageIds,
      turnId: this.turnId,
      eventIdFactory: this.eventIdFactory,
      streamingParts: this.streamingParts,
      nextSection: this.nextSection,
      idleStreamKind: this.idleStreamKind,
    });
    const serialized = JSON.stringify(event);
    if (serialized.toLowerCase().includes('cancelled') || serialized.includes('Task cancelled') || serialized.includes('task was cancelled')) {
      process.stderr.write(`[opencode-task][error] CANCELLED_DETECTED type=${type} sessionId=${eventSessionId ?? this.agentSessionId ?? 'null'} preview=${serialized.slice(0, 800)}\n`);
    }
    for (const normalizedEvent of events) {
      const toEmit = normalizedEvent.type === 'stream_event'
        ? { ...normalizedEvent, session_id: this.config.sessionId }
        : normalizedEvent;
      const emitJson = (() => { try { return JSON.stringify(toEmit).slice(0, 1000) } catch { return String(toEmit).slice(0, 1000) } })();
      process.stderr.write(`[opencode-debug] EMIT to frontend type=${toEmit.type ?? '(no type)'} preview=${emitJson}\n`);
      this.emitEvent(toEmit);
    }
    this.eventSequence += events.length;

    const assistantMessage = asRecord(events.find((e) => e.type === 'assistant')?.message);
    const content = Array.isArray(assistantMessage?.content) ? assistantMessage?.content : [];
    for (const block of content) {
      const recordBlock = asRecord(block);
      if (recordBlock?.type === 'tool_use' && typeof recordBlock.id === 'string' && (recordBlock.name === 'Task' || recordBlock.name === 'Agent')) {
        this.pendingTaskToolCallIds.add(recordBlock.id as string);
      }
    }

    if (type === 'session.idle' && this.pendingTaskToolCallIds.size > 0 && activeSessionId) {
      for (const taskId of this.pendingTaskToolCallIds) {
        this.emitEvent({
          ...buildToolResultEvent({ sessionId: this.config.sessionId, toolUseId: taskId, content: '', eventIdFactory: this.eventIdFactory }),
          agent_id: this.agentId,
          agent_session_id: activeSessionId,
          opencode_session_id: activeSessionId,
        });
      }
      this.pendingTaskToolCallIds.clear();
    }

    if (terminalSessionId && isTerminalEventType(type)) {
      if (events.some((eventItem) => eventItem.type === 'result' || eventItem.type === 'error')) {
        this.terminalSessionIds.add(terminalSessionId);
        this.turnStartedAt = 0;
        this.usage = { input_tokens: 0, output_tokens: 0 };
      }
      const pending = this.pendingTurnCompletion;
      if (pending && pending.sessionId === terminalSessionId) {
        writeLog('[opencode-task]', `handleSdkEvent RESOLVE_TURN type=${type}`);
        this.pendingTurnCompletion = undefined;
        if (type === 'session.error') {
          const properties = asRecord(asRecord(event)?.properties);
          const errorData = properties?.error;
          pending.reject(errorData instanceof Error ? errorData : new Error(errorData ? String(errorData) : 'Session error'));
        } else {
          pending.resolve();
        }
      }
    }
    if (toolId && (toolStatus === 'completed' || toolStatus === 'error')) {
      this.terminalToolIds.add(toolId);
    }
  }

  private async awaitPromptWithTimeout(task: Promise<void>, sessionId: string): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const timeoutError = new Error(`OpenCode prompt timed out after ${this.promptTimeoutMs}ms`);
        timeoutError.name = 'OpenCodePromptTimeoutError';
        reject(timeoutError);
      }, this.promptTimeoutMs);
    });
    try {
      await Promise.race([task, timeout]);
        writeLog('[opencode-task]', 'awaitPromptWithTimeout RESOLVED');
    } catch (error) {
        writeLog('[opencode-task]', `awaitPromptWithTimeout ERROR error=${errorMessage(error)} isTimeout=${isPromptTimeoutError(error)}`);
      if (!isPromptTimeoutError(error)) throw error;
      void this.client?.abort(sessionId).catch(() => undefined);
      this.handleSdkEvent({ type: 'session.error', properties: { sessionID: sessionId, error: { name: 'OpenCodePromptTimeoutError', data: { message: errorMessage(error) } } } });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private beginTurnEventState(): void {
    this.turnId += 1;
    this.terminalSessionIds.clear();
    this.terminalToolIds.clear();
    this.pendingTaskToolCallIds.clear();
    this.assistantMessageIds.clear();
    this.userMessageIds.clear();
    this.streamingParts.clear();
    this.nextSection.kind = 'idle';
    this.idleStreamKind.kind = 'thinking';
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.turnStartedAt = Date.now();
  }

  private rememberSeenEventId(identity: string): void {
    this.seenEventIds.set(identity, true);
    while (this.seenEventIds.size > MAX_SEEN_EVENT_IDS) {
      const oldest = this.seenEventIds.keys().next().value;
      if (oldest === undefined) break;
      this.seenEventIds.delete(oldest);
    }
  }

  private rememberSeenPayloadKey(key: string): void {
    if (this.seenPayloadKeys.has(key)) return;
    this.seenPayloadKeys.set(key, true);
    this.seenPayloadKeyBytes += Buffer.byteLength(key, 'utf8');
    while (this.seenPayloadKeys.size > MAX_SEEN_PAYLOAD_KEYS || this.seenPayloadKeyBytes > MAX_SEEN_PAYLOAD_CACHE_BYTES) {
      const oldest = this.seenPayloadKeys.keys().next().value;
      if (oldest === undefined) break;
      this.seenPayloadKeys.delete(oldest);
      this.seenPayloadKeyBytes -= Buffer.byteLength(oldest, 'utf8');
    }
  }

  private clearEventState(): void {
    this.seenEventIds.clear();
    this.seenPayloadKeys.clear();
    this.seenPayloadKeyBytes = 0;
    this.terminalSessionIds.clear();
    this.terminalToolIds.clear();
    this.assistantMessageIds.clear();
    this.userMessageIds.clear();
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.turnStartedAt = 0;
  }

  private handlePermissionEvent(event: unknown, eventSessionId: string | undefined, nativeRequestIdentity: string | undefined, nativePayloadFingerprint: string | undefined): void {
    const properties = asRecord(asRecord(event)?.properties);
    const requestId = readString(properties?.id);
    if (!requestId) {
      return;
    }
    const permissionType = readString(properties?.type) ?? 'unknown';
    const description = readString(properties?.title) ?? permissionType;
    const metadata = asRecord(properties?.metadata);
    const openCodeSessionId = eventSessionId ?? readString(properties?.sessionID);
    const rawPermission = properties ?? event;
    const registration = this.permissions.upsert({
      requestId,
      openCodeSessionId,
      codeMuxSessionId: this.config.sessionId,
      permissionType,
      description,
      metadata,
      raw: rawPermission,
      nativeRequestIdentity,
      nativePayloadFingerprint,
      respond: async (response) => {
        const client = this.client;
        if (!client || !openCodeSessionId) {
          throw new Error('OpenCode permission response session is unavailable');
        }
        await client.respondToPermission({ sessionId: openCodeSessionId, requestId, response });
      },
    });
    if (!registration.accepted) {
      return;
    }
    this.emitEvent({
      type: 'permission',
      subtype: 'request',
      agent_id: this.agentId,
      session_id: this.config.sessionId,
      ...(openCodeSessionId ? { agent_session_id: openCodeSessionId, opencode_session_id: openCodeSessionId } : {}),
      sequence: this.eventSequence,
      request_id: requestId,
      permission_id: requestId,
      permission_type: permissionType,
      description,
      ...(metadata ? { metadata } : {}),
      raw_permission: rawPermission,
      raw_permission_payload: rawPermission,
    });
    this.eventSequence += 1;
  }

  private handleQuestionEvent(event: unknown, eventSessionId: string | undefined, nativeRequestIdentity: string | undefined, nativePayloadFingerprint: string | undefined): void {
    const properties = asRecord(asRecord(event)?.properties);
    const requestId = readString(properties?.id);
    if (!requestId) {
      return;
    }
    const questions = readArray(properties?.questions);
    if (!questions || questions.length === 0) {
      return;
    }
    this.pendingQuestionIds.add(requestId);
    const openCodeSessionId = eventSessionId ?? readString(properties?.sessionID);
    this.emitEvent({
      type: 'ask_user_question',
      agent_id: this.agentId,
      session_id: this.config.sessionId,
      ...(openCodeSessionId ? { agent_session_id: openCodeSessionId, opencode_session_id: openCodeSessionId } : {}),
      tool_use_id: requestId,
      questions: questions.map((q: unknown) => {
        const qr = asRecord(q);
        const options = Array.isArray(qr?.options) ? (qr.options as Array<Record<string, unknown>>).map((opt) => ({
          label: String(opt.label ?? ''),
          ...(opt.description ? { description: String(opt.description) } : {}),
        })) : [];
        return { question: readString(qr?.question) ?? '', header: readString(qr?.header), options };
      }),
      sequence: this.eventSequence,
      uuid: this.eventIdFactory(),
    });
    this.eventSequence += 1;
  }

  private async closeEventSubscription(errors: unknown[]): Promise<void> {
    const subscription = this.eventSubscription;
    this.eventSubscription = undefined;
    if (!subscription) {
      return;
    }
    try {
      await subscription.close();
    } catch (error) {
      errors.push(error);
    }
  }
  private async interruptInternal(): Promise<void> {
    writeLog('[opencode-task]', `interruptInternal START state=${this.state} hasActiveTask=${!!this.activeTask}`);
    const cancellation = this.beginPermissionCancellation();
    try {
      await this.permissions.cancelAll(this.config.sessionId);
      const client = this.client;
      const sessionId = this.agentSessionId;
      if (client && sessionId && this.activeTask) {
        try {
          writeLog('[opencode-task]', 'interruptInternal calling client.abort');
          await client.abort(sessionId);
          writeLog('[opencode-task]', 'interruptInternal client.abort DONE');
        } catch (error) {
          writeLog('[opencode-task]', `interruptInternal client.abort ERROR error=${errorMessage(error)} isAbort=${isAbortError(error)}`);
          if (!isAbortError(error)) {
            throw error;
          }
        }
        this.handleSdkEvent({ type: 'session.interrupted', properties: { sessionID: sessionId } });
      }
      await this.permissions.cancelAll(this.config.sessionId);
    } finally {
      this.finishPermissionCancellation(cancellation);
    }
    writeLog('[opencode-task]', 'interruptInternal END');
  }

  private async disposeResources(): Promise<void> {
    this.state = 'disposing';
    const cancellation = this.beginPermissionCancellation();
    const errors: unknown[] = [];
    try {
      await this.permissions.cancelAll(this.config.sessionId);
      try {
        await this.interruptInternal();
      } catch (error) {
        errors.push(error);
      }

      try {
        await this.waitForActiveTaskIfPresent();
      } catch (error) {
        errors.push(error);
      }
      this.activeTask = undefined;

      this.pendingTurnCompletion = undefined;
      this.pendingTaskToolCallIds.clear();

      await this.closeEventSubscription(errors);
      await this.permissions.cancelAll(this.config.sessionId);
      this.agentSessionId = undefined;
      this.client = undefined;

      const server = this.server;
      if (server) {
        try {
          await this.closeServerWithTimeout(server);
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
    } finally {
      this.finishPermissionCancellation(cancellation, true);
    }
  }

  private beginPermissionCancellation(): { epoch: number; owner: boolean } {
    if (this.permissionClosing) {
      return { epoch: this.permissionCancellationEpoch, owner: false };
    }
    this.permissionCancellationEpoch += 1;
    this.permissionClosing = true;
    return { epoch: this.permissionCancellationEpoch, owner: true };
  }

  private finishPermissionCancellation(cancellation: { epoch: number; owner: boolean }, keepClosed = false): void {
    if (cancellation.owner && cancellation.epoch === this.permissionCancellationEpoch && !keepClosed) {
      this.permissionClosing = false;
    }
  }

  private async waitForActiveTaskIfPresent(): Promise<void> {
    const activeTask = this.activeTask;
    if (!activeTask) {
      return;
    }
    await this.waitForActiveTask(activeTask);
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
      await this.closeServerWithTimeout(server);
      this.server = undefined;
      return undefined;
    } catch (error) {
      return error;
    }
  }

  private async closeServerWithTimeout(server: OpenCodeServerHandle): Promise<void> {
    await closeOpenCodeServerWithTimeout(server, this.serverCloseTimeoutMs);
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
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isPromptTimeoutError(error: unknown): boolean {
  return readString(asRecord(error)?.name) === 'OpenCodePromptTimeoutError';
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

function isTerminalEventType(type: string): boolean {
  return type === 'session.idle' || type === 'session.error' || type === 'session.interrupted' || type === 'session.aborted' || type === 'server.disconnected' || type === 'server.error' || type === 'disconnect' || type === 'connection.error';
}

function readArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
