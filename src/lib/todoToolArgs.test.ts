import { describe, expect, it } from 'vitest';
import { getTodoListForTool, isTodoListTool, parseTodoItemsFromArgs, readTodoExplanation } from './todoToolArgs';

describe('isTodoListTool', () => {
  it('matches todo tools regardless of case and separators', () => {
    expect(isTodoListTool('TodoWrite')).toBe(true);
    expect(isTodoListTool('todowrite')).toBe(true);
    expect(isTodoListTool('TodoWRITE')).toBe(true);
    expect(isTodoListTool('update_plan')).toBe(true);
    expect(isTodoListTool('updatePlan')).toBe(true);
  });

  it('does not match unrelated tools', () => {
    expect(isTodoListTool('Bash')).toBe(false);
    expect(isTodoListTool('TaskUpdate')).toBe(false);
    expect(isTodoListTool('ExitPlanMode')).toBe(false);
  });
});

describe('parseTodoItemsFromArgs', () => {
  it('parses Claude / OpenCode todos[]', () => {
    expect(parseTodoItemsFromArgs({
      todos: [
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'in_progress', activeForm: '正在做 B' },
        { content: 'C', status: 'pending' },
      ],
    })).toEqual([
      { content: 'A', status: 'completed', activeForm: undefined },
      { content: 'B', status: 'in_progress', activeForm: '正在做 B' },
      { content: 'C', status: 'pending', activeForm: undefined },
    ]);
  });

  it('parses Codex plan[] with step field', () => {
    expect(parseTodoItemsFromArgs({
      explanation: 'all done',
      plan: [
        { step: 'Task 1', status: 'completed' },
        { step: 'Task 2', status: 'pending' },
      ],
    })).toEqual([
      { content: 'Task 1', status: 'completed', activeForm: undefined },
      { content: 'Task 2', status: 'pending', activeForm: undefined },
    ]);
  });

  it('parses items[] with text + completed boolean', () => {
    expect(parseTodoItemsFromArgs({
      items: [{ text: 'done thing', completed: true }, { text: 'todo thing', completed: false }],
    })).toEqual([
      { content: 'done thing', status: 'completed', activeForm: undefined },
      { content: 'todo thing', status: 'pending', activeForm: undefined },
    ]);
  });

  it('normalizes status aliases and hyphenated spellings', () => {
    const items = parseTodoItemsFromArgs({
      todos: [
        { content: 'a', status: 'in-progress' },
        { content: 'b', status: 'DONE' },
        { content: 'c', status: 'weird-value' },
      ],
    });
    expect(items?.map((item) => item.status)).toEqual(['in_progress', 'completed', 'pending']);
  });

  it('accepts plain string entries', () => {
    expect(parseTodoItemsFromArgs({ todos: ['first', 'second'] })).toEqual([
      { content: 'first', status: 'pending' },
      { content: 'second', status: 'pending' },
    ]);
  });

  it('reads active_form as an alias of activeForm', () => {
    expect(parseTodoItemsFromArgs({
      todos: [{ content: 'A', status: 'in_progress', active_form: '正在做 A' }],
    })?.[0].activeForm).toBe('正在做 A');
  });

  it('returns null when the input carries no todo list', () => {
    expect(parseTodoItemsFromArgs(undefined)).toBeNull();
    expect(parseTodoItemsFromArgs({})).toBeNull();
    expect(parseTodoItemsFromArgs({ todos: [] })).toBeNull();
    // `plan` 字符串(ExitPlanMode)不是待办列表
    expect(parseTodoItemsFromArgs({ plan: '## 计划正文' })).toBeNull();
  });

  it('drops entries without readable text', () => {
    expect(parseTodoItemsFromArgs({ todos: [{ status: 'pending' }, { content: 'kept' }] })).toEqual([
      { content: 'kept', status: 'pending', activeForm: undefined },
    ]);
  });
});

describe('getTodoListForTool', () => {
  it('returns the parsed list for a known todo tool', () => {
    expect(getTodoListForTool('TodoWrite', { todos: [{ content: 'A', status: 'pending' }] })).toHaveLength(1);
  });

  it('returns an empty list for a todo tool without a parseable list, so raw args stay hidden', () => {
    expect(getTodoListForTool('TodoWrite', {})).toEqual([]);
    expect(getTodoListForTool('update_plan', { explanation: 'done' })).toEqual([]);
  });

  it('returns null for non-todo tools that merely carry a plan array', () => {
    expect(getTodoListForTool('Task', { plan: [{ step: 'x', status: 'pending' }] })).toBeNull();
    expect(getTodoListForTool('ExitPlanMode', { plan: '## 计划正文' })).toBeNull();
    expect(getTodoListForTool('Bash', { command: 'ls' })).toBeNull();
  });

  it('still renders an unknown runtime todo tool that uses todos[]', () => {
    expect(getTodoListForTool('some_future_todo_tool', {
      todos: [{ content: 'A', status: 'pending' }],
    })).toHaveLength(1);
  });
});

describe('readTodoExplanation', () => {
  it('reads the Codex explanation', () => {
    expect(readTodoExplanation({ explanation: 'all done' })).toBe('all done');
  });

  it('returns undefined when absent', () => {
    expect(readTodoExplanation({})).toBeUndefined();
    expect(readTodoExplanation(undefined)).toBeUndefined();
    expect(readTodoExplanation({ explanation: '  ' })).toBeUndefined();
  });
});
