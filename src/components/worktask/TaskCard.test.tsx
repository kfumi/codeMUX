// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkTask } from '../../types/workTask';
const { storeMock } = vi.hoisted(() => {
  const storeState = {
    tasks: [] as unknown[],
    isLoading: false,
    startTask: vi.fn(),
    cancelTask: vi.fn(),
    retryTask: vi.fn(),
    restartTask: vi.fn(),
    mergeTask: vi.fn(),
    completeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    deleteTask: vi.fn(),
  };
  const storeMock = Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    { getState: () => storeState },
  );
  return { storeMock };
});
vi.mock('../../stores/workTaskStore', () => ({
  useWorkTaskStore: storeMock,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { TaskCard } from './TaskCard';

function makeTask(overrides: Partial<WorkTask> & Pick<WorkTask, 'id' | 'status'>): WorkTask {
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
    failureReason: null,
    lastError: null,
    runSeq: 0,
    sortOrder: 0,
    sessionId: 'session-1',
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

const noop = vi.fn();

describe('TaskCard', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the title and status label', () => {
    render(
      <TaskCard task={makeTask({ id: 'a', status: 'todo' })} onOpen={noop} onEdit={noop} onOpenSession={noop} />,
    );
    expect(screen.getByText('修复登录页')).toBeTruthy();
    expect(screen.getByText('待办')).toBeTruthy();
  });

  it('shows the failed row with lastError and offers retry/restart', () => {
    render(
      <TaskCard
        task={makeTask({ id: 'a', status: 'failed', lastError: '进程崩溃' })}
        onOpen={noop}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('进程崩溃')).toBeTruthy();
    expect(screen.getByText('重试')).toBeTruthy();
    expect(screen.getByText('重新开始')).toBeTruthy();
  });

  it('shows interrupted badge when failureReason is interrupted', () => {
    render(
      <TaskCard
        task={makeTask({ id: 'a', status: 'failed', failureReason: 'interrupted', lastError: 'x' })}
        onOpen={noop}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );
    expect(screen.getByText('已中断')).toBeTruthy();
  });

  it('hides failed row when lastError is null', () => {
    render(
      <TaskCard task={makeTask({ id: 'a', status: 'failed' })} onOpen={noop} onEdit={noop} onOpenSession={noop} />,
    );
    expect(screen.queryByText('进程崩溃')).toBeNull();
  });

  it('action matrix: todo has start/edit, no cancel', () => {
    render(
      <TaskCard task={makeTask({ id: 'a', status: 'todo' })} onOpen={noop} onEdit={noop} onOpenSession={noop} />,
    );
    expect(screen.getByText('开始')).toBeTruthy();
    expect(screen.getByText('编辑')).toBeTruthy();
    expect(screen.queryByText('取消')).toBeNull();
  });

  it('action matrix: running only offers cancel', () => {
    render(
      <TaskCard task={makeTask({ id: 'a', status: 'running' })} onOpen={noop} onEdit={noop} onOpenSession={noop} />,
    );
    expect(screen.getByText('取消')).toBeTruthy();
    expect(screen.queryByText('开始')).toBeNull();
    expect(screen.queryByText('编辑')).toBeNull();
  });

  it('action matrix: merging has no actions', () => {
    render(
      <TaskCard task={makeTask({ id: 'a', status: 'merging' })} onOpen={noop} onEdit={noop} onOpenSession={noop} />,
    );
    expect(screen.queryByText('取消')).toBeNull();
    expect(screen.queryByText('开始')).toBeNull();
  });

  it('done offers archive and delete', () => {
    render(
      <TaskCard task={makeTask({ id: 'a', status: 'done' })} onOpen={noop} onEdit={noop} onOpenSession={noop} />,
    );
    expect(screen.getByText('归档')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
  });

  it('calls onOpen on click', () => {
    const onOpen = vi.fn();
    render(
      <TaskCard task={makeTask({ id: 'a', status: 'todo' })} onOpen={onOpen} onEdit={noop} onOpenSession={noop} />,
    );
    fireEvent.click(screen.getByText('修复登录页'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('review shows diff stats and result summary', () => {
    render(
      <TaskCard
        task={makeTask({ id: 'a', status: 'review', additions: 12, deletions: 3, resultSummary: '改好了' })}
        onOpen={noop}
        onEdit={noop}
        onOpenSession={noop}
      />,
    );
    expect(screen.getByText('+12')).toBeTruthy();
    expect(screen.getByText('-3')).toBeTruthy();
    expect(screen.getByText('改好了')).toBeTruthy();
  });
  it('drag start publishes text/worktask-id and drop fires the column onDrop callback', () => {
    const task = makeTask({ id: 'a', status: 'todo' });
    const onDrop = vi.fn();
    const setData = vi.fn();
    render(
      <TaskCard
        task={task}
        onOpen={noop}
        onEdit={noop}
        onOpenSession={noop}
        draggable
        onDrop={onDrop}
      />,
    );
    const card = screen.getByText('修复登录页').closest('[role="button"]') as HTMLElement;

    fireEvent.dragStart(card, {
      dataTransfer: {
        effectAllowed: '',
        setData,
      } as unknown as DataTransfer,
    });
    expect(setData).toHaveBeenCalledWith('text/worktask-id', 'a');
    fireEvent.drop(card, {
      dataTransfer: {} as unknown as DataTransfer,
    });
    // 卡片上的 drop 回调把被拖拽目标交给宿主（看板按目标列区分排序/启动语义）。
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(task);
  });
});
