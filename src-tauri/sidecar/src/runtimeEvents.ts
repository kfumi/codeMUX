import type {
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadItem,
  TodoListItem,
  Usage,
  WebSearchItem,
} from '@openai/codex-sdk';
import type { RuntimeFlavor } from './types.js';
export type { RuntimeFlavor } from './types.js';

export type CodexTokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

export type ClaudeTokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export type OpenCodeTokenUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_output_tokens?: number;
};

export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

type ToolUseContext = {
  workdir?: string;
  timeoutMs?: number;
};

function createEventId(factory?: () => string): string {
  return factory?.() ?? crypto.randomUUID();
}

export function getRuntimeFlavor(agentKind?: string): RuntimeFlavor {
  if (agentKind === 'codex') {
    return 'codex';
  }
  if (agentKind === 'opencode') {
    return 'opencode';
  }
  return 'claude';
}

export function buildToolResultEvent({
  sessionId,
  toolUseId,
  content,
  isError = false,
  eventIdFactory,
}: {
  sessionId: string;
  toolUseId: string;
  eventIdFactory?: () => string;
  content: string;
  isError?: boolean;
}) {
  return {
    type: 'user',
    uuid: createEventId(eventIdFactory),
    session_id: sessionId,
    message: {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
    parent_tool_use_id: null,
  };
}

export function buildCodexResultEvent({
  sessionId,
  usage,
  lastTokenUsage,
  durationMs,
}: {
  sessionId: string;
  usage: Usage;
  lastTokenUsage?: CodexTokenUsage | null;
  durationMs: number;
}) {
  const lastUsage: CodexTokenUsage = lastTokenUsage ?? {
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_output_tokens: usage.reasoning_output_tokens,
  };
  const totalTokens = lastUsage.total_tokens ?? lastUsage.input_tokens + lastUsage.output_tokens;
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
    duration_ms: durationMs,
    duration_api_ms: durationMs,
    num_turns: 1,
    result: 'ok',
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cached_input_tokens,
    },
    last_token_usage: {
      input_tokens: lastUsage.input_tokens,
      output_tokens: lastUsage.output_tokens,
      cached_input_tokens: lastUsage.cached_input_tokens,
      total_tokens: totalTokens,
    },
  };
}

export function normalizeClaudeResultEvent(
  event: Record<string, unknown>,
  fallbackUsage: ClaudeTokenUsage | null = null,
): Record<string, unknown> {
  if (event.type !== 'result') {
    return event;
  }

  const usage = readClaudeUsage(event.usage);
  if (usage) {
    return {
      ...event,
      usage,
    };
  }

  const modelUsage = readClaudeUsageFromModelUsage(event.modelUsage);
  if (modelUsage) {
    return {
      ...event,
      usage: modelUsage,
    };
  }

  if (fallbackUsage) {
    return {
      ...event,
      usage: fallbackUsage,
    };
  }

  return event;
}

function readClaudeUsage(value: unknown): ClaudeTokenUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const usage = {
    input_tokens: readFlexibleNumber(value.input_tokens ?? value.inputTokens),
    output_tokens: readFlexibleNumber(value.output_tokens ?? value.outputTokens),
    cache_read_input_tokens: readFlexibleNumber(
      value.cache_read_input_tokens ?? value.cacheReadInputTokens ?? value.cached_input_tokens ?? value.cachedInputTokens,
    ),
    cache_creation_input_tokens: readFlexibleNumber(value.cache_creation_input_tokens ?? value.cacheCreationInputTokens),
  };

  return usage.input_tokens > 0 || usage.output_tokens > 0 || usage.cache_read_input_tokens > 0 || usage.cache_creation_input_tokens > 0
    ? usage
    : null;
}

function readClaudeUsageFromModelUsage(value: unknown): ClaudeTokenUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  let result: ClaudeTokenUsage | null = null;

  for (const entry of Object.values(value)) {
    if (!isRecord(entry)) {
      continue;
    }

    const usage = {
      input_tokens: readFlexibleNumber(entry.inputTokens ?? entry.input_tokens),
      output_tokens: readFlexibleNumber(entry.outputTokens ?? entry.output_tokens),
      cache_read_input_tokens: readFlexibleNumber(entry.cacheReadInputTokens ?? entry.cache_read_input_tokens),
      cache_creation_input_tokens: readFlexibleNumber(entry.cacheCreationInputTokens ?? entry.cache_creation_input_tokens),
    };

    if (usage.input_tokens > 0 || usage.output_tokens > 0 || usage.cache_read_input_tokens > 0 || usage.cache_creation_input_tokens > 0) {
      result = result
        ? {
            input_tokens: result.input_tokens + usage.input_tokens,
            output_tokens: result.output_tokens + usage.output_tokens,
            cache_read_input_tokens: result.cache_read_input_tokens + usage.cache_read_input_tokens,
            cache_creation_input_tokens: result.cache_creation_input_tokens + usage.cache_creation_input_tokens,
          }
        : usage;
    }
  }

  return result;
}

function readFlexibleNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? value : 0;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildCodexToolUseContent(item: ThreadItem, context: ToolUseContext = {}): AssistantContentBlock | null {
  switch (item.type) {
    case 'command_execution': {
      const input: Record<string, unknown> = { command: unwrapWindowsPowerShellCommand(item.command) };
      if (context.timeoutMs !== undefined) {
        input.timeout_ms = context.timeoutMs;
      }
      if (context.workdir) {
        input.workdir = context.workdir;
      }
      return {
        type: 'tool_use',
        id: item.id,
        name: 'shell_command',
        input,
      };
    }
    case 'mcp_tool_call':
      return {
        type: 'tool_use',
        id: item.id,
        name: formatMcpToolName(item.server, item.tool),
        input: (item.arguments as Record<string, unknown>) ?? {},
      };
    case 'web_search':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'WebSearch',
        input: { query: item.query },
      };
    case 'file_change':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'apply_patch',
        input: { changes: item.changes },
      };
    default:
      return null;
  }
}

function unwrapWindowsPowerShellCommand(command: string): string {
  const match = command.match(/^(?:"[^"]*powershell(?:\.exe)?"|[^"\s]*powershell(?:\.exe)?)\s+-Command\s+([\s\S]+)$/i);
  if (!match) {
    return command;
  }

  const rawInnerCommand = match[1].trim();
  if (rawInnerCommand.startsWith('"') && rawInnerCommand.endsWith('"')) {
    return rawInnerCommand.slice(1, -1);
  }
  if (rawInnerCommand.startsWith("'") && rawInnerCommand.endsWith("'")) {
    return rawInnerCommand.slice(1, -1);
  }

  return rawInnerCommand;
}

export function buildCodexTodoListEvent({
  sessionId,
  item,
}: {
  sessionId: string;
  item: TodoListItem;
}) {
  return {
    type: 'codex_todo_list',
    session_id: sessionId,
    todos: item.items.map((todo) => ({
      content: todo.text,
      status: todo.completed ? 'completed' : 'pending',
    })),
  };
}

function formatMcpToolName(server: string, tool: string): string {
  // Global MCP helper tools (list_mcp_resources, etc.) don't follow the mcp__server__tool convention
  if (tool.startsWith('list_mcp_') || tool.startsWith('read_mcp_')) {
    return tool;
  }

  return `mcp__${server}__${tool}`;
}

export function buildCodexToolResultContent(
  item: CommandExecutionItem | FileChangeItem | McpToolCallItem | TodoListItem | WebSearchItem,
): string | null {
  switch (item.type) {
    case 'command_execution':
      return item.aggregated_output || `Command finished with status ${item.status}`;
    case 'mcp_tool_call':
      if (item.status === 'failed' && item.error?.message) {
        return item.error.message;
      }
      return JSON.stringify(
        item.result?.structured_content ?? item.result?.content ?? item.error ?? { status: item.status },
        null,
        2,
      );
    case 'web_search':
      return `Search completed for: ${item.query}`;
    case 'file_change':
      return item.changes.length > 0
        ? `Patch ${item.status}: ${item.changes.map((change) => `${change.kind} ${change.path}`).join(', ')}`
        : `Patch ${item.status}`;
    default:
      return null;
  }
}

export function isCodexToolResultError(
  item: CommandExecutionItem | FileChangeItem | McpToolCallItem | TodoListItem | WebSearchItem,
): boolean {
  switch (item.type) {
    case 'command_execution':
    case 'mcp_tool_call':
    case 'file_change':
      return item.status === 'failed';
    default:
      return false;
  }
}
