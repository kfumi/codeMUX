import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizeAgentInputPayload, type AgentInputPayload } from './agentInputPayload.js';
import { createPiEventContext, toCodeMuxEvents, type PiEventContext, type PiRuntimeEvent } from './piEvents.js';
import { PiRpcProcess } from './piRpcTransport.js';
import { emit } from './streamEventBatcher.js';
import type { PiSessionConfig, PiSessionMapping } from './types.js';
import type { ProviderRuntimeRef } from './runtimeContract.js';
import { setLogCtx, writeLog } from './writeLog.js';

export const PI_RPC_ENTRY_RELATIVE = 'node_modules/@mariozechner/pi/dist/cli.js';

export interface PiRuntimeOptions {
  /** 测试 seam：替换传输层构造（fake-pi 基建走这里）。 */
  transportFactory?: (config: PiSessionConfig) => PiRpcProcess;
  emitEvent?: (event: unknown) => void;
  eventIdFactory?: () => string;
}

type RuntimeState = 'idle' | 'starting' | 'started' | 'disposed';

interface PiPendingTurn {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/** 托管 Runtime 里的 pi JS 入口（`@mariozechner/pi` 的 bin 目标）。 */
export function resolvePiEntryFromRuntimeRef(runtimeRef: ProviderRuntimeRef | undefined): string | null {
  if (!runtimeRef?.runtimePath) return null;
  return path.join(runtimeRef.runtimePath, PI_RPC_ENTRY_RELATIVE);
}

function looksLikePiSessionPath(value: string): boolean {
  return value.endsWith('.jsonl') && path.isAbsolute(value);
}

/**
 * ADR 0005：CodeMUX 托管会话不隐式回落 pi 自身认证。非 environment 来源
 * 一律剥离常见供应商凭据环境变量，避免用户本机的 ambient key 漏进子进程。
 */
function sanitizePiEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ]) {
    delete env[key];
  }
  return env;
}

function dataUrlToBase64(dataUrl: string): string | null {
  const commaIndex = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || commaIndex < 0) return null;
  return dataUrl.slice(commaIndex + 1);
}

function mapPiImages(payload: AgentInputPayload): PiImageContent[] {
  const images: PiImageContent[] = [];
  for (const image of payload.images ?? []) {
    const data = dataUrlToBase64(image.dataUrl);
    if (data) {
      images.push({ type: 'image', data, mimeType: image.mediaType });
    }
  }
  return images;
}

/**
 * pi `--mode rpc` 会话运行时：一个 CodeMUX pi 会话对应一个长期存活的
 * pi 子进程。`prompt` RPC 的响应仅是受理确认，turn 完成以 `agent_end`
 * 事件为准；进程退出 / RPC 失败投影为 failed outcome。
 */
export class PiRuntime {
  private transport: PiRpcProcess | undefined;
  private readonly ctx: PiEventContext;
  private state: RuntimeState = 'idle';
  private startPromise: Promise<PiSessionMapping> | undefined;
  private pendingTurn: PiPendingTurn | undefined;
  private interrupted = false;
  private agentSessionFile: string | undefined;
  private piSessionId: string | undefined;
  private stopping = false;

  constructor(
    private readonly config: PiSessionConfig,
    private readonly options: PiRuntimeOptions = {},
  ) {
    this.ctx = createPiEventContext({
      sessionId: config.sessionId,
      ...(config.agentSessionId ? { agentSessionId: config.agentSessionId } : {}),
      ...(options.eventIdFactory ? { eventIdFactory: options.eventIdFactory } : {}),
    });
  }

  get isStarted(): boolean {
    return this.state === 'started';
  }

  canReuse(next: PiSessionConfig): boolean {
    return (
      this.state === 'started' &&
      next.sessionId === this.config.sessionId &&
      (next.agentSessionId ?? undefined) === (this.config.agentSessionId ?? undefined)
    );
  }

  buildSessionMapping(runtimeGeneration: number): PiSessionMapping {
    return {
      sessionId: this.config.sessionId,
      agentSessionId: this.currentNativeSessionId(),
      runtimeGeneration,
    };
  }

  async ensure(): Promise<PiSessionMapping> {
    if (this.state === 'started' && this.transport) {
      return this.buildSessionMapping(this.config.runtimeGeneration);
    }
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        this.startPromise = undefined;
        throw error;
      });
    }
    return this.startPromise;
  }

  async sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void> {
    const transport = this.transport;
    if (this.state !== 'started' || !transport) {
      throw new Error('pi runtime is not started');
    }
    if (this.pendingTurn) {
      throw new Error('pi runtime already has an active turn');
    }

    const payload = normalizeAgentInputPayload(prompt, inputPayload);
    setLogCtx({ sessionId: this.config.sessionId });
    writeLog('[pi-task]', `sendInput START model=${this.config.provider ?? 'default'}/${this.config.model ?? 'default'} prompt_preview=${payload.text.slice(0, 120)}`);

    this.interrupted = false;
    const turn = new Promise<void>((resolve, reject) => {
      this.pendingTurn = { resolve, reject };
    });

    const images = mapPiImages(payload);
    try {
      await transport.request({
        type: 'prompt',
        message: payload.text,
        ...(images.length > 0 ? { images } : {}),
      });
    } catch (error) {
      this.pendingTurn = undefined;
      const messageText = error instanceof Error ? error.message : String(error);
      writeLog('[pi-task]', `sendInput prompt FAILED error=${messageText}`);
      this.emitTurnError(messageText);
      throw error;
    }

    // prompt 的响应只是受理确认；turn 完成由 agent_end / 进程退出驱动。
    try {
      await turn;
      writeLog('[pi-task]', 'sendInput COMPLETE');
    } catch (error) {
      writeLog('[pi-task]', `sendInput turn FAILED error=${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      if (this.pendingTurn) {
        this.pendingTurn = undefined;
      }
    }
  }

  async interrupt(): Promise<void> {
    const transport = this.transport;
    if (this.state !== 'started' || !transport) {
      throw new Error('pi runtime is not started');
    }
    if (this.pendingTurn) {
      this.interrupted = true;
    }
    writeLog('[pi-task]', 'interrupt REQUEST');
    await transport.request({ type: 'abort' });
  }

  async resetSession(): Promise<void> {
    const transport = this.transport;
    if (this.state !== 'started' || !transport) {
      throw new Error('pi runtime is not started');
    }
    await transport.request({ type: 'new_session' });
    await this.refreshSessionIdentity();
  }

  async deleteSession(agentSessionId: string): Promise<void> {
    // pi 的 Native Session mapping 是会话文件路径；仅删除 .jsonl 会话文件。
    if (!looksLikePiSessionPath(agentSessionId)) {
      throw new Error(`Refusing to delete non-pi-session path: ${agentSessionId}`);
    }
    await fs.promises.rm(agentSessionId, { force: true });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.state = 'disposed';
    const transport = this.transport;
    this.transport = undefined;
    if (this.pendingTurn) {
      const pending = this.pendingTurn;
      this.pendingTurn = undefined;
      pending.reject(new Error('pi runtime is shutting down'));
    }
    if (!transport) return;
    await transport.close(new Error('pi runtime is shutting down')).catch(() => undefined);
  }

  private currentNativeSessionId(): string {
    if (this.agentSessionFile) return this.agentSessionFile;
    if (this.piSessionId) return `pi:${this.piSessionId}`;
    return `pi:pending-${this.config.sessionId}`;
  }

  private async start(): Promise<PiSessionMapping> {
    this.state = 'starting';
    const transport = this.options.transportFactory
      ? this.options.transportFactory(this.config)
      : createDefaultPiTransport(this.config);
    this.transport = transport;
    transport.onMessage((message) => this.handlePiEvent(message as PiRuntimeEvent));
    void transport.waitForExit().then((info) => {
      this.handleProcessExit(info.code, info.signal);
    });

    try {
      await this.readSessionIdentity(transport);
    } catch (error) {
      this.state = 'disposed';
      this.transport = undefined;
      await transport.close(new Error('pi runtime failed to start')).catch(() => undefined);
      throw error;
    }
    this.ctx.agentSessionId = this.agentSessionFile;
    this.state = 'started';
    writeLog('[pi-task]', `ensure STARTED session=${this.currentNativeSessionId()}`);
    return this.buildSessionMapping(this.config.runtimeGeneration);
  }

  /** 从 get_state 回读 pi 会话 id 与会话文件路径。 */
  private async readSessionIdentity(transport: PiRpcProcess): Promise<void> {
    const state = await transport.request({ type: 'get_state' });
    const record = typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
    this.piSessionId = typeof record.sessionId === 'string' ? record.sessionId : this.piSessionId;
    this.agentSessionFile =
      typeof record.sessionFile === 'string' && record.sessionFile
        ? record.sessionFile
        : this.agentSessionFile;
    this.ctx.agentSessionId = this.agentSessionFile;
  }

  private async refreshSessionIdentity(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    try {
      await this.readSessionIdentity(transport);
    } catch {
      // 身份刷新失败不影响会话继续。
    }
  }

  private handlePiEvent(event: PiRuntimeEvent): void {
    if (event.type === 'agent_end') {
      const outcome = this.interrupted ? 'interrupted' : 'completed';
      this.interrupted = false;
      const projected = toCodeMuxEvents(event, this.ctx);
      for (const mapped of projected) {
        (this.options.emitEvent ?? emit)(mapped);
      }
      this.finishTurn(outcome);
      return;
    }
    const projected = toCodeMuxEvents(event, this.ctx);
    for (const mapped of projected) {
      (this.options.emitEvent ?? emit)(mapped);
    }
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping || this.state !== 'started') return;
    this.state = 'disposed';
    this.transport = undefined;
    const message = `pi process exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
    writeLog('[pi-task]', `process EXIT ${message}`);
    this.emitTurnError(message);
  }

  private emitTurnError(message: string): void {
    (this.options.emitEvent ?? emit)({
      type: 'error',
      subtype: 'pi_process_error',
      error: message,
    });
    this.finishTurn('failed', message);
  }

  private finishTurn(outcome: 'completed' | 'failed' | 'interrupted', reason?: string): void {
    (this.options.emitEvent ?? emit)({
      type: 'turn_finished',
      outcome,
      ...(reason ? { reason } : {}),
    });
    const pending = this.pendingTurn;
    this.pendingTurn = undefined;
    if (!pending) return;
    if (outcome === 'failed') {
      pending.reject(new Error(reason ?? `pi turn failed`));
      return;
    }
    // completed / interrupted 都正常结束 sendInput：turn_finished 已携带
    // outcome，用户主动中断不应再向 send_input 的兜底抛出错误。
    pending.resolve();
  }
}

/**
 * 默认传输层：托管 Runtime 存在时以其 node 入口启动 pi（规避 Windows
 * .cmd shim 与 PATH 依赖）；否则回落 PATH 上的 `pi`。凭据按 ADR 0005 经
 * 环境变量注入，不读写 `~/.pi` 原生配置。
 */
export function createDefaultPiTransport(config: PiSessionConfig): PiRpcProcess {
  const args = ['--mode', 'rpc'];
  let command: string;

  const entry = resolvePiEntryFromRuntimeRef(config.runtimeRef);
  if (entry) {
    if (!fs.existsSync(entry)) {
      throw new Error(`pi runtime entry not found: ${entry}`);
    }
    command = process.execPath;
    args.unshift(entry);
  } else {
    command = 'pi';
  }

  if (config.agentSessionId && looksLikePiSessionPath(config.agentSessionId)) {
    args.push('--session', config.agentSessionId);
  }
  const provider = config.provider?.trim();
  const model = config.model?.trim();
  if (provider && model && model !== 'default') {
    args.push('--model', `${provider}/${model}`);
  } else if (model && model !== 'default') {
    args.push('--model', model);
  }

  const env: Record<string, string | undefined> =
    config.credentialSource === 'environment'
      ? { ...process.env }
      : sanitizePiEnv({ ...process.env });
  if (config.credentialSource === 'codemux') {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new Error('pi session has no API key configured; refusing to fall back to pi auth (ADR 0005)');
    }
    const providerKey = (provider ?? '').toLowerCase();
    if (providerKey.includes('anthropic')) {
      env.ANTHROPIC_API_KEY = apiKey;
      if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
    } else if (providerKey.includes('openai')) {
      env.OPENAI_API_KEY = apiKey;
      if (config.baseUrl) env.OPENAI_BASE_URL = config.baseUrl;
    } else {
      throw new Error(
        `pi provider "${provider ?? 'unknown'}" cannot be mapped to environment credentials; configure an anthropic/openai-compatible provider`,
      );
    }
  }

  return PiRpcProcess.start({
    command,
    args,
    cwd: config.cwd,
    env,
    requestTimeoutMs: 30_000,
  });
}
