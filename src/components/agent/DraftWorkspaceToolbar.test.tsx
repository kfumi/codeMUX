// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitApiMock = vi.hoisted(() => ({
  getRepositoryState: vi.fn(),
  listWorktrees: vi.fn(),
  checkoutBranch: vi.fn(),
  createWorktree: vi.fn(),
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    git: gitApiMock,
  },
}));

vi.mock('../../lib/desktopDialogs', () => ({
  openDialog: vi.fn(async () => null),
  saveDialog: vi.fn(async () => null),
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

  it('renders as an attached rail of borderless chips rather than three bordered buttons', () => {
    render(<DraftWorkspaceToolbar />);

    const bar = screen.getByTestId('draft-workspace-toolbar');
    // 上下文条是**发送框顶部贴着的那一条**（Codex 的 composer rail）：
    // 左右各内缩一个输入框圆角、只圆上面两角、直接压在输入框顶边上；底色取
    // `--composer-action-bar-bg`（Codex 的 `background-composer-action-bar`）。
    expect(bar.getAttribute('data-composer-rail')).toBe('true');
    expect(bar.className).toContain('rounded-t-xl');
    expect(bar.className).toContain('mx-[var(--radius-xl)]');
    expect(bar.className).toContain('bg-[hsl(var(--composer-action-bar-bg))]');
    // 底边不圆：下面那条边要和输入框的顶边接上，圆了就会漏出两个缺口。
    expect(bar.className).not.toContain('rounded-xl');
    expect(bar.className).not.toContain('bg-[hsl(var(--surface-1))]');
    // 压住输入框的外描边，接缝处不能多出一条线。
    expect(bar.className).toContain('z-10');

    // chip 无边框、无常驻底色，只有悬停时才浮出来。
    const chip = screen.getByTestId('draft-project-picker');
    const base = chip.className.split('hover:')[0];
    expect(chip.className).not.toContain('border');
    expect(base).not.toContain('bg-');
    // 悬停用 ink 的 alpha：压在凹面上时 `--surface-3` 与底色同档，浮不出来。
    expect(chip.className).toContain('hover:bg-foreground/8');
  });
});
