import {
  spawn,
  type ChildProcess,
} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as readline from 'node:readline';

import type { SidecarCommand } from './types.js';
import {
  buildAssistantEvent,
  buildCodexResultEvent,
  buildToolResultEvent,
} from './runtimeEvents.js';
import { shouldUseCodexChatCompatProxy } from './sessionRuntimeHelpers.js';
import { proxyManager } from './proxyManager.js';

type EnsureSessionCommand = Extract<SidecarCommand, { type: 'ensure_session' }>;

type CodexJsonItem = {
  type: string;
  id?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

type CodexSessionBootstrap = {
  sessionId?: string;
  cwd: string;
  apiKey?: string;
  upstreamBaseUrl?: string;
  runtimeBaseUrl?: string;
  model?: string;
};

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function buildCliWrapperSource(): string {
  return [
    "import { pathToFileURL } from 'node:url';",
    'const [nodePath, cliPath, ...cliArgs] = process.argv;',
    'const realExit = process.exit.bind(process);',
    'process.argv = [nodePath, cliPath, ...cliArgs];',
    "process.exit = (code = 0) => { setTimeout(() => realExit(code), 80); throw new Error('__CODEX_EXIT__:' + code); };",
    'try {',
    '  await import(pathToFileURL(cliPath).href);',
    '} catch (error) {',
    "  const text = error instanceof Error ? error.message : String(error);",
    "  if (!text.startsWith('__CODEX_EXIT__:')) {",
    '    throw error;',
    '  }',
    '}',
  ].join('\n');
}

export class CodexSessionRuntime {
  private config: CodexSessionBootstrap | null = null;
  private configFingerprint: string | null = null;
  private abortController: AbortController | null = null;
  private activeChild: ChildProcess | null = null;

  async ensure(cmd: EnsureSessionCommand): Promise<void> {
    const cwd = cmd.cwd === '.'
      ? (process.env.USERPROFILE || process.env.HOME || cmd.cwd)
      : cmd.cwd;
    const requestedConfig = {
      sessionId: cmd.sessionId,
      cwd,
      apiKey: cmd.apiKey,
      upstreamBaseUrl: cmd.baseUrl,
      model: cmd.model,
    };
    const nextFingerprint = JSON.stringify(requestedConfig);

    if (this.configFingerprint === nextFingerprint && this.config) {
      process.stderr.write(`[codex] Session ensured: session_id=${cmd.sessionId || 'none'} cwd=${cwd}\n`);
      emit({
        type: 'mcp_status_update',
        servers: {},
        status: 'ready',
      });
      // Always sync proxy status to frontend on every ensure() call
      emit({ type: 'proxy_status', ...proxyManager.getStatus() });
      return;
    }

    await this.teardownClient();
    this.configFingerprint = nextFingerprint;

    let runtimeBaseUrl = requestedConfig.upstreamBaseUrl;
    if (
      requestedConfig.apiKey &&
      requestedConfig.upstreamBaseUrl &&
      shouldUseCodexChatCompatProxy(requestedConfig.upstreamBaseUrl)
    ) {
      const result = await proxyManager.start(requestedConfig.apiKey, requestedConfig.upstreamBaseUrl);
      if (result) {
        runtimeBaseUrl = proxyManager.getBaseUrl() ?? runtimeBaseUrl;
        process.stderr.write(
          `[codex] Using chat-compat proxy upstream=${requestedConfig.upstreamBaseUrl} local=${runtimeBaseUrl}\n`,
        );
      }
    }

    this.config = {
      ...requestedConfig,
      runtimeBaseUrl,
    };

    process.stderr.write(`[codex] Session ensured: session_id=${cmd.sessionId || 'none'} cwd=${cwd}\n`);

    emit({
      type: 'mcp_status_update',
      servers: {},
      status: 'ready',
    });

    // Always emit proxy status so frontend stays in sync
    emit({ type: 'proxy_status', ...proxyManager.getStatus() });
  }

  async sendInput(prompt: string): Promise<void> {
    if (!this.config) {
      throw new Error('Codex session not initialized. Call ensure_session first.');
    }

    const sessionId = this.config.sessionId || '';
    const model = this.config.model || 'o4-mini';
    const startedAt = Date.now();

    this.abortController = new AbortController();

    process.stderr.write(`[codex] Processing input: ${prompt.slice(0, 80)}...\n`);

    emit({
      type: 'system',
      subtype: 'init',
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      model,
      cwd: this.config.cwd,
      tools: [],
      permissionMode: 'bypassPermissions',
    });

    try {
      await this.runQuietTurn(prompt, sessionId, startedAt);
    } catch (error) {
      if (!this.abortController?.signal.aborted) {
        throw error;
      }
      process.stderr.write('[codex] Turn aborted\n');
    } finally {
      this.abortController = null;
      this.finishTurn();
    }
  }

  async interrupt(): Promise<void> {
    process.stderr.write('[codex] Interrupt requested\n');
    this.abortController?.abort();
    this.activeChild?.kill();
  }

  async resetSession(sessionId: string): Promise<void> {
    process.stderr.write(`[codex] Reset session: ${sessionId}\n`);
    this.abortController?.abort();
    this.abortController = null;
    await this.teardownClient();
    this.config = null;
    this.configFingerprint = null;
  }

  async shutdown(): Promise<void> {
    process.stderr.write('[codex] Shutdown\n');
    this.abortController?.abort();
    this.abortController = null;
    await this.teardownClient();
    this.config = null;
    this.configFingerprint = null;
  }

  private async runQuietTurn(
    prompt: string,
    sessionId: string,
    startedAt: number,
  ): Promise<void> {
    if (!this.config) {
      throw new Error('Codex session not initialized. Call ensure_session first.');
    }

    const cliPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../node_modules/@openai/codex/dist/cli.js',
    );
    const args = [
      '--input-type=module',
      '-e',
      buildCliWrapperSource(),
      cliPath,
      '-q',
      '--model',
      this.config.model || 'o4-mini',
      '--dangerously-auto-approve-everything',
      prompt,
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENAI_API_KEY: this.config.apiKey || process.env.OPENAI_API_KEY || 'dummy',
      CODEX_API_KEY: this.config.apiKey || process.env.CODEX_API_KEY || 'dummy',
    };
    fs.mkdirSync(path.join(os.tmpdir(), 'oai-codex'), { recursive: true });
    if (this.config.runtimeBaseUrl) {
      env.OPENAI_BASE_URL = this.config.runtimeBaseUrl;
    }

    const child = spawn(process.execPath, args, {
      cwd: this.config.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: this.abortController?.signal,
    });
    this.activeChild = child;
    let childError: Error | null = null;
    child.on('error', (error) => {
      if (error.name === 'AbortError' || this.abortController?.signal.aborted) {
        return;
      }
      childError = error;
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    let assistantMessages = 0;

    try {
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }

        let item: CodexJsonItem;
        try {
          item = JSON.parse(line) as CodexJsonItem;
        } catch {
          process.stderr.write(`[codex] Failed to parse JSON line: ${line.slice(0, 200)}\n`);
          continue;
        }

        assistantMessages += this.handleQuietItem(sessionId, item);
      }
    } finally {
      rl.close();
    }

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    this.activeChild = null;

    if (stderr.trim()) {
      process.stderr.write(`[codex] CLI stderr: ${stderr.slice(0, 500)}\n`);
    }

    if (childError && !this.abortController?.signal.aborted) {
      throw childError;
    }

    if (!this.abortController?.signal.aborted && exit.code !== 0) {
      throw new Error(`Codex CLI exited with code ${exit.code ?? 1}: ${stderr}`);
    }

    emit(buildCodexResultEvent({
      sessionId,
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: assistantMessages,
        reasoning_output_tokens: 0,
      },
      durationMs: Date.now() - startedAt,
    }));
  }

  private handleQuietItem(
    sessionId: string,
    item: CodexJsonItem,
  ): number {
    if (item.type === 'message' && item.role === 'assistant') {
      const text = (item.content ?? [])
        .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text?.trim() ?? '')
        .filter(Boolean)
        .join('\n');
      if (!text) {
        return 0;
      }

      emit(buildAssistantEvent({
        sessionId,
        content: [{ type: 'text', text }],
      }));
      return 1;
    }

    if (item.type === 'function_call' && item.call_id && item.name) {
      let parsedArguments: Record<string, unknown> = {};
      if (item.arguments) {
        try {
          parsedArguments = JSON.parse(item.arguments) as Record<string, unknown>;
        } catch {
          parsedArguments = { raw: item.arguments };
        }
      }

      emit(buildAssistantEvent({
        sessionId,
        content: [{
          type: 'tool_use',
          id: item.call_id,
          name: item.name,
          input: parsedArguments,
        }],
      }));
      return 0;
    }

    if (item.type === 'function_call_output' && item.call_id && typeof item.output === 'string') {
      emit(buildToolResultEvent({
        sessionId,
        toolUseId: item.call_id,
        content: item.output,
      }));
    }

    return 0;
  }

  private finishTurn(): void {
    emit({ type: 'sidecar_query_done' });
  }

  private async teardownClient(): Promise<void> {
    this.activeChild?.kill();
    this.activeChild = null;
  }
}
