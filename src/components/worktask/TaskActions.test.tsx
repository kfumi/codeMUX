// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkTask } from '../../types/workTask';

const { storeActions, toastMocks } = vi.hoisted(() => ({
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
  toastMocks: { success: vi.fn(), error: vi.fn() },
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

import { TaskActions } from './TaskActions';

const noop = vi.fn();

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

function renderActions(task: WorkTask) {
  return render(
    <TaskActions task={task} onEdit={noop} onOpenSession={noop} onSettled={noop} />,
  );
}

describe('TaskActions 动作矩阵', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('awaiting_input 只有查看会话与取消，没有完成/合并/删除', () => {
    renderActions(makeTask({ id: 'a', status: 'awaiting_input' }));
    expect(screen.getByText('查看会话')).toBeTruthy();
    expect(screen.getByText('取消')).toBeTruthy();
    expect(screen.queryByText('完成')).toBeNull();
    expect(screen.queryByText('合并')).toBeNull();
    expect(screen.queryByText('删除')).toBeNull();
  });

  it('awaiting_input 无 sessionId 时不显示查看会话', () => {
    renderActions(makeTask({ id: 'a', status: 'awaiting_input', sessionId: null }));
    expect(screen.queryByText('查看会话')).toBeNull();
    expect(screen.getByText('取消')).toBeTruthy();
  });

  it('failed 有重试/重新开始/编辑，没有删除', () => {
    renderActions(makeTask({ id: 'a', status: 'failed', lastError: 'x' }));
    expect(screen.getByText('重试')).toBeTruthy();
    expect(screen.getByText('重新开始')).toBeTruthy();
    expect(screen.getByText('编辑')).toBeTruthy();
    expect(screen.queryByText('删除')).toBeNull();
  });

  it('canceled 有重新开始/归档/删除，没有取消归档', () => {
    renderActions(makeTask({ id: 'a', status: 'canceled' }));
    expect(screen.getByText('重新开始')).toBeTruthy();
    expect(screen.getByText('归档')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
    expect(screen.queryByText('取消归档')).toBeNull();
  });

  it('canceled 点击重新开始调用 restartTask 并在成功后回调 onSettled', async () => {
    storeActions.restartTask.mockResolvedValue(makeTask({ id: 'a', status: 'running' }));
    const onSettled = vi.fn();
    render(<TaskActions task={makeTask({ id: 'a', status: 'canceled' })} onSettled={onSettled} />);

    fireEvent.click(screen.getByText('重新开始'));

    await waitFor(() => {
      expect(storeActions.restartTask).toHaveBeenCalledWith('a');
      expect(onSettled).toHaveBeenCalledTimes(1);
    });
  });

  it('canceled 已归档时显示取消归档', () => {
    renderActions(makeTask({ id: 'a', status: 'canceled', archivedAt: '2026-01-02T00:00:00Z' }));
    expect(screen.getByText('取消归档')).toBeTruthy();
    expect(screen.queryByText('归档')).toBeNull();
  });

  it('review 无 workBranch（非 worktree）时没有合并按钮', () => {
    renderActions(makeTask({ id: 'a', status: 'review', workBranch: null }));
    expect(screen.getByText('完成')).toBeTruthy();
    expect(screen.queryByText('合并')).toBeNull();
  });

  it('review 有 workBranch 时有合并按钮，点击打开合并弹窗', async () => {
    renderActions(makeTask({ id: 'a', status: 'review', workBranch: 'worktask/a' }));
    fireEvent.click(screen.getByText('合并'));

    await waitFor(() => {
      // MergeDialog 内容出现在文档中（含「留空自动生成」提示）。
      expect(screen.getByText(/留空自动生成/)).toBeTruthy();
    });
    // 点击合并按钮本身不应直接触发 mergeTask。
    expect(storeActions.mergeTask).not.toHaveBeenCalled();
  });

  it('todo 有开始/编辑/删除，没有取消', () => {
    renderActions(makeTask({ id: 'a', status: 'todo' }));
    expect(screen.getByText('开始')).toBeTruthy();
    expect(screen.getByText('编辑')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
    expect(screen.queryByText('取消')).toBeNull();
  });

  it('card 布局：主动作图标+文字靠左，次要图标圆钮靠右', () => {
    const { container } = render(
      <TaskActions task={makeTask({ id: 'a', status: 'todo' })} onEdit={noop} layout="card" />,
    );
    // 主动作「开始」保留文字。
    expect(screen.getByText('开始')).toBeTruthy();
    // 次要动作「编辑」「删除」为纯图标按钮：仅 aria-label，无文字。
    expect(screen.getByLabelText('编辑')).toBeTruthy();
    expect(screen.getByLabelText('删除')).toBeTruthy();
    expect(screen.queryByText('编辑')).toBeNull();
    expect(screen.queryByText('删除')).toBeNull();
    // 主动作与次要动作分居两侧：两个分组 div，开始在第一组，编辑/删除在第二组。
    const groups = container.querySelectorAll('.justify-between > div');
    expect(groups).toHaveLength(2);
    expect(groups[0].contains(screen.getByLabelText('开始'))).toBe(true);
    expect(groups[1].contains(screen.getByLabelText('编辑'))).toBe(true);
    expect(groups[1].contains(screen.getByLabelText('删除'))).toBe(true);
  });

  it('list 布局：全部为图标圆钮（无文字，仅 aria-label）', () => {
    render(
      <TaskActions task={makeTask({ id: 'a', status: 'todo' })} onEdit={noop} layout="list" />,
    );
    expect(screen.getByLabelText('开始')).toBeTruthy();
    expect(screen.getByLabelText('编辑')).toBeTruthy();
    expect(screen.getByLabelText('删除')).toBeTruthy();
    expect(screen.queryByText('开始')).toBeNull();
    expect(screen.queryByText('编辑')).toBeNull();
  });

  it('queued/preparing/running 只有取消', () => {
    for (const status of ['queued', 'preparing', 'running'] as const) {
      const { container, unmount } = renderActions(makeTask({ id: 'a', status }));
      expect(screen.getByText('取消')).toBeTruthy();
      expect(screen.queryByText('开始')).toBeNull();
      expect(screen.queryByText('编辑')).toBeNull();
      unmount();
      cleanup();
      void container;
    }
  });

  it('merging 无任何按钮（返回 null）', () => {
    const { container } = renderActions(makeTask({ id: 'a', status: 'merging' }));
    expect(container.firstElementChild).toBeNull();
  });

  it('done 有归档与删除', () => {
    renderActions(makeTask({ id: 'a', status: 'done' }));
    expect(screen.getByText('归档')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
  });

  it('动作失败时不回调 onSettled（详情弹窗保持打开）', async () => {
    storeActions.cancelTask.mockRejectedValue(new Error('busy'));
    const onSettled = vi.fn();
    render(<TaskActions task={makeTask({ id: 'a', status: 'running' })} onSettled={onSettled} />);

    fireEvent.click(screen.getByText('取消'));

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalled();
    });
    expect(onSettled).not.toHaveBeenCalled();
  });
});
