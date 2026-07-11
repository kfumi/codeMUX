import { createOpencodeClient } from '@opencode-ai/sdk/client';
import { createOpencodeServer } from '@opencode-ai/sdk/server';
import type { AgentInputImage, AgentInputPayload } from './agentInputPayload.js';

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

export interface OpenCodePromptInput {
  sessionId: string;
  prompt: string;
  inputPayload?: AgentInputPayload;
  images: OpenCodeImageInput[];
  provider: string;
  model: string;
}

export interface OpenCodeClientPort {
  createSession(input: { cwd: string }): Promise<OpenCodeSessionHandle>;
  restoreSession(input: { cwd: string; sessionId: string }): Promise<OpenCodeSessionHandle>;
  prompt(input: OpenCodePromptInput): Promise<void>;
  abort(sessionId: string): Promise<boolean | void>;
}

export interface OpenCodeSdkPort {
  start(input: { cwd: string }): Promise<{
    server: OpenCodeServerHandle;
    client: OpenCodeClientPort;
  }>;
}

function readResponse<T>(operation: string, response: { data?: T; error?: unknown }): T {
  if (response.data !== undefined) {
    return response.data;
  }
  throw new Error(`${operation} failed${response.error ? `: ${String(response.error)}` : ''}`);
}

function toOpenCodeImage(image: AgentInputImage): OpenCodeImageInput {
  return {
    name: image.name,
    mediaType: image.mediaType,
    dataUrl: image.dataUrl,
  };
}

export const officialOpenCodeSdkPort: OpenCodeSdkPort = {
  async start({ cwd }) {
    const server = await createOpencodeServer({
      hostname: '127.0.0.1',
      port: 0,
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
          async abort(sessionId) {
            return readResponse(
              'OpenCode session interrupt',
              await client.session.abort({ path: { id: sessionId }, query: { directory: cwd } }),
            );
          },
        },
      };
    } catch (error) {
      await server.close();
      throw error;
    }
  },
};

export function mapOpenCodeImages(payload?: AgentInputPayload): OpenCodeImageInput[] {
  return (payload?.images ?? []).map(toOpenCodeImage);
}
