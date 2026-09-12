// Codex App Server Runtime — ADR 0010 replacement seam.
//
// Drives `codex app-server --stdio` over the AppServerTransport JSON-RPC
// connection: `ensure` spawns a long-lived app-server process and starts (or
// resumes) a thread, `sendInput` runs a turn and normalizes app-server
// notifications into the existing CodeMUX Event protocol via
// CodexTurnEventNormalizer. Official OpenAI endpoints are dialed directly;
// providers flagged `codex_needs_proxy` route through the shared compat proxy
// (Issue 09). Fork reuses this long-lived connection via `thread/fork`
// (Issue 10). Plan Mode runs through `collaborationMode` presets and closes
// with a synthetic Plan Approval Interactive Request (Issue 07).

import type { SidecarCommand, SidecarModelLimits } from './types.js';
import type { ProviderRuntimeRef } from './runtimeContract.js';
import type { PiMcpServers } from './piMcp.js';
import {
  isRuntimeError,
  loadProviderRuntime,
  resolveCodexFromRuntime,
  type RuntimeLoadResult,
} from './runtimeLoader.js';
import {
  AppServerTransport,
  AppServerRpcRequestError,
  CODEX_APP_SERVER_DEFAULT_ARGS,
  type AppServerTransportOptions,
} from './appServerTransport.js';
import {
  CodexAppServerApprovalBridge,
  isDeclinedPermissionResponse,
} from './codexAppServerApprovals.js';
import type { OpenCodePermissionResponse } from './opencodePermissions.js';
import {
  CodexTurnEventNormalizer,
  type CodexTurnOutcome,
  type CodexTurnSourceEvent,
  type CodexTurnUsage,
} from './codexTurnEventNormalizer.js';
import { TurnArtifactAggregator } from './turnArtifactSummary.js';
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
  adaptAppServerItem,
  buildCodexToolResultContent,
  buildCodexToolUseContent,
  isCodexToolResultError,
  type CodexThreadItem,
} from './runtimeEvents.js';
import {
  resolveTurnTimeouts,
  type ResolvedTurnTimeouts,
  type TurnTimeouts,
} from './turnTimeouts.js';
import { createTurnIdleGuard, type TurnIdleGuard } from './turnIdleGuard.js';
import {
  applyCodexWindowsSandboxPathCompatibility,
  shouldUseCodexChatCompatProxy,
} from './sessionRuntimeHelpers.js';
import { proxyManager } from './proxyManager.js';
import { setLogCtx, writeLog } from './writeLog.js';
import {
  DEFAULT_CODEX_CONTEXT_WINDOW,
  ensureCodexModelCatalog,
  resolveCodexModelCatalogPath,
} from './codexModelCatalog.js';
import type { CodeMuxSubagentEvent } from './codeMuxProtocol.js';
import { CodexSubagentSource, type CodexSubagentContext } from './codexSubagentSource.js';
import { isSteerBlockedPrompt, SteerUnavailableError } from './steer.js';

export { emit } from './streamEventBatcher.js';

type EnsureSessionCommand = Extract<SidecarCommand, { type: 'ensure_session' }>;
type UpdatePermissionsCommand = Extract<SidecarCommand, { type: 'update_permissions' }>;

const TURN_IDLE_TIMEOUT_MESSAGE = 'Turn idle timeout: no progress events received';
const DEFAULT_CODEX_MODEL = 'o4-mini';
/** Prompt sent as the automatic implementation turn after Plan Approval (Issue 07). */
const PLAN_IMPLEMENTATION_PROMPT = '请按照上面的计划开始实施。';

/** `collaborationMode/list` preset entry (CollaborationModeMask on the wire). */
type CollaborationModeMask = {
  name: string;
  mode?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
};

/**
 * Fallback presets matching the stock Codex CLI response, used when
 * `collaborationMode/list` is unavailable on older builds.
 */
const FALLBACK_PLAN_MODE_MASK: CollaborationModeMask = { name: 'Plan', mode: 'plan' };
const FALLBACK_DEFAULT_MODE_MASK: CollaborationModeMask = { name: 'Default', mode: 'default' };

type PendingPlanApproval = {
  requestId: string;
  /** `abort` signals the transport died while the approval was pending. */
  resolve: (decision: 'implement' | 'dismiss' | 'abort') => void;
};

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
  /**
   * Issue 09: base URL the app-server should dial — the local compat proxy
   * listening URL when the provider needs protocol translation, otherwise the
   * upstream endpoint directly.
   */
  effectiveBaseUrl?: string;
  codexNeedsProxy?: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionConfig?: SidecarPermissionConfig;
  planMode?: AgentPlanMode;
  runtimeRef?: ProviderRuntimeRef;
  timeouts?: TurnTimeouts;
  modelLimits?: SidecarModelLimits;
  /** daemon 随会话命令下发的 MCP 服务器(落 -c mcp_servers.* 覆盖)。 */
  mcpServers?: PiMcpServers;
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
  /** Issue 07: latest completed assistant text, used as the Plan Approval body. */
  lastAssistantText: string;
  /** Issue 07: authoritative plan text from a completed `plan` item, if any. */
  planText: string;
  artifactAggregator: TurnArtifactAggregator;
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
  /** Issue 07: collaboration mode presets resolved via `collaborationMode/list`. */
  private planModeMask: CollaborationModeMask = FALLBACK_PLAN_MODE_MASK;
  private defaultModeMask: CollaborationModeMask = FALLBACK_DEFAULT_MODE_MASK;
  /** Issue 07: synthetic Plan Approval waiting for the user's Implement/Dismiss. */
  private pendingPlanApproval: PendingPlanApproval | null = null;
  /** ADR 0004 inputs: outstanding approval-bridge requests and the plan hold. */
  private bridgePendingRequests = 0;
  private planApprovalPending = false;
  /** Codex collab subagent adapter: child-thread routes and timelines. */
  private readonly subagents = new CodexSubagentSource();

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
      codexNeedsProxy: cmd.codexNeedsProxy,
      model: cmd.model,
      reasoningEffort: normalizeReasoningEffort(cmd.reasoningEffort),
      permissionConfig: cmd.permissionConfig,
      planMode: normalizeCodexPlanMode(cmd.planMode),
      runtimeRef: cmd.runtimeRef,
      timeouts: cmd.timeouts,
      modelLimits: cmd.modelLimits,
      mcpServers: cmd.mcpServers,
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

    // Issue 09: providers flagged codex_needs_proxy (or non-official hosts)
    // route through the shared compat proxy; official OpenAI dials directly.
    const effectiveBaseUrl = await this.resolveUpstreamRouting(requestedConfig);
    const config: CodexSessionBootstrap = {
      ...requestedConfig,
      ...(effectiveBaseUrl !== undefined ? { effectiveBaseUrl } : {}),
    };

    this.configFingerprint = nextFingerprint;
    this.config = config;

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
      // Session-scoped `-c` overrides must win over the user's global
      // ~/.codex/config.toml, whose `model_provider`/`base_url` would otherwise
      // pin every session to whatever upstream the standalone Codex CLI last
      // selected (config wins over the OPENAI_BASE_URL env var).
      args: [
        // `config` (not requestedConfig): carries effectiveBaseUrl — the
        // compat-proxy listening URL when codex_needs_proxy routing is on.
        ...buildAppServerConfigOverrides(config),
        ...CODEX_APP_SERVER_DEFAULT_ARGS,
      ],
      env: buildAppServerEnv(config),
      // The approval bridge registers an `mcpServer/elicitation/request`
      // handler, so the matching initialize capability must be declared.
      mcpServerElicitation: true,
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

    // Issue 07: resolve the collaboration mode presets once per app-server
    // connection so plan/default turns can pass explicit collaborationMode.
    await this.resolveCollaborationModes(transport);

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
    // Only an explicit planMode flips the stored toggle — an absent value must
    // not rewrite the config (and its ensure fingerprint).
    const planMode = normalizeCodexPlanMode(cmd.planMode) ?? this.config?.planMode;
    if (this.config) {
      this.config = {
        ...this.config,
        sessionId: cmd.sessionId ?? this.config.sessionId,
        permissionConfig: cmd.permissionConfig,
        ...(planMode !== undefined ? { planMode } : {}),
      };
      // Keep the ensure fingerprint in sync so a follow-up ensure with the new
      // permission snapshot does not tear down a healthy app-server process.
      this.configFingerprint = this.requestFingerprint();
    }
    process.stderr.write(
      `[codex-app-server] Permissions updated: session_id=${cmd.sessionId || this.config?.sessionId || 'none'} plan_mode=${planMode ?? 'off'}${this.activeTurn ? ' (next turn)' : ''}\n`,
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

  async steerActiveTurn(prompt: string, inputPayload?: AgentInputPayload): Promise<void> {
    const config = this.config;
    const transport = this.transport;
    const turn = this.activeTurn;
    if (!config || !transport || !this.threadId || !turn?.turnId) {
      throw new SteerUnavailableError('no active Codex turn to steer');
    }
    const payload = normalizeAgentInputPayload(prompt, inputPayload);
    if (isSteerBlockedPrompt(payload.text)) {
      throw new SteerUnavailableError('slash commands cannot steer an active Codex turn');
    }
    const imagePaths = await writePayloadImagesToTempFiles(payload);
    turn.imagePaths.push(...imagePaths);
    try {
      await transport.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: turn.turnId,
        input: buildAppServerUserInput(buildCodexInputEntries(payload, imagePaths, true)),
      });
    } catch (error) {
      if (isCodexSteerUnavailable(error)) {
        throw new SteerUnavailableError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    writeLog('[codex-app-server]', `steer QUEUED prompt_preview=${payload.text.slice(0, 120)}`);
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
      const planFollowUp = await this.runInput(prompt, inputPayload, true);
      if (planFollowUp !== null) {
        // Issue 07: the user approved the plan — automatically start the
        // implementation turn with Plan Mode already closed.
        await this.runInput(PLAN_IMPLEMENTATION_PROMPT, undefined, false);
      }
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
      const planFollowUp = await this.runInput(prompt, inputPayload, false);
      if (planFollowUp !== null) {
        await this.runInput(PLAN_IMPLEMENTATION_PROMPT, undefined, false);
      }
    }
  }

  /**
   * Runs a single app-server turn. Returns the Issue 07 implementation
   * follow-up prompt when the turn was a plan turn whose Plan Approval the
   * user approved — sendInput then starts that turn automatically.
   */
  private async runInput(
    prompt: string,
    inputPayload: AgentInputPayload | undefined,
    includeImages: boolean,
  ): Promise<string | null> {
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
    const planRequested = config.planMode === 'on';
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
      artifactAggregator: new TurnArtifactAggregator(config.cwd),
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
      lastAssistantText: '',
      planText: '',
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
      // Issue 07: always pin the collaboration mode — overrides persist for
      // subsequent turns, so plan-off turns must explicitly restore `default`.
      turnParams.collaborationMode = buildTurnCollaborationMode(
        planRequested ? this.planModeMask : this.defaultModeMask,
        model,
      );
      if (!planRequested && config.reasoningEffort) {
        // User-chosen effort rides the top-level param; only the plan preset
        // contributes its own reasoning_effort via the mask settings.
        turnParams.effort = mapToCodexEffort(config.reasoningEffort);
      }

      const ack = transport.request('turn/start', turnParams, { timeoutMs: 0 });
      // Late rejections (e.g. connection torn down after a crash already
      // settled the turn) must not surface as unhandled.
      ack.catch(() => undefined);
      // Race the ack against settle paths (crash / interrupt / idle timeout)
      // so a hanging turn/start response cannot deadlock the turn.
      await Promise.race([ack, completion]);
      let outcome = await completion;

      if (outcome.outcome === 'completed') {
        // Issue 08: auto-compaction may complete the contextCompaction item
        // without an `item/completed` notification on some builds — flush the
        // boundary before the turn finishes.
        this.flushPendingCompactionBoundaries(turn);
      }
      if (planRequested && outcome.outcome === 'completed' && turn.lastAssistantText.trim()) {
        // Issue 07: hold the turn open as an Interactive Request until the user
        // chooses Implement or Dismiss (ADR 0004 — idle guard suspended).
        const decision = await this.requestPlanApproval(turn, turn.planText || turn.lastAssistantText);
        if (decision === 'implement') {
          this.closePlanMode();
          outcome = { ...outcome, outcome: 'completed' };
          this.emitTurnOutcome(turn, {
            ...outcome,
            durationMs: Date.now() - startedAt,
            ...(turn.usage ? { usage: turn.usage } : {}),
          });
          writeLog('[codex-app-server]', 'sendInput COMPLETE outcome=completed (plan approved)');
          return PLAN_IMPLEMENTATION_PROMPT;
        }
        if (decision === 'abort') {
          // The transport died while the approval was pending — the error
          // event is already emitted; finish with a failed outcome.
          const reason = 'Codex app-server 连接中断，计划审批已中止';
          this.emitTurnOutcome(turn, {
            outcome: 'failed',
            reason,
            durationMs: Date.now() - startedAt,
          });
          writeLog('[codex-app-server]', 'sendInput FAILED (plan approval aborted)');
          return null;
        }
      }
      this.emitTurnOutcome(turn, {
        ...outcome,
        durationMs: Date.now() - startedAt,
        ...(turn.usage ? { usage: turn.usage } : {}),
      });
      writeLog('[codex-app-server]', `sendInput COMPLETE outcome=${outcome.outcome}`);
      return null;
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
      return null;
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
      artifactAggregator: new TurnArtifactAggregator(config.cwd),
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
      lastAssistantText: '',
      planText: '',
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
    this.dismissPendingPlanApproval();
    await this.interruptActiveTurn(turn, 'Interrupted by user');
    this.failRunningSubagents();
    await this.cleanupTurn(turn);
  }

  /**
   * Issue 10: fork on the long-lived app-server connection via `thread/fork`.
   * The child thread gets a fresh native id; the parent runtime's own thread
   * mapping stays untouched.
   */
  async forkSession(
    sourceAgentSessionId?: string,
    sourceProviderTurnId?: string,
    sourceProviderTurnOrdinal?: number,
  ): Promise<string> {
    const config = this.config;
    const transport = this.transport;
    if (!config || !transport) {
      throw new Error('Codex session has not been created yet');
    }
    if (this.activeTurn) {
      throw new Error('Cannot fork while a Codex turn is active');
    }
    const sourceThreadId = sourceAgentSessionId ?? config.agentSessionId ?? this.threadId;
    if (!sourceThreadId) {
      throw new Error('Codex session has no provider thread ID');
    }

    let lastTurnId = sourceProviderTurnId;
    if (!lastTurnId && sourceProviderTurnOrdinal !== undefined) {
      lastTurnId = await this.resolveProviderTurnId(transport, sourceThreadId, sourceProviderTurnOrdinal);
    }

    const params: Record<string, unknown> = {
      threadId: sourceThreadId,
      ...(lastTurnId ? { lastTurnId } : {}),
    };
    const result = await transport.request<{ thread?: { id?: string; sessionId?: string } }>(
      'thread/fork',
      params,
      { timeoutMs: 30_000 },
    );
    const childThreadId = readStringRecordField(result.thread, 'id')
      ?? readStringRecordField(result.thread, 'sessionId');
    if (!childThreadId) {
      throw new Error('Codex app-server fork response did not include a thread ID');
    }
    process.stderr.write(
      `[codex-app-server] Forked thread ${sourceThreadId}${lastTurnId ? ` at turn ${lastTurnId}` : ''} -> ${childThreadId}\n`,
    );
    return childThreadId;
  }

  private async resolveProviderTurnId(
    transport: AppServerTransport,
    threadId: string,
    ordinal: number,
  ): Promise<string> {
    const result = await transport.request<{
      data?: Array<{ id?: string }>;
      thread?: { turns?: Array<{ id?: string }> };
    }>(
      'thread/turns/list',
      { threadId, limit: 200, sortDirection: 'asc', itemsView: 'summary' },
      { timeoutMs: 15_000 },
    );
    const turns = Array.isArray(result.data)
      ? result.data
      : Array.isArray(result.thread?.turns)
        ? result.thread.turns
        : [];
    const turnId = readString(turns[ordinal]?.id);
    if (!turnId) {
      throw new Error(`Codex provider turn ${ordinal} was not found`);
    }
    return turnId;
  }

  async respondToPermission(
    requestId: string,
    response: OpenCodePermissionResponse,
  ): Promise<void> {
    const planApproval = this.pendingPlanApproval;
    if (planApproval && planApproval.requestId === requestId) {
      const decision = isDeclinedPermissionResponse(response) ? 'dismiss' : 'implement';
      process.stderr.write(
        `[codex-app-server] Plan approval ${requestId} responded: ${decision}\n`,
      );
      planApproval.resolve(decision);
      this.emitPermissionResolved(requestId, 'permission');
      return;
    }
    const bridge = this.approvalBridge;
    if (!bridge) {
      throw new Error('Codex app-server session is not initialized');
    }
    await bridge.respondToPermission(requestId, response);
    this.emitPermissionResolved(requestId, 'permission');
  }

  async respondToQuestion(requestId: string, answers: string[][]): Promise<void> {
    const bridge = this.approvalBridge;
    if (!bridge) {
      throw new Error('Codex app-server session is not initialized');
    }
    await bridge.respondToQuestion(requestId, answers);
    this.emitPermissionResolved(requestId, 'question');
  }

  /**
   * Issue 12: broadcast the resolution so every surface (desktop and Mobile
   * Companion) clears its pending Interactive Request UI — the responder's
   * own client cannot be assumed to be the only one showing it.
   */
  private emitPermissionResolved(requestId: string, requestKind: 'permission' | 'question'): void {
    this.emitEvent({
      type: 'permission_resolved',
      session_id: this.config?.sessionId ?? '',
      request_id: requestId,
      request_kind: requestKind,
    });
  }

  isPendingQuestion(requestId: string): boolean {
    return this.approvalBridge?.isPendingQuestion(requestId) ?? false;
  }

  async resetSession(sessionId: string): Promise<void> {
    process.stderr.write(`[codex-app-server] Reset session: ${sessionId}\n`);
    this.dismissPendingPlanApproval();
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
    this.dismissPendingPlanApproval();
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
    this.dismissPendingPlanApproval();
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
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    setLogCtx({
      ...(turn?.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    });

    // Collab subagent threads stream on the same connection, tagged with the
    // child threadId. Route them into the subagent track before any
    // parent-turn projection can misattribute them.
    const route = this.subagents.routeThreadId(threadId, this.threadId);
    if (route === 'child') {
      this.emitSubagentEvents(this.subagents.observeChildNotification(method, params, this.subagentContext()));
      return;
    }
    if (route === 'pending') {
      // Unclaimed child thread: buffer until a collabAgentToolCall declares it.
      this.subagents.bufferPendingNotification(threadId!, method, params);
      return;
    }

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
        // Collab items declare subagent tracks before the card is projected.
        this.emitSubagentEvents(this.subagents.observeParentItem(params.item, 'started', this.subagentContext()));
        if (!turn) return;
        // A re-announced spawn (codex repeats the item with thread ids once
        // the children exist) must not render a duplicate parent card.
        if (isAliasCollabItem(params.item, this.subagents)) return;
        this.handleItemStarted(turn, params.item);
        return;
      }
      case 'item/completed': {
        this.emitSubagentEvents(this.subagents.observeParentItem(params.item, 'completed', this.subagentContext()));
        if (!turn) return;
        this.handleItemCompleted(turn, retargetAliasCollabItem(params.item, this.subagents));
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
        // Issue 08: deprecated double-channel completion signal, kept as a
        // complementary fallback. The contextCompaction item lifecycle stays
        // authoritative; per-item dedup applies, and builds that emit no item
        // lifecycle at all still get a boundary so the marker is never lost.
        if (!turn) return;
        this.completeCompactionFromNotification(turn);
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
    if (item.type === 'agent_message' || item.type === 'reasoning' || item.type === 'plan') {
      // content_started is emitted lazily on the first delta (plan items are
      // only surfaced through the Issue 07 Plan Approval).
      return;
    }
    const toolUse = buildCodexToolUseContent(item, {
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
        turn.lastAssistantText = turn.lastAssistantText
          ? `${turn.lastAssistantText}\n\n${item.text}`
          : item.text;
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
    if (item.type === 'plan') {
      // Issue 07: the completed plan item carries the authoritative plan
      // markdown for the Plan Approval card — not a chat message.
      if (typeof item.text === 'string' && item.text.trim()) {
        turn.planText = item.text;
      }
      return;
    }
    const result = buildCodexToolResultContent(item);
    if (result !== null) {
      if (item.type === 'file_change' && !isCodexToolResultError(item) && item.changes?.length) {
        turn.artifactAggregator.recordApplyPatchCompletion(item.id, item.changes);
      }
      this.emitTurnEvent(turn, {
        kind: 'tool_finished',
        toolUseId: item.id,
        content: result,
        isError: isCodexToolResultError(item),
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
      turn.artifactAggregator.observe(event as Record<string, unknown>);
      this.emitEvent(event);
    }
  }

  private emitTurnOutcome(turn: ActiveTurnState, outcome: CodexTurnOutcome): void {
    const summary = turn.artifactAggregator.flushSummary(turn.sessionId);
    if (summary) {
      this.emitEvent(summary);
    }
    turn.artifactAggregator.reset();
    for (const event of turn.normalizer.finish(outcome)) {
      this.emitEvent(event);
    }
  }

  private subagentContext(): CodexSubagentContext {
    return {
      ...(this.config?.sessionId ? { sessionId: this.config.sessionId } : {}),
      ...(this.config?.cwd ? { workdir: this.config.cwd } : {}),
    };
  }

  private emitSubagentEvents(events: CodeMuxSubagentEvent[]): void {
    for (const event of events) {
      this.emitEvent(event);
    }
  }

  /** User Stop / transport loss: no surviving children outlive the connection. */
  private failRunningSubagents(): void {
    this.emitSubagentEvents(this.subagents.failRunningTasks(this.subagentContext()));
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
    // The app-server protocol carries no post-compaction token count on
    // either channel; the last known context size (input + cached input) is
    // the closest faithful `pre_tokens` value.
    const usage = turn.usage;
    const preTokens = usage ? usage.input_tokens + usage.cached_input_tokens : 0;
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
        pre_tokens: preTokens,
        post_tokens: 0,
      },
    });
  }

  /**
   * Issue 08: `thread/compacted` (deprecated) complementary completion
   * signal. The contextCompaction item lifecycle remains authoritative —
   * pending items are flushed now (a later `item/completed` for the same ids
   * is deduped), and builds that emit no item lifecycle at all still get a
   * synthetic boundary.
   */
  private completeCompactionFromNotification(turn: ActiveTurnState): void {
    if (turn.pendingCompactionItemIds.size > 0) {
      this.flushPendingCompactionBoundaries(turn);
      return;
    }
    if (turn.emittedCompactionItemIds.size > 0) {
      return;
    }
    this.emitCompactionBoundary(turn, `thread-compacted:${turn.turnId ?? 'unknown'}`, 'completed');
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
    this.failRunningSubagents();
    this.abortPendingPlanApproval();
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
    this.failRunningSubagents();
    this.abortPendingPlanApproval();
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
    return buildCodexThreadPermissionOptions(config.permissionConfig);
  }

  /** Serializes the request-shaped config (excluding derived fields) for ensure dedup. */
  private requestFingerprint(): string | null {
    if (!this.config) {
      return null;
    }
    const { effectiveBaseUrl: _derived, ...requestShape } = this.config;
    return JSON.stringify(requestShape);
  }

  /**
   * Issue 09: resolves the base URL the app-server dials. Providers flagged
   * `codex_needs_proxy` (or non-official hosts) go through the shared compat
   * proxy; official OpenAI connects directly. Returns undefined when the
   * upstream is unset.
   */
  private async resolveUpstreamRouting(config: CodexSessionBootstrap): Promise<string | undefined> {
    const upstream = config.upstreamBaseUrl;
    if (!upstream) {
      return undefined;
    }
    if (!config.apiKey || !shouldUseCodexChatCompatProxy(upstream, config.codexNeedsProxy)) {
      return upstream;
    }
    let started: { port: number } | null = null;
    try {
      started = await proxyManager.start(config.apiKey, upstream, undefined, config.codexNeedsProxy);
    } catch (error) {
      throw new Error(
        `Codex compat 代理启动失败（第三方上游 ${upstream}）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!started) {
      // proxyManager judged the proxy unnecessary (official host) — dial direct.
      return upstream;
    }
    const localUrl = proxyManager.getBaseUrl() ?? `http://127.0.0.1:${started.port}`;
    process.stderr.write(
      `[codex-app-server] Using chat-compat proxy upstream=${upstream} local=${localUrl}\n`,
    );
    return localUrl;
  }

  /**
   * Issue 07: fetches the collaboration mode presets. Older app-server builds
   * without `collaborationMode/list` fall back to the stock plan/default pair.
   */
  private async resolveCollaborationModes(transport: AppServerTransport): Promise<void> {
    try {
      const result = await transport.request<{ data?: CollaborationModeMask[] }>(
        'collaborationMode/list',
        {},
        { timeoutMs: 15_000 },
      );
      const masks = Array.isArray(result.data) ? result.data : [];
      const plan = masks.find((mask) => mask.mode === 'plan');
      const fallback = masks.find((mask) => mask.mode === 'default');
      this.planModeMask = plan ?? FALLBACK_PLAN_MODE_MASK;
      this.defaultModeMask = fallback ?? FALLBACK_DEFAULT_MODE_MASK;
      process.stderr.write(
        `[codex-app-server] Collaboration modes resolved: plan=${this.planModeMask.name} default=${this.defaultModeMask.name}\n`,
      );
    } catch (error) {
      this.planModeMask = FALLBACK_PLAN_MODE_MASK;
      this.defaultModeMask = FALLBACK_DEFAULT_MODE_MASK;
      process.stderr.write(
        `[codex-app-server] collaborationMode/list unavailable, using built-in presets: ${String(error)}\n`,
      );
    }
  }

  /**
   * Issue 07: synthesizes the Plan Approval Interactive Request and waits for
   * the user's Implement/Dismiss decision (or the approval timeout, which
   * counts as Dismiss). The idle guard is suspended while waiting (ADR 0004).
   */
  private requestPlanApproval(turn: ActiveTurnState, planText: string): Promise<'implement' | 'dismiss' | 'abort'> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timeoutMs = this.timeouts.approval_timeout_ms;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const entry: PendingPlanApproval = {
        requestId,
        resolve: (decision) => {
          if (timer) {
            clearTimeout(timer);
          }
          if (this.pendingPlanApproval === entry) {
            this.pendingPlanApproval = null;
          }
          this.planApprovalPending = false;
          this.syncIdleGuard();
          resolve(decision);
        },
      };
      this.pendingPlanApproval = entry;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          process.stderr.write('[codex-app-server] Plan approval timed out; treating as dismissed\n');
          entry.resolve('dismiss');
        }, timeoutMs);
        if (timer.unref) timer.unref();
      }
      this.planApprovalPending = true;
      this.syncIdleGuard();
      process.stderr.write(`[codex-app-server] Plan approval pending as ${requestId}\n`);
      this.emitEvent({
        type: 'permission_requested',
        session_id: turn.sessionId,
        sequence: 0,
        event_id: crypto.randomUUID(),
        request_id: requestId,
        permission_id: requestId,
        permission_type: 'plan_approval',
        description: 'Codex 已提交实施计划，请确认后执行。',
        metadata: {
          presentation: 'plan-approval',
          title: '实施计划',
          plan: planText,
        },
      });
    });
  }

  /** Issue 07: closes Plan Mode after Implement and informs the frontend. */
  private closePlanMode(): void {
    if (!this.config || this.config.planMode !== 'on') {
      return;
    }
    this.config = { ...this.config, planMode: 'off' };
    this.configFingerprint = this.requestFingerprint();
    this.emitEvent({
      type: 'permission_mode_changed',
      session_id: this.config.sessionId ?? '',
      plan_mode: 'off',
    });
  }

  /** Resolves a pending Plan Approval as dismissed (interrupt/teardown). */
  private dismissPendingPlanApproval(): void {
    this.pendingPlanApproval?.resolve('dismiss');
  }

  /**
   * Resolves a pending Plan Approval as aborted — the transport died while the
   * user was deciding, so the held turn must fail instead of hanging forever.
   */
  private abortPendingPlanApproval(): void {
    if (this.pendingPlanApproval) {
      process.stderr.write('[codex-app-server] Aborting pending plan approval after transport loss\n');
      this.pendingPlanApproval.resolve('abort');
    }
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
    this.failRunningSubagents();
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
    this.bridgePendingRequests = pendingCount;
    this.syncIdleGuard();
  }

  /**
   * Single idle-guard decision point covering both app-server approval
   * requests and the Issue 07 synthetic Plan Approval hold.
   */
  private syncIdleGuard(): void {
    const guard = this.activeTurn?.idleGuard;
    if (!guard) {
      return;
    }
    if (this.bridgePendingRequests > 0 || this.planApprovalPending) {
      guard.suspend();
      return;
    }
    guard.resume();
  }

  private async teardownTransport(): Promise<void> {
    this.approvalBridge?.dispose();
    this.approvalBridge = null;
    this.bridgePendingRequests = 0;
    this.planApprovalPending = false;
    // A live Plan Approval must not dangle past the connection — aborting
    // lets the awaiting sendInput settle instead of hanging forever.
    this.abortPendingPlanApproval();
    // Session teardown (or reconfigure): subagent tracks die with the query.
    this.subagents.reset();
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

function collabCallId(item: unknown): string | null {
  if (!isRecord(item) || item.type !== 'collabAgentToolCall') {
    return null;
  }
  return typeof item.id === 'string' ? item.id : null;
}

/** Re-announced spawn items are aliases: no duplicate parent card. */
function isAliasCollabItem(item: unknown, subagents: CodexSubagentSource): boolean {
  const callId = collabCallId(item);
  return callId !== null && !subagents.isCanonicalDeclaration(callId);
}

/** Alias completion results are reported against the canonical parent card. */
function retargetAliasCollabItem(item: unknown, subagents: CodexSubagentSource): unknown {
  const callId = collabCallId(item);
  const canonical = callId ? subagents.canonicalCallIdFor(callId) : undefined;
  if (!canonical || !isRecord(item)) {
    return item;
  }
  return { ...item, id: canonical };
}

function buildAppServerEnv(config: CodexSessionBootstrap): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (config.apiKey) {
    env.OPENAI_API_KEY = config.apiKey;
  }
  // Issue 09: dial the resolved base URL — the local compat proxy listening
  // URL for codex_needs_proxy providers, otherwise the upstream directly.
  const baseUrl = config.effectiveBaseUrl ?? config.upstreamBaseUrl;
  if (baseUrl) {
    env.OPENAI_BASE_URL = baseUrl;
  }
  applyCodexWindowsSandboxPathCompatibility(env as Record<string, string>);
  return env;
}

/**
 * Session-scoped provider overrides passed as `-c key=value` flags (must
 * precede the `app-server` subcommand). Registers a dedicated provider entry
 * so a user's global `model_provider`/`model_providers.*` in
 * ~/.codex/config.toml cannot redirect session traffic to another upstream.
 */
export const CODEMUX_APP_SERVER_PROVIDER_ID = 'codemux_session';

export function buildAppServerConfigOverrides(
  config: Pick<CodexSessionBootstrap, 'effectiveBaseUrl' | 'upstreamBaseUrl' | 'mcpServers'>,
): string[] {
  const overrides: string[] = [];
  const baseUrl = config.effectiveBaseUrl ?? config.upstreamBaseUrl;
  if (baseUrl) {
    const prefix = `model_providers.${CODEMUX_APP_SERVER_PROVIDER_ID}`;
    overrides.push(
      '-c', `model_provider=${CODEMUX_APP_SERVER_PROVIDER_ID}`,
      '-c', `${prefix}.name=${CODEMUX_APP_SERVER_PROVIDER_ID}`,
      '-c', `${prefix}.base_url=${baseUrl}`,
      '-c', `${prefix}.wire_api=responses`,
      // Third-party providers take credentials from a named env var
      // (buildAppServerEnv seeds OPENAI_API_KEY from the session's api_key);
      // requires_openai_auth would demand the official ChatGPT/API-key login.
      '-c', `${prefix}.env_key=OPENAI_API_KEY`,
    );
  }
  // 会话级 MCP server(stdio):与用户 ~/.codex/config.toml 同名时,进程级
  // `-c` 覆盖优先。值面用 JSON 序列化(TOML 字符串/数组/内联表兼容子集)。
  for (const [name, spec] of Object.entries(config.mcpServers ?? {})) {
    if (typeof spec.command !== 'string' || !spec.command.trim()) continue;
    const prefix = `mcp_servers.${name}`;
    overrides.push('-c', `${prefix}.command=${JSON.stringify(spec.command)}`);
    if (Array.isArray(spec.args) && spec.args.length > 0) {
      overrides.push('-c', `${prefix}.args=${JSON.stringify(spec.args)}`);
    }
    if (spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env)
      && Object.keys(spec.env).length > 0) {
      overrides.push('-c', `${prefix}.env=${JSON.stringify(spec.env)}`);
    }
  }
  return overrides;
}

/**
 * Issue 07: builds the `turn/start` collaborationMode payload from a preset
 * mask. `settings.model` is required by the wire schema; the plan preset may
 * pin its own reasoning_effort (stock CLI ships `medium` for Plan).
 */
function buildTurnCollaborationMode(
  mask: CollaborationModeMask,
  model: string,
): Record<string, unknown> {
  return {
    mode: mask.mode === 'plan' ? 'plan' : 'default',
    settings: {
      model: mask.model || model,
      ...(mask.mode === 'plan' && mask.reasoning_effort
        ? { reasoning_effort: mask.reasoning_effort }
        : {}),
    },
  };
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

type AdaptedItem = CodexThreadItem;

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

function isCodexSteerUnavailable(error: unknown): boolean {
  if (error instanceof AppServerRpcRequestError) {
    const message = error.message.toLowerCase();
    if (error.method === 'turn/steer' && (error.code === -32600 || error.code === -32601 || error.code === -32000)) {
      return true;
    }
    return message.includes('not steerable') || message.includes('no active turn');
  }
  const message = String(error).toLowerCase();
  return message.includes('not steerable')
    || message.includes('no active turn')
    || message.includes('unknown method')
    || message.includes('method not found');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
