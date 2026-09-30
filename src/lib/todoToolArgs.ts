import type { TodoItem } from '../types/agent';

/**
 * 待办工具参数的解析。各 runtime 的字段名不一样：
 * - Claude / OpenCode：`todos: [{ content, status, activeForm }]`
 * - Codex：`plan: [{ step, status }]`（外加顶层 `explanation`）
 * - pi / 未知 runtime：模型自己给什么形状就按结构嗅探（`todos`/`plan`/`items`/`steps` 数组）
 * 所以这里只认「数组 + 每项能读出文本」，不绑定具体工具名。
 */

const TODO_LIST_KEYS = ['todos', 'plan', 'items', 'steps'] as const;

const TODO_TEXT_KEYS = ['content', 'step', 'text', 'title', 'task', 'description'] as const;

const TODO_ACTIVE_FORM_KEYS = ['activeForm', 'active_form'] as const;

const TODO_LIST_TOOL_NAMES = new Set(['todowrite', 'updateplan', 'writetodo', 'todo']);

// key 一律去掉分隔符（小写），查找前先做同样归一化，因此 `in_progress` / `in-progress`
// / `In Progress` 都映射到同一条。
const TODO_STATUS_ALIASES: Record<string, TodoItem['status']> = {
  pending: 'pending',
  todo: 'pending',
  notstarted: 'pending',
  queued: 'pending',
  inprogress: 'in_progress',
  active: 'in_progress',
  doing: 'in_progress',
  running: 'in_progress',
  started: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  finished: 'completed',
  deleted: 'completed',
  cancelled: 'completed',
  canceled: 'completed',
};

/** 归一化工具名（去分隔符 + 小写），用于待办类工具的大小写/别名无关匹配。 */
function normalizeToolKey(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[-_\s]/g, '');
}

export function isTodoListTool(toolName: string): boolean {
  return TODO_LIST_TOOL_NAMES.has(normalizeToolKey(toolName));
}

function readText(record: Record<string, unknown>): string {
  for (const key of TODO_TEXT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

function readActiveForm(record: Record<string, unknown>): string | undefined {
  for (const key of TODO_ACTIVE_FORM_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

/** 状态归一化：兼容 `in-progress` 写法、`completed: true` 布尔写法与 `in_progress: true`。 */
export function normalizeTodoStatus(record: Record<string, unknown>): TodoItem['status'] {
  const raw = record.status;
  if (typeof raw === 'string') {
    return TODO_STATUS_ALIASES[raw.trim().toLowerCase().replace(/[-_\s]/g, '')] ?? 'pending';
  }
  if (record.completed === true) return 'completed';
  if (record.done === true) return 'completed';
  if (record.in_progress === true) return 'in_progress';
  return 'pending';
}

function parseTodoEntry(entry: unknown): TodoItem | null {
  if (typeof entry === 'string') {
    const content = entry.trim();
    return content ? { content, status: 'pending' } : null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const content = readText(record);
  if (!content) return null;

  return {
    content,
    status: normalizeTodoStatus(record),
    activeForm: readActiveForm(record),
  };
}

/** 从任意工具参数里嗅探待办列表；不是待办形状时返回 `null`。 */
export function parseTodoItemsFromArgs(
  input: Record<string, unknown> | null | undefined,
): TodoItem[] | null {
  if (!input) return null;

  for (const key of TODO_LIST_KEYS) {
    const value = input[key];
    if (!Array.isArray(value) || value.length === 0) continue;

    const items = value
      .map(parseTodoEntry)
      .filter((item): item is TodoItem => item !== null);
    if (items.length > 0) {
      return items;
    }
  }

  return null;
}

/**
 * 待办工具（`TodoWrite` / `update_plan` / …）的待办条目。
 * 已知待办工具即使解析不出条目也返回空数组，这样参数 JSON 不会又露出来。
 *
 * 未知 runtime（pi 等）只认 `todos` 数组这种明确标记；`plan` / `steps` 太通用
 * （`ExitPlanMode` 的计划正文、委派的步骤数组都会命中），不能单独作为依据。
 */
export function getTodoListForTool(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
): TodoItem[] | null {
  const items = parseTodoItemsFromArgs(input);
  if (isTodoListTool(toolName)) {
    return items ?? [];
  }
  if (!items) return null;

  const todos = input?.todos;
  return Array.isArray(todos) && todos.length > 0 ? items : null;
}

/** Codex `update_plan` 的 `explanation`：计划变更原因，渲染在列表上方。 */
export function readTodoExplanation(input: Record<string, unknown> | null | undefined): string | undefined {
  if (!input) return undefined;
  const raw = input.explanation ?? input.reason ?? input.note;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
