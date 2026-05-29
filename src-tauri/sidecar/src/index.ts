import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SidecarCommand } from './types.js';

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
      for (const [key, value] of Object.entries(settings.env)) {
        if (typeof value === 'string' && !process.env[key]) {
          process.env[key] = value;
        }
      }
      process.stderr.write(`[sidecar] Loaded ${Object.keys(settings.env).length} env vars from ~/.claude/settings.json\n`);
    }
  } catch (err) {
    process.stderr.write(`[sidecar] Warning: failed to load Claude settings: ${err}\n`);
  }
}

let activeQuery: ReturnType<typeof query> | null = null;
let abortController: AbortController | null = null;

/**
 * Maps app session ID -> Claude Code's real session ID.
 * Captured from the first SDK message that contains a session_id field.
 * Used to resume conversations with full context on subsequent queries.
 */
const sessionIdMap = new Map<string, string>();

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

  const keyPreview = cmd.apiKey ? `${cmd.apiKey.slice(0, 10)}...` : 'not set';
  const claudePath = findClaudeExecutable();
  const appSessionId = cmd.sessionId;
  const claudeSessionId = appSessionId ? sessionIdMap.get(appSessionId) : undefined;

  process.stderr.write(`[sidecar] Starting query: model=${cmd.model || 'default'}, cwd=${cmd.cwd}, apiKey=${keyPreview}, claude=${claudePath || 'not found'}\n`);
  process.stderr.write(`[sidecar] Session: app=${appSessionId || 'none'}, claude=${claudeSessionId || 'new'}\n`);

  abortController = new AbortController();

  try {
    const options: Record<string, unknown> = {
      cwd: cmd.cwd,
      abortController,
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    };
    if (claudePath) options.pathToClaudeCodeExecutable = claudePath;

    // Resume existing conversation if we have a captured Claude session ID
    if (claudeSessionId) {
      options.resume = claudeSessionId;
      process.stderr.write(`[sidecar] Resuming Claude session: ${claudeSessionId}\n`);
    }

    process.stderr.write(`[sidecar] query options: ${JSON.stringify({ ...options, abortController: '[object]' })}\n`);

    activeQuery = query({
      prompt: cmd.prompt,
      options: options as any,
    });

    for await (const message of activeQuery) {
      // Capture the real Claude session ID from any SDK message
      if (appSessionId && !sessionIdMap.has(appSessionId)) {
        const msg = message as Record<string, unknown>;
        if (typeof msg.session_id === 'string' && msg.session_id) {
          sessionIdMap.set(appSessionId, msg.session_id);
          process.stderr.write(`[sidecar] Captured Claude session ID: ${msg.session_id} for app session: ${appSessionId}\n`);
        }
      }
      emit(message);
    }

    emit({ type: 'sidecar_query_done' });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    if (errorMsg !== 'The operation was aborted') {
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
  process.stderr.write(`[sidecar] Reset session ${cmd.sessionId}: ${deleted ? 'cleared' : 'not found'}\n`);
}

async function main(): Promise<void> {
  // Load Claude Code settings (env vars like ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, etc.)
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
