import { createOpencodeClient } from '@opencode-ai/sdk/client';
import type { Config } from '@opencode-ai/sdk';
import { createOpencodeServer } from '@opencode-ai/sdk/server';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOpenCodeExecutable } from './opencodeExecutable.js';
import type { AgentInputImage, AgentInputPayload } from './agentInputPayload.js';
import type { OpenCodeNativePermissionResponse } from './opencodePermissions.js';
import type { AgentPlanMode, SidecarPermissionConfig } from './agentPermissions.js';

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

export interface OpenCodeEventSubscription {
  close(): void | Promise<void>;
}

export interface OpenCodeClientPort {
  createSession(input: { cwd: string }): Promise<OpenCodeSessionHandle>;
  restoreSession(input: { cwd: string; sessionId: string }): Promise<OpenCodeSessionHandle>;
  prompt(input: OpenCodePromptInput): Promise<void>;
  abort(sessionId: string): Promise<boolean | void>;
  respondToPermission(input: { sessionId: string; requestId: string; response: OpenCodeNativePermissionResponse }): Promise<boolean | void>;
  respondToQuestion?(input: { requestId: string; answers: string[][]; directory?: string }): Promise<boolean | void>;
  subscribe?(input: { cwd: string; onEvent: (event: unknown) => void; onError: (error: unknown) => void; onRetry?: (error: unknown) => void; onDisconnect?: (error: unknown) => void }): Promise<OpenCodeEventSubscription>;
  switchAgent?(input: { sessionId: string; agent: string }): Promise<void>;
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
const SIDECAR_DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
export interface OpenCodeServerConfigInput {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  credentialSource: 'codemux' | 'environment' | 'opencode' | 'none';
  existingConfig?: Config;
}

export function buildOpenCodeServerConfig(input: OpenCodeServerConfigInput): Config {
  if (input.provider === 'opencode') {
    const { provider: existingProviders, ...rest } = input.existingConfig ?? {};
    const opencodeProvider = existingProviders?.opencode;
    return {
      ...rest,
      ...(opencodeProvider ? { provider: { opencode: opencodeProvider } } : {}),
      model: `opencode/${input.model}`,
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
function normalizeOpenCodeBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, '');
  for (const suffix of ['/chat/completions', '/responses', '/messages']) {
    if (normalized.toLowerCase().endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }
  return normalized.replace(/\/+$/, '');
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

export const officialOpenCodeSdkPort: OpenCodeSdkPort = {
  async start({ cwd, provider, model, apiKey, baseUrl, credentialSource, serverCloseTimeoutMs = DEFAULT_OPENCODE_SERVER_CLOSE_TIMEOUT_MS }) {
    prepareOpenCodeExecutable({ sidecarDir: SIDECAR_DIST_DIR });
    const existingConfig = await readNativeOpenCodeConfig();
    const server = await createOpencodeServer({
      hostname: '127.0.0.1',
      port: 0,
      config: buildOpenCodeServerConfig({ provider, model, apiKey, baseUrl, credentialSource, existingConfig }),
    });
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
          async switchAgent({ sessionId, agent }: { sessionId: string; agent: string }) {
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
                return;
              }
              process.stderr.write(`[opencode-task] switchAgent OK sessionId=${sessionId} agent=${agent}\n`);
            } catch (err) {
              process.stderr.write(`[opencode-task] switchAgent ERROR sessionId=${sessionId} agent=${agent} error=${err instanceof Error ? err.message : String(err)}\n`);
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
              process.stderr.write(`[opencode-debug] promptAsync response status=${'status' in sdkResponse ? sdkResponse.status : 'unknown'} hasError=${'error' in sdkResponse && sdkResponse.error !== undefined} raw=${JSON.stringify(sdkResponse).slice(0, 1000)}\n`);
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
            process.stderr.write(`[opencode-task] SDK promptAsync ACCEPTED sessionId=${sessionId}\n`);
          },
          async subscribe({ cwd: sessionCwd, onEvent, onError, onRetry, onDisconnect }) {
            let closed = false;
            let nextEventId: string | undefined;
            const reportRetry = (error: unknown) => {
              process.stderr.write(`[opencode-debug] SSE onSseError fired error=${error instanceof Error ? error.message : String(error).slice(0, 500)}\n`);
              if (!closed) onRetry?.(error);
            };
            const reportDisconnect = (error: unknown) => {
              process.stderr.write(`[opencode-debug] SSE disconnect fired error=${error instanceof Error ? error.message : String(error).slice(0, 500)}\n`);
              if (!closed) (onDisconnect ?? onError)(error);
            };
            const result = await client.event.subscribe({
              query: { directory: sessionCwd },
              onSseError: reportRetry,
              onSseEvent: (event: { id?: string }) => {
                nextEventId = event.id;
                if (event && typeof event === 'object') {
                  process.stderr.write(`[opencode-debug] SSE onSseEvent id=${(event as Record<string, unknown>).id ?? '(none)'} type=${(event as Record<string, unknown>).type ?? '(no type)'}\n`);
                }
              },
            });
            void (async () => {
              try {
                for await (const event of result.stream) {
                  if (!closed) {
                    const eventId = nextEventId;
                    nextEventId = undefined;
                    const eventStr = typeof event === 'string' ? event : (() => { try { return JSON.stringify(event).slice(0, 2000) } catch { return String(event) } })();
                    process.stderr.write(`[opencode-debug] RAW SSE event type=${typeof event === 'object' && event !== null ? (event as Record<string, unknown>).type ?? '(no type)' : typeof event} preview=${eventStr}\n`);
                    if (typeof event === 'object' && event !== null) {
                      const record = event as Record<string, unknown>;
                      if (record.type === 'session.error' || record.type === 'server.error' || record.type === 'server.retry' || record.type === 'server.disconnected' || record.type === 'disconnect' || record.type === 'connection.error') {
                        process.stderr.write(`[opencode-debug] RAW SSE ERROR EVENT full=${JSON.stringify(event)}\n`);
                      }
                      if (typeof record.properties === 'object' && record.properties !== null) {
                        const props = record.properties as Record<string, unknown>;
                        if (props.error) {
                          process.stderr.write(`[opencode-debug] SSE event has error property type=${record.type} error=${typeof props.error === 'object' ? JSON.stringify(props.error).slice(0, 1000) : String(props.error).slice(0, 1000)}\n`);
                        }
                      }
                    }
                    onEvent(eventId && typeof event === 'object' && event !== null ? { ...event, eventId } : event);
                  }
                }
                process.stderr.write(`[opencode-debug] SSE stream ended normally\n`);
                reportDisconnect(new Error('OpenCode SSE stream ended'));
              } catch (error) {
                process.stderr.write(`[opencode-debug] SSE stream threw error=${error instanceof Error ? error.message : String(error)} stack=${error instanceof Error ? error.stack?.slice(0, 500) : 'n/a'}\n`);
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
