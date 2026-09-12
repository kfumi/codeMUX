import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Query,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { SidecarCommand } from './types.js';
import { getProviderMode } from './sessionRuntimeHelpers.js';
import { resolveClaudeExecutable } from './claudeExecutable.js';
import { loadProviderRuntime, isRuntimeError, type RuntimeLoadResult } from './runtimeLoader.js';
import { loadClaudeSdk, type ClaudeSdkModule } from './sdkLoader.js';
import {
  buildClaudeCompactBoundaryEvent,
  isManualCompactPrompt,
  normalizeClaudeCompactBoundaryMessage,
  readClaudeCompactPreTokens,
} from './claudeCompactEvents.js';
import { shouldEmitDoneOnClaudeIteratorCompletion } from './claudeTurnCompletion.js';
import { mapClaudeMcpServers } from './claudeMcpServers.js';
import { projectClaudeToolEvents, toClaudeAssistantMessageEvent } from './claudeToolEvents.js';
import { CodexAppServerRuntime } from './codexAppServerRuntime.js';
import { OpenCodeRuntime } from './opencodeRuntime.js';
import { deleteOpenCodeSessionWithOfficialSdk, normalizeOpenCodeModelReference } from './opencodeSdk.js';
import type { OpenCodePermissionResponse } from './opencodePermissions.js';
import { PiRuntime } from './piRuntime.js';
import type { PiThinkingLevel } from './piEvents.js';
import type { OpenCodeSessionConfig, OpenCodeSessionMapping, PiSessionConfig, PiSessionMapping } from './types.js';
import type { PiMcpServers } from './piMcp.js';
import {
  getRuntimeFlavor,
} from './runtimeEvents.js';
import { toClaudeTurnOutcome } from './claudeTurnOutcome.js';
import { TurnEventNormalizer, type TurnOutcome, type TurnSourceEvent } from './turnEventNormalizer.js';
import { TurnArtifactAggregator } from './turnArtifactSummary.js';
import { proxyManager } from './proxyManager.js';
import { emit, resetStreamEventSequences, syncStreamSessionContext } from './streamEventBatcher.js';
import { ensureWorkingDirectory } from './defaultWorkingDirectory.js';
import { mapToClaudeEffort, normalizeReasoningEffort, type ReasoningEffort } from './reasoningEffort.js';
import { buildClaudePermissionOptions, type AgentPlanMode, type SidecarPermissionConfig } from './agentPermissions.js';
import type { PiApprovalMode } from './piExtension.js';
import { getClaudeApprovalTitle } from './claudeApprovalPrompt.js';
import {
  buildClaudeModeBlockedEvent,
  resolveClaudeToolRuntimeDecision,
  setActivePermissionState,
} from './activePermissionState.js';
import {
  buildClaudeUserMessageContent,
  getDisplayPayloadAttachments,
  isImageUnsupportedError,
  normalizeAgentInputPayload,
  type AgentInputPayload,
} from './agentInputPayload.js';
import { isSteerBlockedPrompt, isSteerUnavailableError, SteerUnavailableError } from './steer.js';
import { enrichAttachments } from './attachmentEnrichment/index.js';
import { shouldCaptureClaudeSessionMapping } from './claudeSessionMapping.js';
import { shouldForwardClaudeSdkMessage } from './claudeSdkMessageFilter.js';
import {
  applyClaudeModelAliasEnv,
  buildClaudeModelAliasEnv,
  wipeClaudeModelAliasEnv,
} from './claudeModelAliasEnv.js';
import { ClaudeTaskProtocolSource } from './claudeTaskProtocolSource.js';
import { ClaudePromptStream } from './claudePromptStream.js';
import { nextWithTimeout } from './claudeQueryTimeout.js';
import { setLogCtx, writeLog } from './writeLog.js';
import { resolveTurnTimeouts, type ResolvedTurnTimeouts, type TurnTimeouts } from './turnTimeouts.js';
import { createTurnIdleGuard, type TurnIdleGuard } from './turnIdleGuard.js';

// Suppress unhandled abort rejections from child process termination during interrupt.
// These are expected when the user cancels a running Codex turn.
process.on('unhandledRejection', (reason) => {
  const msg = String(reason).toLowerCase();
  if (msg.includes('abort') || msg.includes('the operation was aborted')) {
    process.stderr.write(`[sidecar] Suppressed unhandled abort rejection: ${reason}\n`);
    return;
  }
  // Re-throw non-abort errors so they are not silently swallowed.
  process.stderr.write(`[sidecar] Unhandled rejection: ${reason}\n`);
});

const WARM_START_TIMEOUT_MS = 30_000;
const WARM_QUERY_WAIT_WINDOW_MS = 500;
const MESSAGE_TIMEOUT_MS = 300_000;
const ASK_USER_QUESTION_TIMEOUT_MESSAGE = '等待用户回复超时，请重新发送消息继续';
/** Silence window after which a pending continuation turn is considered ended. */
const CONTINUATION_QUIESCENCE_MS = 10_000;

// Gate per-message stderr logs. Each stderr line is read by the Rust backend,
// mutex-locked into a capture buffer, and logged via tracing — so per-message
// writes during streaming (hundreds/sec) cause severe I/O and lock contention.
// Enable with CODEMUX_MESSAGE_DEBUG=1 when debugging message flow.
const DEBUG_MESSAGE_LOGS = process.env.CODEMUX_MESSAGE_DEBUG === '1';

type EnsureSessionCommand = Extract<SidecarCommand, { type: 'ensure_session' }>;
type UpdatePermissionsCommand = Extract<SidecarCommand, { type: 'update_permissions' }>;

export function buildOpenCodeSessionMappingEvent(mapping: OpenCodeSessionMapping): {
  type: 'agent_session_mapping';
  app_session_id: string;
  agent_kind: 'opencode';
  agent_session_id: string;
  runtime_generation: number;
} {
  return {
    type: 'agent_session_mapping',
    app_session_id: mapping.sessionId,
    agent_kind: 'opencode',
    agent_session_id: mapping.agentSessionId,
    runtime_generation: mapping.runtimeGeneration,
  };
}

export function buildPiSessionMappingEvent(mapping: PiSessionMapping): {
  type: 'agent_session_mapping';
  app_session_id: string;
  agent_kind: 'pi';
  agent_session_id: string;
  runtime_generation: number;
} {
  return {
    type: 'agent_session_mapping',
    app_session_id: mapping.sessionId,
    agent_kind: 'pi',
    agent_session_id: mapping.agentSessionId,
    runtime_generation: mapping.runtimeGeneration,
  };
}

type SessionBootstrap = {
  sessionId?: string;
  agentSessionId?: string;
  resumeOnly?: boolean;
  runtimeGeneration: number;
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  skills?: string[];
  settingSources?: string[];
  permissionConfig?: SidecarPermissionConfig;
  planMode?: AgentPlanMode;
  runtimeRef?: import('./runtimeContract.js').ProviderRuntimeRef;
  timeouts?: TurnTimeouts;
  /** daemon 随会话命令下发的 MCP 服务器(pi 直传;claude 经 buildOptions 注入 SDK)。 */
  mcpServers?: PiMcpServers;
};

type QueryOptions = Record<string, unknown> & {
  pathToClaudeCodeExecutable?: string;
};

type PendingToolResponseResult =
  | { kind: 'answered'; value: unknown }
  | { kind: 'expired' };

type PendingClaudeToolResponse = {
  sessionId?: string;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  onExpired?: () => void;
  resolve: (value: PendingToolResponseResult) => void;
};

/** Pending tool responses waiting for user input */
const pendingToolResponses = new Map<string, PendingClaudeToolResponse>();
const pendingClaudePermissions = new Map<string, {
  cwd: string;
  toolName: string;
  input: Record<string, unknown>;
}>();
const alwaysAllowedClaudePermissions = new Set<string>();
const SIDECAR_DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

function isSidecarEntrypoint(scriptPath: string | undefined): boolean {
  if (!scriptPath) return false;

  const entrypoint = path.join(SIDECAR_DIST_DIR, 'index.js');
  try {
    return fs.realpathSync.native(scriptPath) === fs.realpathSync.native(entrypoint);
  } catch {
    return path.resolve(scriptPath) === entrypoint;
  }
}

export function waitForClaudeToolResponse(
  toolUseId: string,
  sessionId?: string,
  timeoutMs = MESSAGE_TIMEOUT_MS,
  onExpired?: () => void,
): Promise<PendingToolResponseResult> {
  return new Promise((resolve) => {
    const pending: PendingClaudeToolResponse = {
      sessionId,
      onExpired,
      resolve,
    };
    if (timeoutMs > 0) {
      pending.timeoutTimer = setTimeout(() => {
        expireClaudeToolResponse(toolUseId);
      }, timeoutMs);
      if (pending.timeoutTimer.unref) pending.timeoutTimer.unref();
    }
    pendingToolResponses.set(toolUseId, pending);
  });
}

export function resolveClaudeToolResponse(toolUseId: string, response: unknown): boolean {
  const pending = pendingToolResponses.get(toolUseId);
  if (!pending) {
    return false;
  }

  pendingToolResponses.delete(toolUseId);
  if (pending.timeoutTimer) {
    clearTimeout(pending.timeoutTimer);
  }
  pending.resolve({ kind: 'answered', value: response });
  return true;
}

function expireClaudeToolResponse(toolUseId: string): boolean {
  const pending = pendingToolResponses.get(toolUseId);
  if (!pending) {
    return false;
  }

  pendingToolResponses.delete(toolUseId);
  if (pending.timeoutTimer) {
    clearTimeout(pending.timeoutTimer);
  }
  pending.onExpired?.();
  pending.resolve({ kind: 'expired' });
  return true;
}

export function expireClaudeToolResponses(sessionId?: string): number {
  let expired = 0;
  for (const [toolUseId, pending] of Array.from(pendingToolResponses.entries())) {
    if (sessionId && pending.sessionId !== sessionId) {
      continue;
    }
    if (expireClaudeToolResponse(toolUseId)) {
      expired += 1;
    }
  }
  return expired;
}

function clearClaudeToolResponses(sessionId?: string): number {
  let cleared = 0;
  for (const [toolUseId, pending] of Array.from(pendingToolResponses.entries())) {
    if (sessionId && pending.sessionId !== sessionId) {
      continue;
    }
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
    }
    pendingToolResponses.delete(toolUseId);
    pending.resolve({ kind: 'expired' });
    cleared += 1;
  }
  return cleared;
}

function isQueryIdleTimeout(errorText: string): boolean {
  return errorText.includes('Query timed out: no message received');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    if (timer.unref) timer.unref();
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

function isMissingClaudeConversationError(err: unknown): boolean {
  return String(err).includes('No conversation found with session ID');
}

function isNativeResumeFailure(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return message.includes('no conversation found with session id')
    || message.includes('failed to restore opencode session')
    || message.includes('session not found')
    || message.includes('session does not exist')
    || message.includes('thread not found')
    || message.includes('thread does not exist')
    || message.includes('unable to resume')
    || message.includes('failed to resume');
}

export class SessionRuntime {
  private config: SessionBootstrap | null = null;
  private configFingerprint: string | null = null;
  private timeouts: ResolvedTurnTimeouts = resolveTurnTimeouts();
  private turnIdleGuard: TurnIdleGuard | undefined;
  private providerMode = getProviderMode(undefined);
  private abortController: AbortController | null = null;
  private queryHandle: Query | null = null;
  private promptStream: ClaudePromptStream | null = null;
  private queryIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private subagents = new ClaudeTaskProtocolSource();
  private warmQuery: WarmQuery | null = null;
  private warmPromise: Promise<WarmQuery | null> | null = null;
  private turnActive = false;
  private turnEventNormalizer: TurnEventNormalizer | null = null;
  private turnArtifactAggregator: TurnArtifactAggregator | null = null;
  /**
   * Async-agent continuation turns: task notifications can wake the model
   * after the parent result, streaming an extra turn while `turnActive` is
   * false. Content of that turn is projected through this normalizer instead
   * of being dropped.
   */
  private continuationNormalizer: TurnEventNormalizer | null = null;
  /**
   * Some CLI/gateway combinations never emit a `result` message for
   * notification-woken continuation turns, so the boundary is synthesized:
   * once continuation content goes quiet (or the next prompt is pushed / the
   * query closes) the pending continuation turn is finished explicitly.
   */
  private continuationQuiescenceTimer: ReturnType<typeof setTimeout> | null = null;
  continuationQuiescenceMs = CONTINUATION_QUIESCENCE_MS;
  private generation = 0;
  private activeConfigGeneration = 0;
  private claudeExecutablePath: string | undefined;
  /** 动态加载的 Claude SDK 模块（仅从托管 Runtime 加载）。 */
  private claudeSdk: ClaudeSdkModule | null = null;
  /** 托管 Runtime 加载结果，用于解析 SDK 路径。 */
  private runtimeLoaded: RuntimeLoadResult | null = null;

  async ensure(cmd: EnsureSessionCommand): Promise<void> {
    const normalized = this.normalizeConfig(cmd);
    this.timeouts = resolveTurnTimeouts(normalized.timeouts);
    const nextFingerprint = JSON.stringify(normalized);
    if (this.configFingerprint === nextFingerprint && this.config) {
      this.applyActivePermissionState(normalized);
      return;
    }

    this.config = normalized;
    this.configFingerprint = nextFingerprint;
    this.providerMode = getProviderMode(normalized.baseUrl);
    this.activeConfigGeneration += 1;
    this.applyActivePermissionState(normalized);
    syncStreamSessionContext({
      appSessionId: normalized.sessionId,
      ...(normalized.agentSessionId ? { providerSessionId: normalized.agentSessionId } : {}),
    });

    await this.resetForReconfigure();

    // 生产与开发环境都必须从 CodeMUX 托管 Runtime 路径动态加载 Claude SDK。
    this.runtimeLoaded = this.loadRuntimeIfNeeded();
    this.claudeSdk = await loadClaudeSdk(this.runtimeLoaded);

    emit({
      type: 'mcp_status_update',
      servers: {},
      status: this.providerMode.supportsDeferredToolSearch ? 'warming' : 'limited_provider',
    });

    this.startWarmup(this.activeConfigGeneration);
  }

  /**
   * 使用 runtimeRef 加载 Provider Runtime。
   */
  private loadRuntimeIfNeeded(): RuntimeLoadResult {
    const runtimeRef = this.config?.runtimeRef;
    if (!runtimeRef) {
      throw new Error('Claude Code Runtime is required before starting a session');
    }
    const result = loadProviderRuntime(runtimeRef);
    if (isRuntimeError(result)) {
      throw new Error(`Claude Runtime 加载失败: ${result.message}`);
    }
    return result;
  }

  updatePermissions(cmd: UpdatePermissionsCommand): void {
    if (!this.config) {
      setActivePermissionState({
        sessionId: cmd.sessionId,
        agentKind: 'claude_code',
        permissionConfig: cmd.permissionConfig,
        planMode: normalizePlanMode(cmd.planMode),
      });
      return;
    }

    const nextConfig: SessionBootstrap = {
      ...this.config,
      sessionId: cmd.sessionId ?? this.config.sessionId,
      permissionConfig: cmd.permissionConfig,
      planMode: normalizePlanMode(cmd.planMode ?? this.config.planMode),
    };

    this.config = nextConfig;
    this.configFingerprint = JSON.stringify(nextConfig);
    this.activeConfigGeneration += 1;
    this.applyActivePermissionState(nextConfig);

    if (this.warmQuery) {
      this.warmQuery.close();
      this.warmQuery = null;
    }
    this.warmPromise = null;

    if (!this.turnActive) {
      this.startWarmup(this.activeConfigGeneration);
    }

    process.stderr.write(
      `[sidecar] Runtime permissions updated: session_id=${nextConfig.sessionId || 'none'} plan_mode=${nextConfig.planMode ?? 'off'}\n`,
    );
  }

  async sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void> {
    if (!this.config) {
      throw new Error('Session has not been bootstrapped. Call ensure_session first.');
    }
    if (this.turnActive) {
      throw new Error('A turn is already active for this session');
    }

    if (this.queryHandle && this.promptStream) {
      // Persistent query still open (previous turn ended, maybe with running
      // subagents): push the new prompt into the existing stream instead of
      // closing the query, which would kill attached subagents.
      this.clearQueryIdleTimer();
      this.turnActive = true;
      this.generation += 1;
      // Close a pending notification-woken continuation turn explicitly so
      // its boundary lands in the timeline before the new prompt's content.
      this.finishPendingContinuation('new_prompt', 'completed');
      this.turnEventNormalizer = new TurnEventNormalizer(this.config.sessionId ?? '');
      this.turnArtifactAggregator = new TurnArtifactAggregator(this.config.cwd);
      writeLog('[claude-task]', `sendInput START (stream reuse) model=${this.config.model ?? 'default'} prompt_preview=${prompt.slice(0, 120)}`);
      if (this.promptStream.push(prompt, inputPayload)) {
        return;
      }
      // Stream is dead; fall through to a fresh query.
      this.turnActive = false;
      this.closeQueryHandle('new_turn_reuse_failed');
    }

    if (this.queryHandle) {
      process.stderr.write('[sidecar] Closing previous query handle before starting a new turn\n');
      this.closeQueryHandle('new_turn');
    }

    this.turnActive = true;
    this.generation += 1;
    this.finishPendingContinuation('new_prompt', 'completed');
    this.turnEventNormalizer = new TurnEventNormalizer(this.config.sessionId ?? '');
    this.turnArtifactAggregator = new TurnArtifactAggregator(this.config.cwd);

    writeLog('[claude-task]', `sendInput START model=${this.config.model ?? 'default'} prompt_preview=${prompt.slice(0, 120)}`);

    try {
      await this.startPersistentQuery(prompt, this.generation, this.activeConfigGeneration, inputPayload);
    } catch (error) {
      writeLog('[claude-task]', `sendInput FAILED error=${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async steerActiveTurn(prompt: string, inputPayload?: AgentInputPayload): Promise<void> {
    if (!this.config) {
      throw new Error('Session has not been bootstrapped. Call ensure_session first.');
    }
    if (!this.turnActive || !this.queryHandle || !this.promptStream) {
      throw new SteerUnavailableError('no active Claude turn to steer');
    }
    if (isSteerBlockedPrompt(prompt)) {
      throw new SteerUnavailableError('slash commands cannot steer an active Claude turn');
    }
    if (!this.promptStream.push(prompt, inputPayload, { priority: 'next' })) {
      throw new SteerUnavailableError('Claude prompt stream is closed');
    }
    writeLog('[claude-task]', `steer QUEUED prompt_preview=${prompt.slice(0, 120)}`);
  }

  async forkSession(sourceAgentSessionId?: string): Promise<string> {
    const config = this.config;
    if (!config) {
      throw new Error('Claude session has not been created yet');
    }
    const sourceSessionId = sourceAgentSessionId ?? config.agentSessionId;
    if (!sourceSessionId) {
      throw new Error('Claude session has not been created yet');
    }
    if (this.turnActive) {
      throw new Error('Cannot fork while a Claude turn is active');
    }
    if (!this.claudeSdk) {
      throw new Error('Claude SDK not loaded; cannot fork session');
    }

    const forkQuery = this.claudeSdk.query({
      // An empty prompt opens the SDK session without creating a user turn.
      prompt: '',
      options: {
        ...this.buildOptions(config),
        abortController: new AbortController(),
        resume: sourceSessionId,
        forkSession: true,
      } as any,
    });

    let forkedSessionId: string | undefined;
    try {
      for await (const message of forkQuery) {
        const candidate = message && typeof message === 'object'
          ? (message as Record<string, unknown>).session_id
          : undefined;
        if (typeof candidate === 'string' && candidate.length > 0 && candidate !== sourceSessionId) {
          forkedSessionId = candidate;
        }
        if (
          forkedSessionId
          && message
          && typeof message === 'object'
          && (message as Record<string, unknown>).type === 'system'
          && (message as Record<string, unknown>).subtype === 'init'
        ) {
          break;
        }
      }
    } finally {
      try {
        forkQuery.close();
      } catch {
        // Closing an already completed query is best-effort.
      }
    }

    if (!forkedSessionId) {
      throw new Error('Claude SDK did not return a forked session ID');
    }
    process.stderr.write(`[sidecar] Forked Claude session ${sourceSessionId} -> ${forkedSessionId}\n`);
    return forkedSessionId;
  }

  async rewindFiles(providerMessageId: string): Promise<string[]> {
    const config = this.config;
    if (!config?.agentSessionId) {
      throw new Error('Claude session has not been created yet');
    }
    if (this.turnActive) {
      throw new Error('Cannot rewind files while a Claude turn is active');
    }
    if (!this.claudeSdk) {
      throw new Error('Claude SDK not loaded; cannot rewind files');
    }

    // An empty prompt resumes the SDK session without creating a user turn;
    // rewindFiles is a control request on that live query.
    const rewindQuery = this.claudeSdk.query({
      prompt: '',
      options: {
        ...this.buildOptions(config),
        abortController: new AbortController(),
        resume: config.agentSessionId,
      } as any,
    });

    const consumed = (async () => {
      try {
        for await (const _message of rewindQuery) {
          // Idle resume: no prompt is pushed, so no model turn starts. Keep
          // draining until close() so the control channel stays alive.
        }
      } catch {
        // Draining ends when the query closes; errors surface via rewindFiles.
      }
    })();

    try {
      const result = await new Promise<{ canRewind: boolean; error?: string; filesChanged?: string[] }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for Claude file rewind')),
          30_000,
        );
        if (timer.unref) timer.unref();
        (rewindQuery as any)
          .rewindFiles(providerMessageId, { dryRun: false })
          .then((value: { canRewind: boolean; error?: string; filesChanged?: string[] }) => {
            clearTimeout(timer);
            resolve(value);
          })
          .catch((error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
      if (!result?.canRewind) {
        throw new Error(result?.error ?? `No file checkpoint found for message ${providerMessageId}`);
      }
      const filesChanged = Array.isArray(result.filesChanged) ? result.filesChanged : [];
      process.stderr.write(
        `[sidecar] Rewound Claude files to ${providerMessageId} files=${filesChanged.length}\n`,
      );
      return filesChanged;
    } finally {
      try {
        rewindQuery.close();
      } catch {
        // Closing an already completed query is best-effort.
      }
      await consumed.catch(() => undefined);
    }
  }

  async interrupt(): Promise<void> {
    clearClaudeToolResponses(this.config?.sessionId);
    if (!this.queryHandle) {
      if (this.abortController && !this.abortController.signal.aborted) {
        this.abortController.abort('user_interrupt_no_query');
      }
      this.emitTurnOutcome({ outcome: 'interrupted', reason: 'Interrupted by user' });
      this.finishTurn();
      this.emitSubagentEvents(this.subagents.failRunningTasks());
      return;
    }

    process.stderr.write('[sidecar] Interrupt requested; sending query.interrupt()\n');
    const controller = this.abortController;
    const fallbackTimer = setTimeout(() => {
      if (controller && !controller.signal.aborted) {
        process.stderr.write('[sidecar] Interrupt fallback timeout reached; aborting transport\n');
        controller.abort('user_interrupt_fallback');
        this.closeQueryHandle('interrupt_fallback');
        this.emitTurnOutcome({ outcome: 'interrupted', reason: 'Interrupted by user' });
        this.finishTurn();
        if (this.config) {
          this.startWarmup(this.activeConfigGeneration);
        }
      }
    }, 2_000);
    if (fallbackTimer.unref) fallbackTimer.unref();

    try {
      await this.queryHandle.interrupt();
    } catch (err) {
      process.stderr.write(`[sidecar] query.interrupt() failed: ${err}\n`);
      if (controller && !controller.signal.aborted) {
        controller.abort('user_interrupt_error');
      }
    } finally {
      clearTimeout(fallbackTimer);
      this.emitTurnOutcome({ outcome: 'interrupted', reason: 'Interrupted by user' });
      this.finishTurn();
      // User Stop ends the whole query (Stop = all children terminated).
      // closeQueryHandle fails any still-running children, then warmup re-arms.
      const hadQuery = this.queryHandle !== null;
      this.closeQueryHandle('user_stop');
      if (hadQuery && this.config) {
        this.startWarmup(this.activeConfigGeneration);
      }
    }
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.resetForReconfigure();
    this.config = null;
    this.configFingerprint = null;
    this.providerMode = getProviderMode(undefined);
    syncStreamSessionContext({ clear: true });
    resetStreamEventSequences();
    process.stderr.write(`[sidecar] Reset session ${sessionId}\n`);
  }

  async shutdown(): Promise<void> {
    await this.resetForReconfigure();
  }

  private normalizeConfig(cmd: EnsureSessionCommand): SessionBootstrap {
    const cwd = ensureWorkingDirectory(cmd.cwd);
    return {
      sessionId: cmd.sessionId,
      agentSessionId: cmd.agentSessionId,
      resumeOnly: cmd.resumeOnly,
      runtimeGeneration: cmd.runtimeGeneration ?? 0,
      cwd,
      apiKey: cmd.apiKey,
      baseUrl: cmd.baseUrl,
      model: cmd.model,
      reasoningEffort: normalizeReasoningEffort(cmd.reasoningEffort),
      skills: cmd.skills,
      settingSources: cmd.settingSources,
      permissionConfig: cmd.permissionConfig,
      planMode: normalizePlanMode(cmd.planMode),
      runtimeRef: cmd.runtimeRef,
      timeouts: cmd.timeouts,
      mcpServers: cmd.mcpServers,
    };
  }

  private applyActivePermissionState(config: SessionBootstrap): void {
    setActivePermissionState({
      sessionId: config.sessionId,
      agentKind: 'claude_code',
      permissionConfig: config.permissionConfig,
      planMode: config.planMode,
    });
  }

  private async resetForReconfigure(): Promise<void> {
    clearClaudeToolResponses(this.config?.sessionId);
    this.finishTurn();
    this.closeQueryHandle('reconfigure');
    this.subagents.reset();
    if (this.warmQuery) {
      this.warmQuery.close();
      this.warmQuery = null;
    }
    this.warmPromise = null;
    this.abortController = null;
  }

  private clearStaleResumeMapping(reason: unknown): boolean {
    if (!this.config?.agentSessionId || !isMissingClaudeConversationError(reason)) {
      return false;
    }

    process.stderr.write(
      `[sidecar] Cleared stale in-memory Claude resume session for app session ${this.config.sessionId}\n`,
    );
    this.config = {
      ...this.config,
      agentSessionId: undefined,
    };
    this.configFingerprint = JSON.stringify(this.config);
    return true;
  }

  private startWarmup(configGeneration: number): void {
    if (!this.config) return;
    if (!this.claudeSdk) {
      process.stderr.write('[sidecar] Claude SDK not loaded, skipping warmup\n');
      return;
    }
    const sdk = this.claudeSdk;

    const warmAttempt = (label: string) => {
      const options = this.buildOptions(this.config!);
      process.stderr.write(`[sidecar] ${label}\n`);
      return sdk.startup({
        options: options as any,
        initializeTimeoutMs: WARM_START_TIMEOUT_MS,
      });
    };

    this.warmPromise = warmAttempt('Calling startup() to pre-warm MCP connections in the background...')
      .then((warm: WarmQuery) => {
        if (configGeneration !== this.activeConfigGeneration) {
          warm.close();
          return null;
        }
        if (this.queryHandle) {
          warm.close();
          return null;
        }
        this.warmQuery = warm;
        emit({ type: 'mcp_status_update', servers: {}, status: 'ready' });
        process.stderr.write('[sidecar] Background startup() complete\n');
        return warm;
      })
      .catch(async (startupErr: unknown) => {
        if (this.config?.resumeOnly && this.config.agentSessionId) {
          process.stderr.write(`[sidecar] External session restore failed: ${startupErr}\n`);
          if (isNativeResumeFailure(startupErr)) {
            emit({
              type: 'session_resume_failed',
              session_id: this.config.sessionId,
              agent_kind: 'claude_code',
              agent_session_id: this.config.agentSessionId,
              error: String(startupErr),
            });
          } else {
            emit({ type: 'sidecar_error', error: String(startupErr) });
          }
          return null;
        }
        if (configGeneration === this.activeConfigGeneration && this.clearStaleResumeMapping(startupErr)) {
          process.stderr.write('[sidecar] Retrying background startup() without stale resume mapping...\n');
          try {
            const warm = await warmAttempt('Retrying startup() after clearing stale resume mapping...');
            if (configGeneration !== this.activeConfigGeneration) {
              warm.close();
              return null;
            }
            if (this.queryHandle) {
              warm.close();
              return null;
            }
            this.warmQuery = warm;
            emit({ type: 'mcp_status_update', servers: {}, status: 'ready' });
            process.stderr.write('[sidecar] Background startup() recovered after clearing stale resume mapping\n');
            return warm;
          } catch (retryErr) {
            startupErr = retryErr;
          }
        }

        process.stderr.write(`[sidecar] Background startup() failed: ${startupErr}\n`);
        if (configGeneration === this.activeConfigGeneration && this.providerMode.supportsDeferredToolSearch) {
          emit({ type: 'mcp_status_update', servers: {}, status: 'deferred' });
        }
        return null;
      });
  }

  private async startPersistentQuery(prompt: string, queryGeneration: number, configGeneration: number, inputPayload?: AgentInputPayload, includeImages = true): Promise<void> {
    if (!this.config) {
      throw new Error('Missing runtime config');
    }

    const warm = this.warmPromise
      ? await withTimeout(this.warmPromise, WARM_QUERY_WAIT_WINDOW_MS)
      : null;

    if (queryGeneration !== this.generation || configGeneration !== this.activeConfigGeneration) {
      if (warm) {
        warm.close();
      }
      return;
    }

    if (warm) {
      process.stderr.write('[sidecar] Starting persistent query from pre-warmed session\n');
      this.warmQuery = null;
      this.promptStream = new ClaudePromptStream(includeImages);
      this.promptStream.pushInitial(prompt, inputPayload);
      this.queryHandle = warm.query(this.promptStream.stream);
    } else {
      process.stderr.write('[sidecar] Starting persistent query directly via query()\n');
      emit({
        type: 'mcp_status_update',
        servers: {},
        status: this.providerMode.supportsDeferredToolSearch ? 'fallback_live' : 'limited_provider',
      });
      if (!this.claudeSdk) {
        throw new Error('Claude SDK not loaded; cannot start query');
      }
      this.promptStream = new ClaudePromptStream(includeImages);
      this.promptStream.pushInitial(prompt, inputPayload);
      this.queryHandle = this.claudeSdk.query({
        prompt: this.promptStream.stream,
        options: this.buildOptions(this.config) as any,
      });
    }

    this.turnIdleGuard?.dispose();
    this.turnIdleGuard = createTurnIdleGuard({
      idleTimeoutMs: this.timeouts.idle_timeout_ms,
    });

    const manualCompact = isManualCompactPrompt(prompt, inputPayload);
    if (manualCompact && this.config.sessionId) {
      emit(buildClaudeCompactBoundaryEvent(this.config.sessionId, 'compacting', { trigger: 'manual' }));
    }

    void this.consumeQuery(
      this.queryHandle,
      this.config.sessionId,
      prompt,
      inputPayload,
      includeImages,
      manualCompact,
    );
  }

  private closeQueryHandle(reason: string): void {
    this.clearQueryIdleTimer();
    // A pending continuation turn dies with the query — give it a terminal
    // boundary so the timeline (and notification gating) sees it end.
    this.finishPendingContinuation(reason, reason === 'idle' ? 'completed' : 'interrupted');
    if (!this.queryHandle) return;
    process.stderr.write(`[sidecar] Closing persistent query (${reason})\n`);
    this.promptStream?.close();
    this.promptStream = null;
    try {
      this.queryHandle.close();
    } catch (err) {
      process.stderr.write(`[sidecar] Failed to close query: ${err}\n`);
    }
    this.queryHandle = null;
    // Closing the query kills every child bound to it — surface that as
    // descriptor terminal states so the UI does not show them as running.
    if (this.subagents.hasRunningTasks()) {
      this.emitSubagentEvents(this.subagents.failRunningTasks());
    }
  }

  /**
   * After a parent turn ends, keep the persistent query open (subagents may
   * still be attached and the next turn reuses it). Arm the idle timer only
   * when no subagent is running; a running child must not be killed by idle.
   */
  private scheduleQueryIdleClose(): void {
    this.clearQueryIdleTimer();
    if (!this.queryHandle || !this.promptStream || this.turnActive) return;
    if (this.subagents.hasRunningTasks()) return;
    if (this.timeouts.idle_timeout_ms <= 0) return;
    this.queryIdleTimer = setTimeout(() => {
      this.queryIdleTimer = null;
      if (this.turnActive || !this.queryHandle || !this.promptStream) return;
      if (this.subagents.hasRunningTasks()) return;
      process.stderr.write('[sidecar] Closing idle persistent query\n');
      this.closeQueryHandle('idle');
      if (this.config) {
        this.startWarmup(this.activeConfigGeneration);
      }
    }, this.timeouts.idle_timeout_ms);
    this.queryIdleTimer.unref?.();
  }

  private clearQueryIdleTimer(): void {
    if (this.queryIdleTimer) {
      clearTimeout(this.queryIdleTimer);
      this.queryIdleTimer = null;
    }
  }

  private emitSubagentEvents(events: ReturnType<ClaudeTaskProtocolSource['failRunningTasks']>): void {
    for (const event of events) {
      emit(event);
    }
    if (!this.turnActive) {
      // Re-arm (or cancel) the idle close window with fresh subagent state.
      this.scheduleQueryIdleClose();
    }
  }

  private buildOptions(config: SessionBootstrap): QueryOptions {
    if (config.apiKey) {
      process.env.ANTHROPIC_API_KEY = config.apiKey;
    }
    if (config.baseUrl) {
      process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    }

    const runtimePath = config.runtimeRef?.runtimePath;
    if (!runtimePath) {
      throw new Error('Claude Code Runtime is required before resolving its executable');
    }
    const claudePath = resolveClaudeExecutable({ runtimePath });
    if (!claudePath) {
      throw new Error(`Claude Runtime 路径中未找到 Claude 可执行文件: ${runtimePath}`);
    }
    this.claudeExecutablePath = claudePath;
    const claudeSessionId = config.agentSessionId;
    const envKey = process.env.ANTHROPIC_API_KEY;
    const envUrl = process.env.ANTHROPIC_BASE_URL;
    process.stderr.write(`[sidecar] ENV ANTHROPIC_API_KEY=${envKey ? envKey.slice(0, 10) + '...' : 'NOT SET'}\n`);
    process.stderr.write(`[sidecar] ENV ANTHROPIC_BASE_URL=${envUrl || 'NOT SET'}\n`);
    process.stderr.write(`[sidecar] ENV ANTHROPIC_API_KEY length=${envKey?.length || 0}\n`);
    const anthropicVars = Object.keys(process.env).filter((key) => key.startsWith('ANTHROPIC_'));
    process.stderr.write(`[sidecar] All ANTHROPIC_* env vars: ${anthropicVars.join(', ') || '(none)'}\n`);
    process.stderr.write(`[sidecar] Session: app=${config.sessionId || 'none'}, claude=${claudeSessionId || 'new'}\n`);
    process.stderr.write(
      `[runtime] provider=claude_code cli=${claudePath} runtime=${runtimePath} version=${config.runtimeRef?.runtimeVersion ?? 'unknown'} node=${process.execPath}\n`,
    );

    const subprocessEnv: Record<string, string | undefined> = { ...process.env };
    if (config.apiKey) subprocessEnv.ANTHROPIC_API_KEY = config.apiKey;
    if (config.baseUrl) subprocessEnv.ANTHROPIC_BASE_URL = config.baseUrl;
    subprocessEnv.ANTHROPIC_AUTH_TOKEN = '';
    subprocessEnv.ANTHROPIC_COOKIE = '';
    wipeClaudeModelAliasEnv(subprocessEnv);
    // Subagents resolve fast-model aliases internally; on a custom gateway
    // those alias codes do not exist, so pin every alias to the session model.
    if (config.baseUrl) {
      applyClaudeModelAliasEnv(subprocessEnv, config.model);
    }

    const cleanSettings: Record<string, unknown> = {};
    if (config.apiKey || config.baseUrl) {
      cleanSettings.env = {
        ...(config.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
        ...(config.baseUrl ? { ANTHROPIC_BASE_URL: config.baseUrl } : {}),
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_COOKIE: '',
        DISABLE_AUTOUPDATER: '1',
        ...(config.baseUrl ? buildClaudeModelAliasEnv(config.model) : {}),
      };
    }

    if (!this.abortController || this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }

    const permissionOptions = buildClaudePermissionOptions(config.permissionConfig, config.planMode);
    const mcpServers = mapClaudeMcpServers(config.mcpServers);

    const options: QueryOptions = {
      cwd: config.cwd,
      abortController: this.abortController,
      permissionMode: permissionOptions.permissionMode,
      allowDangerouslySkipPermissions: permissionOptions.allowDangerouslySkipPermissions,
      env: subprocessEnv,
      enableFileCheckpointing: true,
      ...(mcpServers ? { mcpServers } : {}),
      ...(Object.keys(cleanSettings).length > 0 ? { settings: cleanSettings } : {}),
      includePartialMessages: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: '',
      },
      stderr: (data: string) => {
        process.stderr.write(`[claude-stderr] ${data}`);
      },
      hooks: {
        PreToolUse: [{
          hooks: [async (input: any, toolUseID: string | undefined) => {
            const toolName = input.tool_name as string;
            const toolInput = input.tool_input as Record<string, unknown> | undefined;
            if ((toolName === 'Write' || toolName === 'Edit') && toolInput) {
              const filePath = toolInput.file_path as string;
              if (filePath) {
                try {
                  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(config.cwd, filePath);
                  const original = fs.readFileSync(absolutePath, 'utf-8');
                  emit({
                    type: 'file_snapshot',
                    file_path: absolutePath,
                    original_content: original,
                    is_new: false,
                    tool_use_id: toolUseID || '',
                  });
                  this.turnArtifactAggregator?.observe({
                    type: 'file_snapshot',
                    file_path: absolutePath,
                    original_content: original,
                    is_new: false,
                    tool_use_id: toolUseID || '',
                  });
                } catch {
                  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(config.cwd, filePath);
                  emit({
                    type: 'file_snapshot',
                    file_path: absolutePath,
                    original_content: '',
                    is_new: true,
                    tool_use_id: toolUseID || '',
                  });
                  this.turnArtifactAggregator?.observe({
                    type: 'file_snapshot',
                    file_path: absolutePath,
                    original_content: '',
                    is_new: true,
                    tool_use_id: toolUseID || '',
                  });
                }
              }
            }
            return { continue: true };
          }],
        }],
      },
      canUseTool: async (toolName: string, input: Record<string, unknown>, opts: { toolUseID: string }) => {
        this.turnIdleGuard?.reset();
        if (toolName === 'EnterPlanMode') {
          setActivePermissionState({
            sessionId: config.sessionId,
            agentKind: 'claude_code',
            permissionConfig: { kind: 'claude_code', permissionMode: 'plan' },
            planMode: 'on',
          });
          return { behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID };
        }

        if (toolName === 'AskUserQuestion') {
          const toolUseId = opts.toolUseID;
          let questions: any[] = [];
          const rawQ = (input as any).questions;
          if (typeof rawQ === 'string') {
            try { questions = JSON.parse(rawQ); } catch { questions = []; }
          } else if (Array.isArray(rawQ)) {
            questions = rawQ;
          }
          this.emitTurnSource({ kind: 'user_input_requested', toolUseId, questions });
          const response = await this.waitForInteractiveResponse(
            toolUseId,
            this.timeouts.question_timeout_ms,
            () => this.emitClaudeInteractionTimeout(toolUseId),
          );
          if (response.kind === 'expired') {
            return {
              behavior: 'deny',
              message: ASK_USER_QUESTION_TIMEOUT_MESSAGE,
              toolUseID: toolUseId,
            };
          }
          const userAnswers = response.value as string[];
          const answersRecord: Record<string, string> = {};
          questions.forEach((q: any, i: number) => {
            const answer = userAnswers[i];
            answersRecord[q.question] = Array.isArray(answer) ? answer.join(', ') : String(answer ?? '');
          });
          return { behavior: 'allow', updatedInput: { ...input, questions, answers: answersRecord } };
        }

        const toolUseId = opts.toolUseID;
        if (toolName === 'ExitPlanMode') {
          pendingClaudePermissions.set(toolUseId, {
            cwd: config.cwd,
            toolName,
            input,
          });
          this.emitTurnSource({
            kind: 'permission_requested',
            requestId: toolUseId,
            permissionId: toolUseId,
            permissionType: toolName,
            description: '退出计划模式并开始实施。',
            metadata: {
              presentation: 'plan-approval',
              title: '实施计划',
              input,
            },
          });
          const response = await this.waitForInteractiveResponse(
            toolUseId,
            this.timeouts.approval_timeout_ms,
            () => this.emitClaudeInteractionTimeout(toolUseId),
          );
          if (response.kind === 'expired') {
            return { behavior: 'deny', message: ASK_USER_QUESTION_TIMEOUT_MESSAGE, toolUseID: toolUseId };
          }

          const answer = typeof response.value === 'string'
            ? response.value
            : String((response.value as unknown[])[0] ?? '').trim();
          pendingClaudePermissions.delete(toolUseId);
          if (answer === 'once' || answer === '批准' || answer.toLowerCase() === 'approve') {
            setActivePermissionState({
              sessionId: config.sessionId,
              agentKind: 'claude_code',
              permissionConfig: { kind: 'claude_code', permissionMode: 'bypassPermissions' },
              planMode: 'off',
            });
            emit({ type: 'permission_mode_changed', session_id: config.sessionId, plan_mode: 'off' });
            return { behavior: 'allow', updatedInput: input, toolUseID: toolUseId };
          }

          return {
            behavior: 'deny',
            message: answer || '用户未批准退出计划模式。',
            toolUseID: toolUseId,
          };
        }

        const filePath = typeof input.file_path === 'string' ? input.file_path : null;
        if (isClaudePermissionAlwaysAllowed(config.cwd, toolName, input)) {
          return { behavior: 'allow', updatedInput: input, toolUseID: toolUseId };
        }
        const runtimeDecision = resolveClaudeToolRuntimeDecision(toolName, config.sessionId, filePath);
        if (runtimeDecision.behavior === 'allow') {
          return { behavior: 'allow', updatedInput: input, toolUseID: toolUseId };
        }
        if (runtimeDecision.behavior === 'deny') {
          emit(buildClaudeModeBlockedEvent({
            toolName,
            toolUseId,
            effectiveMode: runtimeDecision.effectiveMode,
            reasonCode: runtimeDecision.reasonCode ?? 'permission_mode_blocked',
          }));
          return {
            behavior: 'deny',
            message: `${toolName} is blocked by the current permission mode.`,
            toolUseID: toolUseId,
          };
        }

        const title = getClaudeApprovalTitle(toolName, input, opts);
        pendingClaudePermissions.set(toolUseId, {
          cwd: config.cwd,
          toolName,
          input,
        });
        this.emitTurnSource({
          kind: 'permission_requested',
          requestId: toolUseId,
          permissionId: toolUseId,
          permissionType: toolName,
          description: title,
          metadata: {
            title,
            toolName,
            input,
            command: typeof input.command === 'string' ? input.command : undefined,
            filePath: typeof input.file_path === 'string' ? input.file_path : undefined,
            cwd: config.cwd,
          },
        });
        const response = await this.waitForInteractiveResponse(
          toolUseId,
          this.timeouts.approval_timeout_ms,
          () => this.emitClaudeInteractionTimeout(toolUseId),
        );
        if (response.kind === 'expired') {
          return {
            behavior: 'deny',
            message: ASK_USER_QUESTION_TIMEOUT_MESSAGE,
            toolUseID: toolUseId,
          };
        }
        const answerValue = response.value;
        if (answerValue === 'always') {
          rememberClaudePermission(toolUseId);
        }
        pendingClaudePermissions.delete(toolUseId);
        if (answerValue === 'once' || answerValue === 'always') {
          return { behavior: 'allow', updatedInput: input, toolUseID: toolUseId };
        }
        return {
          behavior: 'deny',
          message: `${toolName} was denied by the user.`,
          toolUseID: toolUseId,
        };
      },
    };

    if (claudePath) options.pathToClaudeCodeExecutable = claudePath;
    if (config.skills && config.skills.length > 0) {
      options.skills = config.skills;
    }
    if (config.settingSources && config.settingSources.length > 0) {
      options.settingSources = config.settingSources;
    }
    if (config.model) {
      options.model = config.model;
    }
    const claudeEffort = config.reasoningEffort
      ? mapToClaudeEffort(config.reasoningEffort)
      : undefined;
    if (claudeEffort) {
      options.effort = claudeEffort;
    }
    if (claudeSessionId) {
      options.resume = claudeSessionId;
      process.stderr.write(`[sidecar] Resuming Claude session: ${claudeSessionId}\n`);
    }

    return options;
  }

  private async consumeQuery(
    queryHandle: Query,
    appSessionId?: string,
    prompt?: string,
    inputPayload?: AgentInputPayload,
    includeImages = true,
    compactingPlaceholderEmitted = false,
  ): Promise<void> {
    let msgCount = 0;
    let sawResult = false;
    let compactingPlaceholderShown = compactingPlaceholderEmitted;

    const iterator = queryHandle[Symbol.asyncIterator]();

    const nextMessage = async () => {
      if (!this.turnActive) {
        return iterator.next();
      }
      if (this.turnIdleGuard?.isExpired()) {
        throw new Error(`Query timed out: no message received for ${this.timeouts.idle_timeout_ms / 1000}s (after msg #${msgCount})`);
      }
      return await nextWithTimeout(
        () => iterator.next(),
        this.turnIdleGuard?.remainingIdleMs() ?? MESSAGE_TIMEOUT_MS,
        () => {
          if (this.abortController?.signal.aborted) {
            return { done: true, value: undefined };
          }
          throw new Error(`Query timed out: no message received for ${this.timeouts.idle_timeout_ms / 1000}s (after msg #${msgCount})`);
        },
        [],
        () => this.turnIdleGuard?.remainingIdleMs() === Infinity,
      );
    };

    try {
      while (this.queryHandle === queryHandle) {
        const result = await nextMessage();
        if (result.done) {
          break;
        }

        this.turnIdleGuard?.reset();

        msgCount += 1;
        const msg = result.value as Record<string, unknown>;
        const messageUuid = typeof msg.uuid === 'string' ? msg.uuid : undefined;
        if (messageUuid && appSessionId) {
          setLogCtx({ sessionId: appSessionId, messageId: messageUuid });
        }
        if (DEBUG_MESSAGE_LOGS) {
          const msgPreview = (() => { try { return JSON.stringify(msg).slice(0, 2000) } catch { return String(msg).slice(0, 2000) } })();
          process.stderr.write(`[claude-debug] message #${msgCount} type=${msg.type} subtype=${String(msg.subtype || 'none')} preview=${msgPreview}\n`);
        }

        if (msg.type === 'system' && msg.subtype === 'status' && (msg as any).status === 'compacting') {
          this.turnIdleGuard?.suspend();
          if (!compactingPlaceholderShown && appSessionId) {
            const preTokens = readClaudeCompactPreTokens(msg);
            emit(buildClaudeCompactBoundaryEvent(appSessionId, 'compacting', {
              trigger: 'auto',
              ...(preTokens !== undefined ? { pre_tokens: preTokens } : {}),
            }));
            compactingPlaceholderShown = true;
          }
        }
        if (typeof appSessionId === 'string' && shouldCaptureClaudeSessionMapping(msg)) {
          const sdkSessionId = typeof msg.session_id === 'string' ? String(msg.session_id) : undefined;
          if (sdkSessionId && this.config?.agentSessionId !== sdkSessionId) {
            if (this.config) {
              this.config = { ...this.config, agentSessionId: sdkSessionId };
              this.configFingerprint = JSON.stringify(this.config);
            }
            process.stderr.write(`[sidecar] Captured Claude session ID: ${sdkSessionId} for app session: ${appSessionId}\n`);
            syncStreamSessionContext({ providerSessionId: sdkSessionId });
            emit({
              type: 'agent_session_mapping',
              app_session_id: appSessionId,
              agent_kind: 'claude_code',
              agent_session_id: sdkSessionId,
            });
          }
        }

        // Task protocol frames and sidechain traffic are observed into the
        // subagent tracks before being dropped from the parent timeline.
        const subagentEvents = this.subagents.observe(msg, appSessionId ? { sessionId: appSessionId } : {});
        if (subagentEvents.length > 0) {
          this.emitSubagentEvents(subagentEvents);
        }

        if (!shouldForwardClaudeSdkMessage(msg)) {
          continue;
        }

        const eventToEmit = msg.type === 'system' && msg.subtype === 'compact_boundary'
            ? normalizeClaudeCompactBoundaryMessage(result.value as Record<string, unknown>, appSessionId)
            : result.value;

        if (DEBUG_MESSAGE_LOGS) {
          const emitObj = eventToEmit as Record<string, unknown>;
          const emitPreview = (() => { try { return JSON.stringify(emitObj).slice(0, 1000) } catch { return String(emitObj).slice(0, 1000) } })();
          process.stderr.write(`[claude-debug] EMIT type=${emitObj?.type ?? '(no type)'} preview=${emitPreview}\n`);
        }
        let continuationContentActivity = false;
        if (msg.type === 'result') {
          this.emitTurnOutcome(toClaudeTurnOutcome(eventToEmit as Record<string, unknown>));
        } else {
          const projection = projectClaudeToolEvents(eventToEmit as Record<string, unknown>);
          if (projection.planModeChange === 'on') {
            const sessionId = appSessionId ?? this.config?.sessionId;
            if (sessionId) {
              setActivePermissionState({
                sessionId,
                agentKind: 'claude_code',
                permissionConfig: { kind: 'claude_code', permissionMode: 'plan' },
                planMode: 'on',
              });
              emit({ type: 'permission_mode_changed', session_id: sessionId, plan_mode: 'on' });
            }
          }
          for (const sourceEvent of projection.toolEvents) {
            for (const normalizedEvent of this.projectionNormalizer(appSessionId).accept(sourceEvent)) {
              continuationContentActivity = true;
              emit(normalizedEvent);
            }
          }
          if (projection.remainingEvent) {
            const remainingEvent = projection.remainingEvent as Record<string, unknown>;
            if (remainingEvent.type === 'stream_event') {
              continuationContentActivity = true;
              emit({
                ...remainingEvent,
                session_id: appSessionId ?? this.config?.sessionId ?? remainingEvent.session_id,
              });
            } else {
              const remainingMessage = toClaudeAssistantMessageEvent(remainingEvent);
              if (remainingMessage) {
                for (const normalizedEvent of this.projectionNormalizer(appSessionId).accept(remainingMessage)) {
                  continuationContentActivity = true;
                  emit(normalizedEvent);
                }
              } else {
                emit(remainingEvent);
              }
            }
          }
        }

        // A continuation turn the CLI will never close with a `result`: once
        // its content stops streaming, synthesize the turn boundary. Only
        // parent-visible content counts as activity — trailing protocol
        // frames (task_notification, sidechain traffic) project nothing and
        // must not push the boundary out indefinitely.
        if (continuationContentActivity) {
          this.armContinuationQuiescence();
        }

        if (msg.type === 'system' && msg.subtype === 'init' && Array.isArray((msg as any).mcp_servers)) {
          const mcpServers = (msg as any).mcp_servers as Array<{ name: string; status: string }>;
          const statusMap: Record<string, string> = {};
          for (const server of mcpServers) {
            statusMap[server.name] = server.status;
          }
          emit({
            type: 'mcp_status_update',
            servers: statusMap,
            status: this.providerMode.supportsDeferredToolSearch ? 'deferred' : 'limited_provider',
          });
          if (mcpServers.some((server) => server.status === 'pending')) {
            void this.pollMcpServerStatus(queryHandle);
          }
        }

        if (msg.type === 'result') {
          sawResult = true;
          this.clearContinuationQuiescence();
          if (this.turnActive) {
            writeLog('[claude-task]', 'sendInput COMPLETE');
            this.finishTurn();
          } else if (this.continuationNormalizer) {
            writeLog('[claude-task]', 'continuation turn COMPLETE');
            this.emitTurnOutcome(toClaudeTurnOutcome(eventToEmit as Record<string, unknown>));
            this.continuationNormalizer = null;
          }
          // Keep the persistent query open — closing it would kill subagents
          // that outlive the parent turn. Cancel explicitly-foreground
          // children instead; the next turn reuses this query.
          this.emitSubagentEvents(this.subagents.cancelRunningForegroundTasks());
          this.scheduleQueryIdleClose();
        } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          sawResult = true;
          writeLog('[claude-task]', 'sendInput COMPLETE (compact)');
          this.turnIdleGuard?.resume();
          this.finishTurn();
          this.scheduleQueryIdleClose();
        }
      }
      if (this.queryHandle === queryHandle) {
        // The SDK ended the query by itself (prompt stream drained or the
        // transport closed). Drop the handle so the next sendInput opens a
        // fresh query instead of pushing into a dead stream.
        this.closeQueryHandle('query_ended');
      }
      if (DEBUG_MESSAGE_LOGS) {
        process.stderr.write(`[claude-debug] query iterator ended sessionId=${appSessionId || 'none'} msgCount=${msgCount} sawResult=${sawResult}\n`);
      }
    } catch (err: unknown) {
      if (includeImages && isImageUnsupportedError(err) && prompt) {
        emit({
          type: 'vision_unsupported',
          model: this.config?.model,
          message: String(err),
        });
        process.stderr.write(`[sidecar] Vision payload unsupported; retrying text-only: ${String(err)}\n`);
        this.closeQueryHandle('vision_unsupported_retry');
        await this.startPersistentQuery(prompt, this.generation, this.activeConfigGeneration, inputPayload, false);
        return;
      }
      const errorMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      const normalizedError = errorMsg.toLowerCase();
      const isAbort = normalizedError.includes('abort');
      const isIdleTimeout = isQueryIdleTimeout(errorMsg);
      const isGracefulInterruptCleanup = Boolean(
        this.abortController?.signal.aborted &&
        (normalizedError.includes('stream closed') || normalizedError.includes('query timed out')),
      );
      this.clearStaleResumeMapping(errorMsg);
      if (isIdleTimeout) {
        expireClaudeToolResponses(appSessionId);
        this.closeQueryHandle('timeout');
      }
      if (!isAbort && !isGracefulInterruptCleanup) {
        writeLog('[claude-task]', `sendInput FAILED error=${errorMsg.slice(0, 500)}`);
        this.emitTurnError(errorMsg);
        this.emitTurnOutcome({ outcome: 'failed', reason: errorMsg });
      } else {
        writeLog('[claude-task]', 'sendInput ABORT');
        process.stderr.write(`[sidecar] Suppressed interrupt cleanup error: ${errorMsg}\n`);
        this.emitTurnOutcome({ outcome: 'interrupted', reason: 'Interrupted by user' });
      }
      this.finishTurn();
      // The consume loop is exiting; a leftover handle with no reader would
      // swallow the next pushed prompt, so tear the query down.
      if (this.queryHandle === queryHandle) {
        this.closeQueryHandle('query_error');
      }
      if (isIdleTimeout && this.config) {
        this.startWarmup(this.activeConfigGeneration);
      }
    } finally {
      if (shouldEmitDoneOnClaudeIteratorCompletion({
        turnActive: this.turnActive,
        sawResult,
        aborted: Boolean(this.abortController?.signal.aborted),
      })) {
        process.stderr.write('[sidecar] Claude query iterator ended without result; marking turn complete\n');
        this.emitTurnError('Claude query ended without a result', 'iterator');
        this.emitTurnOutcome({ outcome: 'failed', reason: 'Claude query ended without a result' });
        this.finishTurn();
      }
      if (this.queryHandle === queryHandle && this.abortController?.signal.aborted) {
        this.closeQueryHandle('aborted_cleanup');
      }
    }
  }

  private async pollMcpServerStatus(queryHandle: Query): Promise<void> {
    const MAX_POLLS = 30;
    const POLL_INTERVAL = 2_000;

    try {
      for (let i = 0; i < MAX_POLLS; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
        if (this.queryHandle !== queryHandle) break;
        const statuses = await queryHandle.mcpServerStatus();
        const statusMap: Record<string, string> = {};
        for (const status of statuses) {
          statusMap[status.name] = status.status;
        }
        emit({ type: 'mcp_status_update', servers: statusMap });
        const allDone = statuses.every((status: { status: string }) => status.status === 'connected' || status.status === 'failed');
        if (allDone) break;
      }
    } catch (err) {
      process.stderr.write(`[sidecar] MCP status poll error: ${err}\n`);
    }
  }

  private finishTurn(): void {
    if (!this.turnActive) {
      return;
    }
    this.turnActive = false;
    this.turnIdleGuard?.dispose();
    this.turnIdleGuard = undefined;
    emit({ type: 'sidecar_query_done' });
    this.turnEventNormalizer = null;
  }

  /**
   * Normalizer for projected turn content. Falls back to a lazily-created
   * continuation normalizer when messages arrive between turns (notification
   * wake-up after the parent result).
   */
  private projectionNormalizer(appSessionId?: string): TurnEventNormalizer {
    if (this.turnEventNormalizer) return this.turnEventNormalizer;
    if (!this.continuationNormalizer) {
      this.continuationNormalizer = new TurnEventNormalizer(appSessionId ?? this.config?.sessionId ?? '');
      writeLog('[claude-task]', 'continuation turn START (between turns)');
    }
    return this.continuationNormalizer;
  }

  private clearContinuationQuiescence(): void {
    if (this.continuationQuiescenceTimer) {
      clearTimeout(this.continuationQuiescenceTimer);
      this.continuationQuiescenceTimer = null;
    }
  }

  private armContinuationQuiescence(): void {
    this.clearContinuationQuiescence();
    if (!this.continuationNormalizer || this.turnActive) return;
    this.continuationQuiescenceTimer = setTimeout(() => {
      this.continuationQuiescenceTimer = null;
      this.finishPendingContinuation('quiescence', 'completed');
    }, this.continuationQuiescenceMs);
    this.continuationQuiescenceTimer.unref?.();
  }

  /**
   * Close a pending continuation turn when the CLI never sent the `result`
   * message that would normally end it. No-op when an active turn owns the
   * outcome path or when the normalizer already finished.
   */
  private finishPendingContinuation(reason: string, outcome: TurnOutcome['outcome']): void {
    this.clearContinuationQuiescence();
    if (!this.continuationNormalizer || this.turnEventNormalizer) return;
    writeLog('[claude-task]', `continuation turn COMPLETE (${reason}, synthesized)`);
    this.emitTurnOutcome({ outcome }, { synthetic: true });
    this.continuationNormalizer = null;
  }

  private emitTurnError(message: string, subtype = 'runtime'): void {
    for (const event of (this.turnEventNormalizer ?? this.continuationNormalizer)?.accept({ kind: 'error', subtype, message }) ?? []) {
      emit(event);
    }
  }

  private emitTurnSource(source: TurnSourceEvent): void {
    for (const event of (this.turnEventNormalizer ?? this.continuationNormalizer)?.accept(source) ?? []) {
      this.trackArtifactWireEvent(event);
      emit(event);
    }
  }

  private trackArtifactWireEvent(event: Record<string, unknown>): void {
    this.turnArtifactAggregator?.observe(event);
  }

  private emitClaudeInteractionTimeout(toolUseId: string): void {
    this.emitTurnError(ASK_USER_QUESTION_TIMEOUT_MESSAGE, 'user_input_timeout');
    this.emitTurnSource({
      kind: 'tool_finished',
      toolUseId,
      content: ASK_USER_QUESTION_TIMEOUT_MESSAGE,
      isError: true,
    });
  }

  private async waitForInteractiveResponse(
    toolUseId: string,
    timeoutMs: number,
    onExpired?: () => void,
  ): Promise<PendingToolResponseResult> {
    this.turnIdleGuard?.suspend();
    try {
      return await waitForClaudeToolResponse(toolUseId, this.config?.sessionId, timeoutMs, onExpired);
    } finally {
      this.turnIdleGuard?.resume();
    }
  }

  private emitTurnOutcome(outcome: TurnOutcome, flags?: { synthetic?: boolean }): void {
    const sessionId = this.config?.sessionId ?? '';
    const summary = this.turnArtifactAggregator?.flushSummary(sessionId);
    if (summary) {
      emit(summary);
    }
    this.turnArtifactAggregator?.reset();
    for (const event of (this.turnEventNormalizer ?? this.continuationNormalizer)?.finish(outcome, flags) ?? []) {
      emit(event);
    }
  }
}

function getClaudePermissionKey(cwd: string, toolName: string, input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command : '';
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  return `${cwd}:${toolName}:${command || filePath || JSON.stringify(input)}`;
}

function rememberClaudePermission(toolUseId: string): void {
  const pending = pendingClaudePermissions.get(toolUseId);
  if (!pending) return;
  alwaysAllowedClaudePermissions.add(getClaudePermissionKey(pending.cwd, pending.toolName, pending.input));
}

function isClaudePermissionAlwaysAllowed(cwd: string, toolName: string, input: Record<string, unknown>): boolean {
  return alwaysAllowedClaudePermissions.has(getClaudePermissionKey(cwd, toolName, input));
}

export function buildUserMessageEvent(
  sessionId: string,
  prompt: string,
  inputPayload?: AgentInputPayload,
  displayContent?: string,
): Record<string, unknown> {
  const payload = normalizeAgentInputPayload(prompt, inputPayload);
  const displayAttachments = getDisplayPayloadAttachments(payload);
  const displayPayload: AgentInputPayload = {
    text: displayContent ?? payload.text,
    attachments: displayAttachments,
    images: displayAttachments.map(({ name, mediaType, dataUrl, size }) => ({ name, mediaType, dataUrl, size })),
  };
  const imageBlocks = buildClaudeUserMessageContent(displayPayload, true)
    .filter((block): block is { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } => block.type === 'image')
    .map((block, index) => ({
      ...block,
      ...(displayAttachments[index]?.name ? { name: displayAttachments[index].name } : {}),
    }));

  return {
    type: 'user_message',
    session_id: sessionId,
    content: imageBlocks.length > 0
      ? [{ type: 'text', text: displayContent ?? payload.text }, ...imageBlocks]
      : displayContent ?? payload.text,
  };
}


function normalizePlanMode(value: unknown): AgentPlanMode {
  return value === 'on' ? 'on' : 'off';
}

const runtime = new SessionRuntime();
const codexRuntime = new CodexAppServerRuntime();

type SidecarRuntime = {
  ensure(cmd: EnsureSessionCommand): Promise<void>;
  canReuse?(cmd: EnsureSessionCommand): boolean;
  emitSessionMapping?(cmd: EnsureSessionCommand): void;
  updatePermissions(cmd: UpdatePermissionsCommand): void | Promise<void>;
  sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void>;
  steerActiveTurn?(prompt: string, inputPayload?: AgentInputPayload): Promise<void>;
  forkSession?(
    sourceAgentSessionId?: string,
    sourceProviderTurnId?: string,
    sourceProviderTurnOrdinal?: number,
    sourceProviderMessageId?: string,
  ): Promise<string>;
  rewindFiles?(providerMessageId: string): Promise<string[]>;
  resetSession(sessionId: string): Promise<void>;
  deleteSession?(agentSessionId: string): Promise<void>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
  respondToPermission?(requestId: string, response: OpenCodePermissionResponse, sessionId: string): Promise<void>;
  respondToQuestion?(requestId: string, answers: string[][]): Promise<void>;
  isPendingQuestion?(requestId: string): boolean;
  /** 会话树 rewind（pi 专属）：fork 到目标用户消息之前，返回新会话文件路径。 */
  rewindToEntry?(entryId: string): Promise<string>;
};

type SidecarCommandDispatcherOptions = {
  claudeRuntime: SidecarRuntime;
  codexRuntime: SidecarRuntime;
  createOpenCodeRuntime: (cmd: EnsureSessionCommand) => SidecarRuntime;
  createPiRuntime: (cmd: EnsureSessionCommand) => SidecarRuntime;
  emit: (event: unknown) => void;
  startProxy?: (cmd: Extract<SidecarCommand, { type: 'start_proxy' }>) => Promise<unknown>;
  stopProxy: () => Promise<void>;
  getProxyStatus?: () => Record<string, unknown>;
  exit: (code: number) => void;
};

export function createSidecarCommandDispatcher(options: SidecarCommandDispatcherOptions) {
  let activeAgentKind: string | undefined;
  let activeSessionId: string | undefined;
  let activeResumeOnly = false;
  let activeAgentSessionId: string | undefined;
  let activeManagedRuntime: { flavor: 'opencode' | 'pi'; runtime: SidecarRuntime } | undefined;
  let ensureTail: Promise<void> = Promise.resolve();
  const pendingPermissionResponses = new Map<SidecarRuntime, Map<string, Promise<void>>>();

  const emitError = (error: unknown): void => {
    options.emit({ type: 'sidecar_error', error: String(error) });
  };

  const isAbortError = (error: unknown): boolean => {
    const message = String(error).toLowerCase();
    return message.includes('abort') || message.includes('the operation was aborted');
  };

  const shutdownManagedRuntime = async (): Promise<void> => {
    const current = activeManagedRuntime;
    if (!current) return;
    await current.runtime.shutdown();
    if (activeManagedRuntime === current) {
      activeManagedRuntime = undefined;
    }
  };

  const ensureSession = async (cmd: EnsureSessionCommand): Promise<void> => {
    const flavor = getRuntimeFlavor(cmd.agentKind);
    activeAgentKind = cmd.agentKind;
    activeSessionId = cmd.sessionId;
    activeResumeOnly = cmd.resumeOnly === true;
    activeAgentSessionId = cmd.agentSessionId;
    if (flavor !== 'opencode' && flavor !== 'pi') {
      await shutdownManagedRuntime();
      const selectedRuntime = flavor === 'codex' ? options.codexRuntime : options.claudeRuntime;
      await selectedRuntime.ensure(cmd);
      return;
    }

    const current = activeManagedRuntime;
    if (current?.flavor === flavor && current.runtime.canReuse?.(cmd)) {
      process.stderr.write(
        `[${flavor}-task] ensure_session REUSE sessionId=${cmd.sessionId ?? 'null'}\n`,
      );
      await current.runtime.updatePermissions({
        type: 'update_permissions',
        sessionId: cmd.sessionId,
        agentKind: cmd.agentKind,
        permissionConfig: cmd.permissionConfig,
        planMode: cmd.planMode,
      });
      current.runtime.emitSessionMapping?.(cmd);
      return;
    }

    await shutdownManagedRuntime();
    const nextRuntime = flavor === 'pi' ? options.createPiRuntime(cmd) : options.createOpenCodeRuntime(cmd);
    try {
      await nextRuntime.ensure(cmd);
    } catch (error) {
      try {
        await nextRuntime.shutdown();
      } catch (cleanupError) {
        emitError(`${String(error)}; ${flavor} cleanup failed: ${String(cleanupError)}`);
      }
      throw error;
    }
    activeManagedRuntime = { flavor, runtime: nextRuntime };
  };

  const dispatchEnsure = (cmd: EnsureSessionCommand): Promise<void> => {
    const operation = ensureTail.then(() => ensureSession(cmd), () => ensureSession(cmd));
    ensureTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const selectedRuntime = (): SidecarRuntime | undefined => {
    const flavor = getRuntimeFlavor(activeAgentKind);
    if (flavor === 'opencode' || flavor === 'pi') return activeManagedRuntime?.flavor === flavor ? activeManagedRuntime.runtime : undefined;
    return flavor === 'codex' ? options.codexRuntime : options.claudeRuntime;
  };

  const dispatch = async (cmd: SidecarCommand): Promise<void> => {
    const cmdSessionId = (cmd as { sessionId?: string }).sessionId;
    if (cmdSessionId) {
      setLogCtx({ sessionId: cmdSessionId });
    }
    switch (cmd.type) {
      case 'ensure_session':
        try {
          await dispatchEnsure(cmd);
        } catch (error) {
          if (cmd.resumeOnly && cmd.agentSessionId && isNativeResumeFailure(error)) {
            options.emit({
              type: 'session_resume_failed',
              session_id: cmd.sessionId,
              agent_kind: cmd.agentKind,
              agent_session_id: cmd.agentSessionId,
              error: String(error),
            });
          } else {
            emitError(error);
          }
        }
        return;
      case 'update_permissions': {
        activeAgentKind = cmd.agentKind ?? activeAgentKind;
        const flavor = getRuntimeFlavor(activeAgentKind);
        if (flavor === 'pi') {
          // pi 权限档位经 canReuse 比对在下一轮 ensure 重建生效，原地更新为 no-op。
          return;
        }
        try {
          if (flavor === 'opencode') {
            const current = selectedRuntime();
            if (!current) throw new Error('OpenCode runtime is not initialized');
            await current.updatePermissions(cmd);
          } else {
            await (flavor === 'codex' ? options.codexRuntime : options.claudeRuntime).updatePermissions(cmd);
          }
        } catch (error) {
          emitError(error);
        }
        return;
      }
      case 'enrich_attachments': {
        try {
          process.stderr.write(
            `[sidecar] Attachment enrichment START model=${cmd.model} baseUrl=${cmd.baseUrl} attachments=${cmd.attachments.length}\n`,
          );
          const blocks = await enrichAttachments(cmd.attachments, {
            protocol: cmd.protocol,
            apiKey: cmd.apiKey,
            baseUrl: cmd.baseUrl,
            model: cmd.model,
          });
          for (const block of blocks) {
            if (block.ok) {
              process.stderr.write(
                `[sidecar] Attachment enrichment OK name=${block.attachment_name} chars=${block.markdown.length}\n`,
              );
            } else {
              process.stderr.write(
                `[sidecar] Attachment enrichment FAILED name=${block.attachment_name} error=${block.error ?? 'unknown'}\n`,
              );
            }
          }
          options.emit({
            type: 'enrichment_result',
            request_id: cmd.requestId,
            ok: true,
            blocks,
          });
        } catch (error) {
          options.emit({
            type: 'enrichment_result',
            request_id: cmd.requestId,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'send_input': {
        await ensureTail;
        const current = selectedRuntime();
        if (!current) {
          emitError(`${getRuntimeFlavor(activeAgentKind)} runtime is not initialized`);
          return;
        }
        const sessionId = cmd.sessionId ?? activeSessionId;
        if (cmd.delivery === 'steer') {
          try {
            if (!current.steerActiveTurn) {
              throw new SteerUnavailableError(`${getRuntimeFlavor(activeAgentKind)} runtime does not support steer`);
            }
            await current.steerActiveTurn(cmd.prompt, cmd.inputPayload);
            if (sessionId) {
              options.emit(buildUserMessageEvent(sessionId, cmd.prompt, cmd.inputPayload, cmd.displayContent));
            }
            if (cmd.requestId) {
              options.emit({ type: 'steer_result', request_id: cmd.requestId, ok: true });
            }
          } catch (error) {
            if (cmd.requestId) {
              options.emit({
                type: 'steer_result',
                request_id: cmd.requestId,
                ok: false,
                unavailable: isSteerUnavailableError(error),
                error: String(error),
              });
            } else if (!isSteerUnavailableError(error)) {
              emitError(error);
            }
          }
          return;
        }
        if (sessionId) {
          options.emit(buildUserMessageEvent(sessionId, cmd.prompt, cmd.inputPayload, cmd.displayContent));
        }
        void current.sendInput(cmd.prompt, cmd.inputPayload).catch((error) => {
          if (activeResumeOnly && activeAgentSessionId && isNativeResumeFailure(error)) {
            options.emit({
              type: 'session_resume_failed',
              session_id: activeSessionId,
              agent_kind: activeAgentKind,
              agent_session_id: activeAgentSessionId,
              error: String(error),
            });
          } else if (!isAbortError(error)) {
            emitError(error);
          }
        });
        return;
      }
      case 'fork_session': {
        await ensureTail;
        try {
          const current = selectedRuntime();
          const flavor = getRuntimeFlavor(activeAgentKind);
          if (
            (flavor !== 'claude' && flavor !== 'codex' && flavor !== 'opencode' && flavor !== 'pi')
            || !current?.forkSession
          ) {
            throw new Error('This provider runtime does not support session fork');
          }
          const agentSessionId = await current.forkSession(
            cmd.sourceAgentSessionId,
            cmd.sourceProviderTurnId,
            cmd.sourceProviderTurnOrdinal,
            cmd.sourceProviderMessageId,
          );
          options.emit({
            type: 'session_fork_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            agent_kind: activeAgentKind,
            agent_session_id: agentSessionId,
            ok: true,
          });
        } catch (error) {
          options.emit({
            type: 'session_fork_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            agent_kind: activeAgentKind,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'rewind_files': {
        await ensureTail;
        try {
          const current = selectedRuntime();
          const flavor = getRuntimeFlavor(activeAgentKind);
          if (flavor !== 'claude' || !current?.rewindFiles) {
            throw new Error('This provider runtime does not support file rewind');
          }
          const filesChanged = await current.rewindFiles(cmd.providerMessageId);
          options.emit({
            type: 'session_rewind_files_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: true,
            files_changed: filesChanged,
          });
        } catch (error) {
          options.emit({
            type: 'session_rewind_files_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'rewind_conversation': {
        await ensureTail;
        try {
          const current = selectedRuntime();
          const flavor = getRuntimeFlavor(activeAgentKind);
          if (flavor !== 'pi' || !current?.rewindToEntry) {
            throw new Error('This provider runtime does not support conversation rewind');
          }
          const agentSessionId = await current.rewindToEntry(cmd.entryId);
          options.emit({
            type: 'session_rewind_conversation_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: true,
            agent_session_id: agentSessionId,
          });
        } catch (error) {
          options.emit({
            type: 'session_rewind_conversation_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'reset_session':
        try {
          const current = selectedRuntime();
          if (!current) throw new Error('OpenCode runtime is not initialized');
          await current.resetSession(cmd.sessionId);
        } catch (error) {
          emitError(error);
        }
        return;
      case 'delete_session': {
        try {
          const current = selectedRuntime();
          if (current?.deleteSession) {
            await current.deleteSession(cmd.agentSessionId);
          } else {
            if (!cmd.runtimeRef) {
              throw new Error('OpenCode Runtime is required before deleting a session');
            }
            await deleteOpenCodeSessionWithOfficialSdk({ cwd: cmd.cwd, sessionId: cmd.agentSessionId, runtimeRef: cmd.runtimeRef });
          }
          options.emit({
            type: 'session_delete_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: true,
          });
        } catch (error) {
          options.emit({
            type: 'session_delete_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'interrupt':
        try {
          const current = selectedRuntime();
          if (!current) throw new Error(`${getRuntimeFlavor(activeAgentKind)} runtime is not initialized`);
          await current.interrupt();
        } catch (error) {
          if (!isAbortError(error)) emitError(error);
        }
        return;
      case 'tool_response': {
        const flavor = getRuntimeFlavor(activeAgentKind);
        const openCodeRuntime = flavor === 'opencode'
          ? (activeManagedRuntime?.flavor === 'opencode' ? activeManagedRuntime.runtime : undefined)
          : undefined;
        const codexQuestionRuntime = flavor === 'codex' ? options.codexRuntime : undefined;
        const piRuntime = flavor === 'pi'
          ? (activeManagedRuntime?.flavor === 'pi' ? activeManagedRuntime.runtime : undefined)
          : undefined;
        if (openCodeRuntime?.isPendingQuestion?.(cmd.toolUseId)) {
          const raw = Array.isArray(cmd.response) ? cmd.response : [];
          const answers = raw.map((a: unknown) => (Array.isArray(a) ? a : [String(a)]));
          openCodeRuntime.respondToQuestion?.(cmd.toolUseId, answers).catch((err: unknown) => emitError(err));
        } else if (codexQuestionRuntime?.isPendingQuestion?.(cmd.toolUseId)) {
          const raw = Array.isArray(cmd.response) ? cmd.response : [];
          const answers = raw.map((a: unknown) => (Array.isArray(a) ? a : [String(a)]));
          codexQuestionRuntime.respondToQuestion?.(cmd.toolUseId, answers).catch((err: unknown) => emitError(err));
        } else if (piRuntime?.isPendingQuestion?.(cmd.toolUseId)) {
          const raw = Array.isArray(cmd.response) ? cmd.response : [];
          const answers = raw.map((a: unknown) => (Array.isArray(a) ? a : [String(a)]));
          piRuntime.respondToQuestion?.(cmd.toolUseId, answers).catch((err: unknown) => emitError(err));
        } else if (flavor === 'pi') {
          emitError('pi tool responses are only supported while a question is pending');
        } else if (openCodeRuntime) {
          options.emit({ type: 'sidecar_error', error: 'OpenCode tool responses are server-managed/not supported' });
        } else {
          resolveClaudeToolResponse(cmd.toolUseId, cmd.response);
        }
        return;
      }
      case 'respond_to_permission': {
        const flavor = getRuntimeFlavor(activeAgentKind);
        if (flavor === 'claude') {
          if (!resolveClaudeToolResponse(cmd.requestId, cmd.response)) {
            emitError(`Claude permission request ${cmd.requestId} is no longer pending`);
          }
          return;
        }
        const current = flavor === 'opencode'
          ? (activeManagedRuntime?.flavor === 'opencode' ? activeManagedRuntime.runtime : undefined)
          : flavor === 'codex'
            ? options.codexRuntime
            : flavor === 'pi'
              ? (activeManagedRuntime?.flavor === 'pi' ? activeManagedRuntime.runtime : undefined)
              : undefined;
        if (!current?.respondToPermission) {
          emitError(flavor === 'codex'
            ? 'Codex runtime is not initialized'
            : flavor === 'pi'
              ? 'pi runtime is not initialized'
              : 'OpenCode runtime is not initialized');
          return;
        }
        const runtimePendingResponses = pendingPermissionResponses.get(current) ?? new Map<string, Promise<void>>();
        pendingPermissionResponses.set(current, runtimePendingResponses);
        const responseKey = `${cmd.sessionId}:${cmd.requestId}`;
        if (runtimePendingResponses.has(responseKey)) return;
        const responseTask = Promise.resolve()
          .then(() => current.respondToPermission!(cmd.requestId, cmd.response as OpenCodePermissionResponse, cmd.sessionId))
          .catch((error) => {
            emitError(error);
          })
          .finally(() => {
            if (runtimePendingResponses.get(responseKey) === responseTask) {
              runtimePendingResponses.delete(responseKey);
            }
            if (runtimePendingResponses.size === 0 && pendingPermissionResponses.get(current) === runtimePendingResponses) {
              pendingPermissionResponses.delete(current);
            }
          });
        runtimePendingResponses.set(responseKey, responseTask);
        return;
      }
      case 'shutdown': {
        const cleanupErrors: unknown[] = [];
        const attemptCleanup = async (label: string, cleanup: () => Promise<void>): Promise<void> => {
          try {
            await cleanup();
          } catch (error) {
            cleanupErrors.push(new Error(`${label}: ${String(error)}`));
          }
        };
        await attemptCleanup('Failed to stop proxy', options.stopProxy);
        await attemptCleanup('Failed to shutdown managed runtime', shutdownManagedRuntime);
        const activeFlavor = getRuntimeFlavor(activeAgentKind);
        if (activeFlavor !== 'opencode' && activeFlavor !== 'pi') {
          const currentRuntime = activeFlavor === 'codex' ? options.codexRuntime : options.claudeRuntime;
          await attemptCleanup('Failed to shutdown active runtime', () => currentRuntime.shutdown());
        }
        if (cleanupErrors.length > 0) {
          const aggregateError = new AggregateError(cleanupErrors, 'Sidecar shutdown cleanup failed');
          options.emit({ type: 'sidecar_error', error: `${aggregateError.message}: ${cleanupErrors.map(String).join('; ')}` });
        }
        options.exit(0);
        return;
      }
      case 'start_proxy':
        try {
          await options.startProxy?.(cmd);
          if (options.getProxyStatus) options.emit({ type: 'proxy_status', ...options.getProxyStatus() });
        } catch (error) {
          options.emit({ type: 'sidecar_error', error: `Failed to start proxy: ${String(error)}` });
        }
        return;
      case 'stop_proxy':
        try {
          await options.stopProxy();
          if (options.getProxyStatus) options.emit({ type: 'proxy_status', ...options.getProxyStatus() });
        } catch (error) {
          options.emit({ type: 'sidecar_error', error: `Failed to stop proxy: ${String(error)}` });
        }
        return;
      case 'proxy_status':
        if (options.getProxyStatus) options.emit({ type: 'proxy_status', ...options.getProxyStatus() });
        return;
    }
  };

  return { dispatch };
}

function buildOpenCodeSessionConfig(cmd: EnsureSessionCommand): OpenCodeSessionConfig {
  const modelReference = cmd.model?.startsWith('opencode/')
    ? normalizeOpenCodeModelReference(cmd.model)
    : cmd.provider
      ? { provider: cmd.provider, model: cmd.model ?? 'default' }
      : normalizeOpenCodeModelReference(cmd.model ?? 'default');
  return {
    cwd: ensureWorkingDirectory(cmd.cwd),
    sessionId: cmd.sessionId ?? crypto.randomUUID(),
    ...(cmd.agentSessionId ? { agentSessionId: cmd.agentSessionId } : {}),
    runtimeGeneration: cmd.runtimeGeneration ?? 0,
    provider: modelReference.provider,
    model: modelReference.model,
    credentialSource: cmd.credentialSource ?? 'none',
    ...(cmd.credentialSource === 'codemux' && cmd.apiKey ? { apiKey: cmd.apiKey } : {}),
    ...(cmd.baseUrl ? { baseUrl: cmd.baseUrl } : {}),
    ...(cmd.runtimeRef ? { runtimeRef: cmd.runtimeRef } : {}),
    ...(cmd.timeouts ? { timeouts: cmd.timeouts } : {}),
    ...(cmd.modelLimits ? { modelLimits: cmd.modelLimits } : {}),
    ...(cmd.mcpServers ? { mcpServers: cmd.mcpServers } : {}),
  };
}

function createOpenCodeSidecarRuntime(cmd: EnsureSessionCommand): SidecarRuntime {
  const config = buildOpenCodeSessionConfig(cmd);
  syncStreamSessionContext({
    appSessionId: config.sessionId,
    ...(config.agentSessionId ? { providerSessionId: config.agentSessionId } : {}),
  });
  const openCodeRuntime = new OpenCodeRuntime(config);
  if (cmd.planMode === 'on' || cmd.planMode === 'off') {
    openCodeRuntime.updatePermissions({ permissionConfig: cmd.permissionConfig, planMode: cmd.planMode });
  } else if (cmd.permissionConfig) {
    openCodeRuntime.updatePermissions({ permissionConfig: cmd.permissionConfig });
  }
  return {
    ensure: async () => {
      const mapping = await openCodeRuntime.start();
      emit(buildOpenCodeSessionMappingEvent(mapping));
    },
    emitSessionMapping: (cmd) => {
      if (!openCodeRuntime.isStarted()) {
        return;
      }
      emit(buildOpenCodeSessionMappingEvent(
        openCodeRuntime.buildSessionMapping(cmd.runtimeGeneration ?? 0),
      ));
    },
    canReuse: (nextCmd) => openCodeRuntime.canReuse(buildOpenCodeSessionConfig(nextCmd)),
    sendInput: (prompt, inputPayload) => openCodeRuntime.sendInput(prompt, inputPayload),
    steerActiveTurn: (prompt, inputPayload) => openCodeRuntime.steerActiveTurn(prompt, inputPayload),
    updatePermissions: (update) => openCodeRuntime.updatePermissions(update),
    forkSession: (
      sourceAgentSessionId,
      sourceProviderTurnId,
      sourceProviderTurnOrdinal,
      sourceProviderMessageId,
    ) => openCodeRuntime.forkSession(
      sourceAgentSessionId,
      sourceProviderTurnId,
      sourceProviderTurnOrdinal,
      sourceProviderMessageId,
    ),
    resetSession: () => openCodeRuntime.resetSession(),
    deleteSession: (agentSessionId) => openCodeRuntime.deleteSession(agentSessionId),
    interrupt: () => openCodeRuntime.interrupt(),
    shutdown: () => openCodeRuntime.shutdown(),
    respondToPermission: (requestId, response, sessionId) => openCodeRuntime.respondToPermission(requestId, response, sessionId),
    respondToQuestion: (requestId, answers) => openCodeRuntime.respondToQuestion(requestId, answers),
    isPendingQuestion: (requestId) => openCodeRuntime.isPendingQuestion(requestId),
  };
}

function buildPiSessionConfig(cmd: EnsureSessionCommand): PiSessionConfig {
  let provider = cmd.provider ?? undefined;
  let model = cmd.model ?? undefined;
  if (!provider && model && model.includes('/')) {
    const separatorIndex = model.indexOf('/');
    provider = model.slice(0, separatorIndex);
    model = model.slice(separatorIndex + 1);
  }
  // pi 无 'opencode' 凭据来源语义；未知值按未配置处理（不回落 pi 自身认证）。
  const credentialSource: PiSessionConfig['credentialSource'] =
    cmd.credentialSource === 'codemux' || cmd.credentialSource === 'environment'
      ? cmd.credentialSource
      : 'none';
  return {
    cwd: ensureWorkingDirectory(cmd.cwd),
    sessionId: cmd.sessionId ?? crypto.randomUUID(),
    ...(cmd.agentSessionId ? { agentSessionId: cmd.agentSessionId } : {}),
    runtimeGeneration: cmd.runtimeGeneration ?? 0,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(mapReasoningEffortToPiThinking(cmd.reasoningEffort)
      ? { thinkingLevel: mapReasoningEffortToPiThinking(cmd.reasoningEffort) }
      : {}),
    credentialSource,
    ...(credentialSource === 'codemux' && cmd.apiKey ? { apiKey: cmd.apiKey } : {}),
    ...(cmd.baseUrl ? { baseUrl: cmd.baseUrl } : {}),
    ...(cmd.piConfigDir ? { piConfigDir: cmd.piConfigDir } : {}),
    approvalMode: resolvePiApprovalMode(cmd.permissionConfig),
    ...(cmd.modelLimits?.contextWindow && cmd.modelLimits.contextWindow > 0
      ? { modelContextWindow: cmd.modelLimits.contextWindow }
      : {}),
    ...(cmd.modelLimits?.maxTokens && cmd.modelLimits.maxTokens > 0
      ? { modelMaxTokens: cmd.modelLimits.maxTokens }
      : {}),
    ...(cmd.runtimeRef ? { runtimeRef: cmd.runtimeRef } : {}),
    ...(cmd.mcpServers && Object.keys(cmd.mcpServers).length > 0
      ? { mcpServers: cmd.mcpServers }
      : {}),
  };
}

/** pi 审批档位：只识别 pi kind 的配置（executionMode），其余回落 confirm_before_edit。 */
function resolvePiApprovalMode(config: SidecarPermissionConfig | undefined): PiApprovalMode {
  if (config?.kind === 'pi') {
    if (config.executionMode === 'auto_edit' || config.executionMode === 'full_access') {
      return config.executionMode;
    }
  }
  return 'confirm_before_edit';
}

/** CodeMUX reasoningEffort → pi thinking level（'none' → 'off'，缺省交给 pi 默认 medium）。 */
function mapReasoningEffortToPiThinking(effort: string | undefined): PiThinkingLevel | undefined {
  switch (effort) {
    case 'none':
      return 'off';
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort;
    default:
      return undefined;
  }
}

function createPiSidecarRuntime(cmd: EnsureSessionCommand): SidecarRuntime {
  const config = buildPiSessionConfig(cmd);
  syncStreamSessionContext({
    appSessionId: config.sessionId,
    ...(config.agentSessionId ? { providerSessionId: config.agentSessionId } : {}),
  });
  const piRuntime = new PiRuntime(config);
  return {
    ensure: async () => {
      const mapping = await piRuntime.ensure();
      emit(buildPiSessionMappingEvent(mapping));
    },
    emitSessionMapping: (cmd) => {
      if (!piRuntime.isStarted) {
        return;
      }
      emit(buildPiSessionMappingEvent(piRuntime.buildSessionMapping(cmd.runtimeGeneration ?? 0)));
    },
    canReuse: (nextCmd) => piRuntime.canReuse(buildPiSessionConfig(nextCmd)),
    sendInput: (prompt, inputPayload) => piRuntime.sendInput(prompt, inputPayload),
    steerActiveTurn: (prompt, inputPayload) => piRuntime.steerActiveTurn(prompt, inputPayload),
    updatePermissions: () => {
      // pi 权限档位经 canReuse 比对在下一轮 ensure 重建生效（与模型/思考等级同机制），
      // 原地更新为 no-op。
    },
    respondToPermission: (requestId, response, sessionId) =>
      piRuntime.respondToPermission(requestId, response, sessionId),
    respondToQuestion: (requestId, answers) => piRuntime.respondToQuestion(requestId, answers),
    isPendingQuestion: (requestId) => piRuntime.isPendingQuestion(requestId),
    forkSession: (sourceAgentSessionId) => piRuntime.forkSession(sourceAgentSessionId),
    rewindToEntry: (entryId) => piRuntime.forkToEntry(entryId),
    resetSession: () => piRuntime.resetSession(),
    deleteSession: (agentSessionId) => piRuntime.deleteSession(agentSessionId),
    interrupt: () => piRuntime.interrupt(),
    shutdown: () => piRuntime.shutdown(),
  };
}

async function main(): Promise<void> {
  // ADR 0005: CodeMUX sessions inject credentials via ensure_session.
  // Do not preload ~/.claude/settings.json into process.env for hosted chats.

  emit({ type: 'sidecar_ready' });

  const rl = readline.createInterface({ input: process.stdin });
  const dispatcher = createSidecarCommandDispatcher({
    claudeRuntime: runtime,
    codexRuntime,
    createOpenCodeRuntime: createOpenCodeSidecarRuntime,
    createPiRuntime: createPiSidecarRuntime,
    emit,
    startProxy: (cmd) => proxyManager.start(cmd.apiKey, cmd.baseUrl, cmd.providerName, cmd.codexNeedsProxy),
    stopProxy: () => proxyManager.stop(),
    getProxyStatus: () => proxyManager.getStatus(),
    exit: (code) => process.exit(code),
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let cmd: SidecarCommand;
    try {
      cmd = JSON.parse(trimmed) as SidecarCommand;
    } catch {
      emit({ type: 'sidecar_error', error: `Invalid JSON: ${trimmed}` });
      continue;
    }

    await dispatcher.dispatch(cmd);
  }
}

if (isSidecarEntrypoint(process.argv[1])) {
  main().catch((err) => {
    emit({ type: 'sidecar_error', error: `Fatal: ${String(err)}` });
    process.exit(1);
  });
}
