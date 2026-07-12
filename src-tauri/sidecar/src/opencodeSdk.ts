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
  subscribe?(input: { cwd: string; onEvent: (event: unknown) => void; onError: (error: unknown) => void; onRetry?: (error: unknown) => void; onDisconnect?: (error: unknown) => void }): Promise<OpenCodeEventSubscription>;
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
}

export function buildOpenCodeServerConfig(input: OpenCodeServerConfigInput): Config {
  const options: NonNullable<NonNullable<Config['provider']>[string]['options']> = {};
  const adapter = resolveOpenCodeAdapter(input);
  const providerConfig: NonNullable<NonNullable<Config['provider']>[string]> = {
    models: {
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
    provider: {
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
    const server = await createOpencodeServer({
      hostname: '127.0.0.1',
      port: 0,
      config: buildOpenCodeServerConfig({ provider, model, apiKey, baseUrl, credentialSource }),
    });
    try {
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: cwd,
      });
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
          async prompt({ sessionId, prompt, inputPayload, images, provider, model }) {
            const parts = [
              { type: 'text' as const, text: inputPayload?.text ?? prompt },
              ...images.map((image) => ({
                type: 'file' as const,
                mime: image.mediaType,
                filename: image.name,
                url: image.dataUrl,
              })),
            ];
            readResponse(
              'OpenCode prompt',
              await client.session.prompt({
                path: { id: sessionId },
                query: { directory: cwd },
                body: {
                  model: { providerID: provider, modelID: model },
                  parts,
                },
              }),
            );
          },
          async subscribe({ cwd: sessionCwd, onEvent, onError, onRetry, onDisconnect }) {
            let closed = false;
            let nextEventId: string | undefined;
            const reportRetry = (error: unknown) => {
              if (!closed) onRetry?.(error);
            };
            const reportDisconnect = (error: unknown) => {
              if (!closed) (onDisconnect ?? onError)(error);
            };
            const result = await client.event.subscribe({
              query: { directory: sessionCwd },
              onSseError: reportRetry,
              onSseEvent: (event: { id?: string }) => {
                nextEventId = event.id;
              },
            });
            void (async () => {
              try {
                for await (const event of result.stream) {
                  if (!closed) {
                    const eventId = nextEventId;
                    nextEventId = undefined;
                    onEvent(eventId && typeof event === 'object' && event !== null ? { ...event, eventId } : event);
                  }
                }
                reportDisconnect(new Error('OpenCode SSE stream ended'));
              } catch (error) {
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
        },
      };
    } catch (error) {
      const failure = (error instanceof Error ? error : new Error(String(error))) as OpenCodeSdkStartFailure;
      failure.resources = { server };
      throw failure;
    }
  },
};

export function mapOpenCodeImages(payload?: AgentInputPayload): OpenCodeImageInput[] {
  return (payload?.images ?? []).map(toOpenCodeImage);
}
