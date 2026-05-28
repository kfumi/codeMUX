import * as readline from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SidecarCommand } from './types.js';

let activeQuery: ReturnType<typeof query> | null = null;
let abortController: AbortController | null = null;

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

  // Log config for debugging (without exposing full API key)
  const keyPreview = cmd.apiKey ? `${cmd.apiKey.slice(0, 10)}...` : 'not set';
  process.stderr.write(`[sidecar] Starting query: model=${cmd.model || 'default'}, cwd=${cmd.cwd}, apiKey=${keyPreview}\n`);

  abortController = new AbortController();

  try {
    activeQuery = query({
      prompt: cmd.prompt,
      options: {
        cwd: cmd.cwd,
        resume: cmd.sessionId,
        model: cmd.model,
        abortController,
        permissionMode: 'default',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      },
    });

    for await (const message of activeQuery) {
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

async function main(): Promise<void> {
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
