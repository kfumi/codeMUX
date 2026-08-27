import { describe, expect, it } from 'vitest';

import { extractTodosFromEvents, type TodoExtractionEvent } from './extractTodosFromEvents';

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): TodoExtractionEvent {
  return {
    kind: 'assistant',
    data: {
      message: {
        content: [{ type: 'tool_use', id, name, input }],
      },
    },
  };
}

function toolResult(
  toolUseId: string,
  extra: Record<string, unknown> = {},
  isError = false,
): TodoExtractionEvent {
  return {
    kind: 'tool_result',
    data: {
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          ...(isError ? { is_error: true } : {}),
        }],
      },
      ...extra,
    },
  };
}

describe('extractTodosFromEvents', () => {
  it('replaces the list from OpenCode todowrite with explicit statuses', () => {
    const todos = extractTodosFromEvents([
      assistantToolUse('tw-1', 'todowrite', {
        todos: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'in_progress' },
        ],
      }),
    ]);

    expect(todos).toEqual([
      { content: 'A', status: 'completed', activeForm: undefined },
      { content: 'B', status: 'in_progress', activeForm: undefined },
    ]);
  });

  it('replaces the list from Codex update_plan', () => {
    const todos = extractTodosFromEvents([
      assistantToolUse('plan-1', 'update_plan', {
        plan: [
          { step: 'Step 1', status: 'completed' },
          { step: 'Step 2', status: 'pending' },
        ],
      }),
    ]);

    expect(todos).toEqual([
      { content: 'Step 1', status: 'completed', activeForm: undefined },
      { content: 'Step 2', status: 'pending', activeForm: undefined },
    ]);
  });

  it('ignores legacy Claude TodoWrite (PascalCase)', () => {
    const todos = extractTodosFromEvents([
      assistantToolUse('legacy-1', 'TodoWrite', {
        todos: [{ content: 'Legacy task', status: 'completed' }],
      }),
    ]);

    expect(todos).toEqual([]);
  });

  it('commits TaskCreate only after a successful tool_result with task id', () => {
    const events: TodoExtractionEvent[] = [
      assistantToolUse('create-1', 'TaskCreate', {
        subject: 'First task',
        activeForm: 'Doing first',
      }),
    ];

    expect(extractTodosFromEvents(events)).toEqual([]);

    events.push(toolResult('create-1', {
      toolUseResult: { task: { id: '1', subject: 'First task' } },
    }));

    expect(extractTodosFromEvents(events)).toEqual([
      { content: 'First task', status: 'pending', activeForm: 'Doing first' },
    ]);
  });

  it('does not add TaskCreate when tool_result is an error', () => {
    const todos = extractTodosFromEvents([
      assistantToolUse('create-1', 'TaskCreate', { subject: 'Failed task' }),
      toolResult('create-1', {}, true),
    ]);

    expect(todos).toEqual([]);
  });

  it('applies TaskUpdate by taskId, id, or task_id', () => {
    const base: TodoExtractionEvent[] = [
      assistantToolUse('create-1', 'TaskCreate', { subject: 'Task A' }),
      toolResult('create-1', { toolUseResult: { task: { id: '1', subject: 'Task A' } } }),
      assistantToolUse('create-2', 'TaskCreate', { subject: 'Task B' }),
      toolResult('create-2', { toolUseResult: { task: { id: '2', subject: 'Task B' } } }),
    ];

    expect(extractTodosFromEvents([
      ...base,
      assistantToolUse('update-1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
    ])).toEqual([
      { content: 'Task A', status: 'in_progress', activeForm: undefined },
      { content: 'Task B', status: 'pending', activeForm: undefined },
    ]);

    expect(extractTodosFromEvents([
      ...base,
      assistantToolUse('update-2', 'TaskUpdate', { id: '2', status: 'completed' }),
    ])).toEqual([
      { content: 'Task A', status: 'pending', activeForm: undefined },
      { content: 'Task B', status: 'completed', activeForm: undefined },
    ]);
  });

  it('does not infer completion from unrelated Bash tool calls (JSONL regression)', () => {
    const events: TodoExtractionEvent[] = [
      assistantToolUse('call_a407848b480d4979b1666304', 'TaskCreate', {
        subject: '修订设计文档 dashboard-optimization-design.md',
        activeForm: '修订设计文档',
      }),
      assistantToolUse('call_488b018553aa4053992c0079', 'TaskCreate', {
        subject: '修订4个需求计划文档',
        activeForm: '修订四个计划文档',
      }),
      toolResult('call_a407848b480d4979b1666304', {
        toolUseResult: { task: { id: '1', subject: '修订设计文档 dashboard-optimization-design.md' } },
      }),
      toolResult('call_488b018553aa4053992c0079', {
        toolUseResult: { task: { id: '2', subject: '修订4个需求计划文档' } },
      }),
    ];

    for (let i = 0; i < 9; i += 1) {
      const bashId = `bash-${i}`;
      events.push(assistantToolUse(bashId, 'Bash', { command: 'echo test' }));
      events.push(toolResult(bashId));
    }

    events.push(assistantToolUse('call_f22b95063c04485f8185dce0', 'TaskUpdate', {
      taskId: '1',
      status: 'in_progress',
    }));

    expect(extractTodosFromEvents(events)).toEqual([
      {
        content: '修订设计文档 dashboard-optimization-design.md',
        status: 'in_progress',
        activeForm: '修订设计文档',
      },
      {
        content: '修订4个需求计划文档',
        status: 'pending',
        activeForm: '修订四个计划文档',
      },
    ]);
  });
});
