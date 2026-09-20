import { describe, expect, it } from 'vitest';

import type { WorkTask, WorkTaskStatus } from '../../types/workTask';
import {
  BOARD_COLUMN_IDS,
  STATUSES_BY_COLUMN,
  columnForStatus,
  filterTasksForList,
  groupTasksByColumn,
  sortTasksForDisplay,
} from './board-columns';

const ALL_STATUSES: WorkTaskStatus[] = [
  'todo',
  'queued',
  'preparing',
  'running',
  'awaiting_input',
  'review',
  'merging',
  'done',
  'failed',
  'canceled',
];

function makeTask(overrides: Partial<WorkTask> & Pick<WorkTask, 'id'>): WorkTask {
  const now = new Date('2026-01-01T00:00:00Z').toISOString();
  return {
    projectId: 'p1',
    title: overrides.id,
    instruction: '',
    agentKind: 'claude_code',
    providerId: null,
    model: null,
    useWorktree: false,
    baseBranch: null,
    workBranch: null,
    worktreePath: null,
    status: 'todo',
    failureReason: null,
    lastError: null,
    runSeq: 0,
    sortOrder: 0,
    sessionId: null,
    resultSummary: null,
    filesChanged: null,
    additions: null,
    deletions: null,
    mergeCommit: null,
    completionKind: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    settledAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('board columns guard', () => {
  it('covers all 10 statuses exactly once', () => {
    const assigned = BOARD_COLUMN_IDS.flatMap((column) => STATUSES_BY_COLUMN[column]);
    expect(assigned).toHaveLength(ALL_STATUSES.length);
    expect(new Set(assigned)).toEqual(new Set(ALL_STATUSES));
  });

  it('columnForStatus maps each status to its column', () => {
    expect(columnForStatus('todo')).toBe('todo');
    expect(columnForStatus('queued')).toBe('todo');
    expect(columnForStatus('running')).toBe('inProgress');
    expect(columnForStatus('failed')).toBe('attention');
    expect(columnForStatus('done')).toBe('done');
    expect(columnForStatus('canceled')).toBe('done');
  });
});

describe('groupTasksByColumn', () => {
  it('hides canceled unless showCanceled is true', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'done' }),
      makeTask({ id: 'b', status: 'canceled' }),
    ];
    const hidden = groupTasksByColumn(tasks, false, false);
    expect(hidden.done.map((task) => task.id)).toEqual(['a']);
    const shown = groupTasksByColumn(tasks, true, false);
    expect(shown.done.map((task) => task.id)).toEqual(['a', 'b']);
  });

  it('hides archived unless showArchived is true', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'done' }),
      makeTask({ id: 'b', status: 'todo', archivedAt: '2026-01-02T00:00:00Z' }),
    ];
    const hidden = groupTasksByColumn(tasks, false, false);
    expect(hidden.todo).toHaveLength(0);
    expect(hidden.done.map((task) => task.id)).toEqual(['a']);
    const shown = groupTasksByColumn(tasks, false, true);
    expect(shown.todo.map((task) => task.id)).toEqual(['b']);
  });

  it('sorts each column by updatedAt descending', () => {
    const tasks = [
      makeTask({ id: 'old', status: 'todo', updatedAt: '2026-01-01T00:00:00Z' }),
      makeTask({ id: 'new', status: 'todo', updatedAt: '2026-01-03T00:00:00Z' }),
      makeTask({ id: 'mid', status: 'todo', updatedAt: '2026-01-02T00:00:00Z' }),
    ];
    const grouped = groupTasksByColumn(tasks, false, false);
    expect(grouped.todo.map((task) => task.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('filterTasksForList', () => {
  const tasks = [
    makeTask({ id: 'a', status: 'todo' }),
    makeTask({ id: 'b', status: 'running' }),
    makeTask({ id: 'c', status: 'canceled' }),
    makeTask({ id: 'd', status: 'done', archivedAt: '2026-01-02T00:00:00Z' }),
  ];

  it('filters by column when given', () => {
    const result = filterTasksForList(tasks, 'inProgress', false, false);
    expect(result.map((task) => task.id)).toEqual(['b']);
  });

  it('returns all columns when column is null', () => {
    expect(filterTasksForList(tasks, null, false, false)).toHaveLength(2);
    expect(filterTasksForList(tasks, null, true, true)).toHaveLength(4);
  });
});

describe('sortTasksForDisplay', () => {
  it('sorts the todo column by sortOrder for a single project', () => {
    const tasks = [
      makeTask({ id: 'b', status: 'todo', sortOrder: 1 }),
      makeTask({ id: 'a', status: 'todo', sortOrder: 0 }),
    ];
    const sorted = sortTasksForDisplay(tasks, 'todo', 'p1');
    expect(sorted.map((task) => task.id)).toEqual(['a', 'b']);
  });

  it('keeps updatedAt ordering for other columns', () => {
    const tasks = [
      makeTask({ id: 'old', status: 'running', sortOrder: 5, updatedAt: '2026-01-01T00:00:00Z' }),
      makeTask({ id: 'new', status: 'running', sortOrder: 1, updatedAt: '2026-01-03T00:00:00Z' }),
    ];
    const sorted = sortTasksForDisplay(tasks, 'inProgress', 'p1');
    expect(sorted.map((task) => task.id)).toEqual(['new', 'old']);
  });
});
