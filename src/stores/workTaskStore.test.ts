import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkTask } from '../types/workTask';

const { list, create, archive, reorderApi, start } = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  archive: vi.fn(),
  reorderApi: vi.fn(),
  start: vi.fn(),
}));
vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    workTasks: {
      list,
      create,
      archive,
      reorder: reorderApi,
      start,
    },
  },
}));

// 引入放 mock 之后（vi.mock 会被提升，这里保持常规顺序即可）
import { useWorkTaskStore } from './workTaskStore';

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

describe('workTaskStore', () => {
  beforeEach(() => {
    list.mockReset();
    create.mockReset();
    archive.mockReset();
    reorderApi.mockReset();
    start.mockReset();
    useWorkTaskStore.setState({ tasks: [], isLoading: false });
  });

  it('fetchTasks loads tasks into state', async () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b', status: 'running' })];
    list.mockResolvedValue(tasks);

    await useWorkTaskStore.getState().fetchTasks();

    expect(useWorkTaskStore.getState().tasks).toEqual(tasks);
    expect(useWorkTaskStore.getState().isLoading).toBe(false);
  });

  it('fetchTasks keeps state on failure without throwing', async () => {
    list.mockRejectedValue(new Error('boom'));
    await expect(useWorkTaskStore.getState().fetchTasks()).resolves.toBeUndefined();
    expect(useWorkTaskStore.getState().tasks).toEqual([]);
  });

  it('createTask prepends the created task', async () => {
    const existing = makeTask({ id: 'a' });
    useWorkTaskStore.setState({ tasks: [existing] });
    const created = makeTask({ id: 'b' });
    create.mockResolvedValue(created);

    const result = await useWorkTaskStore.getState().createTask({
      title: 'b',
      instruction: '',
      projectId: 'p1',
      agentKind: 'claude_code',
      providerId: null,
      model: null,
      useWorktree: false,
      baseBranch: null,
    });

    expect(result).toEqual(created);
    expect(useWorkTaskStore.getState().tasks.map((task) => task.id)).toEqual(['b', 'a']);
  });

  it('archiveAllDone archives every unarchived done task then refetches', async () => {
    const done1 = makeTask({ id: 'd1', status: 'done' });
    const doneArchived = makeTask({ id: 'd2', status: 'done', archivedAt: '2026-01-02T00:00:00Z' });
    const failed = makeTask({ id: 'f1', status: 'failed' });
    useWorkTaskStore.setState({ tasks: [done1, doneArchived, failed] });
    archive.mockResolvedValue({ ...done1, archivedAt: '2026-01-03T00:00:00Z' });
    const refreshed = [
      makeTask({ id: 'd2', status: 'done', archivedAt: '2026-01-02T00:00:00Z' }),
      failed,
    ];
    list.mockResolvedValue(refreshed);

    await useWorkTaskStore.getState().archiveAllDone();

    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledWith('d1');
    expect(useWorkTaskStore.getState().tasks).toEqual(refreshed);
  });

  it('reorder updates sortOrder optimistically and rolls back on failure', async () => {
    const a = makeTask({ id: 'a', sortOrder: 0 });
    const b = makeTask({ id: 'b', sortOrder: 1 });
    const c = makeTask({ id: 'c', sortOrder: 2 });
    useWorkTaskStore.setState({ tasks: [a, b, c] });
    reorderApi.mockRejectedValue(new Error('boom'));
    list.mockResolvedValue([a, b, c]);

    await expect(
      useWorkTaskStore.getState().reorder('p1', ['b', 'a', 'c']),
    ).rejects.toThrow('boom');

    // 失败后先回滚快照，再由 fetchTasks 兜底刷新 → 顺序更新不残留。
    expect(useWorkTaskStore.getState().tasks.map((task) => task.sortOrder)).toEqual([0, 1, 2]);
  });

  it('reorder updates sortOrder optimistically on success', async () => {
    const a = makeTask({ id: 'a', sortOrder: 0 });
    const b = makeTask({ id: 'b', sortOrder: 1 });
    useWorkTaskStore.setState({ tasks: [a, b] });
    reorderApi.mockResolvedValue(undefined);

    await useWorkTaskStore.getState().reorder('p1', ['b', 'a']);

    const tasks = useWorkTaskStore.getState().tasks;
    expect(tasks.find((task) => task.id === 'a')?.sortOrder).toBe(1);
    expect(tasks.find((task) => task.id === 'b')?.sortOrder).toBe(0);
    expect(reorderApi).toHaveBeenCalledWith('p1', ['b', 'a']);
  });

  it('startTask flips status to queued optimistically then adopts the server row', async () => {
    const a = makeTask({ id: 'a', status: 'todo' });
    useWorkTaskStore.setState({ tasks: [a] });
    let resolveStart!: (task: WorkTask) => void;
    start.mockReturnValue(
      new Promise<WorkTask>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const pending = useWorkTaskStore.getState().startTask('a');
    // 请求返回前本地已置 queued（乐观），其他行不受影响。
    expect(useWorkTaskStore.getState().tasks.find((task) => task.id === 'a')?.status).toBe('queued');

    resolveStart(makeTask({ id: 'a', status: 'running' }));
    await pending;
    expect(useWorkTaskStore.getState().tasks.find((task) => task.id === 'a')?.status).toBe('running');
    expect(start).toHaveBeenCalledWith('a');
  });

  it('startTask rolls back to the snapshot and refetches on failure', async () => {
    const a = makeTask({ id: 'a', status: 'todo' });
    useWorkTaskStore.setState({ tasks: [a] });
    start.mockRejectedValue(new Error('boom'));
    const refreshed = makeTask({ id: 'a', status: 'todo' });
    list.mockResolvedValue([refreshed]);

    await expect(useWorkTaskStore.getState().startTask('a')).rejects.toThrow('boom');

    expect(useWorkTaskStore.getState().tasks.map((task) => task.status)).toEqual(['todo']);
  });
});
