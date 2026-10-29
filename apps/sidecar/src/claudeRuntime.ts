/**
 * Claude 运行时（SessionRuntime）。
 *
 * query 生命周期、流式事件投影、原生标题同步与交互等待都自成一类；原先内联在
 * index.ts 里，dispatcher 只能把它当成一个碰巧长得像 SidecarRuntime 的对象。
 * 本模块只依赖 sidecar 内的共享工具，不依赖 dispatcher 或入口。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Query,
  QueryTitleGenerator,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { EnsureSessionCommand, UpdatePermissionsCommand } from './types.js';
import { getProviderMode } from './sessionRuntimeHelpers.js';
import { formatAdditionalDirectoriesPrompt } from './additionalDirectories.js';
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
import { toClaudeTurnOutcome } from './claudeTurnOutcome.js';
import { TurnEventNormalizer, type TurnOutcome, type TurnSourceEvent } from './turnEventNormalizer.js';
import { TurnArtifactAggregator } from './turnArtifactSummary.js';
import { emit, resetStreamEventSequences, syncStreamSessionContext } from './streamEventBatcher.js';
import { buildSessionTitleEvent, extractClaudeSessionTitle } from './sessionTitleEvent.js';
import { assertWorkingDirectory, ensureWorkingDirectory } from './defaultWorkingDirectory.js';
import { mapToClaudeEffort, normalizeReasoningEffort, type ReasoningEffort } from './reasoningEffort.js';
import { buildClaudePermissionOptions, type AgentPlanMode, type SidecarPermissionConfig } from './agentPermissions.js';
import type { PiMcpServers } from './piMcp.js';
import { getClaudeApprovalTitle } from './claudeApprovalPrompt.js';
import {
  buildClaudeModeBlockedEvent,
  getActivePermissionState,
  permissionGateFor,
  resolveClaudeToolRuntimeDecision,
  setActivePermissionState,
} from './activePermissionState.js';
import { detectShellInputSynthesis, shellInputSynthesisMessage } from './shellInputSynthesis.js';
import { normalizeAskUserQuestionAnswers, ASK_USER_QUESTION_IGNORED_MESSAGE } from './askUserQuestionCancel.js';
import {
  isImageUnsupportedError,
  type AgentInputPayload,
} from './agentInputPayload.js';
import { isSteerBlockedPrompt, SteerUnavailableError } from './steer.js';
import { shouldCaptureClaudeSessionMapping } from './claudeSessionMapping.js';
import { isClaudeSidechainMessage, shouldForwardClaudeSdkMessage } from './claudeSdkMessageFilter.js';
import {
  applyClaudeModelAliasEnv,
  buildClaudeContextEnvWipe,
  buildClaudeModelAliasEnv,
  wipeClaudeContextEnv,
  wipeClaudeModelAliasEnv,
} from './claudeModelAliasEnv.js';
import { ClaudeTaskProtocolSource } from './claudeTaskProtocolSource.js';
import { ClaudePromptStream } from './claudePromptStream.js';
import { nextWithTimeout } from './claudeQueryTimeout.js';
import { setLogCtx, writeLog } from './writeLog.js';
import { resolveTurnTimeouts, type ResolvedTurnTimeouts, type TurnTimeouts } from './turnTimeouts.js';
import { createTurnIdleGuard, type TurnIdleGuard } from './turnIdleGuard.js';
import { isNativeResumeFailure } from './runtimeErrors.js';

const WARM_START_TIMEOUT_MS = 30_000;
/**
 * How long a prompt waits for the background `startup()` warmup before falling
 * back to a cold `query()`. Measured on this machine: the warmup produces a
 * reusable session in ~2.4s, while a cold `query()` needs 3.7–4.3s (CLI spawn +
 * init), so adopting the warm session is worth roughly 1.5–2s. The window is
 * that measured budget plus margin for machine load. A warmup that already
 * settled (with or without a reusable session) resolves the wait immediately,
 * and a failed one rejects fast (~30ms), so the wait only costs extra when the
 * warmup is genuinely slow.
 */
const WARM_QUERY_WAIT_WINDOW_MS = 4_000;
const MESSAGE_TIMEOUT_MS = 300_000;
const ASK_USER_QUESTION_TIMEOUT_MESSAGE = '等待用户回复超时，请重新发送消息继续';
/** Silence window after which a pending continuation turn is considered ended. */
const CONTINUATION_QUIESCENCE_MS = 10_000;
/**
 * Delay ladder for re-reading the Claude session title: the CLI writes the
 * ai-title asynchronously *after* `result`, so the first reads can still see the
 * first-prompt fallback and must be retried.
 */
const CLAUDE_TITLE_SYNC_DELAYS_MS = [4_000, 12_000, 30_000, 60_000] as const;
/** A hung `generateSessionTitle` must not wedge title sync forever. */
const CLAUDE_TITLE_GENERATE_TIMEOUT_MS = 20_000;

// Gate per-message stderr logs. Each stderr line is read by the Rust backend,
// mutex-locked into a capture buffer, and logged via tracing — so per-message
// writes during streaming (hundreds/sec) cause severe I/O and lock contention.
// Enable with CODEMUX_MESSAGE_DEBUG=1 when debugging message flow.
const DEBUG_MESSAGE_LOGS = process.env.CODEMUX_MESSAGE_DEBUG === '1';

type SessionBootstrap = {
  sessionId?: string;
  /** 会话的智能体类型:权限门归因(工单 07)与运行时回退的判断依据。 */
  agentKind?: string;
  agentSessionId?: string;
  resumeOnly?: boolean;
  runtimeGeneration: number;
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /**
   * Provider the daemon bound this session to. Carried so a runtime-learned
   * capability rejection can be scoped to the endpoint that produced it —
   * the same model id behind another provider may well accept images.
   */
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  skills?: string[];
  settingSources?: string[];
  permissionConfig?: SidecarPermissionConfig;
  planMode?: AgentPlanMode;
  runtimeRef?: import('./runtimeContract.js').ProviderRuntimeRef;
  timeouts?: TurnTimeouts;
  /** daemon 随会话命令下发的 MCP 服务器(pi 直传;claude 经 buildOptions 注入 SDK)。 */
  mcpServers?: PiMcpServers;
  /** 项目附加目录的绝对路径；只经系统提示声明，不启用原生多目录能力。 */
  additionalDirectories?: string[];
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

/** Resolve `undefined` if the SDK title generation does not settle in time. */
function withClaudeTitleTimeout<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), CLAUDE_TITLE_GENERATE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

/** Outcome of waiting for the background warmup session before prompting. */
type WarmWaitResult =
  | { kind: 'ready'; warm: WarmQuery }
  | { kind: 'settled_empty' }
  | { kind: 'timeout' }
  | { kind: 'absent' };

/**
 * Await the background warmup for at most `timeoutMs`, keeping "the warmup
 * settled without a reusable session" distinct from "the warmup is still
 * pending". The previous helper collapsed both into `null`, which made a failed
 * warmup and a slow one indistinguishable in the logs.
 */
export function waitForWarmup(
  promise: Promise<WarmQuery | null>,
  timeoutMs: number,
): Promise<WarmWaitResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    if (timer.unref) timer.unref();
    promise
      .then((warm) => {
        clearTimeout(timer);
        resolve(warm ? { kind: 'ready', warm } : { kind: 'settled_empty' });
      })
      .catch(() => {
        clearTimeout(timer);
        resolve({ kind: 'settled_empty' });
      });
  });
}

function isMissingClaudeConversationError(err: unknown): boolean {
  return String(err).includes('No conversation found with session ID');
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
  /**
   * Per-turn compaction flags. They must live on the runtime, not be captured as
   * `consumeQuery` parameters: `consumeQuery` loops across turns on a reused
   * persistent query, so a captured value would describe the *first* turn only.
   */
  private turnManualCompact = false;
  private compactingPlaceholderShown = false;
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
  /** 原生标题同步：首轮结束后主动让 Claude 生成一次标题（成功即止，失败可再试）。 */
  private claudeTitleSynced = false;
  private claudeTitleInFlight = false;
  private lastEmittedNativeTitle: string | null = null;
  /** 梯子定时器按运行代际归属：reconfigure/切会话时必须全部撤销。 */
  private claudeTitleTimers = new Set<ReturnType<typeof setTimeout>>();
  private claudeTitleRunId = 0;
  private generation = 0;
  private activeConfigGeneration = 0;
  private claudeExecutablePath: string | undefined;
  /** 动态加载的 Claude SDK 模块（仅从托管 Runtime 加载）。 */
  private claudeSdk: ClaudeSdkModule | null = null;
  /** 托管 Runtime 加载结果，用于解析 SDK 路径。 */
  private runtimeLoaded: RuntimeLoadResult | null = null;
  /** [perf] 最近一次 query() 消费起点：首条 SDK 消息耗时的基准。 */
  private lastQueryStartedAt = 0;

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

    const ensureStartedAt = Date.now();
    await this.resetForReconfigure();

    // 生产与开发环境都必须从 CodeMUX 托管 Runtime 路径动态加载 Claude SDK。
    this.runtimeLoaded = this.loadRuntimeIfNeeded();
    this.claudeSdk = await loadClaudeSdk(this.runtimeLoaded);
    process.stderr.write(`[sidecar] [perf] claude ensure (runtime load + sdk modules) elapsed_ms=${Date.now() - ensureStartedAt}\n`);

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
      this.armTurnCompaction(prompt, inputPayload);
      writeLog('[claude-task]', `sendInput START (stream reuse) model=${this.config.model ?? 'default'} prompt_preview=${prompt.slice(0, 120)}`);
      if (this.promptStream.push(prompt, inputPayload)) {
        this.emitManualCompactPlaceholder();
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
    this.armTurnCompaction(prompt, inputPayload);

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

    // Non-destructive SDK fork: a pure transcript copy, it never starts a model
    // turn. The legacy path below opens a query with an empty prompt, which the
    // CLI may treat as a real user turn and answer — that stray assistant
    // message then lands in the child transcript and shows up on CLI sync.
    const sdkForkSession = this.claudeSdk.forkSession;
    if (typeof sdkForkSession === 'function') {
      const fork = await sdkForkSession(sourceSessionId);
      const forkedSessionId = fork?.sessionId;
      if (!forkedSessionId) {
        throw new Error('Claude SDK forkSession response did not include a session id');
      }
      process.stderr.write(`[sidecar] Forked Claude session ${sourceSessionId} -> ${forkedSessionId}\n`);
      return forkedSessionId;
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

  /**
   * 会话内回退(回退到 boundary 消息之后的内容):用 SDK 的非破坏
   * `forkSession(sessionId, { upToMessageId })` 从原会话切片复制出一个新
   * 会话并原地 rebind —— 原 transcript 不动,回退后 warm resend 照常工作,
   * 新 agent session id 由返回值交给 daemon 更新 mapping。
   * `providerMessageId` 是回退边界「下一条」消息的 uuid:即切片保留到该
   * 消息之前 daemon 已解析好的 upTo uuid。
   */
  async rewindConversation(input: { providerMessageId?: string }): Promise<string> {
    const config = this.config;
    if (!config) {
      throw new Error('Claude session has not been bootstrapped. Call ensure_session first.');
    }
    if (this.turnActive) {
      throw new Error('Cannot rewind while a Claude turn is active');
    }
    const sourceSessionId = config.agentSessionId;
    if (!sourceSessionId) {
      throw new Error('Claude native session is not ready for rewind');
    }
    const upToMessageId = input.providerMessageId?.trim();
    if (!upToMessageId) {
      throw new Error('Claude rewind requires the boundary message id');
    }
    if (!this.claudeSdk) {
      throw new Error('Claude SDK not loaded; cannot rewind conversation');
    }
    const forkSession = this.claudeSdk.forkSession;
    if (typeof forkSession !== 'function') {
      throw new Error(
        'Installed Claude Code Runtime does not support forkSession; upgrade the Claude Code runtime to rewind conversations',
      );
    }

    writeLog(
      '[claude-task]',
      `rewindConversation START session=${sourceSessionId} upTo=${upToMessageId}`,
    );
    const fork = await forkSession(sourceSessionId, { upToMessageId });
    const forkedSessionId = fork?.sessionId;
    if (!forkedSessionId) {
      throw new Error('Claude SDK forkSession response did not include a session id');
    }
    this.config = { ...config, agentSessionId: forkedSessionId };
    writeLog(
      '[claude-task]',
      `rewindConversation OK session=${sourceSessionId} -> ${forkedSessionId}`,
    );
    return forkedSessionId;
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
      agentKind: cmd.agentKind,
      agentSessionId: cmd.agentSessionId,
      resumeOnly: cmd.resumeOnly,
      runtimeGeneration: cmd.runtimeGeneration ?? 0,
      cwd,
      apiKey: cmd.apiKey,
      baseUrl: cmd.baseUrl,
      model: cmd.model,
      provider: cmd.provider,
      reasoningEffort: normalizeReasoningEffort(cmd.reasoningEffort),
      skills: cmd.skills,
      settingSources: cmd.settingSources,
      permissionConfig: cmd.permissionConfig,
      planMode: normalizePlanMode(cmd.planMode),
      runtimeRef: cmd.runtimeRef,
      timeouts: cmd.timeouts,
      mcpServers: cmd.mcpServers,
      additionalDirectories: cmd.additionalDirectories,
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
    this.resetClaudeTitleSync();
    this.subagents.reset();
    if (this.warmQuery) {
      this.warmQuery.close();
      this.warmQuery = null;
    }
    this.warmPromise = null;
    this.abortController = null;
  }

  /**
   * Drop every pending title-sync attempt and bump the run id so an in-flight
   * generation/read can no longer emit for the session that just went away.
   */
  private resetClaudeTitleSync(): void {
    this.claudeTitleRunId += 1;
    this.claudeTitleSynced = false;
    this.claudeTitleInFlight = false;
    this.lastEmittedNativeTitle = null;
    for (const timer of this.claudeTitleTimers) {
      clearTimeout(timer);
    }
    this.claudeTitleTimers.clear();
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

  /**
   * Adopt a completed background `startup()` session so the next prompt can
   * reuse it. When the session is no longer usable — the config changed while
   * the warmup was in flight, or an interactive query already took over — close
   * it and log why: a silently discarded warmup is indistinguishable from a
   * hung one when reading the daemon log.
   */
  private adoptWarmQuery(
    warm: WarmQuery,
    configGeneration: number,
    warmupStartedAt: number,
    via: string,
  ): WarmQuery | null {
    if (configGeneration !== this.activeConfigGeneration) {
      process.stderr.write(
        `[sidecar] [perf] claude warmup result discarded (${via}): config generation changed ${configGeneration} -> ${this.activeConfigGeneration}; closing warmed session\n`,
      );
      warm.close();
      return null;
    }
    if (this.queryHandle) {
      process.stderr.write(
        `[sidecar] [perf] claude warmup result discarded (${via}): an interactive query already started; closing warmed session\n`,
      );
      warm.close();
      return null;
    }
    this.warmQuery = warm;
    emit({ type: 'mcp_status_update', servers: {}, status: 'ready' });
    process.stderr.write(
      `[sidecar] [perf] claude background startup() complete elapsed_ms=${Date.now() - warmupStartedAt} (${via})\n`,
    );
    return warm;
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

    const warmupStartedAt = Date.now();
    this.warmPromise = warmAttempt(
      'Calling startup() to pre-warm the Claude session (CLI spawn + MCP connect) in the background...',
    ).then((warm: WarmQuery) =>
      this.adoptWarmQuery(warm, configGeneration, warmupStartedAt, 'initial'),
    )
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
            return this.adoptWarmQuery(
              warm,
              configGeneration,
              warmupStartedAt,
              'recovered after clearing stale resume mapping',
            );
          } catch (retryErr) {
            startupErr = retryErr;
          }
        }

        process.stderr.write(`[sidecar] [perf] claude background startup() failed elapsed_ms=${Date.now() - warmupStartedAt}: ${startupErr}\n`);
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

    const warmWaitStartedAt = Date.now();
    const warmOutcome: WarmWaitResult = this.warmPromise
      ? await waitForWarmup(this.warmPromise, WARM_QUERY_WAIT_WINDOW_MS)
      : { kind: 'absent' };
    const warm = warmOutcome.kind === 'ready' ? warmOutcome.warm : null;

    if (queryGeneration !== this.generation || configGeneration !== this.activeConfigGeneration) {
      if (warm) {
        warm.close();
      }
      return;
    }

    if (warm) {
      process.stderr.write(`[sidecar] [perf] claude query from pre-warmed session (waited ${Date.now() - warmWaitStartedAt}ms for warmup)\n`);
      this.warmQuery = null;
      this.promptStream = new ClaudePromptStream(includeImages);
      this.promptStream.pushInitial(prompt, inputPayload);
      this.queryHandle = warm.query(this.promptStream.stream);
    } else {
      const warmupWaitMs = Date.now() - warmWaitStartedAt;
      let warmupReason = `produced no reusable session (settled after ${warmupWaitMs}ms)`;
      if (warmOutcome.kind === 'timeout') {
        warmupReason = `still pending after ${warmupWaitMs}ms (window=${WARM_QUERY_WAIT_WINDOW_MS}ms)`;
      } else if (warmOutcome.kind === 'absent') {
        warmupReason = 'was never started for this session';
      }
      process.stderr.write(`[sidecar] [perf] claude warmup unusable — ${warmupReason}; paying cold query() init (CLI spawn + MCP connect)\n`);
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

    this.emitManualCompactPlaceholder();

    this.lastQueryStartedAt = Date.now();
    void this.consumeQuery(
      this.queryHandle,
      this.config.sessionId,
      prompt,
      inputPayload,
      includeImages,
    );
  }

  /**
   * Arm the per-turn compaction flags. Called for every new prompt (both the
   * fresh-query and the stream-reuse path) before the turn starts, so a stale
   * flag can never leak into the next turn on a reused persistent query.
   */
  private armTurnCompaction(prompt: string, inputPayload?: AgentInputPayload): void {
    this.turnManualCompact = isManualCompactPrompt(prompt, inputPayload);
    // The auto placeholder is emitted by consumeQuery when `status: compacting`
    // arrives; the manual one is emitted below once the prompt is actually
    // dispatched (see emitManualCompactPlaceholder).
    this.compactingPlaceholderShown = false;
  }

  /**
   * Emit the manual `/compact` "compacting" placeholder exactly once per turn.
   * Both dispatch paths call this: the stream-reuse path pushes straight into
   * the open query, so it never reaches startPersistentQuery.
   */
  private emitManualCompactPlaceholder(): void {
    if (!this.turnManualCompact || this.compactingPlaceholderShown) return;
    if (!this.config?.sessionId) return;
    emit(buildClaudeCompactBoundaryEvent(this.config.sessionId, 'compacting', { trigger: 'manual' }));
    this.compactingPlaceholderShown = true;
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
    // cwd 预检:不存在的 cwd 会让 claude.exe spawn 失败(ENOENT),而 SDK 会把它
    // 误报成 "binary failed to launch / libc 不匹配"。见 defaultWorkingDirectory.ts。
    const sessionCwd = assertWorkingDirectory(config.cwd);
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
    wipeClaudeContextEnv(subprocessEnv);
    // Subagents resolve fast-model aliases internally; on a custom gateway
    // those alias codes do not exist, so pin every alias to the session model.
    if (config.baseUrl) {
      applyClaudeModelAliasEnv(subprocessEnv, config.model);
    }

    // `settings.env` is the highest-precedence layer, so the context wipe must
    // live here too: user `~/.claude/settings.json` (loaded via settingSources)
    // could otherwise pin CLAUDE_CODE_AUTO_COMPACT_WINDOW and cap the model's
    // 1M-context window. Applied to every Claude session — direct Anthropic
    // included — so the in-app context config always wins. An empty string is
    // the "unset" convention already used for ANTHROPIC_AUTH_TOKEN / aliases.
    const managedEnv: Record<string, string> = buildClaudeContextEnvWipe();
    if (config.apiKey || config.baseUrl) {
      if (config.apiKey) managedEnv.ANTHROPIC_API_KEY = config.apiKey;
      if (config.baseUrl) {
        managedEnv.ANTHROPIC_BASE_URL = config.baseUrl;
        Object.assign(managedEnv, buildClaudeModelAliasEnv(config.model));
      }
      managedEnv.ANTHROPIC_AUTH_TOKEN = '';
      managedEnv.ANTHROPIC_COOKIE = '';
      managedEnv.DISABLE_AUTOUPDATER = '1';
    }
    const cleanSettings: Record<string, unknown> = { env: managedEnv };

    if (!this.abortController || this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }

    const permissionOptions = buildClaudePermissionOptions(config.permissionConfig, config.planMode);
    const mcpServers = mapClaudeMcpServers(config.mcpServers);

    const options: QueryOptions = {
      cwd: sessionCwd,
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
        // 附加目录只写进系统提示（ADR 0020）：不启用 additionalDirectories，
        // 否则 Claude 会把附加目录当配置来源，连带加载其中的 CLAUDE.md 与 skills。
        append: formatAdditionalDirectoriesPrompt(config.additionalDirectories),
      },
      stderr: (data: string) => {
        process.stderr.write(`[claude-stderr] ${data}`);
      },
      hooks: {
        PreToolUse: [{
          hooks: [async (input: any, toolUseID: string | undefined) => {
            const toolName = input.tool_name as string;
            const toolInput = input.tool_input as Record<string, unknown> | undefined;
            if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') && toolInput) {
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
          const { cancelled, answers } = normalizeAskUserQuestionAnswers(questions.length, response.value);
          if (cancelled) {
            // AskUserQuestion is optional clarification: a real deny lets the agent skip it
            // instead of seeing a fake "__cancelled__" answer.
            return {
              behavior: 'deny',
              message: ASK_USER_QUESTION_IGNORED_MESSAGE,
              toolUseID: toolUseId,
            };
          }
          const answersRecord: Record<string, string> = {};
          questions.forEach((q: any, i: number) => {
            answersRecord[q.question] = answers[i] ?? '';
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

        // shell 合成键鼠输入的预检(工单 13):刻意放在一切「自动放行」之前 ——
        // 权限档位再宽松也不放行这一类命令。桌面操作有 computer_* 工具面:
        // 那条路有审批、有目标裁决、有审计;`powershell -c mouse_event` 没有。
        if (toolName === 'Bash') {
          const hit = detectShellInputSynthesis(
            typeof input.command === 'string' ? input.command : '',
          );
          if (hit) {
            const message = shellInputSynthesisMessage(hit);
            // 走既有的「工具被权限门拦下」事件形状(界面已会渲染),
            // 换一个 reasonCode 说明是「绕过 GUI 闸门」这一类,不是权限档位。
            emit(
              buildClaudeModeBlockedEvent({
                toolName,
                toolUseId,
                effectiveMode:
                  getActivePermissionState({
                    sessionId: config.sessionId,
                    agentKind: 'claude_code',
                  })?.effectiveMode ?? 'code',
                reasonCode: 'shell_input_synthesis_blocked',
                gate: permissionGateFor('claude_code'),
              }),
            );
            writeLog(
              'warn',
              `[sidecar] blocked a shell command that synthesizes input (${hit.code}: ${hit.signal})`,
            );
            return { behavior: 'deny', message, toolUseID: toolUseId };
          }
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
            gate: permissionGateFor(config.agentKind),
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
  ): Promise<void> {
    let msgCount = 0;
    let sawResult = false;

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
        if (msgCount === 1 && prompt) {
          process.stderr.write(`[sidecar] [perf] claude first sdk message after sendInput type=${String(msg.type)} subtype=${String(msg.subtype || 'none')} elapsed_ms=${Date.now() - this.lastQueryStartedAt}\n`);
        }
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
          if (!this.compactingPlaceholderShown && appSessionId) {
            const preTokens = readClaudeCompactPreTokens(msg);
            emit(buildClaudeCompactBoundaryEvent(appSessionId, 'compacting', {
              trigger: 'auto',
              ...(preTokens !== undefined ? { pre_tokens: preTokens } : {}),
            }));
            this.compactingPlaceholderShown = true;
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

        // 侧链帧「产不出任何事件」时最容易静默丢内容（子智能体的思考/正文就走
        // `stream_event` 增量）。开启 CODEMUX_MESSAGE_DEBUG=1 时记一行形状，便于定位。
        if (DEBUG_MESSAGE_LOGS && subagentEvents.length === 0 && isClaudeSidechainMessage(msg as unknown as Record<string, unknown>)) {
          const frame = msg as unknown as Record<string, unknown>;
          const inner = frame.event as Record<string, unknown> | undefined;
          process.stderr.write(
            `[claude-debug] SIDECHAIN no-events type=${String(frame.type)}`
            + ` parent_tool_use_id=${String(frame.parent_tool_use_id ?? '(none)')}`
            + ` inner=${String(inner?.type ?? '(none)')}\n`,
          );
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
              this.trackArtifactWireEvent(normalizedEvent);
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
          this.scheduleClaudeTitleSync(queryHandle, appSessionId, prompt);
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
          this.turnIdleGuard?.resume();
          if (this.turnManualCompact && this.turnActive) {
            // 手动 `/compact` 是独立一轮，边界就是终态。必须走正常收尾路径发出
            // `turn_finished`：daemon 的回合状态机只认 `turn_finished`/`error`
            // （`companion/events.rs`），而 `finishTurn()` 单发的
            // `sidecar_query_done` 不在域事件白名单里会被丢弃，回合就永远
            // 「正在执行」。
            sawResult = true;
            writeLog('[claude-task]', 'sendInput COMPLETE (compact, manual)');
            this.emitTurnOutcome({ outcome: 'completed' });
            this.finishTurn();
            this.scheduleQueryIdleClose();
          } else {
            // 自动压缩发生在正常回合中途：边界只是过程帧，回合要继续等到真正的
            // `result`。这里不能结束回合，否则后续 result 会被吞掉。
            writeLog('[claude-task]', 'compact_boundary mid-turn; awaiting result');
          }
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
          // 学到的结论是「这个供应商的这个模型不接受图片」，所以消费方必须
          // 能按供应商限定这条记忆——同一个 id 在两个供应商下能力可以不同。
          provider: this.config?.provider,
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

  /**
   * 首轮结束后同步 Claude 会话标题。
   *
   * 关键：headless/SDK 模式下 Claude Code **不会**自动生成 `ai-title`，宿主必须
   * 调用 `query.generateSessionTitle(text, { persist: true })`，由 CLI 侧跑一次
   * 标题模型并把结果写进 transcript。之前只读 `getSessionInfo().summary`，拿到的
   * 永远是 first prompt 兜底值，所以标题看起来没变。
   *
   * 生成失败或旧版 Runtime 无该方法时，退回到 `getSessionInfo()`。注意 ai-title
   * 是 CLI 在 `result` **之后**才异步写进 transcript 的，早读只会拿到 first
   * prompt 兜底值；那种值由 `extractClaudeSessionTitle` 丢弃，这里按阶梯重试，
   * 直到真正的原生标题出现（最长 60s）。重试不依赖 query 是否还活着——空闲
   * 关闭 query 不影响从磁盘读元数据。
   */
  private scheduleClaudeTitleSync(
    queryHandle: Query,
    appSessionId: string | undefined,
    firstPrompt?: string,
  ): void {
    if (this.claudeTitleSynced || this.claudeTitleInFlight || !appSessionId) return;
    const sdkSessionId = this.config?.agentSessionId;
    if (!sdkSessionId && !firstPrompt) return;
    const runId = ++this.claudeTitleRunId;
    this.claudeTitleInFlight = true;

    void this.generateClaudeSessionTitle(queryHandle, appSessionId, firstPrompt, sdkSessionId)
      .finally(() => {
        if (this.claudeTitleRunId === runId) this.claudeTitleInFlight = false;
      });

    if (!sdkSessionId) return;
    for (const delayMs of CLAUDE_TITLE_SYNC_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.claudeTitleTimers.delete(timer);
        if (this.claudeTitleRunId !== runId || this.claudeTitleSynced) return;
        void this.fetchClaudeSessionTitle(sdkSessionId, appSessionId);
      }, delayMs);
      timer.unref?.();
      this.claudeTitleTimers.add(timer);
    }
  }

  /** 主动让 Claude Code 生成标题（CLI 侧持久化为 ai-title）。 */
  private async generateClaudeSessionTitle(
    queryHandle: Query,
    appSessionId: string,
    firstPrompt: string | undefined,
    sdkSessionId: string | undefined,
  ): Promise<void> {
    const text = firstPrompt?.trim();
    const generate = (queryHandle as unknown as QueryTitleGenerator).generateSessionTitle;

    if (!text || typeof generate !== 'function') return;
    const startedAt = Date.now();
    try {
      // `persist: true` 走 CLI 自己的落盘路径，但它只在描述通过内部校验时才真的
      // 调用标题模型，否则立刻返回 null。标题模型的输出是否可解出 JSON 取决于
      // 供应商能力（部分网关只能时好时坏地产出），失败时交给下面的
      // `getSessionInfo()` 阶梯重试，不在这里自建标题请求。
      const title = await withClaudeTitleTimeout(generate.call(queryHandle, text, { persist: true }));
      const value = typeof title === 'string' ? title.trim() : '';
      if (value) {
        this.emitClaudeTitle(appSessionId, value);
        return;
      }
    } catch (error) {
      process.stderr.write(
        `[sidecar] Claude session title generation failed: ${error instanceof Error ? error.message : String(error)} elapsed_ms=${Date.now() - startedAt}\n`,
      );
    }
    // 生成没结果时立刻用兜底读一次，别等 4s/12s。
    if (sdkSessionId) await this.fetchClaudeSessionTitle(sdkSessionId, appSessionId);
  }

  private async fetchClaudeSessionTitle(sdkSessionId: string, appSessionId: string): Promise<void> {
    try {
      // `getSessionInfo` 是 SDK 的模块级导出，不是 Query 实例方法；从托管
      // Runtime 加载的 SDK 模块上取。旧版 Runtime 无此导出时静默跳过。
      const getSessionInfo = this.claudeSdk?.getSessionInfo;
      if (typeof getSessionInfo !== 'function') {
        return;
      }
      const info = await getSessionInfo.call(this.claudeSdk, sdkSessionId);
      const title = extractClaudeSessionTitle(info);
      if (!title) return;
      this.emitClaudeTitle(appSessionId, title);
    } catch (error) {
      process.stderr.write(`[sidecar] Claude session title sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private emitClaudeTitle(appSessionId: string, title: string): void {
    if (!title || title === this.lastEmittedNativeTitle) return;
    // A delayed read from a session that has since been replaced must not
    // overwrite the current session's title or mark it as already synced.
    if (this.config?.sessionId !== appSessionId) return;
    this.lastEmittedNativeTitle = title;
    this.claudeTitleSynced = true;
    emit(buildSessionTitleEvent({ appSessionId, agentKind: 'claude_code', title }));
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
    this.turnManualCompact = false;
    this.compactingPlaceholderShown = false;
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
    // 产物汇总按「轮」累积：一轮（一条 User Message）内可有多次内部 turn 收尾，
    // 这里只发射当前累计、不清空——清空发生在下一次 sendInput 新建 aggregator 时。
    const summary = this.turnArtifactAggregator?.flushSummary(sessionId);
    if (summary) {
      emit(summary);
    }
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

function normalizePlanMode(value: unknown): AgentPlanMode {
  return value === 'on' ? 'on' : 'off';
}
