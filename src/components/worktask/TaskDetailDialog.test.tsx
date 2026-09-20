// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkTask, WorkTaskEvent } from '../../types/workTask';

const { listEvents, toastMocks, storeActions } = vi.hoisted(() => ({
  listEvents: vi.fn(),
  toastMocks: { success: vi.fn(), error: vi.fn() },
  storeActions: {
    startTask: vi.fn(),
    cancelTask: vi.fn(),
    retryTask: vi.fn(),
    restartTask: vi.fn(),
    mergeTask: vi.fn(),
    completeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    deleteTask: vi.fn(),
  },
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    workTasks: {
      listEvents,
    },
  },
}));

vi.mock('../../stores/workTaskStore', () => ({
  useWorkTaskStore: Object.assign(
    (selector?: (state: typeof storeActions) => unknown) =>
      selector ? selector(storeActions) : storeActions,
    { getState: () => storeActions },
  ),
}));

vi.mock('sonner', () => ({
  toast: toastMocks,
}));

import { TaskDetailDialog } from './TaskDetailDialog';

const noop = vi.fn();

function makeTask(overrides: Partial<WorkTask> & Pick<WorkTask, 'id'>): WorkTask {
  const now = new Date('2026-01-01T00:00:00Z').toISOString();
  return {
    projectId: 'p1',
    title: '修复登录页',
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

function makeEvent(overrides: Partial<WorkTaskEvent> & Pick<WorkTaskEvent, 'id' | 'kind'>): WorkTaskEvent {
  return {
    taskId: 't1',
    detail: null,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

describe('TaskDetailDialog 时间线与信息行', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('打开时拉取事件并按倒序展示中文时间线', async () => {
    listEvents.mockResolvedValue([
      makeEvent({ id: 1, kind: 'created', detail: '任务已创建' }),
      makeEvent({ id: 2, kind: 'start', detail: '第 1 次运行' }),
    ]);

    render(
      <TaskDetailDialog
        task={makeTask({ id: 't1' })}
        open
        onOpenChange={noop}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );

    await waitFor(() => {
      expect(listEvents).toHaveBeenCalledWith('t1');
      const rows = screen.getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain('启动');
      expect(rows[0].textContent).toContain('第 1 次运行');
      expect(rows[1].textContent).toContain('创建');
    });
  });

  it('拉取失败静默显示「暂无时间线」', async () => {
    listEvents.mockRejectedValue(new Error('boom'));

    render(
      <TaskDetailDialog
        task={makeTask({ id: 't1' })}
        open
        onOpenChange={noop}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('暂无时间线')).toBeTruthy();
    });
  });

  it('展示 sessionId / 工作分支 / 基线分支 / 完成方式，并提供查看会话入口', async () => {
    listEvents.mockResolvedValue([]);
    const onOpenSession = vi.fn();

    render(
      <TaskDetailDialog
        task={makeTask({
          id: 't1',
          status: 'done',
          sessionId: 'session-9',
          workBranch: 'worktask/t1',
          baseBranch: 'main',
          completionKind: 'merged',
        })}
        open
        onOpenChange={noop}
        onEdit={noop}
        onOpenSession={onOpenSession}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('worktask/t1')).toBeTruthy();
      expect(screen.getByText('main')).toBeTruthy();
      expect(screen.getByText('已合并')).toBeTruthy();
      expect(screen.getByText('session-9')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('查看会话'));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
  });

  it('done 且未合并时显示「未合并完成」', async () => {
    listEvents.mockResolvedValue([]);

    render(
      <TaskDetailDialog
        task={makeTask({
          id: 't1',
          status: 'done',
          completionKind: 'completed_without_merge',
        })}
        open
        onOpenChange={noop}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('未合并完成')).toBeTruthy();
    });
  });

  it('显示 diff 统计（+N text-success / -N text-destructive / 文件数）', async () => {
    listEvents.mockResolvedValue([]);

    render(
      <TaskDetailDialog
        task={makeTask({ id: 't1', filesChanged: 3, additions: 12, deletions: 4 })}
        open
        onOpenChange={noop}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('3 个文件')).toBeTruthy();
      expect(screen.getByText('+12').className).toContain('text-success');
      expect(screen.getByText('-4').className).toContain('text-destructive');
    });
  });

  it('canceled 且有 worktreePath 时显示「已保留工作分支」提示', async () => {
    listEvents.mockResolvedValue([]);

    render(
      <TaskDetailDialog
        task={makeTask({ id: 't1', status: 'canceled', worktreePath: 'C:/repo/.worktrees/t1' })}
        open
        onOpenChange={noop}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/已保留工作分支/)).toBeTruthy();
    });
  });

  it('动作失败时详情弹窗保持打开', async () => {
    listEvents.mockResolvedValue([]);
    storeActions.startTask.mockRejectedValue(new Error('busy'));
    const onOpenChange = vi.fn();

    render(
      <TaskDetailDialog
        task={makeTask({ id: 't1', status: 'todo' })}
        open
        onOpenChange={onOpenChange}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );

    fireEvent.click(screen.getByText('开始'));
    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalled();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('动作成功后关闭详情弹窗', async () => {
    listEvents.mockResolvedValue([]);
    storeActions.startTask.mockResolvedValue(makeTask({ id: 't1', status: 'queued' }));
    const onOpenChange = vi.fn();

    render(
      <TaskDetailDialog
        task={makeTask({ id: 't1', status: 'todo' })}
        open
        onOpenChange={onOpenChange}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );

    fireEvent.click(screen.getByText('开始'));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
