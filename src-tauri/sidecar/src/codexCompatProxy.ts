import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { convertResponsesToChatRequest } from './codexRequestTransform.js';
import { convertChatStreamToResponsesEvents, parseChatCompletionSseStream, type ChatCompletionChunk } from './codexStreamTransform.js';
import { CodexHistoryStore } from './codexHistory.js';
import { inferReasoningConfig } from './codexReasoning.js';
// Keep legacy imports for non-streaming path compatibility
import { CodexChatHistory, convertChatCompletionToResponses } from './codexChatCompat.js';
import { buildToolResultEvent } from './runtimeEvents.js';
import crypto from 'node:crypto';
import { waitForInteractiveToolResponse } from './interactiveToolResponses.js';
import {
  buildRequestUserInputBlockedEvent,
  getActiveCodexCollaborationPolicy,
  type CodexCollaborationPolicy,
} from './codexCollaborationPolicy.js';

export type ProxyConfig = {
  apiKey: string;
  baseUrl: string;
  providerName?: string;
};

function createConfigFingerprint(config: ProxyConfig): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex');
}

export type ProxyServerHandle = {
  baseUrl: string;
  close: () => Promise<void>;
};

export async function createCodexCompatProxyServer(
  config: ProxyConfig,
  preferredPort = 15722,
): Promise<ProxyServerHandle> {
  const historyStore = new CodexHistoryStore();
  const legacyHistory = new CodexChatHistory();
  const emittedToolResultIds = new Set<string>();
  const configFingerprint = createConfigFingerprint(config);
  const server = createServer(async (req, res) => {
    try {
      proxyLog(`${req.method ?? 'UNKNOWN'} ${req.url ?? '/'}`);
      await handleRequest(req, res, config, configFingerprint, historyStore, legacyHistory, emittedToolResultIds);
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

  const PORT = preferredPort;
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    let retries = 0;
    const tryListen = () => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && retries < 5) {
          retries++;
          proxyLog(`port ${PORT} busy, retrying (${retries}/5)...`);
          setTimeout(() => {
            server.removeAllListeners('error');
            tryListen();
          }, 300);
        } else {
          reject(err);
        }
      });
      server.listen(PORT, '127.0.0.1', () => {
        const currentAddress = server.address();
        if (!currentAddress || typeof currentAddress === 'string') {
          reject(new Error('Codex proxy server did not expose a TCP port.'));
          return;
        }
        resolve({ port: currentAddress.port });
      });
    };
    tryListen();
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  configFingerprint: string,
  historyStore: CodexHistoryStore,
  legacyHistory: CodexChatHistory,
  emittedToolResultIds: Set<string>,
): Promise<void> {
  if (req.method === 'GET' && isHealthPath(req.url ?? '/')) {
    writeJson(res, 200, { ok: true, configFingerprint });
    return;
  }

  if (req.method === 'POST' && isShutdownPath(req.url ?? '/')) {
    writeJson(res, 200, { ok: true });
    setImmediate(() => {
      (res.socket as typeof res.socket & { server?: HttpServer | null } | null)?.server?.close();
    });
    return;
  }

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
  const collaborationPolicy = getActiveCodexCollaborationPolicy();
  await emitToolResultEventsFromRequest(requestBody, emittedToolResultIds);
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
  const reasoningConfig = inferReasoningConfig(requestBody.model, config.baseUrl, config.providerName ?? '');
  const chatRequest = convertResponsesToChatRequest(requestBody, historyStore, reasoningConfig);
  // Extract and remove the metadata field so it doesn't get sent to the upstream API
  const previousMessageCount = (chatRequest as Record<string, unknown>)._previousMessageCount as number ?? 0;
  delete (chatRequest as Record<string, unknown>)._previousMessageCount;
  proxyLog(`chat request ${summarizeChatRequest(chatRequest)}`);
  if (Array.isArray(chatRequest.tools) && chatRequest.tools.length > 0) {
    // proxyLog(`chat tool names ${chatRequest.tools.map((tool) => summarizeChatToolName(tool)).join(', ')}`);
    const missingChatTools = chatRequest.tools.filter((tool) => summarizeChatToolName(tool) === '<missing>');
    if (missingChatTools.length > 0) {
      proxyLog(`chat missing-name tools ${truncateForLog(JSON.stringify(missingChatTools))}`);
    }
    proxyLog(`chat tools raw ${truncateForLog(JSON.stringify(chatRequest.tools.slice(0, 3)))}`);
    persistDebugJson('last-codex-chat-request.json', chatRequest);
  }
  // --- Streaming path: forward upstream SSE deltas as Responses API events ---
  if (requestBody.stream) {
    try {
      const responseId = `resp_${crypto.randomUUID()}`;
      const messageId = `msg_${crypto.randomUUID()}`;
      const reasoningId = `rs_${crypto.randomUUID()}`;
      const { chunks, response: upstreamRes } = await streamChatCompletion(chatRequest, config);

      // Build toolContext for streaming tool type determination (P1-7)
      const toolContext = new Map<string, { kind: 'function' | 'custom' | 'tool_search'; name: string }>();
      for (const tool of (requestBody.tools ?? [])) {
        const toolRecord = tool as Record<string, unknown>;
        if (toolRecord.type === 'custom' && typeof toolRecord.name === 'string') {
          toolContext.set(toolRecord.name, { kind: 'custom', name: toolRecord.name });
        } else if (toolRecord.type === 'tool_search') {
          toolContext.set('tool_search', { kind: 'tool_search', name: 'tool_search' });
        }
        // function and namespace tools are handled as function_call (default)
      }

      const responsesEvents = convertChatStreamToResponsesEvents(chunks, {
        responseId,
        model: upstreamRes.headers.get('x-model') || chatRequest.model || 'unknown',
        reasoningId,
        messageId,
        reasoningEnabled: reasoningConfig?.supports_thinking ?? false,
        toolContext,
      });

      const events: Array<Record<string, unknown>> = [];
      const toolCalls: StreamingToolCall[] = [];
      let eventCount = 0;
      for await (const event of responsesEvents) {
        eventCount++;
        logStreamingEvent(event, eventCount);
        events.push(event);

        if (event.type === 'response.output_item.done') {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call') {
            const call = {
              id: String(item.call_id ?? item.id ?? ''),
              name: String(item.name ?? ''),
              namespace: typeof item.namespace === 'string' ? item.namespace : undefined,
              arguments: String(item.arguments ?? ''),
            };
            toolCalls.push(call);
            if (call.id) {
              historyStore.recordStreamingToolCall(responseId, {
                callId: call.id,
                name: call.name,
                namespace: call.namespace,
                arguments: call.arguments,
              });
            }
          }
        }
      }

      const interactiveToolCalls = toolCalls.filter(isInteractiveUserInputToolCall);
      if (interactiveToolCalls.length > 0) {
        proxyLog(`stream intercepted ${interactiveToolCalls.length} interactive user input tool calls`);
        await handleInteractiveUserInputToolCalls({
          res,
          chatRequest,
          config,
          collaborationPolicy,
          interactiveToolCalls,
          reasoningEnabled: reasoningConfig?.supports_thinking ?? false,
          toolContext,
        });
        return;
      }

      forwardResponsesSseEvents(res, events);
      proxyLog(`stream completed: ${eventCount} events forwarded`);
      await emitToolUseEventsFromStream(toolCalls);
    } catch (error) {
      proxyLog(`streaming error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        writeJson(res, 502, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'proxy_error',
            code: 502,
          },
        });
      } else {
        res.end();
      }
    }
    return;
  }

  // --- Non-streaming path: wait for complete response ---
  let completion = await fetchChatCompletion(chatRequest, config);

  // Emit tool_use events for tool calls so the frontend renders them in real-time.
  // The Codex SDK doesn't emit item events for function_call items from the proxy.
  let toolCalls = completion.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const streamingToolCalls = chatToolCallsToStreamingToolCalls(toolCalls);
    const interactiveToolCalls = streamingToolCalls.filter(isInteractiveUserInputToolCall);
    if (interactiveToolCalls.length > 0) {
      proxyLog(`non-stream intercepted ${interactiveToolCalls.length} interactive user input tool calls`);
      completion = await continueAfterNonStreamingInteractiveToolCalls(
        chatRequest,
        config,
        collaborationPolicy,
        interactiveToolCalls,
      );
      toolCalls = completion.choices?.[0]?.message?.tool_calls;
    } else {
      const { activeSessionId } = await import('./codexRuntime.js');
      proxyLog(`emitting ${streamingToolCalls.length} tool_use events, sessionId=${activeSessionId || '(empty)'}`);
      for (const toolCall of streamingToolCalls) {
        await emitToolUseEvent(toolCall, parseJsonObject(toolCall.arguments));
      }
    }
  }

  const compatResponse = convertChatCompletionToResponses(completion, requestBody as Parameters<typeof convertChatCompletionToResponses>[1], legacyHistory);

  // Store messages in legacy history so the next request can reconstruct the full
  // conversation chain. Only store NEW messages from this turn — chatRequest.messages
  // already contains previousMessages prepended by convertResponsesToChatRequest,
  // and storing those would cause exponential duplication on the next request.
  const historyMessages: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];
  for (const msg of chatRequest.messages.slice(previousMessageCount)) {
    historyMessages.push(msg as { role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string });
  }
  // Build assistant message with original tool_call IDs from the chat request,
  // not from compatResponse.output which uses generated IDs.
  const assistantMsg: { role: string; content?: string; tool_calls?: unknown[] } = { role: 'assistant' };
  if (compatResponse.output_text) {
    assistantMsg.content = compatResponse.output_text;
  }
  // Find the assistant message from chatRequest.messages that has tool_calls
  // (the last assistant message in the messages array should have them)
  const lastAssistantMsg = [...chatRequest.messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls);
  if (lastAssistantMsg?.tool_calls) {
    assistantMsg.tool_calls = lastAssistantMsg.tool_calls;
  } else if (Array.isArray(completion.choices?.[0]?.message?.tool_calls) && completion.choices[0].message.tool_calls.length > 0) {
    assistantMsg.tool_calls = completion.choices[0].message.tool_calls;
  }
  historyMessages.push(assistantMsg);
  legacyHistory.store(compatResponse.id, historyMessages as any);
  historyStore.storeMessages(compatResponse.id, historyMessages as any);

  writeJson(res, 200, compatResponse);
}

async function emitToolResultEventsFromRequest(
  requestBody: Parameters<typeof convertResponsesToChatRequest>[0],
  emittedToolResultIds: Set<string>,
): Promise<void> {
  const inputItems = Array.isArray(requestBody.input) ? requestBody.input : [requestBody.input];
  const functionCallOutputs = inputItems.filter(isFunctionCallOutputItem);

  if (functionCallOutputs.length === 0) {
    return;
  }

  try {
    const { emit: emitEvent, activeSessionId } = await import('./codexRuntime.js');
    for (const item of functionCallOutputs) {
      const emittedKey = `${activeSessionId}\0${item.call_id}`;
      if (emittedToolResultIds.has(emittedKey)) {
        continue;
      }
      emittedToolResultIds.add(emittedKey);
      emitEvent(buildToolResultEvent({
        sessionId: activeSessionId,
        toolUseId: item.call_id ?? '',
        content: stringifyFunctionCallOutput(item.output),
      }));
    }
  } catch (error) {
    proxyLog(`failed to emit tool_result event: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFunctionCallOutputItem(
  value: unknown,
): value is { type: 'function_call_output'; call_id: string; output: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'function_call_output' &&
    typeof (value as Record<string, unknown>).call_id === 'string'
  );
}

function stringifyFunctionCallOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  if (output == null) {
    return '';
  }

  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

type StreamingToolCall = {
  id: string;
  name: string;
  namespace?: string;
  arguments: string;
};

type InteractiveUserInputQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

function forwardResponsesSseEvents(res: ServerResponse, events: Array<Record<string, unknown>>): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');

  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

function logStreamingEvent(event: Record<string, unknown>, eventCount: number): void {
  if (eventCount <= 2 || (event.type as string) === 'response.output_item.done' || (event.type as string) === 'response.output_text.done' || (event.type as string) === 'response.content_part.done' || (event.type as string) === 'response.completed') {
    proxyLog(`stream event #${eventCount} ${String(event.type)} ${JSON.stringify(event).slice(0, 300)}`);
  }
  if (eventCount === 1) {
    proxyLog(`first event: ${JSON.stringify(event).slice(0, 200)}`);
  }
  if ((event.type as string) === 'response.completed') {
    const output = (event as any).response?.output;
    proxyLog(`response.completed output items=${output?.length ?? 0}`);
    if (output?.[0]) {
      proxyLog(`  output[0] type=${output[0].type} content_len=${JSON.stringify(output[0].content ?? output[0].summary ?? '').length}`);
    }
  }
}

async function emitToolUseEventsFromStream(toolCalls: StreamingToolCall[]): Promise<void> {
  if (toolCalls.length === 0) {
    return;
  }

  const { activeSessionId } = await import('./codexRuntime.js');
  proxyLog(`emitting ${toolCalls.length} tool_use events from stream, sessionId=${activeSessionId || '(empty)'}`);
  for (const tc of toolCalls) {
    await emitToolUseEvent(tc, parseJsonObject(tc.arguments));
  }
}

async function handleInteractiveUserInputToolCalls({
  res,
  chatRequest,
  config,
  collaborationPolicy,
  interactiveToolCalls,
  reasoningEnabled,
  toolContext,
}: {
  res: ServerResponse;
  chatRequest: ReturnType<typeof convertResponsesToChatRequest>;
  config: ProxyConfig;
  collaborationPolicy: CodexCollaborationPolicy;
  interactiveToolCalls: StreamingToolCall[];
  reasoningEnabled: boolean;
  toolContext: Map<string, { kind: 'function' | 'custom' | 'tool_search'; name: string }>;
}): Promise<void> {
  const responses: unknown[] = [];
  const { emit: emitEvent, activeSessionId } = await import('./codexRuntime.js');

  for (const toolCall of interactiveToolCalls) {
    if (collaborationPolicy.requestUserInputPolicy === 'block') {
      const blockedResponse = {
        answers: {},
        blocked: true,
        reason_code: 'request_user_input_blocked_in_default_mode',
      };
      responses.push(blockedResponse);
      emitEvent(buildRequestUserInputBlockedEvent(toolCall.id || null));
      emitEvent(buildToolResultEvent({
        sessionId: activeSessionId,
        toolUseId: toolCall.id,
        content: stringifyInteractiveToolResponse(blockedResponse),
        isError: true,
      }));
      continue;
    }

    const input = parseJsonObject(toolCall.arguments);
    const questions = parseInteractiveQuestions(input.questions);
    emitEvent({
      type: 'ask_user_question',
      tool_use_id: toolCall.id,
      questions,
    });

    const response = await waitForInteractiveToolResponse(toolCall.id);
    responses.push(response);
    emitEvent(buildToolResultEvent({
      sessionId: activeSessionId,
      toolUseId: toolCall.id,
      content: stringifyInteractiveToolResponse(response),
    }));
  }

  const continuationRequest = buildInteractiveContinuationChatRequest(
    chatRequest,
    interactiveToolCalls,
    responses,
  );
  const responseId = `resp_${crypto.randomUUID()}`;
  const messageId = `msg_${crypto.randomUUID()}`;
  const reasoningId = `rs_${crypto.randomUUID()}`;
  const { chunks, response: upstreamRes } = await streamChatCompletion(continuationRequest, config);
  const responsesEvents = convertChatStreamToResponsesEvents(chunks, {
    responseId,
    model: upstreamRes.headers.get('x-model') || continuationRequest.model || 'unknown',
    reasoningId,
    messageId,
    reasoningEnabled,
    toolContext,
  });

  const events: Array<Record<string, unknown>> = [];
  const continuationToolCalls: StreamingToolCall[] = [];
  let eventCount = 0;
  for await (const event of responsesEvents) {
    eventCount++;
    logStreamingEvent(event, eventCount);
    events.push(event);

    if (event.type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call') {
        continuationToolCalls.push({
          id: String(item.call_id ?? item.id ?? ''),
          name: String(item.name ?? ''),
          namespace: typeof item.namespace === 'string' ? item.namespace : undefined,
          arguments: String(item.arguments ?? ''),
        });
      }
    }
  }

  forwardResponsesSseEvents(res, events);
  proxyLog(`interactive continuation completed: ${eventCount} events forwarded`);
  await emitToolUseEventsFromStream(continuationToolCalls);
}

async function continueAfterNonStreamingInteractiveToolCalls(
  chatRequest: ReturnType<typeof convertResponsesToChatRequest>,
  config: ProxyConfig,
  collaborationPolicy: CodexCollaborationPolicy,
  interactiveToolCalls: StreamingToolCall[],
): Promise<Parameters<typeof convertChatCompletionToResponses>[0]> {
  const responses: unknown[] = [];
  const { emit: emitEvent, activeSessionId } = await import('./codexRuntime.js');

  for (const toolCall of interactiveToolCalls) {
    let response: unknown;
    let isError = false;
    if (collaborationPolicy.requestUserInputPolicy === 'block') {
      response = {
        answers: {},
        blocked: true,
        reason_code: 'request_user_input_blocked_in_default_mode',
      };
      isError = true;
      emitEvent(buildRequestUserInputBlockedEvent(toolCall.id || null));
    } else {
      const input = parseJsonObject(toolCall.arguments);
      const questions = parseInteractiveQuestions(input.questions);
      emitEvent({
        type: 'ask_user_question',
        tool_use_id: toolCall.id,
        questions,
      });
      response = await waitForInteractiveToolResponse(toolCall.id);
    }

    responses.push(response);
    emitEvent(buildToolResultEvent({
      sessionId: activeSessionId,
      toolUseId: toolCall.id,
      content: stringifyInteractiveToolResponse(response),
      isError,
    }));
  }

  return fetchChatCompletion(
    buildInteractiveContinuationChatRequest(chatRequest, interactiveToolCalls, responses),
    config,
  );
}

function isInteractiveUserInputToolCall(toolCall: StreamingToolCall): boolean {
  return toolCall.name === 'request_user_input'
    || toolCall.name === 'askUserQuestion'
    || toolCall.name === 'AskUserQuestion';
}

function chatToolCallsToStreamingToolCalls(toolCalls: unknown[]): StreamingToolCall[] {
  return toolCalls
    .filter((toolCall): toolCall is {
      id?: string;
      function?: { name?: string; arguments?: string };
    } => Boolean(toolCall) && typeof toolCall === 'object')
    .map((toolCall) => ({
      id: toolCall.id ?? '',
      name: toolCall.function?.name ?? 'tool',
      arguments: toolCall.function?.arguments ?? '{}',
    }));
}

function parseInteractiveQuestions(value: unknown): InteractiveUserInputQuestion[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as InteractiveUserInputQuestion[] : [];
    } catch {
      return [];
    }
  }

  return Array.isArray(value) ? value as InteractiveUserInputQuestion[] : [];
}

function stringifyInteractiveToolResponse(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }

  if (response == null) {
    return '';
  }

  return JSON.stringify(response);
}

function buildInteractiveContinuationChatRequest(
  chatRequest: ReturnType<typeof convertResponsesToChatRequest>,
  interactiveToolCalls: StreamingToolCall[],
  responses: unknown[],
): ReturnType<typeof convertResponsesToChatRequest> {
  return {
    ...chatRequest,
    messages: [
      ...chatRequest.messages,
      {
        role: 'assistant',
        content: '',
        tool_calls: interactiveToolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
        })),
      },
      ...interactiveToolCalls.map((toolCall, index) => ({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: stringifyInteractiveToolResponse(responses[index]),
      })),
    ],
  } as ReturnType<typeof convertResponsesToChatRequest>;
}

async function emitToolUseEvent(toolCall: StreamingToolCall, input: Record<string, unknown>): Promise<void> {
  const { emit: emitEvent, activeSessionId } = await import('./codexRuntime.js');
  emitEvent({
    type: 'assistant',
    uuid: crypto.randomUUID(),
    session_id: activeSessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolCall.id, name: toolCall.name, input }],
    },
    parent_tool_use_id: null,
  });
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the safe empty object expected by Chat Completions tools.
  }
  return {};
}

async function fetchChatCompletion(
  requestBody: ReturnType<typeof convertResponsesToChatRequest>,
  config: ProxyConfig,
): Promise<Parameters<typeof convertChatCompletionToResponses>[0]> {
  let lastError: Error | null = null;

  for (const endpoint of buildChatCompletionEndpoints(config.baseUrl)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...requestBody,
          stream: false,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    proxyLog(`upstream POST ${endpoint} -> ${response.status}`);

    if (response.status === 404) {
      lastError = new Error(`upstream endpoint not found: ${endpoint}`);
      continue;
    }

    if (response.status >= 400 && response.status < 500) {
      const body = await response.text();
      proxyLog(`upstream client error body ${truncateForLog(body)}`);
      throw new Error(`client error ${response.status}: ${body}`);
    }

    if (response.status >= 500) {
      const body = await response.text();
      proxyLog(`upstream server error body ${truncateForLog(body)}`);
      lastError = new Error(`server error ${response.status}`);
      continue;
    }

    const json = await response.json() as Parameters<typeof convertChatCompletionToResponses>[0];
    proxyLog(`upstream success model=${json.model || 'unknown'} choices=${json.choices?.length ?? 0}`);
    return json;
  }

  throw lastError ?? new Error('No upstream chat completions endpoint succeeded.');
}

async function streamChatCompletion(
  requestBody: ReturnType<typeof convertResponsesToChatRequest>,
  config: ProxyConfig,
): Promise<{ chunks: AsyncGenerator<import('./codexStreamTransform.js').ChatStreamToolCall & Record<string, unknown>, void, unknown>; response: Response }> {
  let lastError: Error | null = null;

  for (const endpoint of buildChatCompletionEndpoints(config.baseUrl)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...requestBody,
        stream: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    proxyLog(`upstream stream POST ${endpoint} -> ${response.status}`);

    if (response.status === 404) {
      lastError = new Error(`upstream endpoint not found: ${endpoint}`);
      continue;
    }

    if (response.status >= 400 && response.status < 500) {
      const body = await response.text();
      proxyLog(`upstream stream client error body ${truncateForLog(body)}`);
      throw new Error(`client error ${response.status}: ${body}`);
    }

    if (response.status >= 500) {
      lastError = new Error(`server error ${response.status}`);
      continue;
    }

    if (!response.body) {
      throw new Error(`upstream response body is null for ${endpoint}`);
    }

    const chunks = parseChatCompletionSseStream(response.body);
    return { chunks: chunks as any, response };
  }

  throw lastError ?? new Error('No upstream chat completions stream endpoint succeeded.');
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
  return pathname === '/responses'
    || pathname === '/v1/responses'
    || pathname === '/v1/v1/responses'
    || pathname === '/responses/compact'
    || pathname === '/v1/responses/compact'
    || pathname === '/v1/v1/responses/compact'
    || pathname === '/codex/responses';
}

function isModelsPath(rawUrl: string): boolean {
  const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname.replace(/\/+$/, '');
  return pathname === '/models' || pathname === '/v1/models';
}

function isHealthPath(rawUrl: string): boolean {
  const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname.replace(/\/+$/, '');
  return pathname === '/__codemux_proxy_health';
}

function isShutdownPath(rawUrl: string): boolean {
  const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname.replace(/\/+$/, '');
  return pathname === '/__codemux_proxy_shutdown';
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
