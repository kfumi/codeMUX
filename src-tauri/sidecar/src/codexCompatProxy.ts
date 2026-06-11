import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
      proxyLog(`${req.method ?? 'UNKNOWN'} ${req.url ?? '/'}`);
      await handleRequest(req, res, config, history);
    } catch (error) {
      proxyLog(`error ${req.method ?? 'UNKNOWN'} ${req.url ?? '/'}: ${error instanceof Error ? error.message : String(error)}`);
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
  proxyLog(`responses request ${summarizeResponsesRequest(requestBody)}`);
  if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
    proxyLog(`responses tool names ${requestBody.tools.map((tool) => summarizeToolName(tool)).join(', ')}`);
    const missingResponseTools = requestBody.tools.filter((tool) => summarizeToolName(tool) === '<missing>');
    if (missingResponseTools.length > 0) {
      proxyLog(`responses missing-name tools ${truncateForLog(JSON.stringify(missingResponseTools))}`);
    }
    proxyLog(`responses tools raw ${truncateForLog(JSON.stringify(requestBody.tools.slice(0, 3)))}`);
    persistDebugJson('last-codex-responses-request.json', requestBody);
  }
  const chatRequest = convertResponsesToChatRequest(requestBody, history);
  proxyLog(`chat request ${summarizeChatRequest(chatRequest)}`);
  if (Array.isArray(chatRequest.tools) && chatRequest.tools.length > 0) {
    proxyLog(`chat tool names ${chatRequest.tools.map((tool) => summarizeChatToolName(tool)).join(', ')}`);
    const missingChatTools = chatRequest.tools.filter((tool) => summarizeChatToolName(tool) === '<missing>');
    if (missingChatTools.length > 0) {
      proxyLog(`chat missing-name tools ${truncateForLog(JSON.stringify(missingChatTools))}`);
    }
    proxyLog(`chat tools raw ${truncateForLog(JSON.stringify(chatRequest.tools.slice(0, 3)))}`);
    persistDebugJson('last-codex-chat-request.json', chatRequest);
  }
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

    proxyLog(`upstream POST ${endpoint} -> ${response.status}`);

    if (response.status === 404) {
      lastError = new Error(`upstream endpoint not found: ${endpoint}`);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      proxyLog(`upstream error body ${truncateForLog(body)}`);
      throw new Error(`unexpected status ${response.status} from ${endpoint}: ${body}`);
    }

    const json = await response.json() as Parameters<typeof convertChatCompletionToResponses>[0];
    proxyLog(`upstream success model=${json.model || 'unknown'} choices=${json.choices?.length ?? 0}`);
    return json;
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

    proxyLog(`upstream GET ${endpoint} -> ${response.status}`);

    if (response.status === 404 || response.status === 405) {
      lastError = new Error(`upstream models endpoint not found: ${endpoint}`);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      proxyLog(`upstream models error body ${truncateForLog(body)}`);
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

function proxyLog(message: string): void {
  process.stderr.write(`[codex-compat-proxy] ${message}\n`);
}

function summarizeResponsesRequest(request: Parameters<typeof convertResponsesToChatRequest>[0]): string {
  const inputs = Array.isArray(request.input) ? request.input : [request.input];
  const toolSummary = Array.isArray(request.tools)
    ? request.tools
      .slice(0, 5)
      .map((tool, index) => `#${index}:${summarizeTool(tool)}`)
      .join(', ')
    : 'none';
  return [
    `model=${request.model}`,
    `stream=${request.stream === true}`,
    `previous=${request.previous_response_id ?? 'none'}`,
    `input_items=${inputs.length}`,
    `tools=${request.tools?.length ?? 0}`,
    `tool_summary=[${toolSummary}]`,
  ].join(' ');
}

function summarizeChatRequest(request: ReturnType<typeof convertResponsesToChatRequest>): string {
  const toolSummary = Array.isArray(request.tools)
    ? request.tools
      .slice(0, 5)
      .map((tool, index) => `#${index}:${summarizeChatTool(tool)}`)
      .join(', ')
    : 'none';
  return [
    `model=${request.model}`,
    `messages=${request.messages.length}`,
    `tools=${request.tools?.length ?? 0}`,
    `stream=${request.stream === true}`,
    `tool_summary=[${toolSummary}]`,
  ].join(' ');
}

function truncateForLog(value: string, maxLength = 500): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function persistDebugJson(fileName: string, value: unknown): void {
  try {
    const dir = path.join(os.tmpdir(), 'codemux-codex-debug');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, fileName), JSON.stringify(value, null, 2), 'utf8');
  } catch (error) {
    proxyLog(`failed to persist debug json ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function summarizeTool(tool: unknown): string {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return String(tool);
  }
  const record = tool as Record<string, unknown>;
  return JSON.stringify({
    type: record.type,
    name: record.name,
    has_parameters: Boolean(record.parameters),
  });
}

function summarizeChatTool(tool: unknown): string {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return String(tool);
  }
  const record = tool as Record<string, unknown>;
  const fn = record.function && typeof record.function === 'object' && !Array.isArray(record.function)
    ? record.function as Record<string, unknown>
    : null;
  return JSON.stringify({
    type: record.type,
    name: fn?.name,
    has_parameters: Boolean(fn?.parameters),
  });
}

function summarizeToolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return String(tool);
  }
  const record = tool as Record<string, unknown>;
  return typeof record.name === 'string' ? record.name : '<missing>';
}

function summarizeChatToolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return String(tool);
  }
  const record = tool as Record<string, unknown>;
  const fn = record.function && typeof record.function === 'object' && !Array.isArray(record.function)
    ? record.function as Record<string, unknown>
    : null;
  return typeof fn?.name === 'string' ? fn.name : '<missing>';
}
