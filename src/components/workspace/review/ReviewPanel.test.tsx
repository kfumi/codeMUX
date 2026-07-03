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

describe('ReviewPanel staging actions', () => {
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
  });

  it('loads repository state and switches branches', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('master');
    fireEvent.click(screen.getByRole('button', { name: '切换分支' }));
    fireEvent.click(screen.getByRole('button', { name: 'feature/git-panel' }));

    await waitFor(() => expect(gitApiMock.checkoutBranch).toHaveBeenCalledWith('D:/project/app', 'feature/git-panel'));
    await waitFor(() => expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(2));
  });

  it('creates a branch from the branch dialog', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('master');
    fireEvent.click(screen.getByRole('button', { name: '新建分支' }));
    fireEvent.change(screen.getByLabelText('分支名'), { target: { value: 'feature/new-work' } });
    fireEvent.click(screen.getByRole('button', { name: '创建分支' }));

    await waitFor(() => expect(gitApiMock.createBranch).toHaveBeenCalledWith('D:/project/app', 'feature/new-work', true));
  });

  it('stages all unstaged files and refreshes the review list', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByRole('button', { name: '全部暂存' }));

    await waitFor(() => expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app', undefined));
    await waitFor(() => expect(gitApiMock.getStatusChanges).toHaveBeenCalledTimes(2));
  });

  it('stages a single unstaged file', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByRole('button', { name: '暂存 App.tsx' }));

    await waitFor(() => expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app', 'D:/project/app/src/App.tsx'));
  });
});
