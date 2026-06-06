import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { query, startup } from '@anthropic-ai/claude-agent-sdk';
import type { SidecarCommand } from './types.js';

/** Pending tool responses waiting for user input */
const pendingToolResponses = new Map<string, { resolve: (value: unknown) => void }>();

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

let activeQuery: ReturnType<typeof query> | null = null;

/**
 * Build MCP tool instructions from server names and server-provided instructions.
 * This replicates Claude Code Desktop's mcp_instructions_delta mechanism,
 * ensuring the model always knows what MCP tools are available and when to use them.
 */
function buildMcpInstructions(
  mcpServers?: Record<string, unknown>,
  serverInstructions?: Record<string, string>,
): string | undefined {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return undefined;

  const lines: string[] = [];
  const serverNames = Object.keys(mcpServers);

  // Per-server instructions (from MCP initialize response)
  if (serverInstructions && Object.keys(serverInstructions).length > 0) {
    for (const name of serverNames) {
      const instr = serverInstructions[name];
      if (instr) {
        lines.push(`## ${name}`);
        lines.push(instr);
        lines.push('');
      }
    }
  }

  // WaitForMcpServers: startup() pre-warms but doesn't guarantee all MCP servers
  // are connected by the time the model starts. The model must call
  // WaitForMcpServers before using any MCP tool.
  // Keep the instruction short to avoid verbose "let me wait" responses.
  lines.push(`MCP servers: ${serverNames.join(', ')}.`);
  lines.push('Before using any MCP tool, call WaitForMcpServers first.');

  return lines.join('\n');
}

let abortController: AbortController | null = null;

/**
 * Maps app session ID -> Claude Code's real session ID.
 * Captured from the first SDK message that contains a session_id field.
 * Used to resume conversations with full context on subsequent queries.
 */
const sessionIdMap = new Map<string, string>();

/** Path to persist the session ID mapping so Rust can read it for cleanup. */
const SESSION_MAP_FILE = path.join(os.homedir(), '.claude', 'session-id-map.json');

/** Load persisted session ID mapping from disk on startup. */
function loadSessionMap(): void {
  try {
    if (fs.existsSync(SESSION_MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf-8'));
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'string') sessionIdMap.set(k, v);
        }
        process.stderr.write(`[sidecar] Loaded ${sessionIdMap.size} session mappings from disk\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[sidecar] Warning: failed to load session map: ${err}\n`);
  }
}

/** Persist the current session ID mapping to disk. */
function saveSessionMap(): void {
  try {
    const obj: Record<string, string> = {};
    sessionIdMap.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    process.stderr.write(`[sidecar] Warning: failed to save session map: ${err}\n`);
  }
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleStart(cmd: Extract<SidecarCommand, { type: 'start' }>): Promise<void> {
  if (activeQuery) {
    emit({ type: 'sidecar_error', error: 'A query is already active' });
    return;
  }

  if (cmd.apiKey) {
    process.env.ANTHROPIC_API_KEY = cmd.apiKey;
  }
  if (cmd.baseUrl) {
    process.env.ANTHROPIC_BASE_URL = cmd.baseUrl;
  }

  const keyPreview = cmd.apiKey ? `${cmd.apiKey.slice(0, 10)}...` : 'not set';
  const claudePath = findClaudeExecutable();

  // Debug: verify env vars are set correctly before spawning SDK
  const envKey = process.env.ANTHROPIC_API_KEY;
  const envUrl = process.env.ANTHROPIC_BASE_URL;
  process.stderr.write(`[sidecar] ENV ANTHROPIC_API_KEY=${envKey ? envKey.slice(0, 10) + '...' : 'NOT SET'}\n`);
  process.stderr.write(`[sidecar] ENV ANTHROPIC_BASE_URL=${envUrl || 'NOT SET'}\n`);
  process.stderr.write(`[sidecar] ENV ANTHROPIC_API_KEY length=${envKey?.length || 0}\n`);
  // Check for other auth-related env vars that might conflict
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const cookie = process.env.ANTHROPIC_COOKIE;
  if (authToken) process.stderr.write(`[sidecar] WARNING: ANTHROPIC_AUTH_TOKEN is also set! (len=${authToken.length})\n`);
  if (cookie) process.stderr.write(`[sidecar] WARNING: ANTHROPIC_COOKIE is also set!\n`);
  // Log all ANTHROPIC_* env vars in the environment
  const anthropicVars = Object.keys(process.env).filter(k => k.startsWith('ANTHROPIC_'));
  process.stderr.write(`[sidecar] All ANTHROPIC_* env vars: ${anthropicVars.join(', ') || '(none)'}\n`);
  const appSessionId = cmd.sessionId;
  const claudeSessionId = appSessionId ? sessionIdMap.get(appSessionId) : undefined;

  process.stderr.write(`[sidecar] Starting query: cwd=${cmd.cwd}, apiKey=${keyPreview}, baseUrl=${cmd.baseUrl || 'default'}, claude=${claudePath || 'not found'}\n`);
  process.stderr.write(`[sidecar] Session: app=${appSessionId || 'none'}, claude=${claudeSessionId || 'new'}\n`);

  abortController = new AbortController();

  try {
    // Build explicit env for the SDK subprocess — ensures provider switch
    // picks up new ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL instead of using
    // whatever the child process inherited at startup.
    const subprocessEnv: Record<string, string | undefined> = { ...process.env };
    // Force-overwrite auth vars so stale values from settings.json can't leak through
    if (cmd.apiKey) subprocessEnv.ANTHROPIC_API_KEY = cmd.apiKey;
    if (cmd.baseUrl) subprocessEnv.ANTHROPIC_BASE_URL = cmd.baseUrl;
    // Remove ANTHROPIC_AUTH_TOKEN — it's the Claude account login token from
    // ~/.claude/settings.json. When set alongside ANTHROPIC_API_KEY, Claude Code
    // uses the auth token (for anthropic.com) instead of the API key, causing
    // 401 on non-Anthropic endpoints like DeepSeek.
    // NOTE: Must set to empty string instead of delete — the CLI re-reads
    // settings.json and picks up the token even when the env var is absent.
    subprocessEnv.ANTHROPIC_AUTH_TOKEN = '';
    subprocessEnv.ANTHROPIC_COOKIE = '';
    // Remove global model overrides from settings — the user's chosen model
    // is passed via the SDK --model flag, these env defaults would interfere.
    for (const key of Object.keys(subprocessEnv)) {
      if (key.startsWith('ANTHROPIC_DEFAULT_')) {
        subprocessEnv[key] = '';
      }
    }

    // Build MCP instructions from server names + descriptions (replicates
    // Claude Code Desktop's mcp_instructions_delta mechanism)
    const mcpInstructions = buildMcpInstructions(cmd.mcpServers, cmd.mcpServerInstructions);
    process.stderr.write(`[sidecar] MCP instructions built: ${mcpInstructions ? `${mcpInstructions.length} chars` : 'none'}\n`);
    if (mcpInstructions) {
      process.stderr.write(`[sidecar] MCP instructions preview: ${mcpInstructions.slice(0, 200)}...\n`);
    }

    // Build a clean settings object to override ~/.claude/settings.json.
    // This prevents the CLI from picking up conflicting auth tokens or model
    // overrides from the user's global Claude Code config.
    const cleanSettings: Record<string, unknown> = {};
    if (cmd.apiKey || cmd.baseUrl) {
      cleanSettings.env = {
        ...(cmd.apiKey ? { ANTHROPIC_API_KEY: cmd.apiKey } : {}),
        ...(cmd.baseUrl ? { ANTHROPIC_BASE_URL: cmd.baseUrl } : {}),
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_COOKIE: '',
        DISABLE_AUTOUPDATER: '1',
      };
    }

    const options: Record<string, unknown> = {
      cwd: cmd.cwd === '.' ? os.homedir() : cmd.cwd,
      abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
        'WebSearch', 'WebFetch', 'AskUserQuestion', 'TodoWrite',
        'WaitForMcpServers',
        ...Object.keys(cmd.mcpServers || {}).map(name => `mcp__${name}__*`),
      ],
      env: subprocessEnv,
      ...(Object.keys(cleanSettings).length > 0 ? { settings: cleanSettings } : {}),
      mcpServers: cmd.mcpServers || undefined,
      // Emit streaming events (thinking deltas, text deltas) for real-time UI updates
      includePartialMessages: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: mcpInstructions || '',
      },
      // Capture stderr from the Claude Code subprocess for debugging
      stderr: (data: string) => {
        process.stderr.write(`[claude-stderr] ${data}`);
      },
      // Intercept interactive tools that need user input
      canUseTool: async (toolName: string, input: Record<string, unknown>, opts: { toolUseID: string; signal: AbortSignal }) => {
        if (toolName === 'AskUserQuestion') {
          const toolUseId = opts.toolUseID;
          // questions may come as a JSON string or array
          let questions: any[] = [];
          const rawQ = (input as any).questions;
          if (typeof rawQ === 'string') {
            try { questions = JSON.parse(rawQ); } catch { questions = []; }
          } else if (Array.isArray(rawQ)) {
            questions = rawQ;
          }
          process.stderr.write(`[sidecar] AskUserQuestion intercepted, toolUseId=${toolUseId}, questions=${questions.length}\n`);
          // Emit event to frontend with questions (always as parsed array)
          emit({
            type: 'ask_user_question',
            tool_use_id: toolUseId,
            questions,
          });
          // Wait for frontend to send back the user's response (array of answers)
          const userAnswers = await new Promise<string[]>((resolve) => {
            pendingToolResponses.set(toolUseId, { resolve: resolve as (v: unknown) => void });
          });
          pendingToolResponses.delete(toolUseId);
          // Format: Record<questionText, answerText> (multi-select joined by comma)
          const answersRecord: Record<string, string> = {};
          questions.forEach((q: any, i: number) => {
            const answer = userAnswers[i];
            answersRecord[q.question] = Array.isArray(answer) ? answer.join(', ') : String(answer ?? '');
          });
          process.stderr.write(`[sidecar] AskUserQuestion resolved: ${JSON.stringify(answersRecord)}\n`);
          // Ensure questions is always an array in updatedInput (not a JSON string)
          return { behavior: 'allow', updatedInput: { ...input, questions, answers: answersRecord } };
        }
        // Auto-allow all other tools
        return { behavior: 'allow', updatedInput: input };
      },
    };
    if (claudePath) options.pathToClaudeCodeExecutable = claudePath;
    if (cmd.model) options.model = cmd.model;

    // Resume existing conversation if we have a captured Claude session ID
    if (claudeSessionId) {
      options.resume = claudeSessionId;
      process.stderr.write(`[sidecar] Resuming Claude session: ${claudeSessionId}\n`);
    }

    process.stderr.write(`[sidecar] query options: ${JSON.stringify({ ...options, abortController: '[object]' })}\n`);

    // Emit progress event so the frontend knows we're initializing MCP connections
    emit({ type: 'mcp_status_update', servers: {}, status: 'initializing' });

    // Use startup() to pre-warm the CLI subprocess and MCP connections.
    // Falls back to direct query() if startup() fails (e.g., MCP timeout).
    process.stderr.write(`[sidecar] Calling startup() to pre-warm MCP connections...\n`);
    try {
      const warm = await startup({
        options: options as any,
        initializeTimeoutMs: 30_000,
      });
      process.stderr.write(`[sidecar] startup() complete. Sending prompt...\n`);
      activeQuery = warm.query(cmd.prompt);
    } catch (startupErr) {
      process.stderr.write(`[sidecar] startup() failed: ${startupErr}. Falling back to query()...\n`);
      emit({ type: 'mcp_status_update', servers: {}, status: 'startup_failed_fallback' });
      activeQuery = query({
        prompt: cmd.prompt,
        options: options as any,
      });
    }
    process.stderr.write(`[sidecar] query ready, starting iteration...\n`);

    let msgCount = 0;
    const MESSAGE_TIMEOUT_MS = 120_000; // 2 minutes per message
    let compacting = false;
    let compactTimer: ReturnType<typeof setTimeout> | null = null;
    const COMPACT_TIMEOUT_MS = 60_000; // 60s — compact can take a while on large contexts

    function clearCompactTimer() {
      if (compactTimer) { clearTimeout(compactTimer); compactTimer = null; }
    }

    // Iteration with timeout detection
    const iterator = activeQuery[Symbol.asyncIterator]();
    while (true) {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Query timed out: no message received for ${MESSAGE_TIMEOUT_MS / 1000}s (after msg #${msgCount})`));
          }, MESSAGE_TIMEOUT_MS);
          if (timer.unref) timer.unref();
        }),
        // When compacting, if no new message arrives within COMPACT_TIMEOUT_MS, treat as done
        ...(compacting ? [new Promise<{ done: true; value: undefined }>((resolve) => {
          compactTimer = setTimeout(() => {
            process.stderr.write(`[sidecar] Compact timeout: no message after ${COMPACT_TIMEOUT_MS}ms, treating as complete\n`);
            // Emit synthetic compact_boundary since SDK didn't send it
            emit({
              type: 'system',
              subtype: 'compact_boundary',
              compact_metadata: { trigger: 'manual', pre_tokens: 0 },
              session_id: claudeSessionId || '',
              uuid: `compact-timeout-${Date.now()}`,
            });
            resolve({ done: true, value: undefined });
          }, COMPACT_TIMEOUT_MS);
          if (compactTimer.unref) compactTimer.unref();
        })] : []),
      ]);

      clearCompactTimer();
      if (result.done) break;

      msgCount++;
      const message = result.value;
      const msg = message as Record<string, unknown>;
      process.stderr.write(`[sidecar] Message #${msgCount}: type=${msg.type}, subtype=${msg.subtype || 'none'}\n`);
      // Log full content for system messages and assistant messages (debug)
      if (msg.type === 'system') {
        process.stderr.write(`[sidecar]   → ${JSON.stringify(message)}\n`);
      }
      // Log ALL non-assistant messages for debugging compact/status flows
      if (msg.type !== 'assistant' && msg.type !== 'user' && msg.type !== 'system') {
        process.stderr.write(`[sidecar]   → [${msg.type}] ${JSON.stringify(message)}\n`);
      }
      // Track compacting status
      if (msg.type === 'system' && msg.subtype === 'status' && (msg as any).status === 'compacting') {
        compacting = true;
        // Capture pre_tokens if available in the compacting status
        const compactTokens = (msg as any).tokens || (msg as any).pre_tokens || (msg as any).total_tokens;
        if (compactTokens) {
          process.stderr.write(`[sidecar] Compact in progress, pre_tokens=${compactTokens}\n`);
        } else {
          process.stderr.write(`[sidecar] Compact in progress, will timeout after ${COMPACT_TIMEOUT_MS}ms of silence\n`);
        }
      }
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        compacting = false;
        process.stderr.write(`[sidecar] Received compact_boundary: ${JSON.stringify(message)}\n`);
      }
      if (msg.type === 'assistant') {
        const m: any = message;
        const usage = m?.message?.usage || m?.usage;
        process.stderr.write(`[sidecar]   → assistant usage: ${JSON.stringify(usage || 'NONE')}\n`);
        // Debug: log tool_use block names to trace TodoWrite
        const blocks = m?.message?.content;
        if (Array.isArray(blocks)) {
          const toolNames = blocks.filter((b: any) => b?.type === 'tool_use').map((b: any) => b.name);
          if (toolNames.length > 0) {
            process.stderr.write(`[sidecar]   → tool_use blocks: ${toolNames.join(', ')}\n`);
          }
        }
      }

      // Capture the real Claude session ID from any SDK message
      if (appSessionId && !sessionIdMap.has(appSessionId)) {
        if (typeof msg.session_id === 'string' && msg.session_id) {
          sessionIdMap.set(appSessionId, msg.session_id);
          saveSessionMap();
          process.stderr.write(`[sidecar] Captured Claude session ID: ${msg.session_id} for app session: ${appSessionId}\n`);
        }
      }
      emit(message);

      // After init message, poll MCP server status for UI updates
      if (msg.type === 'system' && msg.subtype === 'init' && Array.isArray((msg as any).mcp_servers)) {
        const mcpServers = (msg as any).mcp_servers as Array<{ name: string; status: string }>;
        const hasPending = mcpServers.some(s => s.status === 'pending');
        if (hasPending && activeQuery) {
          (async () => {
            const MAX_POLLS = 30;
            const POLL_INTERVAL = 2000;
            try {
              for (let i = 0; i < MAX_POLLS; i++) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                if (!activeQuery) break;
                const statuses = await activeQuery.mcpServerStatus();
                const statusMap: Record<string, string> = {};
                for (const s of statuses) {
                  statusMap[s.name] = s.status;
                }
                emit({ type: 'mcp_status_update', servers: statusMap });
                process.stderr.write(`[sidecar] MCP poll #${i + 1}: ${JSON.stringify(statusMap)}\n`);
                const allDone = statuses.every(s => s.status === 'connected' || s.status === 'failed');
                if (allDone) break;
              }
            } catch (err) {
              process.stderr.write(`[sidecar] MCP status poll error: ${err}\n`);
            }
          })();
        }
      }
    }

    process.stderr.write(`[sidecar] Query iteration done. Total messages: ${msgCount}\n`);
    emit({ type: 'sidecar_query_done' });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    const isAbort = errorMsg.includes('aborted by user') || errorMsg === 'The operation was aborted';
    if (!isAbort) {
      emit({ type: 'sidecar_error', error: errorMsg });
    }
  } finally {
    activeQuery = null;
    abortController = null;
  }
}

function handleInterrupt(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  activeQuery = null;
}

function handleResetSession(cmd: Extract<SidecarCommand, { type: 'reset_session' }>): void {
  const deleted = sessionIdMap.delete(cmd.sessionId);
  if (deleted) saveSessionMap();
  process.stderr.write(`[sidecar] Reset session ${cmd.sessionId}: ${deleted ? 'cleared' : 'not found'}\n`);
}

async function main(): Promise<void> {
  // Load Claude Code settings (env vars like ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, etc.)
  loadClaudeSettingsEnv();
  // Load persisted session ID mapping
  loadSessionMap();

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
      case 'start':
        // Run async but don't await — allows interrupt to be received during execution
        handleStart(cmd).catch((err) => {
          emit({ type: 'sidecar_error', error: String(err) });
        });
        break;
      case 'reset_session':
        handleResetSession(cmd);
        break;
      case 'interrupt':
        handleInterrupt();
        break;
      case 'tool_response': {
        // Resolve pending canUseTool promise with the user's response
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
        process.exit(0);
        break;
    }
  }
}

main().catch((err) => {
  emit({ type: 'sidecar_error', error: `Fatal: ${String(err)}` });
  process.exit(1);
});
