import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  CodexChatHistory,
  buildResponsesSseEvents,
  convertChatCompletionToResponses,
  convertResponsesToChatRequest,
} from './codexChatCompat.js';

type ProxyConfig = {
  apiKey: string;
  baseUrl: string;
};

export type ProxyServerHandle = {
  baseUrl: string;
  close: () => Promise<void>;
};

export async function createCodexCompatProxyServer(config: ProxyConfig): Promise<ProxyServerHandle> {
  const history = new CodexChatHistory();
  const server = createServer(async (req, res) => {
    try {
      debugLog(`${req.method ?? 'UNKNOWN'} ${req.url ?? '/'}`);
      await handleRequest(req, res, config, history);
    } catch (error) {
      debugLog(`error ${req.method ?? 'UNKNOWN'} ${req.url ?? '/'}: ${error instanceof Error ? error.message : String(error)}`);
      writeJson(res, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'proxy_error',
          code: 500,
        },
      });
    }
  });

  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const currentAddress = server.address();
      if (!currentAddress || typeof currentAddress === 'string') {
        reject(new Error('Codex proxy server did not expose a TCP port.'));
        return;
      }
      resolve({ port: currentAddress.port });
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  history: CodexChatHistory,
): Promise<void> {
  if (req.method === 'GET' && isModelsPath(req.url ?? '/')) {
    const models = await fetchModels(config);
    writeJson(res, 200, models);
    return;
  }

  if (req.method !== 'POST' || !isResponsesPath(req.url ?? '/')) {
    writeJson(res, 404, {
      error: {
        message: `Unsupported Codex proxy route: ${req.method ?? 'UNKNOWN'} ${req.url ?? '/'}`,
        type: 'proxy_error',
        code: 404,
      },
    });
    return;
  }

  const requestBody = await readJsonBody(req) as Parameters<typeof convertResponsesToChatRequest>[0];
  const chatRequest = convertResponsesToChatRequest(requestBody, history);
  const completion = await fetchChatCompletion(chatRequest, config);
  const compatResponse = convertChatCompletionToResponses(completion, requestBody, history);

  if (requestBody.stream) {
    writeSse(res, buildResponsesSseEvents(compatResponse));
    return;
  }

  writeJson(res, 200, compatResponse);
}

async function fetchChatCompletion(
  requestBody: ReturnType<typeof convertResponsesToChatRequest>,
  config: ProxyConfig,
): Promise<Parameters<typeof convertChatCompletionToResponses>[0]> {
  let lastError: Error | null = null;

  for (const endpoint of buildChatCompletionEndpoints(config.baseUrl)) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...requestBody,
        stream: false,
      }),
    });

    if (response.status === 404) {
      lastError = new Error(`upstream endpoint not found: ${endpoint}`);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`unexpected status ${response.status} from ${endpoint}: ${body}`);
    }

    return response.json() as Promise<Parameters<typeof convertChatCompletionToResponses>[0]>;
  }

  throw lastError ?? new Error('No upstream chat completions endpoint succeeded.');
}

async function fetchModels(config: ProxyConfig): Promise<unknown> {
  let lastError: Error | null = null;

  for (const endpoint of buildModelEndpoints(config.baseUrl)) {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });

    if (response.status === 404 || response.status === 405) {
      lastError = new Error(`upstream models endpoint not found: ${endpoint}`);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`unexpected status ${response.status} from ${endpoint}: ${body}`);
    }

    return response.json();
  }

  throw lastError ?? new Error('No upstream models endpoint succeeded.');
}

function buildChatCompletionEndpoints(baseUrl: string): string[] {
  const normalized = stripTrailingSlash(baseUrl);
  if (normalized.endsWith('/v1/chat/completions') || normalized.endsWith('/chat/completions')) {
    return [normalized];
  }
  if (normalized.endsWith('/v1')) {
    return [`${normalized}/chat/completions`];
  }

  return [
    `${normalized}/v1/chat/completions`,
    `${normalized}/chat/completions`,
  ];
}

function buildModelEndpoints(baseUrl: string): string[] {
  const normalized = stripTrailingSlash(baseUrl);
  if (normalized.endsWith('/v1/models') || normalized.endsWith('/models')) {
    return [normalized];
  }
  if (normalized.endsWith('/v1')) {
    return [`${normalized}/models`];
  }

  return [
    `${normalized}/v1/models`,
    `${normalized}/models`,
  ];
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isResponsesPath(rawUrl: string): boolean {
  const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname.replace(/\/+$/, '');
  return pathname === '/responses' || pathname === '/v1/responses' || pathname === '/codex/responses';
}

function isModelsPath(rawUrl: string): boolean {
  const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname.replace(/\/+$/, '');
  return pathname === '/models' || pathname === '/v1/models';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function writeSse(res: ServerResponse, events: Array<Record<string, unknown>>): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');

  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

function debugLog(message: string): void {
  if (process.env.CODEX_COMPAT_PROXY_DEBUG !== '1') {
    return;
  }

  process.stderr.write(`[codex-compat-proxy] ${message}\n`);
}
