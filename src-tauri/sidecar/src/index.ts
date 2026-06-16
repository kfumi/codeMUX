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
import { CodexSessionRuntime, interruptActiveTurn } from './codexRuntime.js';
import { getRuntimeFlavor } from './runtimeEvents.js';
import { proxyManager } from './proxyManager.js';

const WARM_START_TIMEOUT_MS = 30_000;
const WARM_QUERY_WAIT_WINDOW_MS = 500;
const MESSAGE_TIMEOUT_MS = 300_000;
const COMPACT_TIMEOUT_MS = 60_000;

type EnsureSessionCommand = Extract<SidecarCommand, { type: 'ensure_session' }>;

type SessionBootstrap = {
  sessionId?: string;
  agentSessionId?: string;
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  skills?: string[];
};

type QueryOptions = Record<string, unknown> & {
  pathToClaudeCodeExecutable?: string;
};

/** Pending tool responses waiting for user input */
const pendingToolResponses = new Map<string, { resolve: (value: unknown) => void }>();
const SIDECAR_DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

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

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function* createPromptStream(prompt: string): AsyncGenerator<SDKUserMessage, void, void> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: prompt,
        },
      ],
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

  async ensure(cmd: EnsureSessionCommand): Promise<void> {
    const normalized = this.normalizeConfig(cmd);
    const nextFingerprint = JSON.stringify(normalized);
    if (this.configFingerprint === nextFingerprint && this.config) {
      return;
    }

    this.config = normalized;
    this.configFingerprint = nextFingerprint;
    this.providerMode = getProviderMode(normalized.baseUrl);
    this.activeConfigGeneration += 1;

    await this.resetForReconfigure();

    emit({
      type: 'mcp_status_update',
      servers: {},
      status: this.providerMode.supportsDeferredToolSearch ? 'warming' : 'limited_provider',
    });

    this.startWarmup(this.activeConfigGeneration);
  }

  async sendInput(prompt: string): Promise<void> {
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

    await this.startPersistentQuery(prompt, this.generation, this.activeConfigGeneration);
  }

  async interrupt(): Promise<void> {
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
    const cwd = cmd.cwd === '.' ? os.homedir() : cmd.cwd;
    return {
      sessionId: cmd.sessionId,
      agentSessionId: cmd.agentSessionId,
      cwd,
      apiKey: cmd.apiKey,
      baseUrl: cmd.baseUrl,
      model: cmd.model,
      skills: cmd.skills,
    };
  }

  private async resetForReconfigure(): Promise<void> {
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

  private async startPersistentQuery(prompt: string, queryGeneration: number, configGeneration: number): Promise<void> {
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
      this.queryHandle = warm.query(createPromptStream(prompt));
    } else {
      process.stderr.write('[sidecar] Starting persistent query directly via query()\n');
      emit({
        type: 'mcp_status_update',
        servers: {},
        status: this.providerMode.supportsDeferredToolSearch ? 'fallback_live' : 'limited_provider',
      });
      this.queryHandle = query({
        prompt: createPromptStream(prompt),
        options: this.buildOptions(this.config) as any,
      });
    }

    void this.consumeQuery(this.queryHandle, this.config.sessionId);
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

    const options: QueryOptions = {
      cwd: config.cwd,
      abortController: this.abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
        'WebSearch', 'WebFetch', 'AskUserQuestion', 'TodoWrite',
        'WaitForMcpServers', 'Skill',
      ],
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
          const userAnswers = await new Promise<string[]>((resolve) => {
            pendingToolResponses.set(toolUseId, { resolve: resolve as (v: unknown) => void });
          });
          pendingToolResponses.delete(toolUseId);
          const answersRecord: Record<string, string> = {};
          questions.forEach((q: any, i: number) => {
            const answer = userAnswers[i];
            answersRecord[q.question] = Array.isArray(answer) ? answer.join(', ') : String(answer ?? '');
          });
          return { behavior: 'allow', updatedInput: { ...input, questions, answers: answersRecord } };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    };

    if (claudePath) options.pathToClaudeCodeExecutable = claudePath;
    if (config.skills && config.skills.length > 0) {
      options.skills = config.skills;
    }
    if (config.model) {
      options.model = config.model;
    }
    if (claudeSessionId) {
      options.resume = claudeSessionId;
      process.stderr.write(`[sidecar] Resuming Claude session: ${claudeSessionId}\n`);
    }

    return options;
  }

  private async consumeQuery(queryHandle: Query, appSessionId?: string): Promise<void> {
    let msgCount = 0;
    let compacting = false;
    let compactTimer: ReturnType<typeof setTimeout> | null = null;

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
        process.stderr.write(`[sidecar] Message #${msgCount}: type=${msg.type}, subtype=${String(msg.subtype || 'none')}\n`);

        if (msg.type === 'system' && msg.subtype === 'status' && (msg as any).status === 'compacting') {
          compacting = true;
        }
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          compacting = false;
        }
        if (msg.type === 'assistant') {
          const assistant = result.value as any;
          const usage = assistant?.message?.usage || assistant?.usage;
          process.stderr.write(`[sidecar]   -> assistant usage: ${JSON.stringify(usage || 'NONE')}\n`);
        }

        if (typeof appSessionId === 'string') {
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

        emit(result.value);

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
          this.finishTurn();
          this.closeQueryHandle('turn_complete');
          if (this.config) {
            this.startWarmup(this.activeConfigGeneration);
          }
        }
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      const normalizedError = errorMsg.toLowerCase();
      const isAbort = normalizedError.includes('abort');
      const isGracefulInterruptCleanup = Boolean(
        this.abortController?.signal.aborted &&
        (normalizedError.includes('stream closed') || normalizedError.includes('query timed out')),
      );
      this.clearStaleResumeMapping(errorMsg);
      if (!isAbort && !isGracefulInterruptCleanup) {
        emit({ type: 'sidecar_error', error: errorMsg });
      } else {
        process.stderr.write(`[sidecar] Suppressed interrupt cleanup error: ${errorMsg}\n`);
      }
      this.finishTurn();
    } finally {
      clearCompactTimer();
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

const runtime = new SessionRuntime();
const codexRuntime = new CodexSessionRuntime();

/** Tracks which runtime is active for the current session. */
let activeAgentKind: string | undefined;

async function main(): Promise<void> {
  loadClaudeSettingsEnv();

  emit({ type: 'sidecar_ready' });

  const rl = readline.createInterface({ input: process.stdin });

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

    switch (cmd.type) {
      case 'ensure_session': {
        const flavor = getRuntimeFlavor(cmd.agentKind);
        activeAgentKind = cmd.agentKind;
        try {
          if (flavor === 'codex') {
            await codexRuntime.ensure(cmd);
          } else {
            await runtime.ensure(cmd);
          }
        } catch (err) {
          emit({ type: 'sidecar_error', error: String(err) });
        }
        break;
      }
      case 'send_input':
        // Fire-and-forget: don't await sendInput so the command loop stays
        // responsive. The interrupt command can then call interruptActiveTurn()
        // immediately to abort the running stream.
        if (getRuntimeFlavor(activeAgentKind) === 'codex') {
          codexRuntime.sendInput(cmd.prompt).catch((err) => {
            emit({ type: 'sidecar_error', error: String(err) });
          });
        } else {
          runtime.sendInput(cmd.prompt).catch((err) => {
            emit({ type: 'sidecar_error', error: String(err) });
          });
        }
        break;
      case 'reset_session':
        try {
          if (getRuntimeFlavor(activeAgentKind) === 'codex') {
            await codexRuntime.resetSession(cmd.sessionId);
          } else {
            await runtime.resetSession(cmd.sessionId);
          }
        } catch (err) {
          emit({ type: 'sidecar_error', error: String(err) });
        }
        break;
      case 'interrupt':
        try {
          if (getRuntimeFlavor(activeAgentKind) === 'codex') {
            // Immediately abort the active stream (bypasses blocked stdin loop).
            interruptActiveTurn();
            await codexRuntime.interrupt();
          } else {
            await runtime.interrupt();
          }
        } catch (err) {
          emit({ type: 'sidecar_error', error: String(err) });
        }
        break;
      case 'tool_response': {
        const pending = pendingToolResponses.get(cmd.toolUseId);
        if (pending) {
          pending.resolve(cmd.response);
          process.stderr.write(`[sidecar] tool_response resolved for toolUseId=${cmd.toolUseId}\n`);
        } else {
          process.stderr.write(`[sidecar] tool_response: no pending request for toolUseId=${cmd.toolUseId}\n`);
        }
        break;
      }
      case 'shutdown':
        await proxyManager.stop();
        if (getRuntimeFlavor(activeAgentKind) === 'codex') {
          await codexRuntime.shutdown();
        } else {
          await runtime.shutdown();
        }
        process.exit(0);
        break;
      case 'start_proxy':
        try {
          const result = await proxyManager.start(cmd.apiKey, cmd.baseUrl, cmd.providerName);
          emit({ type: 'proxy_status', ...proxyManager.getStatus() });
          if (result) {
            process.stderr.write(`[sidecar] Proxy started on port ${result.port}\n`);
          }
        } catch (err) {
          emit({ type: 'sidecar_error', error: `Failed to start proxy: ${String(err)}` });
        }
        break;
      case 'stop_proxy':
        try {
          await proxyManager.stop();
          emit({ type: 'proxy_status', ...proxyManager.getStatus() });
        } catch (err) {
          emit({ type: 'sidecar_error', error: `Failed to stop proxy: ${String(err)}` });
        }
        break;
      case 'proxy_status':
        emit({ type: 'proxy_status', ...proxyManager.getStatus() });
        break;
    }
  }
}

main().catch((err) => {
  emit({ type: 'sidecar_error', error: `Fatal: ${String(err)}` });
  process.exit(1);
});
