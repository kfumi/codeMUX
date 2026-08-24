// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitApiMock = vi.hoisted(() => ({
  getRepositoryState: vi.fn(),
  listWorktrees: vi.fn(),
  checkoutBranch: vi.fn(),
  createWorktree: vi.fn(),
}));

vi.mock('../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../lib/tauri')>('../../lib/tauri');
  return {
    ...actual,
    gitApi: gitApiMock,
  };
});

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

import { useNewSessionStore } from '../../stores/newSessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { DraftWorkspaceToolbar } from './DraftWorkspaceToolbar';

describe('DraftWorkspaceToolbar', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({
      projects: [{
        id: 'project-1',
        name: 'codeMUX',
        path: 'D:/project/codeMUX',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      }],
    });
    useNewSessionStore.setState({
      draftProjectId: 'project-1',
      draftWorkspace: { kind: 'local' },
    });
    gitApiMock.getRepositoryState.mockResolvedValue({
      currentBranch: 'master',
      branches: [
        { name: 'master', current: true },
        { name: 'feat/worktree', current: false },
      ],
      detached: false,
      hasUncommittedChanges: false,
      aheadCount: 0,
      hasUnpushedCommits: false,
      upstreamBranch: 'origin/master',
      upstreamRef: 'refs/remotes/origin/master',
    });
    gitApiMock.listWorktrees.mockResolvedValue([
      { path: 'D:/project/codeMUX', branch: 'master', isMain: true },
    ]);
  });

  it('renders project and worktree pickers without branch picker by default', () => {
    render(<DraftWorkspaceToolbar />);

    expect(screen.getByTestId('draft-project-picker').textContent).toContain('codeMUX');
    expect(screen.getByTestId('draft-worktree-picker').textContent).toContain('本地');
    expect(screen.queryByTestId('draft-branch-picker')).toBeNull();
  });

  it('shows worktree picker immediately before git finishes loading', () => {
    gitApiMock.getRepositoryState.mockReturnValue(new Promise(() => {}));
    gitApiMock.listWorktrees.mockReturnValue(new Promise(() => {}));

    render(<DraftWorkspaceToolbar />);

    expect(screen.getByTestId('draft-worktree-picker').textContent).toContain('本地');
  });

  it('shows branch picker after selecting worktree mode', async () => {
    render(<DraftWorkspaceToolbar />);

    await waitFor(() => expect(screen.getByTestId('draft-worktree-picker')).toBeTruthy());
    fireEvent.click(screen.getByTestId('draft-worktree-picker'));
    fireEvent.click(screen.getByTestId('draft-worktree-create-option'));

    await waitFor(() => {
      expect(screen.getByTestId('draft-worktree-picker').textContent).toContain('新建工作树');
      expect(screen.getByTestId('draft-branch-picker')).toBeTruthy();
      expect(useNewSessionStore.getState().draftWorkspace).toEqual({ kind: 'worktree', baseRef: null });
    });
  });

  it('stores the selected base branch without opening a dialog', async () => {
    render(<DraftWorkspaceToolbar />);

    await waitFor(() => expect(screen.getByTestId('draft-worktree-picker')).toBeTruthy());
    fireEvent.click(screen.getByTestId('draft-worktree-picker'));
    fireEvent.click(screen.getByTestId('draft-worktree-create-option'));
    await waitFor(() => expect(screen.getByTestId('draft-branch-picker')).toBeTruthy());
    fireEvent.click(screen.getByTestId('draft-branch-picker'));
    await waitFor(() => expect(screen.getByTestId('draft-branch-option-feat--worktree')).toBeTruthy());
    fireEvent.click(screen.getByTestId('draft-branch-option-feat--worktree'));

    expect(useNewSessionStore.getState().draftWorkspace).toEqual({
      kind: 'worktree',
      baseRef: 'feat/worktree',
    });
    expect(screen.queryByTestId('worktree-branch-name')).toBeNull();
  });

  it('selects an existing worktree from the dropdown', async () => {
    gitApiMock.listWorktrees.mockResolvedValue([
      { path: 'D:/project/codeMUX', branch: 'master', isMain: true },
      { path: 'D:/project/codeMUX/.worktrees/feat-new', branch: 'feat/new', isMain: false },
    ]);

    render(<DraftWorkspaceToolbar />);
    await waitFor(() => expect(screen.getByTestId('draft-worktree-picker')).toBeTruthy());
    fireEvent.click(screen.getByTestId('draft-worktree-picker'));
    fireEvent.click(screen.getByText('feat/new'));

    expect(useNewSessionStore.getState().draftWorkspace).toEqual({
      kind: 'existing',
      worktreePath: 'D:/project/codeMUX/.worktrees/feat-new',
    });
    expect(screen.queryByTestId('draft-branch-picker')).toBeNull();
  });
});
