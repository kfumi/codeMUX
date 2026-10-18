// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitApiMock = vi.hoisted(() => ({
  getStatusChanges: vi.fn(),
  stageStatusChanges: vi.fn(),
  generateCommitMessage: vi.fn(),
  commitChanges: vi.fn(),
  pushBranch: vi.fn(),
}));

vi.mock('../../../lib/facades/daemon-facade', () => ({
  daemonFacade: { git: gitApiMock },
}));

import type { GitRepositoryState } from '../../../lib/gitTypes';
import { GitCommitOrPushDialog, canPushRepository } from './GitCommitOrPushDialog';

function repositoryState(overrides: Partial<GitRepositoryState> = {}): GitRepositoryState {
  return {
    currentBranch: 'feat/x',
    branches: [],
    detached: false,
    hasUncommittedChanges: true,
    aheadCount: 0,
    hasUnpushedCommits: false,
    upstreamBranch: 'origin/feat/x',
    upstreamRef: 'refs/remotes/origin/feat/x',
    ...overrides,
  };
}

describe('GitCommitOrPushDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitApiMock.getStatusChanges.mockResolvedValue([{ additions: 1, deletions: 0 }]);
    gitApiMock.stageStatusChanges.mockResolvedValue(undefined);
    gitApiMock.generateCommitMessage.mockResolvedValue({ message: 'feat: 生成的提交信息' });
    gitApiMock.commitChanges.mockResolvedValue('abc1234');
    gitApiMock.pushBranch.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it('提交：暂存全部改动并提交输入的信息', async () => {
    const onCompleted = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <GitCommitOrPushDialog
        projectPath="D:/project/app"
        state={repositoryState()}
        totals={{ additions: 3, deletions: 1 }}
        open
        onOpenChange={onOpenChange}
        onRequestPush={vi.fn()}
        onCompleted={onCompleted}
      />,
    );

    fireEvent.change(screen.getByTestId('git-commit-or-push-message'), {
      target: { value: 'feat: 手动信息' },
    });
    fireEvent.click(screen.getByTestId('git-commit-or-push-commit'));

    await waitFor(() =>
      expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: 手动信息'),
    );
    // 勾选「包含未暂存」时先全量暂存
    expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app');
    expect(gitApiMock.pushBranch).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCompleted).toHaveBeenCalled();
  });

  it('提交并推送：提交后继续推送', async () => {
    const onCompleted = vi.fn();
    render(
      <GitCommitOrPushDialog
        projectPath="D:/project/app"
        state={repositoryState()}
        totals={{ additions: 1, deletions: 0 }}
        open
        onOpenChange={vi.fn()}
        onRequestPush={vi.fn()}
        onCompleted={onCompleted}
      />,
    );

    fireEvent.change(screen.getByTestId('git-commit-or-push-message'), {
      target: { value: 'feat: x' },
    });
    fireEvent.click(screen.getByTestId('git-commit-or-push-commitAndPush'));

    await waitFor(() => expect(gitApiMock.pushBranch).toHaveBeenCalledWith('D:/project/app'));
    expect(gitApiMock.commitChanges).toHaveBeenCalled();
    expect(onCompleted).toHaveBeenCalled();
  });

  it('留空提交信息时用 AI 生成', async () => {
    render(
      <GitCommitOrPushDialog
        projectPath="D:/project/app"
        state={repositoryState()}
        totals={{ additions: 1, deletions: 0 }}
        open
        onOpenChange={vi.fn()}
        onRequestPush={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('git-commit-or-push-commit'));

    await waitFor(() =>
      expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: 生成的提交信息'),
    );
  });

  it('推送：改为请求打开确认弹窗，不直接推送', async () => {
    const onRequestPush = vi.fn();
    render(
      <GitCommitOrPushDialog
        projectPath="D:/project/app"
        state={repositoryState({ hasUncommittedChanges: false, upstreamBranch: null, upstreamRef: null })}
        totals={{ additions: 0, deletions: 0 }}
        open
        onOpenChange={vi.fn()}
        onRequestPush={onRequestPush}
        onCompleted={vi.fn()}
      />,
    );

    const pushButton = screen.getByTestId('git-commit-or-push-push') as HTMLButtonElement;
    expect(pushButton.disabled).toBe(false);
    fireEvent.click(pushButton);
    await waitFor(() => expect(onRequestPush).toHaveBeenCalled());
    expect(gitApiMock.pushBranch).not.toHaveBeenCalled();
  });

  it('无可提交/推送时禁用入口动作', () => {
    render(
      <GitCommitOrPushDialog
        projectPath="D:/project/app"
        state={repositoryState({ hasUncommittedChanges: false, aheadCount: 0 })}
        totals={{ additions: 0, deletions: 0 }}
        open
        onOpenChange={vi.fn()}
        onRequestPush={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );

    expect((screen.getByTestId('git-commit-or-push-commit') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('git-commit-or-push-push') as HTMLButtonElement).disabled).toBe(true);
  });

  it('canPushRepository：detached 或无分支不可推送', () => {
    expect(canPushRepository(repositoryState({ detached: true }))).toBe(false);
    expect(canPushRepository(repositoryState({ currentBranch: null }))).toBe(false);
    expect(canPushRepository(repositoryState({ aheadCount: 1 }))).toBe(true);
    expect(canPushRepository(repositoryState({ upstreamBranch: null, upstreamRef: null }))).toBe(true);
    expect(canPushRepository(repositoryState({ upstreamBranch: 'origin/x', aheadCount: 0 }))).toBe(false);
  });
});
