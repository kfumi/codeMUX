import type { TodoItem } from '../types/agent';
import { parseTodoItemsFromArgs } from './todoToolArgs';

type AssistantToolUseBlock = {
  type?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
};

type ToolResultBlock = {
  type?: string;
  tool_use_id?: string;
  is_error?: boolean;
};

type TodoEventData = {
  message?: {
    content?: unknown[];
  };
  tool_use_result?: unknown;
  toolUseResult?: unknown;
};

export type TodoExtractionEvent = {
  kind: string;
  data?: TodoEventData;
};

type PendingTaskCreate = {
  subject: string;
  activeForm?: string;
};

function isTodoListReplacementTool(name: string): boolean {
  return name === 'todowrite' || name === 'update_plan';
}

function isTaskCreateTool(name: string): boolean {
  return name === 'TaskCreate' || name === 'taskcreate';
}

function isTaskUpdateTool(name: string): boolean {
  return name === 'TaskUpdate' || name === 'taskupdate';
}

function readTaskUpdateId(input: Record<string, unknown>): string | undefined {
  const raw = input.taskId ?? input.id ?? input.task_id;
  if (raw == null || raw === '') return undefined;
  return String(raw);
}

function asToolUseBlock(block: unknown): AssistantToolUseBlock | undefined {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const record = block as AssistantToolUseBlock;
  return record.type === 'tool_use' ? record : undefined;
}

function asToolResultBlock(block: unknown): ToolResultBlock | undefined {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const record = block as ToolResultBlock;
  return record.type === 'tool_result' ? record : undefined;
}

function parseTaskCreateOutput(data: TodoEventData): { id: string; subject?: string } | undefined {
  const raw = data.tool_use_result ?? data.toolUseResult;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const task = (raw as Record<string, unknown>).task;
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return undefined;
  }
  const taskRecord = task as Record<string, unknown>;
  const id = taskRecord.id ?? taskRecord.task_id;
  if (id == null || id === '') {
    return undefined;
  }
  const subject = taskRecord.subject;
  return {
    id: String(id),
    subject: typeof subject === 'string' && subject.length > 0 ? subject : undefined,
  };
}

/**
 * Extract the current todo list from a stream of agent events.
 * Accepts the full AgentMessage union; only assistant/tool_result events are read.
 * - OpenCode: `todowrite` (full list replacement with explicit statuses)
 * - Codex: `update_plan` (full list replacement)
 * - Claude Code: `TaskCreate` (commit on successful tool_result) + `TaskUpdate` (incremental)
 */
export function extractTodosFromEvents(events: ReadonlyArray<{ kind: string; data?: unknown }>): TodoItem[] {
  let todos: TodoItem[] = [];
  const taskMap = new Map<string, TodoItem>();
  const pendingCreates = new Map<string, PendingTaskCreate>();
  let nextTaskId = 1;

  for (const evt of events) {
    const data = evt.data as TodoEventData | undefined;
    if (evt.kind === 'assistant') {
      const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];

      for (const rawBlock of blocks) {
        const block = asToolUseBlock(rawBlock);
        if (!block?.name) continue;

        if (isTodoListReplacementTool(block.name)) {
          const input = block.input ?? {};
          // 字段名各家不同（`todos[].content` / `plan[].step` …），解析集中在 todoToolArgs。
          const newTodos = parseTodoItemsFromArgs(input);
          if (newTodos) {
            todos = newTodos;
            taskMap.clear();
            newTodos.forEach((t, i) => {
              taskMap.set(String(i + 1), t);
            });
          }
          continue;
        }

        if (isTaskCreateTool(block.name)) {
          const input = block.input ?? {};
          if (typeof block.id === 'string') {
            pendingCreates.set(block.id, {
              subject: String(input.subject || input.description || ''),
              activeForm: typeof input.activeForm === 'string'
                ? input.activeForm
                : typeof input.active_form === 'string'
                  ? input.active_form
                  : undefined,
            });
          }
          continue;
        }

        if (isTaskUpdateTool(block.name)) {
          const input = block.input ?? {};
          const taskId = readTaskUpdateId(input);
          if (taskId && taskMap.has(taskId)) {
            const item = taskMap.get(taskId)!;
            if (input.status) {
              const status = String(input.status);
              item.status = (['pending', 'in_progress', 'completed', 'deleted'].includes(status)
                ? status === 'deleted' ? 'completed' : status
                : 'pending') as TodoItem['status'];
            }
            if (input.subject) item.content = String(input.subject);
            const activeForm = input.activeForm ?? input.active_form;
            if (typeof activeForm === 'string') item.activeForm = activeForm;
          }
          continue;
        }
      }
    }

    if (evt.kind === 'tool_result') {
      const toolData = evt.data as TodoEventData | undefined;
      if (!toolData) continue;
      const rawContent = toolData.message?.content;
      if (!Array.isArray(rawContent)) continue;

      for (const rawResult of rawContent) {
        const result = asToolResultBlock(rawResult);
        if (!result || typeof result.tool_use_id !== 'string') continue;
        const pending = pendingCreates.get(result.tool_use_id);
        if (!pending) continue;

        pendingCreates.delete(result.tool_use_id);
        if (result.is_error) continue;

        const created = parseTaskCreateOutput(toolData);
        const taskId = created?.id ?? String(nextTaskId++);
        const item: TodoItem = {
          content: created?.subject ?? pending.subject,
          status: 'pending',
          activeForm: pending.activeForm,
        };
        taskMap.set(taskId, item);
        todos.push(item);
      }
    }
  }

  return todos;
}
