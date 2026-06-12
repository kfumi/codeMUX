type JsonRecord = Record<string, unknown>;

type ChatToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
};

type ResponsesInputItem =
  | string
  | {
      type?: string;
      role?: ChatMessage['role'];
      content?: unknown;
      call_id?: string;
      output?: unknown;
    };

type ResponsesFunctionTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters?: JsonRecord;
};

type ResponsesRequest = {
  model: string;
  input: ResponsesInputItem | ResponsesInputItem[];
  previous_response_id?: string | null;
  instructions?: string;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  user?: string;
  metadata?: JsonRecord;
  reasoning?: {
    effort?: string;
  };
  tools?: ResponsesFunctionTool[];
  tool_choice?: string;
};

type ChatCompletionsRequest = {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  user?: string;
  metadata?: JsonRecord;
  reasoning_effort?: string;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: JsonRecord;
    };
  }>;
  tool_choice?: string;
};

type ChatCompletionChoice = {
  message?: {
    role?: 'assistant';
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    reasoning_details?: Array<{ text?: string | null }>;
    tool_calls?: ChatToolCall[];
  };
  finish_reason?: string | null;
};

type ChatCompletionResponse = {
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type ResponsesOutputContent =
  {
      type: 'output_text';
      text: string;
      annotations: [];
    };

type ResponsesOutputItem =
  | {
      type: 'reasoning';
      id: string;
      summary: Array<{
        type: 'summary_text';
        text: string;
      }>;
    }
  | {
      type: 'message';
      id: string;
      status: 'completed';
      role: 'assistant';
      content: ResponsesOutputContent[];
    }
  | {
      type: 'function_call';
      id: string;
      call_id: string;
      name: string;
      arguments: string;
    };

type ResponsesUsage = {
  input_tokens: number;
  input_tokens_details: {
    cached_tokens: number;
  };
  output_tokens: number;
  output_tokens_details: {
    reasoning_tokens: number;
  };
  total_tokens: number;
};

type ResponsesResponse = {
  id: string;
  object: 'response';
  created_at: number;
  error: null;
  incomplete_details: null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  status: 'completed' | 'requires_action';
  output: ResponsesOutputItem[];
  parallel_tool_calls: boolean;
  reasoning: null;
  text: {
    format: {
      type: 'text';
    };
  };
  tool_choice: string;
  tools: ResponsesFunctionTool[];
  top_p?: number;
  truncation: 'disabled';
  usage?: ResponsesUsage;
  user?: string;
  metadata: JsonRecord;
  previous_response_id?: string | null;
  output_text: string;
  required_action?: {
    type: 'submit_tool_outputs';
    submit_tool_outputs: {
      tool_calls: ChatToolCall[];
    };
  };
};

type HistoryEntry = {
  messages: ChatMessage[];
};

export class CodexChatHistory {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, HistoryEntry>();

  constructor(maxEntries = 512) {
    this.maxEntries = maxEntries;
  }

  get(responseId: string): HistoryEntry | undefined {
    return this.entries.get(responseId);
  }

  store(responseId: string, messages: ChatMessage[]): void {
    this.entries.delete(responseId);
    this.entries.set(responseId, {
      messages: messages.map((message) => ({
        ...message,
        tool_calls: message.tool_calls?.map((toolCall) => ({
          ...toolCall,
          function: { ...toolCall.function },
        })),
      })),
    });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}

export function convertResponsesToChatRequest(
  request: ResponsesRequest,
  history: CodexChatHistory,
): ChatCompletionsRequest {
  const messages = buildChatMessages(request, history);
  const tools = request.tools
    ? flattenResponsesTools(request.tools).map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    : undefined;

  return {
    model: request.model,
    messages,
    stream: request.stream ?? false,
    max_tokens: request.max_output_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    user: request.user,
    metadata: request.metadata,
    reasoning_effort: request.reasoning?.effort,
    tools,
    tool_choice: request.tool_choice,
  };
}

export function convertChatCompletionToResponses(
  completion: ChatCompletionResponse,
  request: Pick<ResponsesRequest, 'input' | 'model' | 'previous_response_id' | 'temperature' | 'top_p' | 'user' | 'metadata' | 'tools' | 'tool_choice'>,
  history: CodexChatHistory,
): ResponsesResponse {
  const choice = completion.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new Error('Chat completion response did not include an assistant message.');
  }

  const responseId = createId('resp');
  const messageId = createId('msg');
  const reasoningId = createId('rs');
  const output: ResponsesOutputItem[] = [];
  const { reasoningText, outputText } = extractReasoningAndText(message);

  if (reasoningText) {
    output.push({
      type: 'reasoning',
      id: reasoningId,
      summary: [
        {
          type: 'summary_text',
          text: reasoningText,
        },
      ],
    });
  }

  if (outputText) {
    output.push({
      type: 'message',
      id: messageId,
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: outputText,
          annotations: [],
        },
      ],
    });
  }

  for (const toolCall of message.tool_calls ?? []) {
    const name = toolCall.function.name;
    const callId = toolCall.id;

    if (name.startsWith('mcp__')) {
      // MCP tool: mcp__<server>__<tool> — use function_call but add SDK-compatible fields
      const parts = name.split('__');
      const server = parts[1] ?? '';
      const tool = parts.slice(2).join('__');
      output.push({
        type: 'function_call' as const,
        id: createId('fc'),
        call_id: callId,
        name,
        arguments: toolCall.function.arguments,
        // Extra fields for Codex SDK to recognize as MCP tool
        server,
        tool,
      } as any);
    } else if (name === 'shell_command') {
      output.push({
        type: 'function_call' as const,
        id: createId('fc'),
        call_id: callId,
        name,
        arguments: toolCall.function.arguments,
      });
    } else {
      output.push({
        type: 'function_call',
        id: createId('fc'),
        call_id: callId,
        name,
        arguments: toolCall.function.arguments,
      });
    }
  }

  const status = message.tool_calls?.length ? 'requires_action' : 'completed';
  const response: ResponsesResponse = {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: completion.model || request.model,
    status,
    output,
    parallel_tool_calls: false,
    reasoning: null,
    text: {
      format: {
        type: 'text',
      },
    },
    tool_choice: request.tool_choice ?? 'auto',
    tools: request.tools ?? [],
    top_p: request.top_p,
    truncation: 'disabled',
    usage: completion.usage
      ? {
          input_tokens: completion.usage.prompt_tokens ?? 0,
          input_tokens_details: {
            cached_tokens: 0,
          },
          output_tokens: completion.usage.completion_tokens ?? 0,
          output_tokens_details: {
            reasoning_tokens: reasoningText ? 1 : 0,
          },
          total_tokens: completion.usage.total_tokens ?? 0,
        }
      : undefined,
    user: request.user,
    metadata: request.metadata ?? {},
    previous_response_id: request.previous_response_id ?? null,
    output_text: outputText,
  };

  if (message.tool_calls?.length) {
    response.required_action = {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: message.tool_calls,
      },
    };
  }

  const previousMessages = buildChatMessages(request, history);
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    ...(outputText ? { content: outputText } : {}),
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
  };

  history.store(response.id, [...previousMessages, assistantMessage]);

  return response;
}

export function buildResponsesSseEvents(response: ResponsesResponse): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'response.created',
      response: {
        ...response,
        status: 'in_progress',
        output: [],
      },
    },
    {
      type: 'response.in_progress',
      response: {
        ...response,
        status: 'in_progress',
        output: [],
      },
    },
  ];

  for (const [outputIndex, item] of response.output.entries()) {
    if (item.type === 'function_call') {
      events.push({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: {
          type: 'function_call',
          id: item.id,
          status: 'in_progress',
          call_id: item.call_id,
          name: item.name,
          arguments: '',
        },
      });
      events.push({
        type: 'response.function_call_arguments.delta',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        delta: item.arguments,
      });
      events.push({
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        arguments: item.arguments,
      });
      events.push({
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: {
          type: 'function_call',
          id: item.id,
          status: 'completed',
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        },
      });
      continue;
    }

    if (item.type === 'message') {
      events.push({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: {
          type: 'message',
          id: item.id,
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      });

      for (const [contentIndex, part] of item.content.entries()) {
        events.push({
          type: 'response.content_part.added',
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: {
            type: 'output_text',
            text: '',
            annotations: [],
          },
        });
        events.push({
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: part.text,
        });
        events.push({
          type: 'response.output_text.done',
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          text: part.text,
        });
        events.push({
          type: 'response.content_part.done',
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      }

      events.push({
        type: 'response.output_item.done',
        output_index: outputIndex,
        item,
      });
      continue;
    }
  }

  events.push({
    type: 'response.completed',
    response,
  });

  return events;
}

function buildChatMessages(
  request: Pick<ResponsesRequest, 'input' | 'instructions' | 'previous_response_id'>,
  history: CodexChatHistory,
): ChatMessage[] {
  const historyMessages = request.previous_response_id
    ? history.get(request.previous_response_id)?.messages ?? []
    : [];
  const inputItems = Array.isArray(request.input) ? request.input : [request.input];
  const nextMessages = inputItems.flatMap((item) => convertInputItemToChatMessages(item));
  const messages = [...historyMessages, ...nextMessages];

  if (request.instructions && !startsWithSystemMessage(messages)) {
    return [{ role: 'system', content: request.instructions }, ...messages];
  }

  return messages;
}

function convertInputItemToChatMessages(item: ResponsesInputItem): ChatMessage[] {
  if (typeof item === 'string') {
    return [{ role: 'user', content: item }];
  }

  // Tool results from various SDK tool types
  if (item.type === 'function_call_output') {
    return [{
      role: 'tool',
      tool_call_id: item.call_id ?? '',
      content: stringifyContent(item.output),
    }];
  }

  // MCP tool result (from Codex SDK)
  if ((item as any).type === 'mcp_tool_call_output') {
    const rec = item as any;
    return [{
      role: 'tool',
      tool_call_id: rec.call_id ?? '',
      content: stringifyContent(rec.output ?? rec.result),
    }];
  }

  // Command execution result (from Codex SDK)
  if ((item as any).type === 'command_execution_output') {
    const rec = item as any;
    return [{
      role: 'tool',
      tool_call_id: rec.call_id ?? '',
      content: stringifyContent(rec.output ?? rec.aggregated_output),
    }];
  }

  const role = item.role ?? 'user';
  const content = normalizeContent(item.content);
  return [{ role, content }];
}

function startsWithSystemMessage(messages: ChatMessage[]): boolean {
  const firstRole = messages[0]?.role;
  return firstRole === 'system' || firstRole === 'developer';
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((entry) => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }

        const typedEntry = entry as { type?: string; text?: string; content?: string };
        if (typedEntry.type === 'input_text' || typedEntry.type === 'output_text') {
          return typedEntry.text ? [typedEntry.text] : [];
        }
        if (typedEntry.type === 'text') {
          return typedEntry.text ? [typedEntry.text] : [];
        }
        if (typedEntry.type === 'function_call_output') {
          return [];
        }
        return typedEntry.content ? [typedEntry.content] : [];
      })
      .join('');
  }

  if (content == null) {
    return '';
  }

  return String(content);
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content == null) {
    return '';
  }
  return JSON.stringify(content);
}

function isNamedFunctionTool(tool: unknown): tool is ResponsesFunctionTool {
  if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) return false;
  const record = tool as Record<string, unknown>;
  return record.type === 'function' && typeof record.name === 'string' && record.name.length > 0;
}

/**
 * Flatten Responses API tools to Chat Completions format.
 * MCP tools arrive as { type: "namespace", name: "mcp__server", tools: [...] }.
 * They need to be expanded into individual function tools with prefixed names.
 */
function flattenResponsesTools(tools: unknown[]): ResponsesFunctionTool[] {
  const result: ResponsesFunctionTool[] = [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) continue;
    const record = tool as Record<string, unknown>;

    if (record.type === 'namespace' && typeof record.name === 'string' && Array.isArray(record.tools)) {
      // MCP namespace — expand child tools with mcp__<server>__<tool> naming
      for (const child of record.tools) {
        if (typeof child !== 'object' || child === null) continue;
        const childRecord = child as Record<string, unknown>;
        if (childRecord.type === 'function' && typeof childRecord.name === 'string') {
          result.push({
            type: 'function',
            name: `${record.name}__${childRecord.name}`,
            description: typeof childRecord.description === 'string' ? childRecord.description : undefined,
            parameters: typeof childRecord.parameters === 'object' ? childRecord.parameters as JsonRecord : undefined,
          });
        }
      }
    } else if (isNamedFunctionTool(tool)) {
      result.push(tool);
    }
  }
  return result;
}

function extractReasoningAndText(message: NonNullable<ChatCompletionChoice['message']>): {
  reasoningText: string;
  outputText: string;
} {
  const explicitReasoning =
    cleanText(message.reasoning_content) ||
    cleanText(message.reasoning) ||
    message.reasoning_details?.map((detail) => cleanText(detail.text)).find(Boolean) ||
    '';

  const rawContent = cleanText(message.content);
  const thinkTagMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
  const thinkText = cleanText(thinkTagMatch?.[1]);
  const outputText = cleanText(rawContent.replace(/<think>[\s\S]*?<\/think>/gi, ''));

  return {
    reasoningText: explicitReasoning || thinkText,
    outputText,
  };
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function tryParseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}
