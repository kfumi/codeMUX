// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewPanel } from './ReviewPanel';

const gitApiMock = vi.hoisted(() => ({
  getRepositoryState: vi.fn(),
  createBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  getStatusChanges: vi.fn(),
  getStatusChangeDetail: vi.fn(),
  stageStatusChanges: vi.fn(),
  unstageStatusChanges: vi.fn(),
  revertStatusChanges: vi.fn(),
  commitChanges: vi.fn(),
  pushBranch: vi.fn(),
  generateCommitMessage: vi.fn(),
  generatePullRequestDescription: vi.fn(),
  createPullRequest: vi.fn(),
}));

vi.mock('../../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    git: gitApiMock,
  },
}));

vi.mock('../../preview/DiffView', () => ({
  DiffView: () => <div data-testid="diff-view" />,
}));

describe('ReviewPanel git actions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    gitApiMock.getRepositoryState.mockResolvedValue({
      currentBranch: 'master',
      branches: [
        { name: 'master', current: true },
        { name: 'feature/git-panel', current: false },
      ],
      detached: false,
      hasUncommittedChanges: false,
      aheadCount: 0,
      hasUnpushedCommits: false,
    });
    gitApiMock.getStatusChanges.mockResolvedValue([
      {
        path: 'D:/project/app/src/App.tsx',
        status: 'modified',
        originalContent: null,
        currentContent: '',
        additions: 2,
        deletions: 1,
      },
    ]);
    gitApiMock.createBranch.mockResolvedValue(undefined);
    gitApiMock.checkoutBranch.mockResolvedValue(undefined);
    gitApiMock.stageStatusChanges.mockResolvedValue(undefined);
    gitApiMock.unstageStatusChanges.mockResolvedValue(undefined);
    gitApiMock.revertStatusChanges.mockResolvedValue(undefined);
    gitApiMock.commitChanges.mockResolvedValue('abc1234');
    gitApiMock.pushBranch.mockResolvedValue(undefined);
    gitApiMock.generateCommitMessage.mockResolvedValue({ message: 'feat: 更新应用' });
    gitApiMock.generatePullRequestDescription.mockResolvedValue({
      title: 'feat: 新增 Git 生成设置',
      body: '本分支新增 Git 设置面板。',
      base: 'master',
    });
    gitApiMock.createPullRequest.mockResolvedValue({
      platform: 'github',
      url: 'https://github.com/acme/app/pull/12',
      number: 12,
      head: 'feature/git-panel',
      base: 'master',
    });
  });

  const openGitActions = async (itemTestId: string) => {
    fireEvent.pointerDown(screen.getByTestId('git-actions-trigger'));
    fireEvent.click(await screen.findByTestId(itemTestId));
  };

  it('stages all unstaged files and refreshes the review list', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByRole('button', { name: '全部暂存' }));

    await waitFor(() => expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app', undefined));
    await waitFor(() => expect(gitApiMock.getStatusChanges).toHaveBeenCalledTimes(4));
  });

  it('keeps the review scope in the compact toolbar without a separate area selector row', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');

    expect(screen.getByRole('button', { name: '审查范围：未提交' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '选择审查范围' })).toBeNull();
    expect(screen.getByRole('button', { name: '全部暂存' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部还原' })).toBeTruthy();
  });

  it('stages a single unstaged file', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByRole('button', { name: '暂存 App.tsx' }));

    await waitFor(() => expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app', 'D:/project/app/src/App.tsx'));
  });

  it('reverts a single file after confirmation', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByTestId('git-revert-App.tsx'));
    fireEvent.click(screen.getByRole('button', { name: '确认还原' }));

    await waitFor(() => expect(gitApiMock.revertStatusChanges).toHaveBeenCalledWith(
      'D:/project/app',
      'unstaged',
      'D:/project/app/src/App.tsx',
    ));
  });

  it('reverts all files in the current area after confirmation', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByTestId('git-revert-all'));
    fireEvent.click(screen.getByRole('button', { name: '确认还原' }));

    await waitFor(() => expect(gitApiMock.revertStatusChanges).toHaveBeenCalledWith(
      'D:/project/app',
      'unstaged',
      undefined,
    ));
  });

  it('generates a commit message into the commit input', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    await openGitActions('git-actions-commit');
    fireEvent.click(screen.getByTestId('git-commit-generate'));

    await waitFor(() => {
      expect((screen.getByTestId('git-commit-message') as HTMLTextAreaElement).value).toBe('feat: 更新应用');
    });
  });

  it('commits staged changes and clears the commit input', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    await openGitActions('git-actions-commit');
    const input = screen.getByTestId('git-commit-message');
    fireEvent.change(input, { target: { value: 'feat: update app' } });
    fireEvent.click(screen.getByTestId('git-commit-submit'));

    await waitFor(() => expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: update app'));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
  });

  it('commits multiline staged changes without flattening the message', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    await openGitActions('git-actions-commit');
    const input = screen.getByTestId('git-commit-message');
    const message = 'feat: 更新审查面板\n\n补充多行提交说明';
    fireEvent.change(input, { target: { value: message } });
    fireEvent.click(screen.getByTestId('git-commit-submit'));

    await waitFor(() => expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', message));
  });

  it('pushes when there are no local changes and the branch is ahead', async () => {
    gitApiMock.getRepositoryState.mockResolvedValue({
      currentBranch: 'master',
      branches: [{ name: 'master', current: true }],
      detached: false,
      hasUncommittedChanges: false,
      aheadCount: 1,
      hasUnpushedCommits: true,
    });
    gitApiMock.getStatusChanges.mockResolvedValue([]);

    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('推送');
    await openGitActions('git-actions-push');
    fireEvent.click(screen.getByTestId('git-push-submit'));

    await waitFor(() => expect(gitApiMock.pushBranch).toHaveBeenCalledWith('D:/project/app'));
  });

  it('can stage unstaged changes before committing', async () => {
    gitApiMock.getRepositoryState.mockResolvedValue({
      currentBranch: 'master',
      branches: [{ name: 'master', current: true }],
      detached: false,
      hasUncommittedChanges: true,
      aheadCount: 0,
      hasUnpushedCommits: false,
    });

    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    await openGitActions('git-actions-commit');
    fireEvent.change(screen.getByTestId('git-commit-message'), { target: { value: 'feat: update app' } });
    fireEvent.click(screen.getByTestId('git-commit-submit'));

    await waitFor(() => expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app'));
    await waitFor(() => expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: update app'));
  });

  it('commits and pushes from the commit popover', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    await openGitActions('git-actions-commit');
    fireEvent.change(screen.getByTestId('git-commit-message'), { target: { value: 'feat: update app' } });
    fireEvent.click(screen.getByTestId('git-commit-push-submit'));

    await waitFor(() => expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: update app'));
    await waitFor(() => expect(gitApiMock.pushBranch).toHaveBeenCalledWith('D:/project/app'));
  });

  it('generates a pull request description from the branch bar', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    await openGitActions('git-actions-pr');

    expect(gitApiMock.generatePullRequestDescription).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('git-pr-generate'));
    await waitFor(() => expect(gitApiMock.generatePullRequestDescription).toHaveBeenCalledWith('D:/project/app'));
    await waitFor(() => {
      expect((screen.getByTestId('git-pr-title') as HTMLInputElement).value).toBe('feat: 新增 Git 生成设置');
    });
    expect((screen.getByTestId('git-pr-body') as HTMLTextAreaElement).value).toBe('本分支新增 Git 设置面板。');
    expect(screen.getByText('基准分支: master')).toBeTruthy();
  });

  it('shows a PR generation error from the backend', async () => {
    gitApiMock.generatePullRequestDescription.mockRejectedValueOnce('当前分支即基准分支，没有可生成 PR 的提交差异');

    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    await openGitActions('git-actions-pr');

    expect(gitApiMock.generatePullRequestDescription).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('git-pr-generate'));
    await waitFor(() => expect(screen.getByText('当前分支即基准分支，没有可生成 PR 的提交差异')).toBeTruthy());
  });

  it('creates a pull request from the edited PR content', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    await openGitActions('git-actions-pr');
    fireEvent.change(screen.getByTestId('git-pr-title'), { target: { value: 'feat: create PR' } });
    fireEvent.change(screen.getByTestId('git-pr-body'), { target: { value: 'PR description' } });
    fireEvent.click(screen.getByTestId('git-pr-create'));

    await waitFor(() =>
      expect(gitApiMock.createPullRequest).toHaveBeenCalledWith({
        projectPath: 'D:/project/app',
        title: 'feat: create PR',
        body: 'PR description',
        base: 'feature/git-panel',
      }),
    );
    expect((await screen.findByRole('link', { name: '打开 PR' })).getAttribute('href')).toBe(
      'https://github.com/acme/app/pull/12',
    );
  });
});
