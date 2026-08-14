import type {
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadItem,
  TodoListItem,
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

export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

type ToolUseContext = {
  workdir?: string;
  timeoutMs?: number;
};

export function getRuntimeFlavor(agentKind?: string): RuntimeFlavor {
  if (agentKind === 'codex') {
    return 'codex';
  }
  if (agentKind === 'opencode') {
    return 'opencode';
  }
  return 'claude';
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
    todos: item.items.map((todo: { text: string; completed: boolean }) => ({
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
        ? `Patch ${item.status}: ${item.changes.map((change: { kind: string; path: string }) => `${change.kind} ${change.path}`).join(', ')}`
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
