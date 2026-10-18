// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitApiMock = vi.hoisted(() => ({
  pushBranch: vi.fn(),
}));

const toastMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/facades/daemon-facade', () => ({
  daemonFacade: { git: gitApiMock },
}));

vi.mock('sonner', () => ({ toast: toastMock }));

import type { GitRepositoryState } from '../../../lib/gitTypes';
import { GitPushConfirmDialog } from './GitPushConfirmDialog';

function repositoryState(overrides: Partial<GitRepositoryState> = {}): GitRepositoryState {
  return {
    currentBranch: 'feat/x',
    branches: [],
    detached: false,
    hasUncommittedChanges: false,
    aheadCount: 2,
    hasUnpushedCommits: true,
    upstreamBranch: 'origin/feat/x',
    upstreamRef: 'refs/remotes/origin/feat/x',
    ...overrides,
  };
}

describe('GitPushConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitApiMock.pushBranch.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it('推送成功：调用 pushBranch、toast、关闭并刷新', async () => {
    const onOpenChange = vi.fn();
    const onCompleted = vi.fn();
    render(
      <GitPushConfirmDialog
        projectPath="D:/project/app"
        state={repositoryState()}
        open
        onOpenChange={onOpenChange}
        onCompleted={onCompleted}
      />,
    );

    expect(screen.getByText('origin/feat/x')).toBeTruthy();
    fireEvent.click(screen.getByTestId('git-push-confirm-submit'));

    await waitFor(() => expect(gitApiMock.pushBranch).toHaveBeenCalledWith('D:/project/app'));
    expect(toastMock).toHaveBeenCalledWith('已推送到 origin/feat/x');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCompleted).toHaveBeenCalled();
  });

  it('首次推送：无上游时提示会自动建立上游分支，仍可推送', () => {
    render(
      <GitPushConfirmDialog
        projectPath="D:/project/app"
        state={repositoryState({
          upstreamBranch: null,
          upstreamRef: null,
          aheadCount: 0,
          hasUnpushedCommits: false,
        })}
        open
        onOpenChange={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );

    expect(screen.getByText('首次推送会把当前分支发布到远程并设置 upstream。')).toBeTruthy();
    expect(screen.getByText('首次推送会自动为当前分支建立上游分支')).toBeTruthy();
    expect((screen.getByTestId('git-push-confirm-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('无提交可推：警示并禁用推送按钮', () => {
    render(
      <GitPushConfirmDialog
        projectPath="D:/project/app"
        state={repositoryState({ aheadCount: 0, hasUnpushedCommits: false })}
        open
        onOpenChange={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );

    expect(screen.getByText('当前分支没有需要推送的提交。')).toBeTruthy();
    expect((screen.getByTestId('git-push-confirm-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('推送失败：显示错误详情与关闭按钮，弹窗保持打开', async () => {
    gitApiMock.pushBranch.mockRejectedValue(new Error('remote rejected'));
    const onOpenChange = vi.fn();
    render(
      <GitPushConfirmDialog
        projectPath="D:/project/app"
        state={repositoryState()}
        open
        onOpenChange={onOpenChange}
        onCompleted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('git-push-confirm-submit'));

    await waitFor(() => expect(screen.getByTestId('git-push-confirm-error')).toBeTruthy());
    expect(screen.getByText('推送失败，请检查错误详情。')).toBeTruthy();
    expect(screen.getByText('复制错误信息')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('git-push-confirm-submit')).toBeNull();
  });
});
