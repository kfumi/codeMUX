// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkTask } from '../../types/workTask';

const { mergeTask, toastMocks } = vi.hoisted(() => ({
  mergeTask: vi.fn(),
  toastMocks: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../stores/workTaskStore', () => {
  const state = { mergeTask };
  return {
    useWorkTaskStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

vi.mock('sonner', () => ({
  toast: toastMocks,
}));

import { MergeDialog } from './MergeDialog';

function makeTask(overrides: Partial<WorkTask>): WorkTask {
  const now = new Date('2026-01-01T00:00:00Z').toISOString();
  return {
    id: 't1',
    projectId: 'p1',
    title: '修复登录页',
    instruction: '',
    agentKind: 'claude_code',
    providerId: null,
    model: null,
    useWorktree: true,
    baseBranch: 'main',
    workBranch: 'worktask/t1',
    worktreePath: null,
    status: 'review',
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

describe('MergeDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('打开时显示工作分支与「留空自动生成」提示', () => {
    render(
      <MergeDialog task={makeTask({})} open onOpenChange={vi.fn()} />,
    );
    expect(screen.getByText('合并任务')).toBeTruthy();
    expect(screen.getByText('worktask/t1')).toBeTruthy();
    expect(screen.getByText(/留空自动生成/)).toBeTruthy();
  });

  it('填写提交信息后确认：以自定义 message 调用 mergeTask，成功后关闭并回调', async () => {
    mergeTask.mockResolvedValue(makeTask({ status: 'merging' }));
    const onOpenChange = vi.fn();
    const onMerged = vi.fn();
    render(<MergeDialog task={makeTask({})} open onOpenChange={onOpenChange} onMerged={onMerged} />);

    const input = screen.getByLabelText(/合并提交信息/);
    fireEvent.change(input, { target: { value: 'fix: 修复登录页' } });
    fireEvent.click(screen.getByRole('button', { name: '合并' }));

    await waitFor(() => {
      expect(mergeTask).toHaveBeenCalledWith('t1', 'fix: 修复登录页');
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onMerged).toHaveBeenCalledTimes(1);
      expect(toastMocks.success).toHaveBeenCalled();
    });
  });

  it('留空确认：mergeTask 收到 undefined（自动生成提交信息）', async () => {
    mergeTask.mockResolvedValue(makeTask({ status: 'merging' }));
    render(<MergeDialog task={makeTask({})} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '合并' }));

    await waitFor(() => {
      expect(mergeTask).toHaveBeenCalledWith('t1', undefined);
    });
  });

  it('合并失败时提示错误并保持弹窗打开', async () => {
    mergeTask.mockRejectedValue(new Error('conflict'));
    const onOpenChange = vi.fn();
    const onMerged = vi.fn();
    render(<MergeDialog task={makeTask({})} open onOpenChange={onOpenChange} onMerged={onMerged} />);

    fireEvent.click(screen.getByRole('button', { name: '合并' }));

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalled();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onMerged).not.toHaveBeenCalled();
  });

  // 同 TaskEditorDialog：space-y-* 在「行内 label + 控件」结构下不生效（Tailwind v4 把外边距
  // 加在前一个兄弟的 margin-block-end，而行内元素纵向外边距被忽略，实测只剩 2px）。
  it('提交信息字段用 flex 列 + gap，不依赖 space-y', () => {
    render(<MergeDialog task={makeTask({})} open onOpenChange={vi.fn()} />);

    const tokens = (screen.getByLabelText(/合并提交信息/).parentElement as HTMLElement)
      .className.split(/\s+/);
    expect(tokens).toContain('flex');
    expect(tokens).toContain('flex-col');
    expect(tokens.some((token) => token.startsWith('gap-'))).toBe(true);
    expect(tokens.some((token) => token.startsWith('space-y-'))).toBe(false);
  });
});
