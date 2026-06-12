import type {
  CommandExecutionItem,
  McpToolCallItem,
  ThreadItem,
  TodoListItem,
  Usage,
  WebSearchItem,
} from '@openai/codex-sdk';

export type RuntimeFlavor = 'claude' | 'codex';

type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export function getRuntimeFlavor(agentKind?: string): RuntimeFlavor {
  return agentKind === 'codex' ? 'codex' : 'claude';
}

export function buildAssistantEvent({
  sessionId,
  content,
}: {
  sessionId: string;
  content: AssistantContentBlock[];
}) {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    session_id: sessionId,
    message: {
      role: 'assistant' as const,
      content,
    },
    parent_tool_use_id: null,
  };
}

export function buildToolResultEvent({
  sessionId,
  toolUseId,
  content,
  isError = false,
}: {
  sessionId: string;
  toolUseId: string;
  content: string;
  isError?: boolean;
}) {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
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
  durationMs,
}: {
  sessionId: string;
  usage: Usage;
  durationMs: number;
}) {
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
    total_cost_usd: 0,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cached_input_tokens,
    },
  };
}

export function buildCodexToolUseContent(item: ThreadItem): AssistantContentBlock | null {
  switch (item.type) {
    case 'command_execution':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'Bash',
        input: { command: item.command },
      };
    case 'mcp_tool_call':
      return {
        type: 'tool_use',
        id: item.id,
        name: `mcp__${item.server}__${item.tool}`,
        input: (item.arguments as Record<string, unknown>) ?? {},
      };
    case 'todo_list':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'TodoWrite',
        input: {
          todos: item.items.map((todo) => ({
            content: todo.text,
            status: todo.completed ? 'completed' : 'pending',
          })),
        },
      };
    case 'web_search':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'WebSearch',
        input: { query: item.query },
      };
    default:
      return null;
  }
}

export function buildCodexToolResultContent(
  item: CommandExecutionItem | McpToolCallItem | TodoListItem | WebSearchItem,
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
    case 'todo_list':
      return item.items.map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n');
    case 'web_search':
      return `Search completed for: ${item.query}`;
    default:
      return null;
  }
}

export function isCodexToolResultError(
  item: CommandExecutionItem | McpToolCallItem | TodoListItem | WebSearchItem,
): boolean {
  switch (item.type) {
    case 'command_execution':
    case 'mcp_tool_call':
      return item.status === 'failed';
    default:
      return false;
  }
}
