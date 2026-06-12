// src-tauri/sidecar/src/codexRequestTransform.ts
// Converts OpenAI Responses API requests to Chat Completions format.

import { applyReasoningOptions, ReasoningConfig } from './codexReasoning.js';
import { CodexHistoryStore } from './codexHistory.js';

export type JsonRecord = Record<string, unknown>;

export interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  [key: string]: unknown;
}

export interface ResponsesFunctionTool {
  type: string;
  name: string;
  description?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  stream: boolean;
  max_output_tokens?: number;
  tool_choice?: unknown;
  tools?: ResponsesFunctionTool[];
  reasoning?: JsonRecord;
  [key: string]: unknown;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  stream_options?: { include_usage: true };
  max_tokens?: number;
  max_completion_tokens?: number;
  tool_choice?: unknown;
  tools?: unknown[];
  [key: string]: unknown;
}

/**
 * Convert a Responses API input item into one or more Chat messages.
 * Consecutive function_call items are merged into a single assistant message.
 */
export function convertInputItemToChatMessages(
  item: ResponsesInputItem,
): ChatMessage[] {
  // Plain string input → user message
  if (typeof item === 'string') {
    return [{ role: 'user', content: item }];
  }

  const type = item.type as string | undefined;

  // function_call → assistant with tool_calls (handled externally via merging,
  // but single-item fallback here)
  if (type === 'function_call' && item.call_id) {
    return [{
      role: 'assistant',
      tool_calls: [{
        id: item.call_id,
        type: 'function',
        function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
      }],
    }];
  }

  // function_call_output / mcp_tool_call_output / command_execution_output → tool message
  if (
    type === 'function_call_output' ||
    type === 'mcp_tool_call_output' ||
    type === 'command_execution_output'
  ) {
    return [{
      role: 'tool',
      tool_call_id: item.call_id ?? '',
      content: item.output ?? '',
    }];
  }

  // Default: role + normalized content
  const role = (item.role as string) ?? 'user';
  const content = normalizeContent(item.content);
  return [{ role, content }];
}

/**
 * Normalize content from various Responses API formats into a plain string.
 */
function normalizeContent(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: Record<string, unknown>) => {
        if (typeof part === 'string') return part;
        if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
        if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    return JSON.stringify(content);
  }
  return String(content);
}

/**
 * Flatten Responses-format tools into Chat Completions format.
 * MCP namespaced tools (mcp__server__tool) get expanded into individual tools.
 */
export function flattenResponsesTools(tools: ResponsesFunctionTool[]): unknown[] {
  const result: unknown[] = [];
  for (const tool of tools) {
    if (tool.type !== 'function') {
      result.push(tool);
      continue;
    }
    const name = tool.name ?? '';
    const mcpMatch = name.match(/^mcp__([^_]+(?:__[^_]+)*)__([^_]+)$/);
    if (mcpMatch) {
      // Already namespaced mcp__<server>__<tool> — keep as-is, just wrap in chat format
      result.push({
        type: 'function',
        function: {
          name,
          description: tool.description ?? '',
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      });
    } else if (name.includes('::')) {
      // Legacy mcpserver::tool format — convert to mcp__ prefix
      const converted = name.replace(/::/g, '__');
      result.push({
        type: 'function',
        function: {
          name: converted,
          description: tool.description ?? '',
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      });
    } else {
      result.push({
        type: 'function',
        function: {
          name,
          description: tool.description ?? '',
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      });
    }
  }
  return result;
}

/**
 * Convert an OpenAI Responses API request into a Chat Completions request.
 */
export function convertResponsesToChatRequest(
  request: ResponsesRequest,
  history: CodexHistoryStore,
  reasoningConfig: ReasoningConfig | null,
): ChatCompletionsRequest {
  const { model, instructions, input, previous_response_id, stream, max_output_tokens, tool_choice, tools, reasoning, ...rest } = request;

  // Retrieve previous messages from history for multi-turn conversations
  const previousMessages = previous_response_id ? history.getMessages(previous_response_id) : undefined;

  // Enrich input with any missing function_call items from history
  const enrichedInput = [...input] as Array<Record<string, unknown>>;
  history.enrichRequest(enrichedInput, previous_response_id);

  // Build chat messages from input items, merging consecutive function_calls
  const messages: ChatMessage[] = [];
  if (previousMessages && previousMessages.length > 0) {
    for (const msg of previousMessages) {
      messages.push(msg as ChatMessage);
    }
  }
  let i = 0;
  while (i < enrichedInput.length) {
    const item = enrichedInput[i] as ResponsesInputItem;
    const type = item.type as string | undefined;

    if (type === 'function_call' && item.call_id) {
      // Collect consecutive function_calls into a single assistant message
      const toolCalls: ChatToolCall[] = [];
      while (
        i < enrichedInput.length &&
        (enrichedInput[i] as ResponsesInputItem).type === 'function_call'
      ) {
        const fc = enrichedInput[i] as ResponsesInputItem;
        toolCalls.push({
          id: fc.call_id ?? '',
          type: 'function',
          function: { name: fc.name ?? '', arguments: fc.arguments ?? '{}' },
        });
        i++;
      }
      messages.push({ role: 'assistant', tool_calls: toolCalls });
    } else {
      messages.push(...convertInputItemToChatMessages(item));
      i++;
    }
  }

  // Inject instructions as system message at the beginning
  if (instructions) {
    messages.unshift({ role: 'system', content: instructions });
  }

  const chatBody: ChatCompletionsRequest = {
    model,
    messages,
    stream,
    ...rest,
  };

  // Stream options
  if (stream) {
    chatBody.stream_options = { include_usage: true };
  }

  // Token limits: o-series uses max_completion_tokens, others use max_tokens
  if (max_output_tokens !== undefined) {
    if (/^o\d/i.test(model)) {
      chatBody.max_completion_tokens = max_output_tokens;
    } else {
      chatBody.max_tokens = max_output_tokens;
    }
  }

  // Tool choice conversion
  if (tool_choice !== undefined) {
    if (typeof tool_choice === 'string') {
      chatBody.tool_choice = tool_choice;
    } else if (typeof tool_choice === 'object' && tool_choice !== null) {
      const tc = tool_choice as Record<string, unknown>;
      if (tc.type === 'function' && typeof tc.name === 'string') {
        chatBody.tool_choice = { type: 'function', function: { name: tc.name } };
      } else {
        chatBody.tool_choice = tool_choice;
      }
    }
  }

  // Tools conversion
  if (tools && tools.length > 0) {
    chatBody.tools = flattenResponsesTools(tools);
  }

  // Apply reasoning options
  applyReasoningOptions(chatBody, request as unknown as Record<string, unknown>, model, reasoningConfig);

  return chatBody;
}
