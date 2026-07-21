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
}));

vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    gitApi: gitApiMock,
  };
});

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
  });

  it('loads repository state and switches branches', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('master');
    fireEvent.pointerDown(screen.getByTestId('git-branch-trigger'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'feature/git-panel' }));

    await waitFor(() => expect(gitApiMock.checkoutBranch).toHaveBeenCalledWith('D:/project/app', 'feature/git-panel'));
    await waitFor(() => expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(2));
  });

  it('creates a branch from the branch dialog', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('master');
    fireEvent.click(screen.getByTestId('git-branch-create'));
    fireEvent.change(screen.getByTestId('git-branch-name'), { target: { value: 'feature/new-work' } });
    fireEvent.click(screen.getByTestId('git-branch-submit'));

    await waitFor(() => expect(gitApiMock.createBranch).toHaveBeenCalledWith('D:/project/app', 'feature/new-work', true));
  });

  it('stages all unstaged files and refreshes the review list', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByRole('button', { name: '全部暂存' }));

    await waitFor(() => expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app', undefined));
    await waitFor(() => expect(gitApiMock.getStatusChanges).toHaveBeenCalledTimes(4));
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
    fireEvent.click(screen.getByTestId('git-action-trigger'));
    fireEvent.click(screen.getByTestId('git-commit-generate'));

    await waitFor(() => {
      expect((screen.getByTestId('git-commit-message') as HTMLTextAreaElement).value).toBe('feat: 更新应用');
    });
  });

  it('commits staged changes and clears the commit input', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByTestId('git-action-trigger'));
    const input = screen.getByTestId('git-commit-message');
    fireEvent.change(input, { target: { value: 'feat: update app' } });
    fireEvent.click(screen.getByTestId('git-commit-submit'));

    await waitFor(() => expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: update app'));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
  });

  it('commits multiline staged changes without flattening the message', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByTestId('git-action-trigger'));
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
    fireEvent.click(screen.getByTestId('git-action-trigger'));
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
    fireEvent.click(screen.getByTestId('git-action-trigger'));
    fireEvent.change(screen.getByTestId('git-commit-message'), { target: { value: 'feat: update app' } });
    fireEvent.click(screen.getByTestId('git-commit-submit'));

    await waitFor(() => expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app'));
    await waitFor(() => expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: update app'));
  });

  it('commits and pushes from the commit popover', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByTestId('git-action-trigger'));
    fireEvent.change(screen.getByTestId('git-commit-message'), { target: { value: 'feat: update app' } });
    fireEvent.click(screen.getByTestId('git-commit-push-submit'));

    await waitFor(() => expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: update app'));
    await waitFor(() => expect(gitApiMock.pushBranch).toHaveBeenCalledWith('D:/project/app'));
  });
});
