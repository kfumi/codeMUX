import type { Config } from '@opencode-ai/sdk';
import type { PiMcpServers } from './piMcp.js';
import * as path from 'node:path';
import { prepareOpenCodeExecutable } from './opencodeExecutable.js';
import type { AgentInputImage, AgentInputPayload } from './agentInputPayload.js';
import type { OpenCodeNativePermissionResponse } from './opencodePermissions.js';
import type { AgentPlanMode, SidecarPermissionConfig } from './agentPermissions.js';
import { loadProviderRuntime, isRuntimeError, type RuntimeLoadResult } from './runtimeLoader.js';
import { loadOpenCodeClientSdk, loadOpenCodeServerSdk } from './sdkLoader.js';
import type { ProviderRuntimeRef } from './runtimeContract.js';
import { DEBUG_OPENCODE_EVENTS } from './writeLog.js';

export interface OpenCodeServerHandle {
  close(): void | Promise<void>;
}

export interface OpenCodeSessionHandle {
  id: string;
}

export interface OpenCodeImageInput {
  name: string;
  mediaType: string;
  dataUrl: string;
}

export interface OpenCodePermissionUpdate {
  permissionConfig?: SidecarPermissionConfig;
  planMode?: AgentPlanMode;
}

export interface OpenCodePromptInput {
  sessionId: string;
  prompt: string;
  inputPayload?: AgentInputPayload;
  images: OpenCodeImageInput[];
  provider: string;
  model: string;
  agent?: string;
}

export interface OpenCodeCompactInput {
  cwd: string;
  sessionId: string;
  provider: string;
  model: string;
}

export interface OpenCodeEventSubscription {
  close(): void | Promise<void>;
}

export interface OpenCodeClientPort {
  createSession(input: { cwd: string }): Promise<OpenCodeSessionHandle>;
  restoreSession(input: { cwd: string; sessionId: string }): Promise<OpenCodeSessionHandle>;
  forkSession(input: { cwd: string; sessionId: string; messageId?: string }): Promise<OpenCodeSessionHandle>;
  deleteSession(input: { cwd?: string; sessionId: string }): Promise<void>;
  prompt(input: OpenCodePromptInput): Promise<void>;
  compactSession?(input: OpenCodeCompactInput): Promise<void>;
  abort(sessionId: string): Promise<boolean | void>;
  /** 会话内回退:opencode 在 session 记录上打 revert 标记(从 messageID 起隐藏)。 */
  revertSession(input: { sessionId: string; messageId: string }): Promise<void>;
  /**
   * opencode server 侧的会话运行状态:'busy' 表示仍有 runner 在跑(或收尾中),
   * 'idle'/'unknown' 表示可以安全做 rewind 之类的 runner-affecting 操作。
   * 空闲会话不会出现在 status 表里,查不到即视为 idle。
   */
  sessionStatus?(input: { sessionId: string }): Promise<'busy' | 'idle'>;
  respondToPermission(input: { sessionId: string; requestId: string; response: OpenCodeNativePermissionResponse }): Promise<boolean | void>;
  respondToQuestion?(input: { requestId: string; answers: string[][]; directory?: string }): Promise<boolean | void>;
  subscribe?(input: { cwd: string; onEvent: (event: unknown) => void; onError: (error: unknown) => void; onRetry?: (error: unknown) => void; onDisconnect?: (error: unknown) => void }): Promise<OpenCodeEventSubscription>;
  /** true = 原生会话已切到该 agent（HTTP 2xx）；false = 失败（已记日志），调用方需自行兜底。 */
  switchAgent?(input: { sessionId: string; agent: string }): Promise<boolean>;
}

export interface OpenCodeSdkStartResources {
  server?: OpenCodeServerHandle;
  client?: OpenCodeClientPort;
}

export interface OpenCodeSdkStartFailure extends Error {
  resources?: OpenCodeSdkStartResources;
}

export interface OpenCodeSdkReadyResources {
  server: OpenCodeServerHandle;
  client: OpenCodeClientPort;
}

export interface OpenCodeSdkStartInput {
  cwd: string;
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  credentialSource: 'codemux' | 'environment' | 'opencode' | 'none';
  serverCloseTimeoutMs?: number;
  /**
   * 等待 `opencode serve` 打印 "server listening" 的上限。SDK 默认仅 5000ms，
   * 而 opencode.exe 体积很大，冷启动/磁盘繁忙时经常超过，必须放宽。
   */
  serverStartTimeoutMs?: number;
  /** 外部托管 Runtime 引用。 */
  runtimeRef?: ProviderRuntimeRef;
  /** daemon 随会话下发的 MCP 服务器(落 server config 的 mcp 段)。 */
  mcpServers?: PiMcpServers;
  modelLimits?: {
    contextWindow?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    inputModalities?: string[];
  };
}

export function normalizeOpenCodeModelReference(model: string): { provider: string; model: string } {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    return { provider: 'openai', model };
  }
  return { provider: model.slice(0, separator), model: model.slice(separator + 1) };
}

export interface OpenCodeSdkPort {
  start(input: OpenCodeSdkStartInput): Promise<OpenCodeSdkReadyResources>;
}

export const DEFAULT_OPENCODE_SERVER_CLOSE_TIMEOUT_MS = 10_000;
/**
 * `opencode serve` 启动等待上限。SDK 的默认值是 5000ms，但托管 Runtime 的
 * `opencode.exe` 有上百 MB，进程冷启动或机器繁忙时经常超过 5s，导致
 * ensure_session 直接判超时。放宽到 60s，足够覆盖冷启动。
 */
export const DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS = 60_000;
const DEFAULT_OPENCODE_OUTPUT_TOKENS = 65_536;
export interface OpenCodeServerConfigInput {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  credentialSource: 'codemux' | 'environment' | 'opencode' | 'none';
  existingConfig?: Config;
  /** daemon 随会话下发的 MCP 服务器(stdio,覆盖同名用户配置)。 */
  mcpServers?: PiMcpServers;
  modelLimits?: {
    contextWindow?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    inputModalities?: string[];
  };
}

/** CodeMUX MCP spec → opencode `mcp` 段(local stdio server)。 */
export function toOpenCodeMcpConfig(servers: PiMcpServers): Record<string, unknown> {
  const mcp: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (typeof spec.command !== 'string' || !spec.command.trim()) continue;
    mcp[name] = {
      type: 'local',
      command: [spec.command, ...(Array.isArray(spec.args) ? spec.args : [])],
      ...(spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env)
        ? { environment: spec.env }
        : {}),
      enabled: true,
    };
  }
  return mcp;
}

export function buildOpenCodeServerConfig(input: OpenCodeServerConfigInput): Config {
  const sessionMcp = input.mcpServers && Object.keys(input.mcpServers).length > 0
    ? toOpenCodeMcpConfig(input.mcpServers)
    : undefined;
  if (input.provider === 'opencode') {
    const { provider: existingProviders, ...rest } = input.existingConfig ?? {};
    const opencodeProvider = existingProviders?.opencode;
    return {
      ...rest,
      ...(opencodeProvider ? { provider: { opencode: opencodeProvider } } : {}),
      model: `opencode/${input.model}`,
      ...(sessionMcp ? { mcp: { ...((rest as { mcp?: Record<string, unknown> }).mcp ?? {}), ...sessionMcp } } : {}),
    };
  }

  const options: NonNullable<NonNullable<Config['provider']>[string]['options']> = {};
  const adapter = resolveOpenCodeAdapter(input);
  const existingProvider = input.existingConfig?.provider?.[input.provider];
  const providerConfig: NonNullable<NonNullable<Config['provider']>[string]> = {
    ...(existingProvider ?? {}),
    models: {
      ...(existingProvider?.models ?? {}),
      [input.model]: {
        id: input.model,
        name: input.model,
        ...buildOpenCodeModelLimit(input.modelLimits),
        ...buildOpenCodeModelModalities(input.modelLimits),
      },
    },
    ...(adapter ? { npm: adapter, name: adapter === '@ai-sdk/openai-compatible' ? 'CodeMUX OpenAI-compatible' : 'CodeMUX Anthropic' } : {}),
  };
  if (input.credentialSource === 'codemux' && input.apiKey) {
    options.apiKey = input.apiKey;
  }
  if (input.baseUrl) {
    options.baseURL = normalizeOpenCodeBaseUrl(input.baseUrl);
  }
  if (Object.keys(options).length > 0) {
    providerConfig.options = options;
  }
  return {
    ...input.existingConfig,
    provider: {
      ...input.existingConfig?.provider,
      [input.provider]: providerConfig,
    },
    ...(sessionMcp
      ? { mcp: { ...(input.existingConfig?.mcp ?? {}), ...sessionMcp } }
      : {}),
  };
}

function resolveOpenCodeAdapter(input: OpenCodeServerConfigInput): '@ai-sdk/openai-compatible' | '@ai-sdk/anthropic' | undefined {
  if (!input.baseUrl) {
    return undefined;
  }
  if (input.provider === 'codemux-anthropic') {
    return '@ai-sdk/anthropic';
  }
  if (input.provider !== 'codemux-openai') {
    return undefined;
  }
  return '@ai-sdk/openai-compatible';
}

function buildOpenCodeModelLimit(modelLimits: OpenCodeServerConfigInput['modelLimits']): {
  limit?: { context?: number; input?: number; output?: number };
} {
  if (!modelLimits) {
    return {};
  }
  const limit: { context?: number; input?: number; output?: number } = {};
  if (typeof modelLimits.contextWindow === 'number' && modelLimits.contextWindow > 0) {
    limit.context = Math.floor(modelLimits.contextWindow);
  }
  if (typeof modelLimits.maxInputTokens === 'number' && modelLimits.maxInputTokens > 0) {
    limit.input = Math.floor(modelLimits.maxInputTokens);
  }
  if (typeof modelLimits.maxOutputTokens === 'number' && modelLimits.maxOutputTokens > 0) {
    limit.output = Math.floor(modelLimits.maxOutputTokens);
  }
  if (Object.keys(limit).length > 0 && limit.output === undefined) {
    limit.output = DEFAULT_OPENCODE_OUTPUT_TOKENS;
  }
  return Object.keys(limit).length > 0 ? { limit } : {};
}

const OPENCODE_INPUT_MODALITIES = new Set(['text', 'audio', 'image', 'video', 'pdf']);

export function buildOpenCodeModelModalities(modelLimits: OpenCodeServerConfigInput['modelLimits']): {
  modalities?: { input: string[]; output: string[] };
} {
  const input: string[] = [];
  for (const modality of modelLimits?.inputModalities ?? []) {
    const normalized = modality.trim().toLowerCase();
    if (normalized && OPENCODE_INPUT_MODALITIES.has(normalized) && !input.includes(normalized)) {
      input.push(normalized);
    }
  }
  if (input.length === 0) {
    return {};
  }
  if (!input.includes('text')) {
    input.unshift('text');
  }
  return { modalities: { input, output: ['text'] } };
}
function normalizeOpenCodeBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, '');
  let lowerCase = normalized.toLowerCase();
  for (const suffix of ['/chat/completions', '/responses', '/messages']) {
    if (lowerCase.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      lowerCase = normalized.toLowerCase();
      break;
    }
  }
  normalized = normalized.replace(/\/+$/, '');

  // OpenAI-compatible SDK adapters append `/chat/completions` to baseURL.
  // Match the Codex compatibility proxy by supplying `/v1` for an unversioned
  // API root, while preserving gateways that already use paths such as `/v4`.
  if (!hasApiVersionPath(normalized)) {
    normalized = `${normalized}/v1`;
  }
  return normalized;
}

function hasApiVersionPath(baseUrl: string): boolean {
  try {
    const pathname = new URL(baseUrl).pathname.replace(/\/+$/, '');
    const lastSegment = pathname.split('/').filter(Boolean).at(-1) ?? '';
    return /^v\d+[a-z0-9-]*$/i.test(lastSegment);
  } catch {
    return /\/v\d+[a-z0-9-]*$/i.test(baseUrl);
  }
}
const pendingServerClosePromises = new WeakMap<OpenCodeServerHandle, Promise<void>>();

export function closeOpenCodeServerWithTimeout(
  server: OpenCodeServerHandle,
  timeoutMs: number = DEFAULT_OPENCODE_SERVER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  let closePromise = pendingServerClosePromises.get(server);
  if (!closePromise) {
    const rawClosePromise = Promise.resolve().then(() => server.close());
    let trackedClosePromise: Promise<void>;
    trackedClosePromise = rawClosePromise.catch((error) => {
      if (pendingServerClosePromises.get(server) === trackedClosePromise) {
        pendingServerClosePromises.delete(server);
      }
      throw error;
    });
    closePromise = trackedClosePromise;
    pendingServerClosePromises.set(server, trackedClosePromise);
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('OpenCode server close timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
  });

  return Promise.race([closePromise, timeout])
    .catch((error) => {
      if (pendingServerClosePromises.get(server) === closePromise) {
        pendingServerClosePromises.delete(server);
      }
      throw error;
    })
    .finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    });
}

function readResponse<T>(operation: string, response: { data?: T; error?: unknown }): T {
  if (response.data !== undefined) {
    return response.data;
  }
  throw new Error(`${operation} failed${response.error ? `: ${formatSdkError(response.error)}` : ''}`);
}

async function resolveForkBoundaryMessageId(
  client: { session: { messages: (input: unknown) => Promise<{ data?: unknown[]; error?: unknown }> } },
  cwd: string,
  sessionId: string,
  targetMessageId: string,
): Promise<string | undefined> {
  const messages = readResponse<unknown[]>(
    `OpenCode session messages for "${sessionId}"`,
    await client.session.messages({
      path: { id: sessionId },
      query: { directory: cwd },
    }),
  );
  const targetIndex = messages.findIndex((message) => {
    if (typeof message !== 'object' || message === null) return false;
    const info = (message as { info?: unknown }).info;
    return typeof info === 'object'
      && info !== null
      && (info as { id?: unknown }).id === targetMessageId;
  });
  if (targetIndex < 0) {
    throw new Error(`OpenCode Fork target message "${targetMessageId}" was not found`);
  }

  const nextMessage = messages[targetIndex + 1];
  if (typeof nextMessage !== 'object' || nextMessage === null) {
    return undefined;
  }
  const info = (nextMessage as { info?: unknown }).info;
  const nextMessageId = typeof info === 'object' && info !== null
    ? (info as { id?: unknown }).id
    : undefined;
  return typeof nextMessageId === 'string' && nextMessageId.length > 0
    ? nextMessageId
    : undefined;
}

function isNotFoundResponse(response: { error?: unknown; response?: { status?: number } }): boolean {
  if (response.response?.status === 404) return true;
  const error = response.error;
  if (typeof error !== 'object' || error === null) {
    const message = String(error ?? '').toLowerCase();
    return message.includes('404') || message.includes('not found');
  }
  const record = error as Record<string, unknown>;
  const message = JSON.stringify(error).toLowerCase();
  return record.status === 404 || record.statusCode === 404 || message.includes('404') || message.includes('not found');
}

async function deleteWithOfficialOpenCodeSdk(input: { cwd?: string; sessionId: string; runtimeRef: ProviderRuntimeRef }): Promise<void> {
  const cwd = input.cwd?.trim() || process.cwd();
  const resources = await officialOpenCodeSdkPort.start({
    cwd,
    provider: 'opencode',
    model: 'default',
    credentialSource: 'opencode',
    runtimeRef: input.runtimeRef,
  });
  let operationError: unknown;
  try {
    await resources.client.deleteSession(input);
  } catch (error) {
    operationError = error;
  }
  try {
    await closeOpenCodeServerWithTimeout(resources.server);
  } catch (closeError) {
    if (!operationError) operationError = closeError;
  }
  if (operationError) throw operationError;
}

export async function deleteOpenCodeSessionWithOfficialSdk(input: { cwd?: string; sessionId: string; runtimeRef: ProviderRuntimeRef }): Promise<void> {
  return deleteWithOfficialOpenCodeSdk(input);
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function toOpenCodeImage(image: AgentInputImage): OpenCodeImageInput {
  return {
    name: image.name,
    mediaType: image.mediaType,
    dataUrl: image.dataUrl,
  };
}

/**
 * 从 runtimeRef 加载 Provider Runtime。
 */
function loadRuntime(runtimeRef?: ProviderRuntimeRef): RuntimeLoadResult {
  if (!runtimeRef) {
    throw new Error('OpenCode Runtime is required before starting a session');
  }
  const result = loadProviderRuntime(runtimeRef);
  if (isRuntimeError(result)) {
    throw new Error(`OpenCode Runtime 加载失败: ${result.message}`);
  }
  return result;
}

export const officialOpenCodeSdkPort: OpenCodeSdkPort = {
  async start({ cwd, provider, model, apiKey, baseUrl, credentialSource, serverCloseTimeoutMs = DEFAULT_OPENCODE_SERVER_CLOSE_TIMEOUT_MS, serverStartTimeoutMs = DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS, runtimeRef, mcpServers, modelLimits }) {
    const perfStartedAt = Date.now();
    const runtimeLoaded = loadRuntime(runtimeRef);
    const executable = prepareOpenCodeExecutable({ runtimePath: runtimeLoaded.ref.runtimePath });
    const cliPath = executable?.executablePath ?? '(托管 Runtime CLI 路径未解析)';
    process.stderr.write(
      `[runtime] provider=opencode cli=${cliPath} runtime=${runtimeLoaded.ref.runtimePath} version=${runtimeLoaded.ref.runtimeVersion} node=${process.execPath}\n`,
    );

    // 仅从 CodeMUX 托管 Runtime 动态加载 OpenCode SDK。
    const { createOpencodeServer } = await loadOpenCodeServerSdk(runtimeLoaded);
    const { createOpencodeClient } = await loadOpenCodeClientSdk(runtimeLoaded);
    process.stderr.write(`[opencode-task] [perf] opencode sdk modules loaded elapsed_ms=${Date.now() - perfStartedAt}\n`);

    const existingConfig = await readNativeOpenCodeConfig();
    const serverConfig = buildOpenCodeServerConfig({
      provider,
      model,
      apiKey,
      baseUrl,
      credentialSource,
      existingConfig,
      mcpServers,
      modelLimits,
    });
    const serverBootStartedAt = Date.now();
    const server = await createOpencodeServer({
      hostname: '127.0.0.1',
      port: 0,
      config: serverConfig,
      timeout: serverStartTimeoutMs,
    });
    process.stderr.write(`[opencode-task] [perf] opencode serve booted elapsed_ms=${Date.now() - serverBootStartedAt}\n`);
    try {
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: cwd,
      });
      const serverBaseUrl = server.url;
      return {
        server,
        client: {
          async createSession({ cwd: sessionCwd }) {
            return readResponse(
              'OpenCode session creation',
              await client.session.create({ query: { directory: sessionCwd } }),
            );
          },
          async restoreSession({ cwd: sessionCwd, sessionId }) {
            return readResponse(
              `OpenCode session restoration for "${sessionId}"`,
              await client.session.get({ path: { id: sessionId }, query: { directory: sessionCwd } }),
            );
          },
          async forkSession({ cwd: sessionCwd, sessionId, messageId }) {
            const boundaryMessageId = messageId
              ? await resolveForkBoundaryMessageId(client, sessionCwd, sessionId, messageId)
              : undefined;
            return readResponse(
              `OpenCode session fork for "${sessionId}"`,
              await client.session.fork({
                path: { id: sessionId },
                query: { directory: sessionCwd },
                ...(boundaryMessageId ? { body: { messageID: boundaryMessageId } } : {}),
              }),
            );
          },
          async deleteSession({ cwd: sessionCwd, sessionId }) {
            const response = await client.session.delete({
              path: { id: sessionId },
              ...(sessionCwd ? { query: { directory: sessionCwd } } : {}),
            });
            if (response.data === true || isNotFoundResponse(response)) return;
            throw new Error(`OpenCode session deletion failed${response.error ? `: ${formatSdkError(response.error)}` : ''}`);
          },
          async switchAgent({ sessionId, agent }: { sessionId: string; agent: string }) {
            const switchAgentStartedAt = Date.now();
            process.stderr.write(`[opencode-task] switchAgent CALL sessionId=${sessionId} agent=${agent}\n`);
            try {
              const res = await fetch(`${serverBaseUrl.replace(/\/+$/, '')}/api/session/${encodeURIComponent(sessionId)}/agent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent }),
                signal: AbortSignal.timeout(10_000),
              });
              if (!res.ok) {
                const text = await res.text().catch(() => `HTTP ${res.status}`);
                process.stderr.write(`[opencode-task] switchAgent FAILED sessionId=${sessionId} agent=${agent} status=${res.status} body=${text.slice(0, 500)}\n`);
                return false;
              }
              process.stderr.write(`[opencode-task] switchAgent OK sessionId=${sessionId} agent=${agent} elapsed_ms=${Date.now() - switchAgentStartedAt}\n`);
              return true;
            } catch (err) {
              process.stderr.write(`[opencode-task] switchAgent ERROR sessionId=${sessionId} agent=${agent} error=${err instanceof Error ? err.message : String(err)}\n`);
              return false;
            }
          },
          async prompt({ sessionId, prompt, inputPayload, images, provider, model, agent }) {
            const parts = [
              { type: 'text' as const, text: inputPayload?.text ?? prompt },
              ...images.map((image) => ({
                type: 'file' as const,
                mime: image.mediaType,
                filename: image.name,
                url: image.dataUrl,
              })),
            ];
            const promptStartedAt = Date.now();
            process.stderr.write(`[opencode-task] SDK promptAsync CALL sessionId=${sessionId} model=${provider}/${model} agent=${agent ?? 'default'} prompt_len=${(inputPayload?.text ?? prompt).length} parts=${parts.length}\n`);
            try {
              const sdkResponse = await client.session.promptAsync({
                path: { id: sessionId },
                query: { directory: cwd },
                body: {
                  model: { providerID: provider, modelID: model },
                  ...(agent ? { agent } : {}),
                  parts,
                },
              });
              if (DEBUG_OPENCODE_EVENTS) {
                process.stderr.write(`[opencode-debug] promptAsync response status=${'status' in sdkResponse ? sdkResponse.status : 'unknown'} hasError=${'error' in sdkResponse && sdkResponse.error !== undefined} raw=${JSON.stringify(sdkResponse).slice(0, 1000)}\n`);
              }
              if ('error' in sdkResponse && sdkResponse.error !== undefined) {
                readResponse('OpenCode promptAsync', sdkResponse);
              }
            } catch (err) {
              const errMsg = err instanceof TypeError ? err.message : String(err);
              const errStack = err instanceof Error ? err.stack : '';
              process.stderr.write(`[opencode-task] SDK promptAsync THREW sessionId=${sessionId} error=${errMsg}\n`);
              process.stderr.write(`[opencode-task] SDK promptAsync STACK: ${errStack}\n`);
              if (err instanceof TypeError) {
                try {
                  const pingUrl = serverBaseUrl ? serverBaseUrl.replace(/\/+$/, '') + '/config' : 'http://127.0.0.1:1';
                  const ping = await fetch(pingUrl, { signal: AbortSignal.timeout(2000) });
                  process.stderr.write(`[opencode-task] Server ALIVE (base=${serverBaseUrl} status=${ping.status})\n`);
                } catch (pingErr) {
                  process.stderr.write(`[opencode-task] Server DEAD (base=${serverBaseUrl}): ${pingErr instanceof Error ? pingErr.message : String(pingErr)}\n`);
                }
              }
              throw new Error(`[opencode-task] SDK promptAsync failed: ${errMsg}${errStack ? `\n${errStack}` : ''}`);
            }
            process.stderr.write(`[opencode-task] SDK promptAsync ACCEPTED sessionId=${sessionId} elapsed_ms=${Date.now() - promptStartedAt}\n`);
          },
          async compactSession({ cwd: sessionCwd, sessionId, provider: providerId, model: modelId }) {
            const sessionApi = client.session as unknown as {
              compact?: (input: unknown) => Promise<{ data?: unknown; error?: unknown }>;
              summarize?: (input: unknown) => Promise<{ data?: unknown; error?: unknown }>;
            };
            const input = {
              path: { id: sessionId },
              query: { directory: sessionCwd },
            };
            const response = typeof sessionApi.compact === 'function'
              ? await sessionApi.compact({ ...input, body: {} })
              : typeof sessionApi.summarize === 'function'
                ? await sessionApi.summarize({
                  ...input,
                  body: { providerID: providerId, modelID: modelId, auto: false },
                })
                : undefined;

            if (!response) {
              throw new Error('OpenCode SDK does not expose a native session compaction endpoint');
            }
            if (response.error !== undefined) {
              throw new Error(`OpenCode session compaction failed: ${formatSdkError(response.error)}`);
            }
            process.stderr.write(
              `[opencode-task] native session compaction admitted sessionId=${sessionId} endpoint=${typeof sessionApi.compact === 'function' ? 'compact' : 'summarize'}\n`,
            );
          },
          async subscribe({ cwd: sessionCwd, onEvent, onError, onRetry, onDisconnect }) {
            let closed = false;
            let nextEventId: string | undefined;
            const reportRetry = (error: unknown) => {
              if (DEBUG_OPENCODE_EVENTS) {
                process.stderr.write(`[opencode-debug] SSE onSseError fired error=${error instanceof Error ? error.message : String(error).slice(0, 500)}\n`);
              }
              if (!closed) onRetry?.(error);
            };
            const reportDisconnect = (error: unknown) => {
              if (DEBUG_OPENCODE_EVENTS) {
                process.stderr.write(`[opencode-debug] SSE disconnect fired error=${error instanceof Error ? error.message : String(error).slice(0, 500)}\n`);
              }
              if (!closed) (onDisconnect ?? onError)(error);
            };
            const result = await client.event.subscribe({
              query: { directory: sessionCwd },
              onSseError: reportRetry,
              onSseEvent: (event: { id?: string }) => {
                nextEventId = event.id;
                if (DEBUG_OPENCODE_EVENTS) {
                  const eventType = (event as Record<string, unknown>)?.type;
                  if (typeof eventType === 'string') {
                    process.stderr.write(`[opencode-debug] SSE onSseEvent id=${event.id ?? '(none)'} type=${eventType}\n`);
                  }
                }
              },
            });
            void (async () => {
              try {
                for await (const event of result.stream) {
                  if (!closed) {
                    const eventId = nextEventId;
                    nextEventId = undefined;
                    const eventType = typeof event === 'object' && event !== null
                      ? (event as Record<string, unknown>).type
                      : undefined;
                    if (DEBUG_OPENCODE_EVENTS && eventType !== 'server.heartbeat') {
                      const eventStr = typeof event === 'string' ? event : (() => { try { return JSON.stringify(event).slice(0, 2000) } catch { return String(event) } })();
                      process.stderr.write(`[opencode-debug] RAW SSE event type=${typeof event === 'object' && event !== null ? eventType ?? '(no type)' : typeof event} preview=${eventStr}\n`);
                    }
                    if (eventType !== 'server.heartbeat' && typeof event === 'object' && event !== null) {
                      const record = event as Record<string, unknown>;
                      if (DEBUG_OPENCODE_EVENTS && (record.type === 'session.error' || record.type === 'server.error' || record.type === 'server.retry' || record.type === 'server.disconnected' || record.type === 'disconnect' || record.type === 'connection.error')) {
                        process.stderr.write(`[opencode-debug] RAW SSE ERROR EVENT full=${JSON.stringify(event)}\n`);
                      }
                      if (DEBUG_OPENCODE_EVENTS && typeof record.properties === 'object' && record.properties !== null) {
                        const props = record.properties as Record<string, unknown>;
                        if (props.error) {
                          process.stderr.write(`[opencode-debug] SSE event has error property type=${record.type} error=${typeof props.error === 'object' ? JSON.stringify(props.error).slice(0, 1000) : String(props.error).slice(0, 1000)}\n`);
                        }
                      }
                    }
                    onEvent(eventId && typeof event === 'object' && event !== null ? { ...event, eventId } : event);
                  }
                }
                if (DEBUG_OPENCODE_EVENTS) {
                  process.stderr.write(`[opencode-debug] SSE stream ended normally\n`);
                }
                reportDisconnect(new Error('OpenCode SSE stream ended'));
              } catch (error) {
                if (DEBUG_OPENCODE_EVENTS) {
                  process.stderr.write(`[opencode-debug] SSE stream threw error=${error instanceof Error ? error.message : String(error)} stack=${error instanceof Error ? error.stack?.slice(0, 500) : 'n/a'}\n`);
                }
                reportDisconnect(error);
              }
            })();
            return {
              async close() {
                closed = true;
                await result.stream.return(undefined);
              },
            };
          },
          async abort(sessionId) {
            return readResponse(
              'OpenCode session interrupt',
              await client.session.abort({ path: { id: sessionId }, query: { directory: cwd } }),
            );
          },
          async revertSession({ sessionId, messageId }) {
            return readResponse(
              'OpenCode session revert',
              await client.session.revert({
                path: { id: sessionId },
                query: { directory: cwd },
                body: { messageID: messageId },
              }),
            );
          },
          async sessionStatus({ sessionId }) {
            try {
              const response = await client.session.status({ query: { directory: cwd } });
              const statuses = (response.data ?? {}) as Record<string, { type?: unknown }>;
              const entry = statuses[sessionId];
              const statusType =
                entry && typeof entry === 'object' ? String((entry as { type?: unknown }).type ?? '') : '';
              return statusType === 'busy' || statusType === 'retry' ? 'busy' : 'idle';
            } catch {
              // 状态查询失败不作为 busy 证据(可能 server 正在重启);让调用方
              // 的后续操作自己面对真实错误。
              return 'idle';
            }
          },
          async respondToPermission({ sessionId, requestId, response }) {
            return readResponse(
              'OpenCode permission response',
              await client.postSessionIdPermissionsPermissionId({
                path: { id: sessionId, permissionID: requestId },
                query: { directory: cwd },
                body: { response },
              }),
            );
          },
          async respondToQuestion({ requestId, answers, directory }) {
            const normalized = Array.isArray(answers)
              ? answers.map((a) => (Array.isArray(a) ? a : [String(a)]))
              : [];
            const params = new URLSearchParams({ directory: directory ?? cwd });
            const url = `${serverBaseUrl.replace(/\/+$/, '')}/question/${encodeURIComponent(requestId)}/reply?${params}`;
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ answers: normalized }),
            });
            if (!res.ok) {
              throw new Error(`OpenCode question reply failed: ${res.status} ${res.statusText}`);
            }
          },
        },
      };
    } catch (error) {
      const failure = (error instanceof Error ? error : new Error(String(error))) as OpenCodeSdkStartFailure;
      failure.resources = { server };
      throw failure;
    }
  },
};

async function readNativeOpenCodeConfig(): Promise<Config | undefined> {
  const configPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.config', 'opencode', 'opencode.json');
  if (!configPath || configPath.startsWith('.config')) return undefined;
  try {
    const fs = await import('node:fs/promises');
    return JSON.parse(await fs.readFile(configPath, 'utf8')) as Config;
  } catch {
    return undefined;
  }
}

export function mapOpenCodeImages(payload?: AgentInputPayload): OpenCodeImageInput[] {
  return (payload?.images ?? []).map(toOpenCodeImage);
}
