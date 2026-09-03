import type { RuntimeFlavor } from './types.js';
export type { RuntimeFlavor } from './types.js';

/**
 * Codex thread item after the app-server adapter normalizes wire items to
 * snake_case. Replaces the SDK's generated item types (removed with the SDK
 * in the ADR 0010 hard cut) — only fields CodeMUX consumes are declared.
 */
export type CodexThreadItem = {
  type: string;
  id: string;
  command?: string;
  cwd?: string;
  aggregated_output?: string | null;
  exit_code?: number | null;
  status?: string;
  server?: string;
  tool?: string | null;
  arguments?: unknown;
  query?: string;
  text?: string;
  changes?: Array<{ kind: string; path: string; diff?: string }>;
  error?: { message?: string } | null;
  result?: { structured_content?: unknown; content?: unknown } | null;
  items?: Array<{ text: string; completed: boolean }>;
  /** collab_agent_tool_call: collab tool invoked against child agent threads. */
  prompt?: string | null;
  receiver_thread_ids?: string[];
  agents_states?: Record<string, string>;
};

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
  if (agentKind === 'pi') {
    return 'pi';
  }
  return 'claude';
}

export function buildCodexToolUseContent(item: CodexThreadItem, context: ToolUseContext = {}): AssistantContentBlock | null {
  switch (item.type) {
    case 'command_execution': {
      const input: Record<string, unknown> = { command: unwrapWindowsPowerShellCommand(item.command ?? '') };
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
        name: formatMcpToolName(item.server ?? '', item.tool ?? ''),
        input: (item.arguments as Record<string, unknown>) ?? {},
      };
    case 'web_search':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'WebSearch',
        input: { query: item.query },
      };
    case 'collab_agent_tool_call':
      // Only spawn calls launch a child and get a parent card (the clickable
      // Sub-agent track); wait/sendInput/closeAgent are orchestration noise.
      // The name must stay in the frontend `isSubAgentTool` whitelist so the
      // preview chip and panel binding attach to the descriptor.
      if (item.tool !== 'spawnAgent') {
        return null;
      }
      return {
        type: 'tool_use',
        id: item.id,
        name: 'subagent',
        input: {
          ...(item.prompt ? { prompt: item.prompt } : {}),
        },
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
  item: CodexThreadItem;
}) {
  return {
    type: 'codex_todo_list',
    session_id: sessionId,
    todos: (item.items ?? []).map((todo) => ({
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

export function buildCodexToolResultContent(item: CodexThreadItem): string | null {
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
      return (item.changes?.length ?? 0) > 0
        ? `Patch ${item.status}: ${item.changes?.map((change: { kind: string; path: string }) => `${change.kind} ${change.path}`).join(', ')}`
        : `Patch ${item.status}`;
    case 'collab_agent_tool_call': {
      // Full child thread ids — truncated prefixes collide on uuidv7 spawns
      // from the same millisecond.
      const entries = Object.entries(item.agents_states ?? {});
      if (entries.length === 0) {
        return `Sub-agent call ${item.status ?? 'unknown'}`;
      }
      return entries.map(([threadId, state]) => `${threadId}: ${state}`).join('\n');
    }
    default:
      return null;
  }
}

export function isCodexToolResultError(item: CodexThreadItem): boolean {
  switch (item.type) {
    case 'command_execution':
    case 'mcp_tool_call':
    case 'file_change':
    case 'collab_agent_tool_call':
      return item.status === 'failed';
    default:
      return false;
  }
}

/**
 * Adapts an app-server ThreadItem (camelCase) to the snake_case shape consumed
 * by the shared runtimeEvents tool-use/result builders. Lives here (not in the
 * runtime) so the Codex subagent child-thread projection can reuse it without
 * a module cycle. Unknown item types return null and are dropped.
 */
export function adaptAppServerItem(item: Record<string, unknown> | null | undefined): CodexThreadItem | null {
  if (!item) {
    return null;
  }
  const id = readStringField(item.id);
  if (id === null) {
    return null;
  }
  switch (item.type) {
    case 'agentMessage':
      return { type: 'agent_message', id, text: readStringField(item.text) ?? '' };
    case 'plan':
      return { type: 'plan', id, text: readStringField(item.text) ?? '' };
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      const text = [...summary, ...content]
        .filter((part): part is string => typeof part === 'string')
        .join('\n\n');
      return { type: 'reasoning', id, text };
    }
    case 'commandExecution':
      return {
        type: 'command_execution',
        id,
        command: readStringField(item.command) ?? '',
        cwd: readStringField(item.cwd) ?? '',
        aggregated_output: readStringField(item.aggregatedOutput) ?? '',
        exit_code: typeof item.exitCode === 'number' ? item.exitCode : null,
        status: adaptItemStatus(item.status),
      };
    case 'fileChange':
      return {
        type: 'file_change',
        id,
        changes: Array.isArray(item.changes)
          ? item.changes.filter(isRecordValue).map((change) => ({
            kind: readStringField(change.kind) ?? '',
            path: readStringField(change.path) ?? '',
            ...(readStringField(change.diff) ? { diff: readStringField(change.diff)! } : {}),
          }))
          : [],
        status: adaptItemStatus(item.status),
      };
    case 'mcpToolCall':
      return {
        type: 'mcp_tool_call',
        id,
        server: readStringField(item.server) ?? '',
        tool: readStringField(item.tool) ?? '',
        arguments: item.arguments ?? {},
        status: adaptItemStatus(item.status),
        error: isRecordValue(item.error) ? { message: readStringField(item.error.message) ?? undefined } : null,
        result: isRecordValue(item.result)
          ? {
            structured_content: item.result.structuredContent,
            content: item.result.content,
          }
          : null,
      };
    case 'webSearch':
      return { type: 'web_search', id, query: readStringField(item.query) ?? '' };
    case 'contextCompaction':
      return { type: 'context_compaction', id };
    case 'collabAgentToolCall':
      return {
        type: 'collab_agent_tool_call',
        id,
        tool: readStringField(item.tool),
        prompt: readStringField(item.prompt),
        status: adaptItemStatus(item.status),
        receiver_thread_ids: Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
          : [],
        agents_states: collectAgentsStates(item.agentsStates),
      };
    // subAgentActivity items carry no parent-renderable content — the collab
    // tool call card is the parent-side representation; activity items only
    // feed the subagent observation source.
    default:
      return null;
  }
}

function collectAgentsStates(value: unknown): Record<string, string> {
  if (!isRecordValue(value)) {
    return {};
  }
  const states: Record<string, string> = {};
  for (const [threadId, state] of Object.entries(value)) {
    if (typeof state === 'string') {
      states[threadId] = state;
      continue;
    }
    const status = isRecordValue(state) ? readStringField(state.status) : null;
    if (status) {
      states[threadId] = status;
    }
  }
  return states;
}

function adaptItemStatus(value: unknown): string {
  switch (value) {
    case 'inProgress':
      return 'in_progress';
    case 'completed':
    case 'failed':
    case 'declined':
      return value;
    default:
      return 'in_progress';
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
