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
  });

  it('loads repository state and switches branches', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('master');
    fireEvent.click(screen.getByTestId('git-branch-trigger'));
    fireEvent.click(screen.getByRole('button', { name: 'feature/git-panel' }));

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
    gitApiMock.generateCommitMessage.mockResolvedValue({ message: 'feat: update app' });

    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByTestId('git-commit-message');
    fireEvent.click(screen.getByTestId('git-commit-generate'));

    await waitFor(() => {
      expect((screen.getByTestId('git-commit-message') as HTMLInputElement).value).toBe('feat: update app');
    });
  });

  it('commits staged changes and clears the commit input', async () => {
    gitApiMock.commitChanges.mockResolvedValue('abc1234');

    render(<ReviewPanel projectPath="D:/project/app" />);

    const input = await screen.findByTestId('git-commit-message');
    fireEvent.change(input, { target: { value: 'feat: update app' } });
    fireEvent.click(screen.getByTestId('git-commit-submit'));

    await waitFor(() => expect(gitApiMock.commitChanges).toHaveBeenCalledWith('D:/project/app', 'feat: update app'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });
});
