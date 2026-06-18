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
  previous_response_id?: string;
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
  reasoning_content?: string;
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

function toChatFunctionName(item: Pick<ResponsesInputItem, 'name'> & { namespace?: unknown }): string {
  const name = item.name ?? '';
  if (typeof item.namespace === 'string' && item.namespace.startsWith('mcp__') && name.length > 0) {
    return `${item.namespace}__${name}`;
  }
  return name;
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
        function: { name: toChatFunctionName(item), arguments: item.arguments ?? '{}' },
      }],
    }];
  }

  // P0-1: custom_tool_call → assistant with tool_calls
  if (type === 'custom_tool_call' && item.call_id) {
    return [{
      role: 'assistant',
      tool_calls: [{
        id: item.call_id,
        type: 'function',
        function: {
          name: item.name ?? '',
          arguments: typeof (item as Record<string, unknown>).input === 'string'
            ? (item as Record<string, unknown>).input as string
            : JSON.stringify((item as Record<string, unknown>).input ?? '{}'),
        },
      }],
    }];
  }

  // P0-2: tool_search_call → assistant with tool_calls
  if (type === 'tool_search_call' && item.call_id) {
    return [{
      role: 'assistant',
      tool_calls: [{
        id: item.call_id,
        type: 'function',
        function: { name: 'tool_search', arguments: item.arguments ?? '{}' },
      }],
    }];
  }

  // function_call_output / custom_tool_call_output / tool_search_output / mcp_tool_call_output / command_execution_output → tool message
  if (
    type === 'function_call_output' ||
    type === 'custom_tool_call_output' ||
    type === 'tool_search_output' ||
    type === 'mcp_tool_call_output' ||
    type === 'command_execution_output'
  ) {
    return [{
      role: 'tool',
      tool_call_id: item.call_id ?? '',
      content: item.output ?? '',
    }];
  }

  // reasoning → attach as reasoning_content to the next assistant message
  // We store it as a special marker that convertResponsesToChatRequest will process
  if (type === 'reasoning') {
    const reasoningText = extractReasoningText(item);
    if (reasoningText) {
      // Return a placeholder that will be attached to the next assistant message
      return [{ role: 'reasoning_placeholder' as string, content: reasoningText } as ChatMessage];
    }
    return [];
  }

  // Default: role + normalized content (developer → system)
  const role = (item.role as string) ?? 'user';
  const normalizedRole = role === 'developer' ? 'system' : role;
  const content = normalizeContent(item.content);
  return [{ role: normalizedRole, content }];
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
 * Custom tools are converted to function tools with the original definition embedded in description.
 * Tool search generates a proxy function for tool discovery.
 */
export function flattenResponsesTools(tools: Array<Record<string, unknown>>): unknown[] {
  const result: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      continue;
    }
    if (tool.type === 'namespace' && typeof tool.name === 'string' && Array.isArray(tool.tools)) {
      for (const child of tool.tools) {
        if (!child || typeof child !== 'object' || Array.isArray(child)) {
          continue;
        }
        const childRecord = child as Record<string, unknown>;
        if (childRecord.type !== 'function' || typeof childRecord.name !== 'string') {
          continue;
        }
        result.push({
          type: 'function',
          function: {
            name: `${tool.name}__${childRecord.name}`,
            description: typeof childRecord.description === 'string' ? childRecord.description : '',
            parameters: childRecord.parameters ?? { type: 'object', properties: {} },
          },
        });
      }
      continue;
    }
    // P0-2: tool_search → proxy function
    if (tool.type === 'tool_search') {
      result.push({
        type: 'function',
        function: {
          name: 'tool_search',
          description: 'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query for tools or connectors to load.' },
              limit: { type: 'integer', description: 'Maximum number of tool groups to return.' },
            },
            required: ['query'],
          },
        },
      });
      continue;
    }
    // P0-1: custom → function with original definition in description
    if (tool.type === 'custom' && typeof tool.name === 'string' && tool.name.length > 0) {
      const originalDef = JSON.stringify(tool);
      const description = `Original tool definition:\n\`\`\`json\n${originalDef}\n\`\`\``;
      result.push({
        type: 'function',
        function: {
          name: tool.name,
          description,
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.',
              },
            },
            required: ['input'],
          },
        },
      });
      continue;
    }
    if (tool.type !== 'function' || typeof tool.name !== 'string' || tool.name.length === 0) {
      continue;
    }
    const name = tool.name;
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
 * Extract reasoning text from a Responses API reasoning item.
 */
function extractReasoningText(item: Record<string, unknown>): string {
  // Direct reasoning_content field
  if (typeof item.reasoning_content === 'string' && item.reasoning_content.trim()) {
    return item.reasoning_content;
  }
  // summary array
  const summary = item.summary;
  if (Array.isArray(summary)) {
    return summary
      .map((s: Record<string, unknown>) => typeof s?.text === 'string' ? s.text : '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * P0-4: Collapse all system messages into a single system message at the head.
 * MiniMax and similar strict models require only one system message at position 0.
 */
function collapseSystemMessagesToHead(messages: ChatMessage[]): ChatMessage[] {
  const systemChunks: string[] = [];
  const rest: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.trim()) {
      systemChunks.push(msg.content);
    } else {
      rest.push(msg);
    }
  }

  if (systemChunks.length === 0) return rest;
  return [{ role: 'system', content: systemChunks.join('\n\n') }, ...rest];
}

/**
 * P0-3: Ensure every assistant message with tool_calls has a non-empty reasoning_content.
 * DeepSeek/Kimi require this or the API returns an error.
 */
function ensureToolCallReasoningContent(messages: ChatMessage[]): void {
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls?.length && !msg.reasoning_content) {
      (msg as unknown as Record<string, unknown>).reasoning_content = 'tool call';
    }
  }
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

  // Track pending reasoning content from reasoning items
  let pendingReasoning: string | null = null;

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
          function: { name: toChatFunctionName(fc), arguments: fc.arguments ?? '{}' },
        });
        i++;
      }
      const assistantMsg: ChatMessage = { role: 'assistant', tool_calls: toolCalls };
      // Attach pending reasoning if available
      if (pendingReasoning) {
        assistantMsg.reasoning_content = pendingReasoning;
        pendingReasoning = null;
      }
      messages.push(assistantMsg);
    } else {
      const converted = convertInputItemToChatMessages(item);
      for (const msg of converted) {
        // Handle reasoning placeholder: store for next assistant message
        if (msg.role === 'reasoning_placeholder') {
          if (pendingReasoning) {
            pendingReasoning += '\n\n' + msg.content;
          } else {
            pendingReasoning = msg.content ?? null;
          }
          continue;
        }
        // If this is an assistant message and we have pending reasoning, attach it
        if (msg.role === 'assistant' && pendingReasoning && !msg.reasoning_content) {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = null;
        }
        messages.push(msg);
      }
      i++;
    }
  }

  // Inject instructions as system message at the beginning
  if (instructions) {
    messages.unshift({ role: 'system', content: typeof instructions === 'string' ? instructions : String(instructions) });
  }

  // Normalize developer → system across all messages (catches history, edge cases)
  for (const msg of messages) {
    if (msg.role === 'developer') {
      msg.role = 'system';
    }
  }

  // P0-4: Collapse system messages to head
  const finalMessages = collapseSystemMessagesToHead(messages);

  // P0-3: Ensure reasoning_content on tool_calls messages
  ensureToolCallReasoningContent(finalMessages);

  const chatBody: ChatCompletionsRequest = {
    model,
    messages: finalMessages,
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

  // Tools conversion (P0-1 custom, P0-2 tool_search handled in flattenResponsesTools)
  if (tools && tools.length > 0) {
    chatBody.tools = flattenResponsesTools(tools as Array<Record<string, unknown>>);
  }

  // Apply reasoning options
  applyReasoningOptions(chatBody, request as unknown as Record<string, unknown>, model, reasoningConfig);

  return chatBody;
}
