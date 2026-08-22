// Codex App Server Runtime — Issue 03 (official upstream basic turn).
//
// Drives `codex app-server --stdio` over the AppServerTransport JSON-RPC
// connection: `ensure` spawns a long-lived app-server process and starts (or
// resumes) a thread, `sendInput` runs a turn and normalizes app-server
// notifications into the existing CodeMUX Event protocol via
// CodexTurnEventNormalizer. Official OpenAI endpoints are dialed directly —
// the compat proxy is never started here (third-party re-wiring lands with
// Issue 09). The SDK-based CodexSessionRuntime stays in place until the
// Issue 11 hard cut; this module is the replacement seam.

import type { SidecarCommand, SidecarModelLimits } from './types.js';
import type { ProviderRuntimeRef } from './runtimeContract.js';
import {
  isRuntimeError,
  loadProviderRuntime,
  resolveCodexFromRuntime,
  type RuntimeLoadResult,
} from './runtimeLoader.js';
import {
  AppServerTransport,
  type AppServerTransportOptions,
} from './appServerTransport.js';
import { CodexAppServerApprovalBridge } from './codexAppServerApprovals.js';
import type { OpenCodePermissionResponse } from './opencodePermissions.js';
import {
  CodexTurnEventNormalizer,
  type CodexTurnOutcome,
  type CodexTurnSourceEvent,
  type CodexTurnUsage,
} from './codexTurnEventNormalizer.js';
import { emit } from './streamEventBatcher.js';
import { ensureWorkingDirectory } from './defaultWorkingDirectory.js';
import {
  mapToCodexEffort,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from './reasoningEffort.js';
import {
  buildCodexThreadPermissionOptions,
  describeCodexPermissionOptions,
  type AgentPlanMode,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type CodexTurnPolicy,
  type SidecarPermissionConfig,
} from './agentPermissions.js';
import {
  buildCodexInputEntries,
  cleanupTempImageFiles,
  isImageUnsupportedError,
  normalizeAgentInputPayload,
  writePayloadImagesToTempFiles,
  type AgentInputPayload,
} from './agentInputPayload.js';
import {
  buildCodexToolResultContent,
  buildCodexToolUseContent,
  isCodexToolResultError,
} from './runtimeEvents.js';
import {
  resolveTurnTimeouts,
  type ResolvedTurnTimeouts,
  type TurnTimeouts,
} from './turnTimeouts.js';
import { createTurnIdleGuard, type TurnIdleGuard } from './turnIdleGuard.js';
import { applyCodexWindowsSandboxPathCompatibility } from './sessionRuntimeHelpers.js';
import { proxyManager } from './proxyManager.js';
import { setLogCtx, writeLog } from './writeLog.js';
import {
  DEFAULT_CODEX_CONTEXT_WINDOW,
  ensureCodexModelCatalog,
  resolveCodexModelCatalogPath,
} from './codexModelCatalog.js';

export { emit } from './streamEventBatcher.js';

type EnsureSessionCommand = Extract<SidecarCommand, { type: 'ensure_session' }>;
type UpdatePermissionsCommand = Extract<SidecarCommand, { type: 'update_permissions' }>;

const TURN_IDLE_TIMEOUT_MESSAGE = 'Turn idle timeout: no progress events received';
const DEFAULT_CODEX_MODEL = 'o4-mini';

/** Sandbox policy payload sent with each `turn/start` (Issue 06 refines the tiers). */
type AppServerSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
    type: 'workspaceWrite';
    writableRoots: string[];
    networkAccess: boolean;
    excludeTmpdirEnvVar: boolean;
    excludeSlashTmp: boolean;
  };

type CodexSessionBootstrap = {
  sessionId?: string;
  agentSessionId?: string;
  cwd: string;
  apiKey?: string;
  upstreamBaseUrl?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionConfig?: SidecarPermissionConfig;
  planMode?: AgentPlanMode;
  runtimeRef?: ProviderRuntimeRef;
  timeouts?: TurnTimeouts;
  modelLimits?: SidecarModelLimits;
};

type ActiveTurnState = {
  sessionId: string;
  startedAt: number;
  turnId: string | null;
  normalizer: CodexTurnEventNormalizer;
  usage: CodexTurnUsage | null;
  idleGuard: TurnIdleGuard;
  imagePaths: string[];
  /** Issue 08: set while a manual `thread/compact/start` RPC drives this turn. */
  compactionTrigger?: 'manual';
  /**
   * Issue 08: contextCompaction item lifecycle — ids seen started but not yet
   * completed are flushed as completions when the turn settles (some builds
   * never send `item/completed` for the compaction item).
   */
  pendingCompactionItemIds: Set<string>;
  /** Compaction item ids whose boundary was already emitted (dedup guard). */
  emittedCompactionItemIds: Set<string>;
  settle: (outcome: CodexTurnOutcome) => void;
  settled: boolean;
  cleanedUp: boolean;
};

export type CodexAppServerRuntimeOptions = {
  /**
   * Transport factory override. Production resolves the Codex CLI from the
   * managed runtime; tests inject a fake app-server here.
   */
  connect?: (options: AppServerTransportOptions) => Promise<AppServerTransport>;
  /** Event sink override (defaults to the stream event batcher). */
  emit?: (event: unknown) => void;
};

export class CodexAppServerRuntime {
  private config: CodexSessionBootstrap | null = null;
  private configFingerprint: string | null = null;
  private transport: AppServerTransport | null = null;
  private approvalBridge: CodexAppServerApprovalBridge | null = null;
  private threadId: string | null = null;
  private activeTurn: ActiveTurnState | null = null;
  private streamingItemState = new Map<string, { kind: 'text' | 'thinking' }>();
  private timeouts: ResolvedTurnTimeouts = resolveTurnTimeouts();

  private readonly connectTransport: (options: AppServerTransportOptions) => Promise<AppServerTransport>;
  private readonly emitEvent: (event: unknown) => void;

  constructor(options: CodexAppServerRuntimeOptions = {}) {
    this.connectTransport = options.connect ?? defaultConnectTransport;
    this.emitEvent = options.emit ?? ((event) => {
      emit(event);
    });
  }

  async ensure(cmd: EnsureSessionCommand): Promise<void> {
    if (cmd.sessionId) {
      setLogCtx({ sessionId: cmd.sessionId });
    }
    const cwd = ensureWorkingDirectory(cmd.cwd);
    const requestedConfig: CodexSessionBootstrap = {
      sessionId: cmd.sessionId,
      agentSessionId: cmd.agentSessionId,
      cwd,
      apiKey: cmd.apiKey,
      upstreamBaseUrl: cmd.baseUrl,
      model: cmd.model,
      reasoningEffort: normalizeReasoningEffort(cmd.reasoningEffort),
      permissionConfig: cmd.permissionConfig,
      planMode: normalizeCodexPlanMode(cmd.planMode),
      runtimeRef: cmd.runtimeRef,
      timeouts: cmd.timeouts,
      modelLimits: cmd.modelLimits,
    };
    this.timeouts = resolveTurnTimeouts(requestedConfig.timeouts);

    const nextFingerprint = JSON.stringify(requestedConfig);
    if (this.configFingerprint === nextFingerprint && this.config && this.transport?.isConnected && this.threadId) {
      process.stderr.write(
        `[codex-app-server] Session ensured: session_id=${cmd.sessionId || 'none'} cwd=${cwd} thread=${this.threadId}\n`,
      );
      this.emitEvent({ type: 'mcp_status_update', servers: {}, status: 'ready' });
      this.emitEvent({ type: 'proxy_status', ...proxyManager.getStatus() });
      return;
    }

    await this.teardownTransport();
    this.configFingerprint = nextFingerprint;
    this.config = requestedConfig;

    const loadedRuntime = this.loadRuntimeIfNeeded();
    const executable = resolveCodexFromRuntime(loadedRuntime);
    if (!executable) {
      throw new Error(`Codex Runtime 未找到 app-server 可执行文件: ${loadedRuntime.ref.runtimePath}`);
    }
    process.stderr.write(
      `[runtime] provider=codex app-server=${executable} runtime=${loadedRuntime.ref.runtimePath} version=${loadedRuntime.ref.runtimeVersion} node=${process.execPath}\n`,
    );

    const modelCatalogPath = await this.syncModelCatalog(
      requestedConfig.model,
      requestedConfig.modelLimits?.contextWindow,
      requestedConfig.modelLimits?.inputModalities,
    );

    const permissionOptions = this.resolvePermissionOptions();
    const threadParams = {
      cwd,
      ...(requestedConfig.model ? { model: requestedConfig.model } : {}),
      ...(permissionOptions
        ? {
          approvalPolicy: permissionOptions.approvalPolicy,
          sandbox: permissionOptions.sandboxMode,
          ...(permissionOptions.approvalsReviewer ? { approvalsReviewer: permissionOptions.approvalsReviewer } : {}),
        }
        : {}),
      ...(modelCatalogPath ? { config: { model_catalog_json: modelCatalogPath } } : {}),
    };

    const transport = await this.connectTransport({
      executable,
      cwd,
      env: buildAppServerEnv(requestedConfig),
      onNotification: (method, params) => this.handleNotification(method, params),
      onError: (error) => this.handleTransportError(error),
      onExit: (code, signal) => this.handleTransportExit(code, signal),
      onStderrLine: (line) => {
        if (line.trim()) {
          process.stderr.write(`[codex-app-server][stderr] ${line.slice(0, 500)}\n`);
        }
      },
    });
    this.transport = transport;
    this.approvalBridge = new CodexAppServerApprovalBridge({
      emitPermissionRequest: (projection) => {
        this.emitEvent({
          type: 'permission_requested',
          session_id: requestedConfig.sessionId ?? '',
          sequence: 0,
          event_id: crypto.randomUUID(),
          request_id: projection.requestId,
          permission_id: projection.requestId,
          permission_type: projection.permissionType,
          description: projection.description,
          ...(projection.metadata ? { metadata: projection.metadata } : {}),
        });
      },
      emitUserInputRequest: (projection) => {
        this.emitEvent({
          type: 'user_input_requested',
          session_id: requestedConfig.sessionId ?? '',
          sequence: 0,
          event_id: crypto.randomUUID(),
          tool_use_id: projection.requestId,
          questions: projection.questions,
        });
      },
      onPendingChange: (pendingCount) => this.syncIdleGuardWithApprovals(pendingCount),
    });
    this.approvalBridge.register(transport);

    const result = await this.startOrResumeThread(requestedConfig, threadParams);
    this.threadId = result.threadId;

    if (result.rebuilt) {
      // Issue 04: resume failed — the native thread was rebuilt under a new
      // id. The CodeMUX event timeline is untouched; surface the rebuild as a
      // system status hint so the UI can explain the mapping change.
      this.emitEvent({
        type: 'system_event',
        subtype: 'native_session_rebuilt',
        session_id: requestedConfig.sessionId ?? '',
        content: 'Codex 原生会话恢复失败，已重建会话。对话历史保持完整。',
        agent_kind: 'codex',
        previous_agent_session_id: result.rebuilt.previousAgentSessionId,
        agent_session_id: result.threadId,
        reason: result.rebuilt.reason,
      });
    }

    process.stderr.write(
      `[codex-app-server] Session ensured: session_id=${cmd.sessionId || 'none'} cwd=${cwd} thread=${result.threadId} resumed=${result.resumed} rebuilt=${result.rebuilt ? 'true' : 'false'}\n`,
    );
    this.emitEvent({
      type: 'agent_session_mapping',
      app_session_id: requestedConfig.sessionId ?? '',
      agent_kind: 'codex',
      agent_session_id: result.threadId,
    });

    this.emitEvent({ type: 'mcp_status_update', servers: {}, status: 'ready' });
    this.emitEvent({ type: 'proxy_status', ...proxyManager.getStatus() });
  }

  updatePermissions(cmd: UpdatePermissionsCommand): void {
    const planMode = normalizeCodexPlanMode(cmd.planMode) ?? this.config?.planMode ?? 'off';
    if (this.config) {
      this.config = {
        ...this.config,
        sessionId: cmd.sessionId ?? this.config.sessionId,
        permissionConfig: cmd.permissionConfig,
        planMode,
      };
    }
    process.stderr.write(
      `[codex-app-server] Permissions updated: session_id=${cmd.sessionId || this.config?.sessionId || 'none'} plan_mode=${planMode}${this.activeTurn ? ' (next turn)' : ''}\n`,
    );
    if (this.activeTurn && this.config) {
      // Issue 06: turn policy is fixed at turn/start — a change mid-turn only
      // takes effect on the next turn. Surface that so the UI can explain it.
      this.emitEvent({
        type: 'system_event',
        subtype: 'permission_update_deferred',
        session_id: cmd.sessionId ?? this.config.sessionId ?? '',
        content: 'Workflow Mode 变更将在下一回合生效。',
        agent_kind: 'codex',
      });
    }
  }

  async sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void> {
    // Issue 08: route `/compact` to the native compact RPC instead of sending
    // it to the model as a text prompt. The compaction runs as a regular turn
    // (`turn/started` … `item/started` contextCompaction … `turn/completed`)
    // and is normalized by the shared notification path below.
    const compactPayload = normalizeAgentInputPayload(prompt, inputPayload);
    if (compactPayload.text.trim() === '/compact' && (compactPayload.images?.length ?? 0) === 0) {
      await this.compactSession();
      return;
    }

    try {
      await this.runInput(prompt, inputPayload, true);
    } catch (error) {
      if (!isImageUnsupportedError(error)) {
        throw error;
      }
      this.emitEvent({
        type: 'vision_unsupported',
        model: this.config?.model || DEFAULT_CODEX_MODEL,
        message: String(error),
      });
      process.stderr.write(`[codex-app-server] Vision payload unsupported; retrying text-only: ${String(error)}\n`);
      await this.runInput(prompt, inputPayload, false);
    }
  }

  private async runInput(
    prompt: string,
    inputPayload: AgentInputPayload | undefined,
    includeImages: boolean,
  ): Promise<void> {
    const config = this.config;
    const transport = this.transport;
    if (!config || !transport || !this.threadId) {
      throw new Error('Codex session not initialized. Call ensure_session first.');
    }
    if (this.activeTurn) {
      throw new Error('A Codex turn is already in progress');
    }

    const sessionId = config.sessionId || '';
    const model = config.model || DEFAULT_CODEX_MODEL;
    const startedAt = Date.now();
    const payload = normalizeAgentInputPayload(prompt, inputPayload);
    const imagePaths = includeImages ? await writePayloadImagesToTempFiles(payload) : [];
    const permissionOptions = this.resolvePermissionOptions();

    process.stderr.write(`[codex-app-server] Processing input: ${payload.text.slice(0, 80)}...\n`);
    writeLog('[codex-app-server]', `sendInput START model=${model} prompt_preview=${payload.text.slice(0, 120)} includeImages=${includeImages}`);

    this.emitEvent({
      type: 'system_event',
      subtype: 'init',
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      model,
      cwd: config.cwd,
      tools: [],
      permissionMode: permissionOptions
        ? describeCodexPermissionOptions(permissionOptions)
        : 'unknown',
    });

    const turn: ActiveTurnState = {
      sessionId,
      startedAt,
      turnId: null,
      normalizer: new CodexTurnEventNormalizer(sessionId),
      usage: null,
      idleGuard: createTurnIdleGuard({
        idleTimeoutMs: this.timeouts.idle_timeout_ms,
        onExpired: () => {
          process.stderr.write('[codex-app-server] Turn idle timeout fired; interrupting turn\n');
          void this.interruptActiveTurn(turn, TURN_IDLE_TIMEOUT_MESSAGE);
        },
      }),
      imagePaths,
      pendingCompactionItemIds: new Set<string>(),
      emittedCompactionItemIds: new Set<string>(),
      settled: false,
      cleanedUp: false,
      settle: () => undefined,
    };
    const completion = new Promise<CodexTurnOutcome>((resolve) => {
      turn.settle = (outcome) => {
        if (turn.settled) return;
        turn.settled = true;
        resolve(outcome);
      };
    });
    this.activeTurn = turn;
    turn.idleGuard.reset();

    try {
      const input = buildAppServerUserInput(
        buildCodexInputEntries(payload, imagePaths, includeImages),
      );
      const turnParams: Record<string, unknown> = {
        threadId: this.threadId,
        input,
      };
      if (permissionOptions) {
        turnParams.approvalPolicy = permissionOptions.approvalPolicy;
        turnParams.sandboxPolicy = buildAppServerSandboxPolicy(
          permissionOptions.sandboxMode,
          permissionOptions.networkAccessEnabled,
          config.cwd,
        );
        if (permissionOptions.approvalsReviewer) {
          turnParams.approvalsReviewer = permissionOptions.approvalsReviewer;
        }
      }
      if (config.model) {
        turnParams.model = config.model;
      }
      if (config.reasoningEffort) {
        turnParams.effort = mapToCodexEffort(config.reasoningEffort);
      }

      const ack = transport.request('turn/start', turnParams, { timeoutMs: 0 });
      // Late rejections (e.g. connection torn down after a crash already
      // settled the turn) must not surface as unhandled.
      ack.catch(() => undefined);
      // Race the ack against settle paths (crash / interrupt / idle timeout)
      // so a hanging turn/start response cannot deadlock the turn.
      await Promise.race([ack, completion]);
      const outcome = await completion;

      if (outcome.outcome === 'completed') {
        // Issue 08: auto-compaction may complete the contextCompaction item
        // without an `item/completed` notification on some builds — flush the
        // boundary before the turn finishes.
        this.flushPendingCompactionBoundaries(turn);
      }
      this.emitTurnOutcome(turn, {
        ...outcome,
        durationMs: Date.now() - startedAt,
        ...(turn.usage ? { usage: turn.usage } : {}),
      });
      writeLog('[codex-app-server]', `sendInput COMPLETE outcome=${outcome.outcome}`);
    } catch (error) {
      if (includeImages && isImageUnsupportedError(error)) {
        await this.cleanupTurn(turn);
        throw error;
      }
      const message = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
        : String(error);
      process.stderr.write(`[codex-app-server] Turn failed before completion: ${message}\n`);
      // Transport crash handlers (onError/onExit) already emitted the error
      // event when they settled the turn — avoid duplicating it here.
      if (!turn.settled) {
        this.emitTurnEvent(turn, { kind: 'error', subtype: 'runtime', message });
      }
      this.emitTurnOutcome(turn, { outcome: 'failed', reason: message, durationMs: Date.now() - startedAt });
      writeLog('[codex-app-server]', 'sendInput FAILED');
    } finally {
      await this.cleanupTurn(turn);
    }
  }

  /**
   * Issue 08: manual context compaction. Sends `thread/compact/start` and
   * awaits the compaction turn's completion notifications (`turn/completed`).
   * The `contextCompaction` item lifecycle emits the compact boundary events.
   */
  private async compactSession(): Promise<void> {
    const config = this.config;
    const transport = this.transport;
    const threadId = this.threadId;
    if (!config || !transport || !threadId) {
      throw new Error('Codex session not initialized. Call ensure_session first.');
    }
    if (this.activeTurn) {
      throw new Error('A Codex turn is already in progress');
    }

    const sessionId = config.sessionId || '';
    const startedAt = Date.now();
    setLogCtx({ sessionId });
    writeLog('[codex-app-server]', 'manual compact START');
    process.stderr.write(`[codex-app-server] Manual compact: thread=${threadId}\n`);

    const turn: ActiveTurnState = {
      sessionId,
      startedAt,
      turnId: null,
      normalizer: new CodexTurnEventNormalizer(sessionId),
      usage: null,
      idleGuard: createTurnIdleGuard({
        idleTimeoutMs: this.timeouts.idle_timeout_ms,
        onExpired: () => {
          process.stderr.write('[codex-app-server] Compact idle timeout fired; interrupting turn\n');
          void this.interruptActiveTurn(turn, TURN_IDLE_TIMEOUT_MESSAGE);
        },
      }),
      imagePaths: [],
      compactionTrigger: 'manual',
      pendingCompactionItemIds: new Set<string>(),
      emittedCompactionItemIds: new Set<string>(),
      settled: false,
      cleanedUp: false,
      settle: () => undefined,
    };
    const completion = new Promise<CodexTurnOutcome>((resolve) => {
      turn.settle = (outcome) => {
        if (turn.settled) return;
        turn.settled = true;
        resolve(outcome);
      };
    });
    this.activeTurn = turn;
    turn.idleGuard.reset();

    try {
      const ack = transport.request('thread/compact/start', { threadId }, { timeoutMs: 0 });
      // Late rejections (e.g. transport torn down after a crash already
      // settled the turn) must not surface as unhandled.
      ack.catch(() => undefined);
      await Promise.race([ack, completion]);
      const outcome = await completion;

      if (outcome.outcome === 'completed') {
        this.flushPendingCompactionBoundaries(turn);
      }
      this.emitTurnOutcome(turn, {
        ...outcome,
        durationMs: Date.now() - startedAt,
        ...(turn.usage ? { usage: turn.usage } : {}),
      });
      writeLog('[codex-app-server]', `manual compact COMPLETE outcome=${outcome.outcome}`);
    } catch (error) {
      const message = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
        : String(error);
      process.stderr.write(`[codex-app-server] Manual compact failed before completion: ${message}\n`);
      if (!turn.settled) {
        this.emitTurnEvent(turn, { kind: 'error', subtype: 'runtime', message });
      }
      this.emitTurnOutcome(turn, { outcome: 'failed', reason: message, durationMs: Date.now() - startedAt });
      writeLog('[codex-app-server]', 'manual compact FAILED');
    } finally {
      await this.cleanupTurn(turn);
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    process.stderr.write('[codex-app-server] Interrupt requested\n');
    // Outstanding interactive requests cannot outlive the turn they belong
    // to — answer them with the cancel payload so the app-server is not left
    // waiting on a turn that will never resume.
    this.approvalBridge?.cancelAll();
    await this.interruptActiveTurn(turn, 'Interrupted by user');
    await this.cleanupTurn(turn);
  }

  async respondToPermission(
    requestId: string,
    response: OpenCodePermissionResponse,
  ): Promise<void> {
    const bridge = this.approvalBridge;
    if (!bridge) {
      throw new Error('Codex app-server session is not initialized');
    }
    await bridge.respondToPermission(requestId, response);
  }

  async respondToQuestion(requestId: string, answers: string[][]): Promise<void> {
    const bridge = this.approvalBridge;
    if (!bridge) {
      throw new Error('Codex app-server session is not initialized');
    }
    await bridge.respondToQuestion(requestId, answers);
  }

  isPendingQuestion(requestId: string): boolean {
    return this.approvalBridge?.isPendingQuestion(requestId) ?? false;
  }

  async resetSession(sessionId: string): Promise<void> {
    process.stderr.write(`[codex-app-server] Reset session: ${sessionId}\n`);
    await this.settleActiveTurn('interrupted', 'Session reset');
    await this.teardownTransport();
    this.config = null;
    this.configFingerprint = null;
  }

  async deleteSession(agentSessionId: string): Promise<void> {
    if (this.threadId && agentSessionId !== this.threadId) {
      return;
    }
    const transport = this.transport;
    const threadId = this.threadId;
    await this.settleActiveTurn('interrupted', 'Session deleted');
    if (transport && threadId && transport.isConnected) {
      try {
        await transport.request('thread/delete', { threadId }, { timeoutMs: 5_000 });
      } catch (error) {
        process.stderr.write(`[codex-app-server] thread/delete failed: ${String(error)}\n`);
      }
    }
    await this.teardownTransport();
    this.config = null;
    this.configFingerprint = null;
  }

  async shutdown(): Promise<void> {
    process.stderr.write('[codex-app-server] Shutdown\n');
    await this.settleActiveTurn('interrupted', 'Sidecar shutdown');
    await this.teardownTransport();
    this.config = null;
    this.configFingerprint = null;
  }

  // ---------------------------------------------------------------------------
  // Notification handling
  // ---------------------------------------------------------------------------

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (turn) {
      turn.idleGuard.reset();
    }
    setLogCtx({
      ...(turn?.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    });

    switch (method) {
      case 'turn/started': {
        const turnId = readStringRecordField(params.turn, 'id') ?? readString(params.turnId);
        if (turn && turnId) {
          turn.turnId = turnId;
        }
        return;
      }
      case 'turn/completed': {
        if (!turn) return;
        const turnPayload = isRecord(params.turn) ? params.turn : {};
        const status = readString(turnPayload.status);
        const turnId = readString(turnPayload.id) ?? turn.turnId;
        if (turnId) {
          turn.turnId = turnId;
        }
        switch (status) {
          case 'completed':
            turn.settle({ outcome: 'completed' });
            return;
          case 'interrupted':
            turn.settle({ outcome: 'interrupted' });
            return;
          case 'failed': {
            const message = readStringRecordField(turnPayload.error, 'message') ?? 'Codex turn failed';
            process.stderr.write(`[codex-app-server] Turn failed: ${message}\n`);
            this.emitTurnEvent(turn, { kind: 'error', subtype: 'runtime', message });
            turn.settle({ outcome: 'failed', reason: message });
            return;
          }
          default:
            return;
        }
      }
      case 'item/started': {
        if (!turn) return;
        this.handleItemStarted(turn, params.item);
        return;
      }
      case 'item/completed': {
        if (!turn) return;
        this.handleItemCompleted(turn, params.item);
        return;
      }
      case 'item/agentMessage/delta': {
        if (!turn) return;
        const itemId = readString(params.itemId);
        const delta = readString(params.delta);
        if (itemId !== null && delta !== null) {
          this.emitStreamingDelta(turn, itemId, 'text', delta);
        }
        return;
      }
      case 'item/reasoning/textDelta': {
        if (!turn) return;
        const itemId = readString(params.itemId);
        const delta = readString(params.delta);
        if (itemId !== null && delta !== null) {
          this.emitStreamingDelta(turn, itemId, 'thinking', delta);
        }
        return;
      }
      case 'item/reasoning/summaryTextDelta': {
        if (!turn) return;
        const itemId = readString(params.itemId);
        const delta = readString(params.delta);
        if (itemId !== null && delta !== null) {
          this.emitStreamingDelta(turn, itemId, 'thinking', delta);
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        if (!turn) return;
        const usage = parseTokenUsage(params.tokenUsage);
        if (usage) {
          turn.usage = usage;
        }
        return;
      }
      case 'thread/compacted': {
        // Issue 08: deprecated double-channel completion signal. The
        // contextCompaction item lifecycle is the authoritative boundary
        // source; swallowing this notification keeps the boundary single.
        return;
      }
      case 'error': {
        this.handleErrorNotification(turn, params);
        return;
      }
      default:
        return;
    }
  }

  private handleErrorNotification(
    turn: ActiveTurnState | null,
    params: Record<string, unknown>,
  ): void {
    const message = readStringRecordField(params.error, 'message') ?? 'Unknown app-server error';
    const willRetry = params.willRetry === true;
    process.stderr.write(`[codex-app-server] Error notification: ${message} willRetry=${willRetry}\n`);
    if (!turn) {
      return;
    }
    if (willRetry) {
      this.emitEvent({
        type: 'sidecar_stream_status',
        message,
        is_reconnecting: true,
      });
      return;
    }
    this.emitTurnEvent(turn, { kind: 'error', subtype: 'runtime', message });
    turn.settle({ outcome: 'failed', reason: message });
  }

  private handleItemStarted(turn: ActiveTurnState, rawItem: unknown): void {
    if (!isRecord(rawItem)) {
      return;
    }
    const item = adaptAppServerItem(rawItem);
    if (!item) {
      return;
    }
    if (item.type === 'context_compaction') {
      // Issue 08: timeline loading state for the compaction item.
      turn.pendingCompactionItemIds.add(item.id);
      this.emitCompactionBoundary(turn, item.id, 'compacting');
      return;
    }
    if (item.type === 'agent_message' || item.type === 'reasoning') {
      // content_started is emitted lazily on the first delta.
      return;
    }
    const toolUse = buildCodexToolUseContent(item as never, {
      workdir: this.config?.cwd,
    });
    if (toolUse?.type === 'tool_use') {
      this.emitTurnEvent(turn, {
        kind: 'tool_started',
        toolUseId: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      });
    }
  }

  private handleItemCompleted(turn: ActiveTurnState, rawItem: unknown): void {
    if (!isRecord(rawItem)) {
      return;
    }
    const item = adaptAppServerItem(rawItem);
    if (!item) {
      return;
    }
    if (item.type === 'context_compaction') {
      // Issue 08: compaction completed — emit the terminal boundary. The
      // compaction summary itself must NOT render as an assistant message.
      turn.pendingCompactionItemIds.delete(item.id);
      this.emitCompactionBoundary(turn, item.id, 'completed');
      return;
    }
    if (item.type === 'agent_message') {
      this.completeStreamingText(turn, item.id);
      if (typeof item.text === 'string' && item.text.trim()) {
        this.emitTurnEvent(turn, {
          kind: 'assistant_message',
          content: [{ type: 'text', text: item.text }],
          providerMessageId: item.id,
          providerTurnId: turn.turnId ?? undefined,
        });
      }
      return;
    }
    if (item.type === 'reasoning') {
      this.completeStreamingText(turn, item.id);
      const text = typeof item.text === 'string' ? item.text : '';
      if (text.trim()) {
        this.emitTurnEvent(turn, {
          kind: 'assistant_message',
          content: [{ type: 'thinking', thinking: text }],
          providerMessageId: item.id,
          providerTurnId: turn.turnId ?? undefined,
        });
      }
      return;
    }
    const result = buildCodexToolResultContent(item as never);
    if (result !== null) {
      this.emitTurnEvent(turn, {
        kind: 'tool_finished',
        toolUseId: item.id,
        content: result,
        isError: isCodexToolResultError(item as never),
      });
    }
  }

  private emitStreamingDelta(
    turn: ActiveTurnState,
    itemId: string,
    kind: 'text' | 'thinking',
    delta: string,
  ): void {
    if (!this.streamingItemState.has(itemId)) {
      this.emitTurnEvent(turn, {
        kind: 'content_started',
        index: 0,
        contentKind: kind === 'thinking' ? 'reasoning' : 'text',
      });
    }
    this.streamingItemState.set(itemId, { kind });
    this.emitTurnEvent(turn, {
      kind: kind === 'thinking' ? 'reasoning_delta' : 'text_delta',
      index: 0,
      text: delta,
    });
  }

  private completeStreamingText(turn: ActiveTurnState, itemId: string): void {
    if (this.streamingItemState.delete(itemId)) {
      this.emitTurnEvent(turn, { kind: 'content_finished', index: 0 });
    }
  }

  private emitTurnEvent(turn: ActiveTurnState, source: CodexTurnSourceEvent): void {
    for (const event of turn.normalizer.accept(source)) {
      this.emitEvent(event);
    }
  }

  private emitTurnOutcome(turn: ActiveTurnState, outcome: CodexTurnOutcome): void {
    for (const event of turn.normalizer.finish(outcome)) {
      this.emitEvent(event);
    }
  }

  /**
   * Issue 08: emit a compact boundary event for a contextCompaction item.
   * `compacting` marks the timeline loading state; `completed` is the terminal
   * boundary. Both channels (item lifecycle + deprecated `thread/compacted`
   * notification) converge here with per-item dedup.
   */
  private emitCompactionBoundary(
    turn: ActiveTurnState,
    itemId: string,
    status: 'compacting' | 'completed',
  ): void {
    if (turn.emittedCompactionItemIds.has(itemId)) {
      return;
    }
    if (status === 'completed') {
      turn.emittedCompactionItemIds.add(itemId);
    }
    const trigger = turn.compactionTrigger === 'manual' ? 'manual' : 'auto';
    process.stderr.write(
      `[codex-app-server] Compaction boundary: item=${itemId} status=${status} trigger=${trigger}\n`,
    );
    this.emitEvent({
      type: 'system_event',
      subtype: 'compact_boundary',
      session_id: turn.sessionId,
      event_id: crypto.randomUUID(),
      content: 'Conversation compacted',
      compact_metadata: {
        trigger,
        status,
        pre_tokens: 0,
        post_tokens: 0,
      },
    });
  }

  /**
   * Issue 08: flush compaction items that started but never received
   * `item/completed` (observed on some app-server builds) so the timeline is
   * not left in the loading state.
   */
  private flushPendingCompactionBoundaries(turn: ActiveTurnState): void {
    for (const itemId of turn.pendingCompactionItemIds) {
      this.emitCompactionBoundary(turn, itemId, 'completed');
    }
    turn.pendingCompactionItemIds.clear();
  }

  private handleTransportError(error: Error): void {
    const turn = this.activeTurn;
    if (!turn) {
      process.stderr.write(`[codex-app-server] Transport error while idle: ${error.message}\n`);
      return;
    }
    process.stderr.write(`[codex-app-server] Transport error during turn: ${error.message}\n`);
    const message = `Codex app-server 连接中断: ${error.message}`;
    this.emitTurnEvent(turn, { kind: 'error', subtype: 'runtime', message });
    turn.settle({ outcome: 'failed', reason: message });
  }

  /**
   * A clean app-server exit (code 0) does not surface through onError, but a
   * turn pending on notifications would otherwise hang until the idle guard
   * fires — settle it as an observable failure instead.
   */
  private handleTransportExit(code: number | null, signal: NodeJS.Signals | null): void {
    const turn = this.activeTurn;
    // Abnormal exits already surface through handleTransportError (onError),
    // which runs before onExit — skip duplicates.
    if (!turn || turn.settled) {
      return;
    }
    process.stderr.write(
      `[codex-app-server] Process exited during turn: code=${code ?? 'null'} signal=${signal ?? 'null'}\n`,
    );
    const message = `Codex app-server 进程退出 (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
    this.emitTurnEvent(turn, { kind: 'error', subtype: 'runtime', message });
    turn.settle({ outcome: 'failed', reason: message });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async startOrResumeThread(
    config: CodexSessionBootstrap,
    threadParams: Record<string, unknown>,
  ): Promise<{
    threadId: string;
    resumed: boolean;
    rebuilt: { previousAgentSessionId: string; reason: string } | null;
  }> {
    const transport = this.transport;
    if (!transport) {
      throw new Error('App-server transport was not established');
    }
    if (config.agentSessionId) {
      try {
        const result = await transport.request<{ thread?: { id?: string } }>(
          'thread/resume',
          { threadId: config.agentSessionId, ...threadParams },
        );
        const threadId = readStringRecordField(result.thread, 'id');
        if (threadId) {
          return { threadId, resumed: true, rebuilt: null };
        }
        throw new Error('thread/resume succeeded but returned no thread id');
      } catch (error) {
        // Issue 04: the mapped native session is gone (e.g. history rotated or
        // the rollout file was removed). Fall back to a fresh thread and swap
        // the mapping so the conversation can continue.
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[codex-app-server] thread/resume failed for ${config.agentSessionId}; rebuilding native session: ${reason}\n`,
        );
        return {
          threadId: await this.startThread(transport, threadParams),
          resumed: false,
          rebuilt: { previousAgentSessionId: config.agentSessionId, reason },
        };
      }
    }
    return {
      threadId: await this.startThread(transport, threadParams),
      resumed: false,
      rebuilt: null,
    };
  }

  private async startThread(
    transport: AppServerTransport,
    threadParams: Record<string, unknown>,
  ): Promise<string> {
    const result = await transport.request<{ thread?: { id?: string } }>(
      'thread/start',
      threadParams,
    );
    const threadId = readStringRecordField(result.thread, 'id');
    if (!threadId) {
      throw new Error('thread/start succeeded but returned no thread id');
    }
    return threadId;
  }

  private resolvePermissionOptions(): CodexTurnPolicy | null {
    const config = this.config;
    if (!config) {
      return null;
    }
    return buildCodexThreadPermissionOptions(
      config.permissionConfig,
      config.planMode ?? 'off',
    );
  }

  private loadRuntimeIfNeeded(): RuntimeLoadResult {
    const runtimeRef = this.config?.runtimeRef;
    if (!runtimeRef) {
      throw new Error('Codex Runtime is required before starting a session');
    }
    const result = loadProviderRuntime(runtimeRef);
    if (isRuntimeError(result)) {
      throw new Error(`Codex Runtime 加载失败: ${result.message}`);
    }
    return result;
  }

  private async syncModelCatalog(
    model: string | undefined,
    contextWindow?: number,
    inputModalities?: string[],
  ): Promise<string | null> {
    const modelId = model?.trim();
    if (!modelId) {
      return null;
    }
    try {
      const catalogPath = await ensureCodexModelCatalog(
        [{
          id: modelId,
          contextWindow: contextWindow && contextWindow > 0
            ? contextWindow
            : DEFAULT_CODEX_CONTEXT_WINDOW,
          ...(inputModalities ? { inputModalities } : {}),
        }],
        resolveCodexModelCatalogPath(),
      );
      if (catalogPath) {
        process.stderr.write(`[codex-app-server] Ensured model catalog entry for ${modelId} at ${catalogPath}\n`);
      }
      return catalogPath;
    } catch (error) {
      process.stderr.write(`[codex-app-server] Failed to sync model catalog for ${modelId}: ${String(error)}\n`);
      return null;
    }
  }

  private async interruptActiveTurn(turn: ActiveTurnState, reason: string): Promise<void> {
    const transport = this.transport;
    const threadId = this.threadId;
    turn.settle({ outcome: 'interrupted', reason });
    if (!transport || !threadId || !turn.turnId) {
      return;
    }
    try {
      await transport.request('turn/interrupt', { threadId, turnId: turn.turnId }, { timeoutMs: 5_000 });
    } catch (error) {
      process.stderr.write(`[codex-app-server] turn/interrupt failed: ${String(error)}\n`);
    }
  }

  private async settleActiveTurn(outcome: 'interrupted', reason: string): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    turn.settle({ outcome, reason });
    // Give the pending sendInput await a chance to run its finally cleanup.
    await new Promise((resolve) => setImmediate(resolve));
  }

  private async cleanupTurn(turn: ActiveTurnState): Promise<void> {
    if (turn.cleanedUp) {
      return;
    }
    turn.cleanedUp = true;
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
    turn.idleGuard.dispose();
    this.streamingItemState.clear();
    await cleanupTempImageFiles(turn.imagePaths);
    this.emitEvent({ type: 'sidecar_query_done' });
  }

  /**
   * ADR 0004: while an interactive request is pending the turn is legitimately
   * idle waiting for the user — suspend the idle guard so it is not mistaken
   * for an engine stall. Resolving the last request re-arms the window.
   */
  private syncIdleGuardWithApprovals(pendingCount: number): void {
    const guard = this.activeTurn?.idleGuard;
    if (!guard) {
      return;
    }
    if (pendingCount > 0) {
      guard.suspend();
      return;
    }
    guard.resume();
  }

  private async teardownTransport(): Promise<void> {
    this.approvalBridge?.dispose();
    this.approvalBridge = null;
    const transport = this.transport;
    this.transport = null;
    this.threadId = null;
    this.streamingItemState.clear();
    if (transport) {
      await transport.stop().catch((error) => {
        process.stderr.write(`[codex-app-server] Transport teardown failed: ${String(error)}\n`);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function defaultConnectTransport(
  options: AppServerTransportOptions,
): Promise<AppServerTransport> {
  return AppServerTransport.connect(options);
}

function normalizeCodexPlanMode(value: unknown): AgentPlanMode | undefined {
  if (value === 'on' || value === 'off') {
    return value;
  }
  return undefined;
}

function buildAppServerEnv(config: CodexSessionBootstrap): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (config.apiKey) {
    env.OPENAI_API_KEY = config.apiKey;
  }
  // Official upstream (or a directly reachable OpenAI-compatible endpoint).
  // Compat-proxy routing is intentionally NOT handled here (Issue 09).
  if (config.upstreamBaseUrl) {
    env.OPENAI_BASE_URL = config.upstreamBaseUrl;
  }
  applyCodexWindowsSandboxPathCompatibility(env as Record<string, string>);
  return env;
}

function buildAppServerSandboxPolicy(
  sandboxMode: CodexSandboxMode,
  networkAccessEnabled: boolean,
  cwd: string,
): AppServerSandboxPolicy {
  switch (sandboxMode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: networkAccessEnabled };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: networkAccessEnabled,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
  }
}

/** Converts agentInputPayload entries to app-server `UserInput` wire items. */
function buildAppServerUserInput(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entries.map((entry) => {
    if (entry.type === 'local_image') {
      return { type: 'localImage', path: entry.path };
    }
    if (entry.type === 'text') {
      return { type: 'text', text: entry.text, text_elements: [] };
    }
    return entry;
  });
}

type AdaptedItem = Record<string, unknown> & { type: string; id: string };

/**
 * Adapts an app-server ThreadItem (camelCase) to the SDK-shaped item consumed
 * by the shared runtimeEvents tool-use/result builders (snake_case).
 */
function adaptAppServerItem(item: Record<string, unknown>): AdaptedItem | null {
  const id = readString(item.id);
  if (id === null) {
    return null;
  }
  switch (item.type) {
    case 'agentMessage':
      return { type: 'agent_message', id, text: readString(item.text) ?? '' };
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      const text = [...summary, ...content]
        .filter((part): part is string => typeof part === 'string')
        .join('\n\n');
      return { type: 'reasoning', id, text };
    }
    case 'commandExecution':
      return {
        type: 'command_execution',
        id,
        command: readString(item.command) ?? '',
        cwd: readString(item.cwd) ?? '',
        aggregated_output: readString(item.aggregatedOutput) ?? '',
        exit_code: typeof item.exitCode === 'number' ? item.exitCode : null,
        status: adaptItemStatus(item.status),
      };
    case 'fileChange':
      return {
        type: 'file_change',
        id,
        changes: Array.isArray(item.changes) ? item.changes : [],
        status: adaptItemStatus(item.status),
      };
    case 'mcpToolCall':
      return {
        type: 'mcp_tool_call',
        id,
        server: readString(item.server) ?? '',
        tool: readString(item.tool) ?? '',
        arguments: item.arguments ?? {},
        status: adaptItemStatus(item.status),
        error: isRecord(item.error) ? item.error : undefined,
        result: isRecord(item.result) ? item.result : undefined,
      };
    case 'webSearch':
      return { type: 'web_search', id, query: readString(item.query) ?? '' };
    case 'contextCompaction':
      // Issue 08: manual/auto context compaction item.
      return { type: 'context_compaction', id };
    default:
      return null;
  }
}

function adaptItemStatus(value: unknown): string {
  switch (value) {
    case 'inProgress':
      return 'in_progress';
    case 'completed':
    case 'failed':
    case 'declined':
      return value;
    default:
      return 'in_progress';
  }
}

function parseTokenUsage(value: unknown): CodexTurnUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  // Prefer the last-turn breakdown; fall back to the cumulative totals.
  const breakdown = isRecord(value.last) ? value.last : isRecord(value.total) ? value.total : null;
  if (!breakdown) {
    return null;
  }
  return {
    input_tokens: readFiniteNumber(breakdown.inputTokens) ?? 0,
    output_tokens: readFiniteNumber(breakdown.outputTokens) ?? 0,
    cached_input_tokens: readFiniteNumber(breakdown.cachedInputTokens) ?? 0,
    reasoning_output_tokens: readFiniteNumber(breakdown.reasoningOutputTokens) ?? 0,
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStringRecordField(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return readString(value[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
