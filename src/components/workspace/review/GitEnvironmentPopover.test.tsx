// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitApiMock = vi.hoisted(() => ({
  getRepositoryState: vi.fn(),
  getStatusChanges: vi.fn(),
}));
const openReviewTabMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    gitApi: gitApiMock,
  };
});

vi.mock('../../../stores/sidePanelStore', () => ({
  useSidePanelStore: (selector: (state: { openReviewTab: typeof openReviewTabMock }) => unknown) =>
    selector({ openReviewTab: openReviewTabMock }),
}));

vi.mock('./GitBranchDialog', () => ({
  GitBranchDialog: () => null,
}));

import { GitEnvironmentPopover } from './GitEnvironmentPopover';

describe('GitEnvironmentPopover', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    gitApiMock.getRepositoryState.mockResolvedValue({
      currentBranch: 'feat/mobile-companion',
      branches: [
        { name: 'master', current: false },
        { name: 'feat/mobile-companion', current: true },
      ],
      detached: false,
      hasUncommittedChanges: true,
      aheadCount: 0,
      hasUnpushedCommits: false,
    });
    gitApiMock.getStatusChanges.mockResolvedValue([
      { additions: 34376, deletions: 2509 },
      { additions: 4, deletions: 2 },
    ]);
  });

  it('shows environment totals and opens the review panel from the changes row', async () => {
    render(<GitEnvironmentPopover projectPath="D:/project/app" />);

    fireEvent.click(screen.getByTestId('git-environment-trigger'));

    await screen.findByText('环境信息');
    expect(screen.getByText('+34,380')).toBeTruthy();
    expect(screen.getByText('-2,511')).toBeTruthy();

    fireEvent.click(screen.getByTestId('git-environment-changes'));

    expect(openReviewTabMock).toHaveBeenCalledWith('D:/project/app');
  });

  it('opens the branch selector from the environment panel', async () => {
    render(<GitEnvironmentPopover projectPath="D:/project/app" />);

    fireEvent.click(screen.getByTestId('git-environment-trigger'));
    await screen.findByText('feat/mobile-companion');
    fireEvent.click(screen.getByTestId('git-environment-branch'));

    await waitFor(() => expect(screen.getByPlaceholderText('搜索分支')).toBeTruthy());
    expect(screen.getByText('master')).toBeTruthy();
  });

  it('renders session todos below the environment section', async () => {
    render(
      <GitEnvironmentPopover
        projectPath="D:/project/app"
        todos={[
          { content: '已完成任务', status: 'completed' },
          { content: '进行中任务', status: 'in_progress', activeForm: '正在处理' },
          { content: '待办任务', status: 'pending' },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId('git-environment-trigger'));
    await screen.findByText('环境信息');

    const section = screen.getByTestId('git-environment-todos');
    expect(screen.getByText('1/3')).toBeTruthy();
    expect(section.textContent).toContain('已完成任务');
    expect(section.textContent).toContain('正在处理');
    expect(section.textContent).toContain('待办任务');
  });

  it('collapses older todos when the list overflows and can expand them', async () => {
    render(
      <GitEnvironmentPopover
        projectPath="D:/project/app"
        todos={Array.from({ length: 8 }, (_, i) => ({
          content: `任务${i + 1}`,
          status: 'completed' as const,
        }))}
      />,
    );

    fireEvent.click(screen.getByTestId('git-environment-trigger'));
    await screen.findByText('环境信息');

    const section = screen.getByTestId('git-environment-todos');
    expect(screen.getByText('8/8')).toBeTruthy();
    // 折叠态：仅展示最后 5 条，前面的默认隐藏
    expect(section.textContent).not.toContain('任务1');
    expect(section.textContent).not.toContain('任务3');
    expect(section.textContent).toContain('任务4');
    expect(section.textContent).toContain('任务8');

    fireEvent.click(screen.getByTestId('git-environment-todos-expand'));
    expect(section.textContent).toContain('任务1');
    expect(section.textContent).toContain('任务3');

    fireEvent.click(screen.getByTestId('git-environment-todos-collapse'));
    expect(section.textContent).not.toContain('任务1');
  });

  it('hides the todo section when there are no todos', async () => {
    render(<GitEnvironmentPopover projectPath="D:/project/app" />);

    fireEvent.click(screen.getByTestId('git-environment-trigger'));
    await screen.findByText('环境信息');

    expect(screen.queryByTestId('git-environment-todos')).toBeNull();
  });

  it('hides the environment section and error when the project is not a git repo', async () => {
    gitApiMock.getRepositoryState.mockRejectedValue('当前项目不是 Git 仓库');

    render(
      <GitEnvironmentPopover
        projectPath="D:/project/app"
        todos={[{ content: '任务一', status: 'in_progress' }]}
      />,
    );

    fireEvent.click(screen.getByTestId('git-environment-trigger'));
    await screen.findByText('任务');

    expect(screen.queryByText('环境信息')).toBeNull();
    expect(screen.queryByTestId('git-environment-changes')).toBeNull();
    expect(screen.queryByTestId('git-environment-branch')).toBeNull();
    expect(screen.queryByText(/当前项目不是 Git 仓库/)).toBeNull();
    expect(screen.getByText('任务一')).toBeTruthy();
  });
});
