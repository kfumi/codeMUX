import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { query, startup } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKUserMessage,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { SidecarCommand } from './types.js';
import { getProviderMode } from './sessionRuntimeHelpers.js';
import { resolveClaudeExecutable } from './claudeExecutable.js';
import { shouldEmitDoneOnClaudeIteratorCompletion } from './claudeTurnCompletion.js';
import { CodexSessionRuntime, interruptActiveTurn } from './codexRuntime.js';
import { OpenCodeRuntime } from './opencodeRuntime.js';
import type { OpenCodePermissionResponse } from './opencodePermissions.js';
import type { OpenCodeSessionConfig } from './types.js';
import {
  getRuntimeFlavor,
  normalizeClaudeResultEvent,
  type ClaudeTokenUsage,
} from './runtimeEvents.js';
import { proxyManager } from './proxyManager.js';
import { resolveInteractiveToolResponse } from './interactiveToolResponses.js';
import { emit } from './streamEventBatcher.js';
import { ensureWorkingDirectory } from './defaultWorkingDirectory.js';
import { buildClaudePermissionOptions, type AgentPlanMode, type SidecarPermissionConfig } from './agentPermissions.js';
import { getClaudeApprovalTitle } from './claudeApprovalPrompt.js';
import {
  applyPermissionElevation,
  buildPermissionElevationResponse,
  buildClaudeModeBlockedEvent,
  resolveClaudeToolRuntimeDecision,
  setActivePermissionState,
} from './activePermissionState.js';
import {
  buildClaudeUserMessageContent,
  isImageUnsupportedError,
  normalizeAgentInputPayload,
  type AgentInputPayload,
} from './agentInputPayload.js';
import { shouldCaptureClaudeSessionMapping } from './claudeSessionMapping.js';

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
const COMPACT_TIMEOUT_MS = 60_000;
const ASK_USER_QUESTION_TIMEOUT_MESSAGE = '等待用户回复超时，请重新发送消息继续';

// Gate per-message stderr logs. Each stderr line is read by the Rust backend,
// mutex-locked into a capture buffer, and logged via tracing — so per-message
// writes during streaming (hundreds/sec) cause severe I/O and lock contention.
// Enable with CODEMUX_MESSAGE_DEBUG=1 when debugging message flow.
const DEBUG_MESSAGE_LOGS = process.env.CODEMUX_MESSAGE_DEBUG === '1';

type EnsureSessionCommand = Extract<SidecarCommand, { type: 'ensure_session' }>;
type UpdatePermissionsCommand = Extract<SidecarCommand, { type: 'update_permissions' }>;

type SessionBootstrap = {
  sessionId?: string;
  agentSessionId?: string;
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: string;
  skills?: string[];
  permissionConfig?: SidecarPermissionConfig;
  planMode?: AgentPlanMode;
};

type QueryOptions = Record<string, unknown> & {
  pathToClaudeCodeExecutable?: string;
};

type PendingToolResponseResult =
  | { kind: 'answered'; value: unknown }
  | { kind: 'expired' };

/** Pending tool responses waiting for user input */
const pendingToolResponses = new Map<string, {
  sessionId?: string;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  resolve: (value: PendingToolResponseResult) => void;
}>();
const SIDECAR_DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

function waitForClaudeToolResponse(
  toolUseId: string,
  sessionId?: string,
  timeoutMs = MESSAGE_TIMEOUT_MS,
): Promise<PendingToolResponseResult> {
  return new Promise((resolve) => {
    const timeoutTimer = setTimeout(() => {
      expireClaudeToolResponse(toolUseId);
    }, timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();
    pendingToolResponses.set(toolUseId, {
      sessionId,
      timeoutTimer,
      resolve,
    });
  });
}

function resolveClaudeToolResponse(toolUseId: string, response: unknown): boolean {
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
  emitAskUserQuestionTimeout(toolUseId);
  pending.resolve({ kind: 'expired' });
  return true;
}

function expireClaudeToolResponses(sessionId?: string): number {
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

function emitAskUserQuestionTimeout(toolUseId: string): void {
  emit({
    type: 'ask_user_question_timeout',
    tool_use_id: toolUseId,
    timeout_ms: MESSAGE_TIMEOUT_MS,
    message: ASK_USER_QUESTION_TIMEOUT_MESSAGE,
  });
}

function isQueryIdleTimeout(errorText: string): boolean {
  return errorText.includes('Query timed out: no message received');
}

function findClaudeExecutable(): string | undefined {
  try {
    if (process.platform === 'win32') {
      return execSync('where claude', { encoding: 'utf-8' }).trim().split('\n')[0]?.trim();
    }
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
}

/** Load env vars from ~/.claude/settings.json and apply to process.env */
function loadClaudeSettingsEnv(): void {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (settings.env && typeof settings.env === 'object') {
      const keys = Object.keys(settings.env);
      process.stderr.write(`[sidecar] Settings env keys: ${keys.join(', ')}\n`);
      for (const [key, value] of Object.entries(settings.env)) {
        if (typeof value === 'string' && !process.env[key]) {
          process.env[key] = value;
        }
      }
      process.stderr.write(`[sidecar] Loaded ${keys.length} env vars from ~/.claude/settings.json\n`);
    }
  } catch (err) {
    process.stderr.write(`[sidecar] Warning: failed to load Claude settings: ${err}\n`);
  }
}

async function* createPromptStream(prompt: string, inputPayload?: AgentInputPayload, includeImages = true): AsyncGenerator<SDKUserMessage, void, void> {
  const payload = normalizeAgentInputPayload(prompt, inputPayload);
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: buildClaudeUserMessageContent(payload, includeImages) as SDKUserMessage['message']['content'],
    },
    parent_tool_use_id: null,
  };
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

export class SessionRuntime {
  private config: SessionBootstrap | null = null;
  private configFingerprint: string | null = null;
  private providerMode = getProviderMode(undefined);
  private abortController: AbortController | null = null;
  private queryHandle: Query | null = null;
  private warmQuery: WarmQuery | null = null;
  private warmPromise: Promise<WarmQuery | null> | null = null;
  private turnActive = false;
  private generation = 0;
  private activeConfigGeneration = 0;
  private claudeExecutablePath: string | undefined;

  async ensure(cmd: EnsureSessionCommand): Promise<void> {
    const normalized = this.normalizeConfig(cmd);
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

    await this.resetForReconfigure();

    emit({
      type: 'mcp_status_update',
      servers: {},
      status: this.providerMode.supportsDeferredToolSearch ? 'warming' : 'limited_provider',
    });

    this.startWarmup(this.activeConfigGeneration);
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

    if (this.queryHandle) {
      process.stderr.write('[sidecar] Closing previous query handle before starting a new turn\n');
      this.closeQueryHandle('new_turn');
    }

    this.turnActive = true;
    this.generation += 1;

    await this.startPersistentQuery(prompt, this.generation, this.activeConfigGeneration, inputPayload);
  }

  async interrupt(): Promise<void> {
    clearClaudeToolResponses(this.config?.sessionId);
    if (!this.queryHandle) {
      if (this.abortController && !this.abortController.signal.aborted) {
        this.abortController.abort('user_interrupt_no_query');
      }
      this.finishTurn();
      return;
    }

    process.stderr.write('[sidecar] Interrupt requested; sending query.interrupt()\n');
    const controller = this.abortController;
    const fallbackTimer = setTimeout(() => {
      if (controller && !controller.signal.aborted) {
        process.stderr.write('[sidecar] Interrupt fallback timeout reached; aborting transport\n');
        controller.abort('user_interrupt_fallback');
        this.closeQueryHandle('interrupt_fallback');
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
      this.finishTurn();
    }
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.resetForReconfigure();
    this.config = null;
    this.configFingerprint = null;
    this.providerMode = getProviderMode(undefined);
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
      cwd,
      apiKey: cmd.apiKey,
      baseUrl: cmd.baseUrl,
      model: cmd.model,
      reasoningEffort: normalizeReasoningEffort(cmd.reasoningEffort),
      skills: cmd.skills,
      permissionConfig: cmd.permissionConfig,
      planMode: normalizePlanMode(cmd.planMode),
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

    const warmAttempt = (label: string) => {
      const options = this.buildOptions(this.config!);
      process.stderr.write(`[sidecar] ${label}\n`);
      return startup({
        options: options as any,
        initializeTimeoutMs: WARM_START_TIMEOUT_MS,
      });
    };

    this.warmPromise = warmAttempt('Calling startup() to pre-warm MCP connections in the background...')
      .then((warm) => {
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
      .catch(async (startupErr) => {
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
      this.queryHandle = warm.query(createPromptStream(prompt, inputPayload, includeImages));
    } else {
      process.stderr.write('[sidecar] Starting persistent query directly via query()\n');
      emit({
        type: 'mcp_status_update',
        servers: {},
        status: this.providerMode.supportsDeferredToolSearch ? 'fallback_live' : 'limited_provider',
      });
      this.queryHandle = query({
        prompt: createPromptStream(prompt, inputPayload, includeImages),
        options: this.buildOptions(this.config) as any,
      });
    }

    void this.consumeQuery(this.queryHandle, this.config.sessionId, prompt, inputPayload, includeImages);
  }

  private closeQueryHandle(reason: string): void {
    if (!this.queryHandle) return;
    process.stderr.write(`[sidecar] Closing persistent query (${reason})\n`);
    try {
      this.queryHandle.close();
    } catch (err) {
      process.stderr.write(`[sidecar] Failed to close query: ${err}\n`);
    }
    this.queryHandle = null;
  }

  private buildOptions(config: SessionBootstrap): QueryOptions {
    if (config.apiKey) {
      process.env.ANTHROPIC_API_KEY = config.apiKey;
    }
    if (config.baseUrl) {
      process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    }

    const pathClaude = findClaudeExecutable();
    const claudePath = resolveClaudeExecutable({
      sidecarDir: SIDECAR_DIST_DIR,
      pathClaude,
    });
    this.claudeExecutablePath = claudePath ?? pathClaude ?? 'claude';
    const claudeSessionId = config.agentSessionId;
    const envKey = process.env.ANTHROPIC_API_KEY;
    const envUrl = process.env.ANTHROPIC_BASE_URL;
    process.stderr.write(`[sidecar] ENV ANTHROPIC_API_KEY=${envKey ? envKey.slice(0, 10) + '...' : 'NOT SET'}\n`);
    process.stderr.write(`[sidecar] ENV ANTHROPIC_BASE_URL=${envUrl || 'NOT SET'}\n`);
    process.stderr.write(`[sidecar] ENV ANTHROPIC_API_KEY length=${envKey?.length || 0}\n`);
    const anthropicVars = Object.keys(process.env).filter((key) => key.startsWith('ANTHROPIC_'));
    process.stderr.write(`[sidecar] All ANTHROPIC_* env vars: ${anthropicVars.join(', ') || '(none)'}\n`);
    process.stderr.write(`[sidecar] Session: app=${config.sessionId || 'none'}, claude=${claudeSessionId || 'new'}\n`);
    process.stderr.write(`[sidecar] Claude executable=${claudePath || 'NOT FOUND'}\n`);
    if (pathClaude && claudePath !== pathClaude) {
      process.stderr.write(`[sidecar] Ignoring PATH Claude shim in favor of bundled binary: ${pathClaude}\n`);
    }

    const subprocessEnv: Record<string, string | undefined> = { ...process.env };
    if (config.apiKey) subprocessEnv.ANTHROPIC_API_KEY = config.apiKey;
    if (config.baseUrl) subprocessEnv.ANTHROPIC_BASE_URL = config.baseUrl;
    subprocessEnv.ANTHROPIC_AUTH_TOKEN = '';
    subprocessEnv.ANTHROPIC_COOKIE = '';
    for (const key of Object.keys(subprocessEnv)) {
      if (key.startsWith('ANTHROPIC_DEFAULT_')) {
        subprocessEnv[key] = '';
      }
    }

    const cleanSettings: Record<string, unknown> = {};
    if (config.apiKey || config.baseUrl) {
      cleanSettings.env = {
        ...(config.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
        ...(config.baseUrl ? { ANTHROPIC_BASE_URL: config.baseUrl } : {}),
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_COOKIE: '',
        DISABLE_AUTOUPDATER: '1',
      };
    }

    if (!this.abortController || this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }

    const permissionOptions = buildClaudePermissionOptions(config.permissionConfig, config.planMode);

    const options: QueryOptions = {
      cwd: config.cwd,
      abortController: this.abortController,
      permissionMode: permissionOptions.permissionMode,
      allowDangerouslySkipPermissions: permissionOptions.allowDangerouslySkipPermissions,
      env: subprocessEnv,
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
                } catch {
                  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(config.cwd, filePath);
                  emit({
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
        if (toolName === 'AskUserQuestion') {
          const toolUseId = opts.toolUseID;
          let questions: any[] = [];
          const rawQ = (input as any).questions;
          if (typeof rawQ === 'string') {
            try { questions = JSON.parse(rawQ); } catch { questions = []; }
          } else if (Array.isArray(rawQ)) {
            questions = rawQ;
          }
          emit({
            type: 'ask_user_question',
            tool_use_id: toolUseId,
            questions,
          });
          const response = await waitForClaudeToolResponse(toolUseId, config.sessionId);
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
        const filePath = typeof input.file_path === 'string' ? input.file_path : null;
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
        emit({
          type: 'ask_user_question',
          tool_use_id: toolUseId,
          questions: [{
            header: '审批',
            question: title,
            options: [
              { label: '接受', description: '执行这一次操作。' },
              {
                label: '接受并允许编辑',
                description: '放行本次操作，并将当前会话提升到允许编辑。',
                value: buildPermissionElevationResponse('claude_code'),
              },
              { label: '拒绝', description: '阻止这一次操作。' },
            ],
            allowOther: false,
          }],
        });
        const response = await waitForClaudeToolResponse(toolUseId, config.sessionId);
        if (response.kind === 'expired') {
          return {
            behavior: 'deny',
            message: ASK_USER_QUESTION_TIMEOUT_MESSAGE,
            toolUseID: toolUseId,
          };
        }
        const userAnswers = response.value as unknown[];
        const answerValue = userAnswers[0];
        if (applyPermissionElevation(answerValue, { sessionId: config.sessionId, agentKind: 'claude_code' })) {
          return { behavior: 'allow', updatedInput: input, toolUseID: toolUseId };
        }
        const answer = String(answerValue ?? '');
        if (answer === '接受' || answer === '允许') {
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
    if (config.model) {
      options.model = config.model;
    }
    if (config.reasoningEffort) {
      options.effort = config.reasoningEffort;
    }
    if (claudeSessionId) {
      options.resume = claudeSessionId;
      process.stderr.write(`[sidecar] Resuming Claude session: ${claudeSessionId}\n`);
    }

    return options;
  }

  private async consumeQuery(queryHandle: Query, appSessionId?: string, prompt?: string, inputPayload?: AgentInputPayload, includeImages = true): Promise<void> {
    let msgCount = 0;
    let compacting = false;
    let sawResult = false;
    let compactTimer: ReturnType<typeof setTimeout> | null = null;
    let lastAssistantUsage: ClaudeTokenUsage | null = null;

    const clearCompactTimer = () => {
      if (compactTimer) {
        clearTimeout(compactTimer);
        compactTimer = null;
      }
    };

    const iterator = queryHandle[Symbol.asyncIterator]();

    const nextMessage = async () => {
      if (!this.turnActive) {
        return iterator.next();
      }

      return await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<unknown>>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.abortController?.signal.aborted) {
              resolve({ done: true, value: undefined });
              return;
            }
            reject(new Error(`Query timed out: no message received for ${MESSAGE_TIMEOUT_MS / 1000}s (after msg #${msgCount})`));
          }, MESSAGE_TIMEOUT_MS);
          if (timer.unref) timer.unref();
        }),
        ...(compacting ? [new Promise<{ done: true; value: undefined }>((resolve) => {
          compactTimer = setTimeout(() => {
            process.stderr.write(`[sidecar] Compact timeout: no message after ${COMPACT_TIMEOUT_MS}ms, treating turn as complete\n`);
            emit({
              type: 'system',
              subtype: 'compact_boundary',
              compact_metadata: { trigger: 'manual', pre_tokens: 0 },
              session_id: appSessionId || '',
              uuid: `compact-timeout-${Date.now()}`,
            });
            resolve({ done: true, value: undefined });
          }, COMPACT_TIMEOUT_MS);
          if (compactTimer.unref) compactTimer.unref();
        })] : []),
      ]);
    };

    try {
      while (this.queryHandle === queryHandle) {
        const result = await nextMessage();
        clearCompactTimer();
        if (result.done) {
          break;
        }

        msgCount += 1;
        const msg = result.value as Record<string, unknown>;
        if (DEBUG_MESSAGE_LOGS) {
          process.stderr.write(`[sidecar] Message #${msgCount}: type=${msg.type}, subtype=${String(msg.subtype || 'none')}\n`);
        }

        if (msg.type === 'system' && msg.subtype === 'status' && (msg as any).status === 'compacting') {
          compacting = true;
        }
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          compacting = false;
        }
        if (msg.type === 'assistant') {
          const assistant = result.value as any;
          const usage = assistant?.message?.usage || assistant?.usage;
          if (DEBUG_MESSAGE_LOGS) {
            process.stderr.write(`[sidecar]   -> assistant usage: ${JSON.stringify(usage || 'NONE')}\n`);
          }
          const normalizedUsage = normalizeClaudeAssistantUsage(usage);
          if (normalizedUsage) {
            lastAssistantUsage = normalizedUsage;
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
            emit({
              type: 'agent_session_mapping',
              app_session_id: appSessionId,
              agent_kind: 'claude_code',
              agent_session_id: sdkSessionId,
            });
          }
        }

        const eventToEmit = msg.type === 'result'
          ? normalizeClaudeResultEvent(result.value as Record<string, unknown>, lastAssistantUsage)
          : result.value;

        if (msg.type === 'result') {
          const resultEvent = eventToEmit as Record<string, unknown>;
          process.stderr.write(`[sidecar]   -> result usage: ${JSON.stringify(resultEvent.usage || 'NONE')}, modelUsage=${JSON.stringify(resultEvent.modelUsage || 'NONE')}\n`);
        }

        emit(eventToEmit);

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
          this.finishTurn();
          this.closeQueryHandle('turn_complete');
          if (this.config) {
            this.startWarmup(this.activeConfigGeneration);
          }
        }
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
        this.queryHandle = null;
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
        emit({ type: 'sidecar_error', error: errorMsg });
      } else {
        process.stderr.write(`[sidecar] Suppressed interrupt cleanup error: ${errorMsg}\n`);
      }
      this.finishTurn();
      if (isIdleTimeout && this.config) {
        this.startWarmup(this.activeConfigGeneration);
      }
    } finally {
      clearCompactTimer();
      if (shouldEmitDoneOnClaudeIteratorCompletion({
        turnActive: this.turnActive,
        sawResult,
        aborted: Boolean(this.abortController?.signal.aborted),
      })) {
        process.stderr.write('[sidecar] Claude query iterator ended without result; marking turn complete\n');
        this.finishTurn();
      }
      if (this.queryHandle === queryHandle && this.abortController?.signal.aborted) {
        this.queryHandle = null;
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
        const allDone = statuses.every((status) => status.status === 'connected' || status.status === 'failed');
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
    emit({ type: 'sidecar_query_done' });
  }
}

function normalizeReasoningEffort(value: unknown): 'low' | 'medium' | 'high' | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function normalizeClaudeAssistantUsage(value: unknown): ClaudeTokenUsage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const usage = value as Record<string, unknown>;
  const normalized = {
    input_tokens: readFiniteNumber(usage.input_tokens),
    output_tokens: readFiniteNumber(usage.output_tokens),
    cache_read_input_tokens: readFiniteNumber(usage.cache_read_input_tokens),
    cache_creation_input_tokens: readFiniteNumber(usage.cache_creation_input_tokens),
  };

  return normalized.input_tokens > 0 || normalized.output_tokens > 0 || normalized.cache_read_input_tokens > 0 || normalized.cache_creation_input_tokens > 0
    ? normalized
    : null;
}

function readFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizePlanMode(value: unknown): AgentPlanMode {
  return value === 'on' ? 'on' : 'off';
}

const runtime = new SessionRuntime();
const codexRuntime = new CodexSessionRuntime();

type SidecarRuntime = {
  ensure(cmd: EnsureSessionCommand): Promise<void>;
  updatePermissions(cmd: UpdatePermissionsCommand): void | Promise<void>;
  sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void>;
  resetSession(sessionId: string): Promise<void>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
  respondToPermission?(requestId: string, response: OpenCodePermissionResponse, sessionId: string): Promise<void>;
};

type SidecarCommandDispatcherOptions = {
  claudeRuntime: SidecarRuntime;
  codexRuntime: SidecarRuntime;
  createOpenCodeRuntime: (cmd: EnsureSessionCommand) => SidecarRuntime;
  emit: (event: unknown) => void;
  startProxy?: (cmd: Extract<SidecarCommand, { type: 'start_proxy' }>) => Promise<unknown>;
  stopProxy: () => Promise<void>;
  getProxyStatus?: () => Record<string, unknown>;
  exit: (code: number) => void;
};

export function createSidecarCommandDispatcher(options: SidecarCommandDispatcherOptions) {
  let activeAgentKind: string | undefined;
  let activeOpenCodeRuntime: SidecarRuntime | undefined;
  let ensureTail: Promise<void> = Promise.resolve();
  const pendingPermissionResponses = new Map<SidecarRuntime, Map<string, Promise<void>>>();

  const emitError = (error: unknown): void => {
    options.emit({ type: 'sidecar_error', error: String(error) });
  };

  const isAbortError = (error: unknown): boolean => {
    const message = String(error).toLowerCase();
    return message.includes('abort') || message.includes('the operation was aborted');
  };

  const shutdownOpenCodeRuntime = async (): Promise<void> => {
    const current = activeOpenCodeRuntime;
    if (!current) return;
    await current.shutdown();
    if (activeOpenCodeRuntime === current) {
      activeOpenCodeRuntime = undefined;
    }
  };

  const ensureSession = async (cmd: EnsureSessionCommand): Promise<void> => {
    const flavor = getRuntimeFlavor(cmd.agentKind);
    activeAgentKind = cmd.agentKind;
    if (flavor !== 'opencode') {
      await shutdownOpenCodeRuntime();
      const selectedRuntime = flavor === 'codex' ? options.codexRuntime : options.claudeRuntime;
      await selectedRuntime.ensure(cmd);
      return;
    }

    await shutdownOpenCodeRuntime();
    const nextRuntime = options.createOpenCodeRuntime(cmd);
    try {
      await nextRuntime.ensure(cmd);
    } catch (error) {
      try {
        await nextRuntime.shutdown();
      } catch (cleanupError) {
        emitError(`${String(error)}; OpenCode cleanup failed: ${String(cleanupError)}`);
      }
      throw error;
    }
    activeOpenCodeRuntime = nextRuntime;
  };

  const dispatchEnsure = (cmd: EnsureSessionCommand): Promise<void> => {
    const operation = ensureTail.then(() => ensureSession(cmd), () => ensureSession(cmd));
    ensureTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const selectedRuntime = (): SidecarRuntime | undefined => {
    const flavor = getRuntimeFlavor(activeAgentKind);
    if (flavor === 'opencode') return activeOpenCodeRuntime;
    return flavor === 'codex' ? options.codexRuntime : options.claudeRuntime;
  };

  const dispatch = async (cmd: SidecarCommand): Promise<void> => {
    switch (cmd.type) {
      case 'ensure_session':
        try {
          await dispatchEnsure(cmd);
        } catch (error) {
          emitError(error);
        }
        return;
      case 'update_permissions': {
        activeAgentKind = cmd.agentKind ?? activeAgentKind;
        const flavor = getRuntimeFlavor(activeAgentKind);
        try {
          if (flavor === 'opencode') {
            const current = activeOpenCodeRuntime;
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
      case 'send_input': {
        const current = selectedRuntime();
        if (!current) {
          emitError('OpenCode runtime is not initialized');
          return;
        }
        void current.sendInput(cmd.prompt, cmd.inputPayload).catch((error) => {
          if (!isAbortError(error)) emitError(error);
        });
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
      case 'interrupt':
        try {
          if (getRuntimeFlavor(activeAgentKind) === 'codex') interruptActiveTurn();
          const current = selectedRuntime();
          if (!current) throw new Error('OpenCode runtime is not initialized');
          await current.interrupt();
        } catch (error) {
          if (!isAbortError(error)) emitError(error);
        }
        return;
      case 'tool_response':
        if (getRuntimeFlavor(activeAgentKind) === 'opencode') {
          options.emit({ type: 'sidecar_error', error: 'OpenCode tool responses are server-managed/not supported' });
        } else if (!resolveClaudeToolResponse(cmd.toolUseId, cmd.response)) {
          resolveInteractiveToolResponse(cmd.toolUseId, cmd.response);
        }
        return;
      case 'respond_to_permission': {
        const current = getRuntimeFlavor(activeAgentKind) === 'opencode' ? activeOpenCodeRuntime : undefined;
        if (!current?.respondToPermission) {
          emitError('OpenCode runtime is not initialized');
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
        await attemptCleanup('Failed to shutdown OpenCode runtime', shutdownOpenCodeRuntime);
        if (getRuntimeFlavor(activeAgentKind) !== 'opencode') {
          const currentRuntime = getRuntimeFlavor(activeAgentKind) === 'codex' ? options.codexRuntime : options.claudeRuntime;
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

function createOpenCodeSidecarRuntime(cmd: EnsureSessionCommand): SidecarRuntime {
  const config: OpenCodeSessionConfig = {
    cwd: ensureWorkingDirectory(cmd.cwd),
    sessionId: cmd.sessionId ?? crypto.randomUUID(),
    ...(cmd.agentSessionId ? { agentSessionId: cmd.agentSessionId } : {}),
    provider: cmd.provider ?? 'opencode',
    model: cmd.model ?? 'default',
    credentialSource: cmd.credentialSource ?? 'none',
  };
  const openCodeRuntime = new OpenCodeRuntime(config);
  return {
    ensure: async () => { await openCodeRuntime.start(); },
    sendInput: (prompt, inputPayload) => openCodeRuntime.sendInput(prompt, inputPayload),
    updatePermissions: (update) => openCodeRuntime.updatePermissions(update),
    resetSession: () => openCodeRuntime.resetSession(),
    interrupt: () => openCodeRuntime.interrupt(),
    shutdown: () => openCodeRuntime.shutdown(),
    respondToPermission: (requestId, response, sessionId) => openCodeRuntime.respondToPermission(requestId, response, sessionId),
  };
}

async function main(): Promise<void> {
  loadClaudeSettingsEnv();

  emit({ type: 'sidecar_ready' });

  const rl = readline.createInterface({ input: process.stdin });
  const dispatcher = createSidecarCommandDispatcher({
    claudeRuntime: runtime,
    codexRuntime,
    createOpenCodeRuntime: createOpenCodeSidecarRuntime,
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(SIDECAR_DIST_DIR, 'index.js')) {
  main().catch((err) => {
    emit({ type: 'sidecar_error', error: `Fatal: ${String(err)}` });
    process.exit(1);
  });
}
