import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizeAgentInputPayload, type AgentInputPayload } from './agentInputPayload.js';
import {
  createPiEventContext,
  toCodeMuxEvents,
  type PiEventContext,
  type PiRuntimeEvent,
  type PiThinkingLevel,
} from './piEvents.js';
import { PiRpcProcess } from './piRpcTransport.js';
import { emit } from './streamEventBatcher.js';
import type { PiSessionConfig, PiSessionMapping } from './types.js';
import type { ProviderRuntimeRef } from './runtimeContract.js';
import { setLogCtx, writeLog } from './writeLog.js';

export const PI_RPC_ENTRY_RELATIVE = 'node_modules/@mariozechner/pi/dist/cli.js';

/** pi 用量快照（get_session_stats 的 token 子集，用于 turn 级差值）。 */
interface PiUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** CodeMUX turn_finished.usage 的 token 字段。 */
interface PiTurnUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
}

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
  private usageBaseline: PiUsageSnapshot | undefined;

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
      (next.agentSessionId ?? undefined) === (this.config.agentSessionId ?? undefined) &&
      next.cwd === this.config.cwd &&
      (next.provider ?? undefined) === (this.config.provider ?? undefined) &&
      (next.model ?? undefined) === (this.config.model ?? undefined) &&
      (next.thinkingLevel ?? undefined) === (this.config.thinkingLevel ?? undefined) &&
      next.credentialSource === this.config.credentialSource &&
      (next.apiKey ?? undefined) === (this.config.apiKey ?? undefined) &&
      (next.baseUrl ?? undefined) === (this.config.baseUrl ?? undefined) &&
      JSON.stringify(next.runtimeRef ?? null) === JSON.stringify(this.config.runtimeRef ?? null)
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
    if (this.state === 'starting' && this.startPromise) {
      return this.startPromise;
    }
    // 进程崩溃（disposed）后允许重新拉起：以上次已知会话文件 resume。
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
    // 手动压缩是独立的阻塞 RPC，不进入常规 prompt 流程。
    if (payload.text.trim().startsWith('/compact') && (payload.images?.length ?? 0) === 0) {
      await this.compactSession(payload.text.trim());
      return;
    }
    setLogCtx({ sessionId: this.config.sessionId });
    writeLog('[pi-task]', `sendInput START model=${this.config.provider ?? 'default'}/${this.config.model ?? 'default'} prompt_preview=${payload.text.slice(0, 120)}`);

    this.interrupted = false;
    this.usageBaseline = await this.readUsageSnapshot(transport);
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

  /** 手动压缩：`/compact [自定义指令]`。compact 是阻塞 LLM 任务，不设墙钟超时。 */
  private async compactSession(commandText: string): Promise<void> {
    const transport = this.transport;
    if (this.state !== 'started' || !transport) {
      throw new Error('pi runtime is not started');
    }
    if (this.pendingTurn) {
      throw new Error('pi runtime already has an active turn');
    }
    const customInstructions = commandText.replace(/^\/compact\s*/i, '').trim();
    setLogCtx({ sessionId: this.config.sessionId });
    writeLog('[pi-task]', `compact START${customInstructions ? ' instructions=yes' : ''}`);

    this.interrupted = false;
    this.usageBaseline = await this.readUsageSnapshot(transport);
    try {
      await transport.request(
        { type: 'compact', ...(customInstructions ? { customInstructions } : {}) },
        { timeoutMs: null },
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      writeLog('[pi-task]', `compact FAILED error=${messageText}`);
      this.emitTurnError(messageText);
      throw error;
    }
    const usage = await this.readTurnUsageDelta(transport);
    (this.options.emitEvent ?? emit)({
      type: 'turn_finished',
      outcome: 'completed',
      ...(usage ? { usage } : {}),
    });
    writeLog('[pi-task]', 'compact COMPLETE');
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

  /**
   * Fork = 拷贝当前 pi 会话文件为同目录下的独立副本，返回新文件路径作为
   * 新会话的 Native Session mapping。pi 按路径加载会话，文件级拷贝即得到
   * 互不影响的原生历史副本（provider turn 定位参数不适用，整卷拷贝）。
   */
  async forkSession(sourceAgentSessionId?: string): Promise<string> {
    const source = this.agentSessionFile ?? sourceAgentSessionId;
    if (!source || !looksLikePiSessionPath(source) || !fs.existsSync(source)) {
      throw new Error('pi fork requires an existing native session file');
    }
    const target = path.join(
      path.dirname(source),
      `${path.basename(source, '.jsonl')}-fork-${randomUUID().slice(0, 8)}.jsonl`,
    );
    await fs.promises.copyFile(source, target);
    writeLog('[pi-task]', `fork COPIED to=${target}`);
    return target;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.state = 'disposed';
    this.startPromise = undefined;
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
    // resume 路径取最新已知会话文件（崩溃自动恢复时 config 里的还是旧值）。
    const spawnConfig: PiSessionConfig = {
      ...this.config,
      ...(this.agentSessionFile ? { agentSessionId: this.agentSessionFile } : {}),
    };
    const transport = this.options.transportFactory
      ? this.options.transportFactory(spawnConfig)
      : createDefaultPiTransport(spawnConfig);
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
      const transport = this.transport;
      void (transport
        ? this.readTurnUsageDelta(transport).catch(() => undefined)
        : Promise.resolve(undefined)
      ).then((usage) => {
        this.finishTurn(outcome, undefined, usage);
      });
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
    this.startPromise = undefined;
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

  private finishTurn(
    outcome: 'completed' | 'failed' | 'interrupted',
    reason?: string,
    usage?: PiTurnUsage,
  ): void {
    (this.options.emitEvent ?? emit)({
      type: 'turn_finished',
      outcome,
      ...(reason ? { reason } : {}),
      ...(usage ? { usage } : {}),
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

  /**
   * 读取会话用量快照。旧版 pi 缺 `get_session_stats` 时回退
   * `get_state.contextUsage`（仅上下文占用，无 token 数）。
   */
  private async readUsageSnapshot(transport: PiRpcProcess): Promise<PiUsageSnapshot | undefined> {
    try {
      const stats = await transport.request({ type: 'get_session_stats' });
      const tokens = readRecordField(stats, 'tokens');
      return {
        inputTokens: readNumberField(tokens, 'input') ?? 0,
        outputTokens: readNumberField(tokens, 'output') ?? 0,
        cachedInputTokens: readNumberField(tokens, 'cacheRead') ?? 0,
      };
    } catch {
      return undefined;
    }
  }

  /** turn 级用量 = 结束快照 - 起始快照（pi 的 stats 是会话累计值）。 */
  private async readTurnUsageDelta(transport: PiRpcProcess): Promise<PiTurnUsage | undefined> {
    const finalSnapshot = await this.readUsageSnapshot(transport);
    const baseline = this.usageBaseline;
    this.usageBaseline = finalSnapshot;
    if (!finalSnapshot) return undefined;
    if (!baseline) {
      return {
        input_tokens: finalSnapshot.inputTokens,
        output_tokens: finalSnapshot.outputTokens,
        cached_input_tokens: finalSnapshot.cachedInputTokens,
        reasoning_output_tokens: 0,
      };
    }
    return {
      input_tokens: Math.max(0, finalSnapshot.inputTokens - baseline.inputTokens),
      output_tokens: Math.max(0, finalSnapshot.outputTokens - baseline.outputTokens),
      cached_input_tokens: Math.max(0, finalSnapshot.cachedInputTokens - baseline.cachedInputTokens),
      reasoning_output_tokens: 0,
    };
  }
}

function readRecordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === 'object' && field !== null && !Array.isArray(field)) {
      return field as Record<string, unknown>;
    }
  }
  return undefined;
}

function readNumberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  if (config.thinkingLevel) {
    args.push('--thinking', config.thinkingLevel);
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
